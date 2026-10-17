import { base64Url, pemBody } from "./encoding.ts";
import type { Delivery, DeliveryResult } from "./protocol.ts";

export interface FcmServiceAccount {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: string;
}

export function parseServiceAccount(value: string | undefined): FcmServiceAccount | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "project_id" in parsed &&
      "client_email" in parsed &&
      "private_key" in parsed &&
      typeof parsed.project_id === "string" &&
      typeof parsed.client_email === "string" &&
      typeof parsed.private_key === "string"
    ) {
      return {
        projectId: parsed.project_id,
        clientEmail: parsed.client_email,
        privateKey: parsed.private_key,
      };
    }
  } catch {
    // An unreadable account turns Android off, as an absent one does.
  }
  return null;
}

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The RS256 assertion Google exchanges for an access token, valid for an hour. */
export async function makeAssertion(account: FcmServiceAccount, issuedAt: number) {
  const encoder = new TextEncoder();
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64Url(
    encoder.encode(
      JSON.stringify({
        iss: account.clientEmail,
        scope: FCM_SCOPE,
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBody(account.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
}

// Google's tokens last an hour; refresh ten minutes early.
const ACCESS_TOKEN_REUSE_SECONDS = 50 * 60;
const accessTokens = new Map<string, { readonly token: string; readonly expiresAt: number }>();

export function forgetAccessToken(account: FcmServiceAccount): void {
  accessTokens.delete(account.clientEmail);
}

export async function accessToken(
  account: FcmServiceAccount,
  nowSeconds: number,
  fetcher: typeof fetch,
): Promise<string> {
  const cached = accessTokens.get(account.clientEmail);
  if (cached && cached.expiresAt > nowSeconds) return cached.token;
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await makeAssertion(account, nowSeconds),
    }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status}).`);
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("access_token" in body) ||
    typeof body.access_token !== "string"
  ) {
    throw new Error("Google token exchange returned no access token.");
  }
  accessTokens.set(account.clientEmail, {
    token: body.access_token,
    expiresAt: nowSeconds + ACCESS_TOKEN_REUSE_SECONDS,
  });
  return body.access_token;
}

const ANDROID_FIELDS = ["priority", "ttl", "collapse_key"] as const;

/**
 * The HTTP v1 message. Only `data` and the Android delivery options pass through, and the package
 * is always the delivery's allowed bundle id, so a credential cannot reach other apps or platforms.
 */
export function fcmMessage(delivery: Delivery) {
  const { data, android } = delivery.payload;
  const stringData =
    typeof data === "object" && data !== null
      ? Object.fromEntries(
          Object.entries(data).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  const options =
    typeof android === "object" && android !== null
      ? Object.fromEntries(
          Object.entries(android).filter(
            ([key, value]) =>
              (ANDROID_FIELDS as ReadonlyArray<string>).includes(key) && typeof value === "string",
          ),
        )
      : {};
  return {
    message: {
      token: delivery.token,
      data: stringData,
      android: { ...options, restricted_package_name: delivery.bundleId },
    },
  };
}

export function fcmRequest(delivery: Delivery, account: FcmServiceAccount, token: string) {
  return new Request(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(fcmMessage(delivery)),
    },
  );
}

/** FCM's error code (`UNREGISTERED`, `INVALID_ARGUMENT`, ...) becomes the result's reason. */
export async function fcmResult(response: Response): Promise<DeliveryResult> {
  if (response.ok) return { ok: true, status: response.status };
  let reason: string | undefined;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const error = body.error as { status?: unknown; details?: unknown };
      const details = Array.isArray(error.details) ? error.details : [];
      const code = details
        .map((detail: unknown) =>
          typeof detail === "object" && detail !== null && "errorCode" in detail
            ? detail.errorCode
            : undefined,
        )
        .find((value): value is string => typeof value === "string");
      reason = code ?? (typeof error.status === "string" ? error.status : undefined);
    }
  } catch {
    reason = undefined;
  }
  return { ok: false, status: response.status, ...(reason === undefined ? {} : { reason }) };
}
