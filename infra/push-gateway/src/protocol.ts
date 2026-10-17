/**
 * The server-to-gateway request, validated by hand so the Worker carries no schema library. The
 * same shape is `PushGatewayRequest` in `packages/contracts/src/pushGateway.ts`; `protocol.test.ts`
 * checks the two stay assignable.
 */

/**
 * Each delivery is one subrequest, and Cloudflare's free plan allows 50 per request, so the
 * server sends at most this many at once (`PUSH_GATEWAY_MAX_DELIVERIES`).
 */
export const MAX_DELIVERIES = 40;
export const MAX_BODY_BYTES = 512 * 1024;
const MAX_PAYLOAD_BYTES = 4096;
const MAX_FCM_TOKEN_LENGTH = 4096;
// APNs tokens go into the request path, so only hex is accepted.
const APNS_TOKEN = /^[0-9a-fA-F]{32,200}$/;

export interface Delivery {
  readonly platform: "ios" | "android";
  readonly token: string;
  readonly kind: "alert" | "liveactivity";
  readonly bundleId: string;
  readonly apsEnvironment?: "sandbox" | "production";
  readonly priority?: 5 | 10;
  readonly collapseId?: string;
  readonly expiration?: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DeliveryResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason?: string;
}

export type ParsedRequest =
  | { readonly ok: true; readonly deliveries: ReadonlyArray<Delivery | DeliveryResult> }
  | { readonly ok: false; readonly status: number; readonly error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const refused = (reason: string): DeliveryResult => ({ ok: false, status: 400, reason });

/**
 * One malformed or disallowed delivery is answered on its own, so the rest of the batch still
 * goes out; only a request that is not a batch at all is refused whole.
 */
export function parseDeliveries(
  body: unknown,
  allowedBundleIds: ReadonlySet<string>,
): ParsedRequest {
  if (!isRecord(body) || !Array.isArray(body.deliveries)) {
    return { ok: false, status: 400, error: "Expected { deliveries: [...] }." };
  }
  if (body.deliveries.length > MAX_DELIVERIES) {
    return { ok: false, status: 413, error: `At most ${MAX_DELIVERIES} deliveries per request.` };
  }
  return {
    ok: true,
    deliveries: body.deliveries.map((item) => parseDelivery(item, allowedBundleIds)),
  };
}

function parseDelivery(
  item: unknown,
  allowedBundleIds: ReadonlySet<string>,
): Delivery | DeliveryResult {
  if (!isRecord(item)) return refused("InvalidDelivery");
  const { platform, token, kind, bundleId, apsEnvironment, priority, collapseId, expiration } =
    item;
  if (platform !== "ios" && platform !== "android") return refused("InvalidPlatform");
  if (kind !== "alert" && kind !== "liveactivity") return refused("InvalidKind");
  if (typeof bundleId !== "string") return refused("InvalidBundleId");
  // A credential may only use the owner's keys for the owner's own apps.
  if (!allowedBundleIds.has(bundleId)) {
    return { ok: false, status: 403, reason: "TopicNotAllowed" };
  }
  if (typeof token !== "string") return refused("BadDeviceToken");
  if (
    platform === "ios"
      ? !APNS_TOKEN.test(token)
      : token.length === 0 || token.length > MAX_FCM_TOKEN_LENGTH
  ) {
    return refused("BadDeviceToken");
  }
  if (
    apsEnvironment !== undefined &&
    apsEnvironment !== "sandbox" &&
    apsEnvironment !== "production"
  ) {
    return refused("InvalidApsEnvironment");
  }
  if (priority !== undefined && priority !== 5 && priority !== 10) return refused("BadPriority");
  if (
    collapseId !== undefined &&
    (typeof collapseId !== "string" || new TextEncoder().encode(collapseId).length > 64)
  ) {
    return refused("BadCollapseId");
  }
  if (
    expiration !== undefined &&
    (typeof expiration !== "number" || !Number.isInteger(expiration))
  ) {
    return refused("BadExpirationDate");
  }
  if (!isRecord(item.payload)) return refused("PayloadEmpty");
  if (new TextEncoder().encode(JSON.stringify(item.payload)).length > MAX_PAYLOAD_BYTES) {
    return refused("PayloadTooLarge");
  }
  return {
    platform,
    token,
    kind,
    bundleId,
    ...(apsEnvironment === undefined ? {} : { apsEnvironment }),
    ...(priority === undefined ? {} : { priority }),
    ...(collapseId === undefined ? {} : { collapseId }),
    ...(expiration === undefined ? {} : { expiration }),
    payload: item.payload,
  };
}

export function isDelivery(value: Delivery | DeliveryResult): value is Delivery {
  return "platform" in value;
}

export function parseAllowedBundleIds(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}
