import { describe, expect, it } from "vite-plus/test";

import {
  APNS_JWT_REUSE_SECONDS,
  apnsRequest,
  apnsResult,
  makeApnsJwt,
  providerToken,
  quantizedIssuedAt,
} from "./apns.ts";
import { base64UrlDecode } from "./encoding.ts";
import type { Delivery } from "./protocol.ts";
import { apnsTestKey, decodeJwtPart } from "./testKeys.ts";

const token = "ab".repeat(32);
const delivery: Delivery = {
  platform: "ios",
  token,
  kind: "alert",
  bundleId: "com.example.z6",
  priority: 10,
  payload: { aps: { alert: { title: "Thread", body: "Done: Project" } } },
};

describe("APNs provider token", () => {
  it("signs ES256 with the team and key ids, verifiable with the key", async () => {
    const key = await apnsTestKey();
    const jwt = await makeApnsJwt(
      { teamId: "TEAM", keyId: "KEY", privateKey: key.privateKey },
      900,
    );
    const [header, claims, signature] = jwt.split(".");
    expect(decodeJwtPart(header!)).toEqual({ alg: "ES256", kid: "KEY" });
    expect(decodeJwtPart(claims!)).toEqual({ iss: "TEAM", iat: 900 });
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key.publicKey,
      base64UrlDecode(signature!),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(verified).toBe(true);
  });

  it("reuses one token per 45-minute window, identical across isolates", async () => {
    const key = await apnsTestKey();
    const credentials = { teamId: "TEAM", keyId: "WINDOW", privateKey: key.privateKey };
    const start = 10 * APNS_JWT_REUSE_SECONDS;
    expect(quantizedIssuedAt(start + 100)).toBe(start);
    const first = await providerToken(credentials, start + 1);
    expect(await providerToken(credentials, start + APNS_JWT_REUSE_SECONDS - 1)).toBe(first);
    // Deterministic signing: a fresh signer derives the same token for the window.
    expect(await makeApnsJwt(credentials, start)).toBe(first);
    expect(await providerToken(credentials, start + APNS_JWT_REUSE_SECONDS)).not.toBe(first);
  });
});

describe("APNs requests", () => {
  it("sends an alert to the bundle's topic in production by default", async () => {
    const request = apnsRequest(delivery, "jwt");
    expect(request.url).toBe(`https://api.push.apple.com/3/device/${token}`);
    expect(Object.fromEntries(request.headers)).toMatchObject({
      authorization: "bearer jwt",
      "apns-push-type": "alert",
      "apns-topic": "com.example.z6",
      "apns-priority": "10",
    });
    expect(await request.json()).toEqual(delivery.payload);
  });

  it("sends a Live Activity update to the liveactivity topic in sandbox", () => {
    const request = apnsRequest(
      {
        ...delivery,
        kind: "liveactivity",
        apsEnvironment: "sandbox",
        priority: 5,
        collapseId: "card",
        expiration: 1_800_000_000,
      },
      "jwt",
    );
    expect(request.url).toBe(`https://api.sandbox.push.apple.com/3/device/${token}`);
    expect(Object.fromEntries(request.headers)).toMatchObject({
      "apns-push-type": "liveactivity",
      "apns-topic": "com.example.z6.push-type.liveactivity",
      "apns-priority": "5",
      "apns-collapse-id": "card",
      "apns-expiration": "1800000000",
    });
  });

  it("reports APNs' reason for a refusal", async () => {
    expect(await apnsResult(Response.json({ reason: "BadDeviceToken" }, { status: 400 }))).toEqual({
      ok: false,
      status: 400,
      reason: "BadDeviceToken",
    });
    expect(await apnsResult(new Response(null, { status: 200 }))).toEqual({
      ok: true,
      status: 200,
    });
  });
});
