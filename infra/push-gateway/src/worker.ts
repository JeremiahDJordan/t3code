// @effect-diagnostics globalConsole:off globalFetch:off globalDate:off -- A plain Worker without Effect, to stay small.
/**
 * Z6 Code push gateway: a Cloudflare Worker that signs and forwards finished APNs and FCM
 * deliveries for the owner's T3 servers. Servers decide what to send; the gateway holds the
 * Apple and Firebase keys, checks the server's credential and the app's bundle id, and stores
 * nothing. See README.md.
 */
import { type ApnsCredentials, apnsRequest, apnsResult, providerToken } from "./apns.ts";
import { authenticate, parseCredentialEntries } from "./auth.ts";
import {
  accessToken,
  type FcmServiceAccount,
  fcmRequest,
  fcmResult,
  forgetAccessToken,
  parseServiceAccount,
} from "./fcm.ts";
import {
  type Delivery,
  type DeliveryResult,
  isDelivery,
  MAX_BODY_BYTES,
  parseAllowedBundleIds,
  parseDeliveries,
} from "./protocol.ts";

export interface Env {
  /** JSON array of `{ "id", "sha256" }`, one per server credential. */
  readonly PUSH_GATEWAY_CREDENTIALS?: string;
  /** Comma-separated iOS bundle ids and Android package names this gateway may push to. */
  readonly ALLOWED_BUNDLE_IDS?: string;
  readonly APNS_TEAM_ID?: string;
  readonly APNS_KEY_ID?: string;
  readonly APNS_PRIVATE_KEY?: string;
  /** The Firebase service account's JSON key file. */
  readonly FCM_SERVICE_ACCOUNT?: string;
  /** Optional Workers rate-limit binding, keyed by credential id. */
  readonly RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

export interface Dependencies {
  readonly fetch: typeof fetch;
  readonly nowSeconds: () => number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// A platform without keys answers as a refusal, so the server does not retry it.
const unavailable = (reason: string): DeliveryResult => ({ ok: false, status: 403, reason });

// Subrequests per Worker invocation are limited, and APNs keeps one connection busy anyway.
const CONCURRENCY = 6;

async function mapLimited<A, B>(
  items: ReadonlyArray<A>,
  run: (item: A) => Promise<B>,
): Promise<Array<B>> {
  const results: Array<B> = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function apnsCredentials(env: Env): ApnsCredentials | null {
  return env.APNS_TEAM_ID && env.APNS_KEY_ID && env.APNS_PRIVATE_KEY
    ? { teamId: env.APNS_TEAM_ID, keyId: env.APNS_KEY_ID, privateKey: env.APNS_PRIVATE_KEY }
    : null;
}

async function sendApns(
  delivery: Delivery,
  credentials: ApnsCredentials | null,
  deps: Dependencies,
): Promise<DeliveryResult> {
  if (credentials === null) return unavailable("ApnsNotConfigured");
  try {
    const jwt = await providerToken(credentials, deps.nowSeconds());
    return await apnsResult(await deps.fetch(apnsRequest(delivery, jwt)));
  } catch (error) {
    console.error("APNs delivery failed", error);
    return { ok: false, status: 0, reason: "ApnsUnreachable" };
  }
}

async function sendFcm(
  delivery: Delivery,
  account: FcmServiceAccount | null,
  deps: Dependencies,
): Promise<DeliveryResult> {
  if (account === null) return unavailable("FcmNotConfigured");
  try {
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken(account, deps.nowSeconds(), deps.fetch);
      const result = await fcmResult(await deps.fetch(fcmRequest(delivery, account, token)));
      // A revoked access token is replaced once; any other answer is the delivery's.
      if (result.status !== 401 || attempt > 0) return result;
      forgetAccessToken(account);
    }
  } catch (error) {
    console.error("FCM delivery failed", error);
    return { ok: false, status: 0, reason: "FcmUnreachable" };
  }
}

export async function handle(request: Request, env: Env, deps: Dependencies): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return new Response("ok");
  if (url.pathname !== "/v1/deliveries") return json({ error: "Not found." }, 404);
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);

  const credentialId = await authenticate(
    request.headers.get("authorization"),
    parseCredentialEntries(env.PUSH_GATEWAY_CREDENTIALS),
  );
  if (credentialId === null) return json({ error: "Unknown credential." }, 401);
  if (env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({ key: credentialId })).success) {
    return json({ error: "Rate limited." }, 429);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) return json({ error: "Body too large." }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "Body too large." }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Body is not JSON." }, 400);
  }

  const parsed = parseDeliveries(body, parseAllowedBundleIds(env.ALLOWED_BUNDLE_IDS));
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const apns = apnsCredentials(env);
  const fcm = parseServiceAccount(env.FCM_SERVICE_ACCOUNT);
  const results = await mapLimited(parsed.deliveries, (item) =>
    !isDelivery(item)
      ? Promise.resolve(item)
      : item.platform === "ios"
        ? sendApns(item, apns, deps)
        : sendFcm(item, fcm, deps),
  );
  return json({ results });
}

export default {
  fetch: (request: Request, env: Env) =>
    handle(request, env, {
      fetch: (input, init) => fetch(input, init),
      nowSeconds: () => Math.floor(Date.now() / 1_000),
    }),
} satisfies ExportedHandler<Env>;
