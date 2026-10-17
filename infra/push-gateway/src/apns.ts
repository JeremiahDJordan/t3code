import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";

import { base64Url, base64UrlDecode, pemBody } from "./encoding.ts";
import type { Delivery, DeliveryResult } from "./protocol.ts";

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  /** The `.p8` key's PEM text. */
  readonly privateKey: string;
}

// APNs rejects a provider token refreshed more than about once per 20 minutes
// (429 TooManyProviderTokenUpdates) and expires it after 60, so each token is reused for a
// 45-minute window. Signing is deterministic (RFC 6979), so every isolate derives the same token
// for a window without shared storage, as T3 Connect's relay does (infra/relay apnsJwt.ts).
export const APNS_JWT_REUSE_SECONDS = 45 * 60;

export function quantizedIssuedAt(nowSeconds: number): number {
  return Math.floor(nowSeconds / APNS_JWT_REUSE_SECONDS) * APNS_JWT_REUSE_SECONDS;
}

const scalarCache = new Map<string, Uint8Array>();
const tokenCache = new Map<string, { readonly issuedAt: number; readonly jwt: string }>();

async function signingScalar(privateKeyPem: string): Promise<Uint8Array> {
  const cached = scalarCache.get(privateKeyPem);
  if (cached) return cached;
  // WebCrypto only converts the PKCS#8 key to its raw scalar; noble signs deterministically.
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBody(privateKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (typeof jwk.d !== "string") throw new Error("The APNs key is not a P-256 private key.");
  const scalar = base64UrlDecode(jwk.d);
  scalarCache.set(privateKeyPem, scalar);
  return scalar;
}

export async function makeApnsJwt(credentials: ApnsCredentials, issuedAt: number): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64Url(
    encoder.encode(JSON.stringify({ alg: "ES256", kid: credentials.keyId })),
  );
  const claims = base64Url(
    encoder.encode(JSON.stringify({ iss: credentials.teamId, iat: issuedAt })),
  );
  const signingInput = `${header}.${claims}`;
  const signature = p256
    .sign(sha256(encoder.encode(signingInput)), await signingScalar(credentials.privateKey), {
      prehash: false,
    })
    .toCompactRawBytes();
  return `${signingInput}.${base64Url(signature)}`;
}

export async function providerToken(credentials: ApnsCredentials, nowSeconds: number) {
  const issuedAt = quantizedIssuedAt(nowSeconds);
  const key = `${credentials.teamId}:${credentials.keyId}`;
  const cached = tokenCache.get(key);
  if (cached?.issuedAt === issuedAt) return cached.jwt;
  const jwt = await makeApnsJwt(credentials, issuedAt);
  tokenCache.set(key, { issuedAt, jwt });
  return jwt;
}

export function apnsRequest(delivery: Delivery, jwt: string): Request {
  const host =
    delivery.apsEnvironment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const liveActivity = delivery.kind === "liveactivity";
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-push-type": liveActivity ? "liveactivity" : "alert",
    "apns-topic": liveActivity ? `${delivery.bundleId}.push-type.liveactivity` : delivery.bundleId,
    "apns-priority": String(delivery.priority ?? 10),
    "content-type": "application/json",
  };
  if (delivery.collapseId !== undefined) headers["apns-collapse-id"] = delivery.collapseId;
  if (delivery.expiration !== undefined) headers["apns-expiration"] = String(delivery.expiration);
  return new Request(`https://${host}/3/device/${delivery.token}`, {
    method: "POST",
    headers,
    body: JSON.stringify(delivery.payload),
  });
}

export async function apnsResult(response: Response): Promise<DeliveryResult> {
  if (response.ok) return { ok: true, status: response.status };
  const text = await response.text().catch(() => "");
  let reason: string | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "reason" in parsed) {
      reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
    }
  } catch {
    reason = text.trim().slice(0, 100) || undefined;
  }
  return { ok: false, status: response.status, ...(reason === undefined ? {} : { reason }) };
}
