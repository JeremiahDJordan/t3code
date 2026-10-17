import { describe, expect, it } from "vite-plus/test";

import { base64UrlDecode } from "./encoding.ts";
import { fcmMessage, fcmRequest, fcmResult, makeAssertion, parseServiceAccount } from "./fcm.ts";
import type { Delivery } from "./protocol.ts";
import { decodeJwtPart, fcmTestKey } from "./testKeys.ts";

const delivery: Delivery = {
  platform: "android",
  token: "fcm-token",
  kind: "liveactivity",
  bundleId: "com.example.z6",
  payload: {
    data: { t3_kind: "agent_activity", count: 3 },
    android: {
      priority: "HIGH",
      ttl: "300s",
      collapse_key: "t3-agent-activity",
      direct_boot_ok: true,
    },
    notification: { title: "spoof" },
    apns: { headers: {} },
  },
};

describe("FCM", () => {
  it("passes only string data and Android options, and pins the package", () => {
    expect(fcmMessage(delivery)).toEqual({
      message: {
        token: "fcm-token",
        data: { t3_kind: "agent_activity" },
        android: {
          priority: "HIGH",
          ttl: "300s",
          collapse_key: "t3-agent-activity",
          restricted_package_name: "com.example.z6",
        },
      },
    });
    const pinned = fcmMessage({
      ...delivery,
      payload: { data: {}, android: { restricted_package_name: "com.someone.else" } },
    });
    expect(pinned.message.android.restricted_package_name).toBe("com.example.z6");
  });

  it("addresses the service account's project", () => {
    const request = fcmRequest(
      delivery,
      { projectId: "my project", clientEmail: "a@b", privateKey: "" },
      "access",
    );
    expect(request.url).toBe("https://fcm.googleapis.com/v1/projects/my%20project/messages:send");
    expect(request.headers.get("authorization")).toBe("Bearer access");
  });

  it("signs the token-exchange assertion with RS256", async () => {
    const key = await fcmTestKey();
    const account = parseServiceAccount(
      JSON.stringify({
        project_id: "project",
        client_email: "push@project.iam.gserviceaccount.com",
        private_key: key.privateKey,
      }),
    )!;
    const assertion = await makeAssertion(account, 1_000);
    const [header, claims, signature] = assertion.split(".");
    expect(decodeJwtPart(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeJwtPart(claims!)).toEqual({
      iss: "push@project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_000,
      exp: 4_600,
    });
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key.publicKey,
        base64UrlDecode(signature!),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    ).toBe(true);
  });

  it("reports FCM's error code", async () => {
    const response = Response.json(
      {
        error: {
          status: "NOT_FOUND",
          details: [
            {
              "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
              errorCode: "UNREGISTERED",
            },
          ],
        },
      },
      { status: 404 },
    );
    expect(await fcmResult(response)).toEqual({ ok: false, status: 404, reason: "UNREGISTERED" });
    expect(parseServiceAccount("{}")).toBeNull();
  });
});
