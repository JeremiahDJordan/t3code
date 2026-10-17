import { describe, expect, it } from "vite-plus/test";

import { sha256Hex } from "./auth.ts";
import { apnsTestKey, fcmTestKey } from "./testKeys.ts";
import { type Env, handle } from "./worker.ts";

const SECRET = "z6pg_secret";
const apnsToken = "cd".repeat(32);
let accounts = 0;

async function setup(overrides: { readonly [K in keyof Env]?: Env[K] | undefined } = {}) {
  const [apns, fcm] = await Promise.all([apnsTestKey(), fcmTestKey()]);
  const configured: Record<string, unknown> = {
    PUSH_GATEWAY_CREDENTIALS: JSON.stringify([{ id: "laptop", sha256: await sha256Hex(SECRET) }]),
    ALLOWED_BUNDLE_IDS: "com.example.z6",
    APNS_TEAM_ID: "TEAM",
    APNS_KEY_ID: "KEY",
    APNS_PRIVATE_KEY: apns.privateKey,
    FCM_SERVICE_ACCOUNT: JSON.stringify({
      project_id: "project",
      // Each test gets its own cached access token.
      client_email: `push-${(accounts += 1)}@project.iam.gserviceaccount.com`,
      private_key: fcm.privateKey,
    }),
    ...overrides,
  };
  const env = Object.fromEntries(
    Object.entries(configured).filter(([, value]) => value !== undefined),
  ) as Env;
  const outbound: Array<Request> = [];
  const answers = new Map<string, () => Response>();
  const deps = {
    nowSeconds: () => 1_800_000_000,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      outbound.push(request);
      const host = new URL(request.url).host;
      const answer = answers.get(host);
      if (answer) return Promise.resolve(answer());
      if (host === "oauth2.googleapis.com")
        return Promise.resolve(Response.json({ access_token: "access", expires_in: 3600 }));
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch,
  };
  const post = (body: unknown, authorization = `Bearer ${SECRET}`) =>
    handle(
      new Request("https://push.example.test/v1/deliveries", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      deps,
    );
  return { env, deps, outbound, answers, post };
}

const iosAlert = {
  platform: "ios",
  token: apnsToken,
  kind: "alert",
  bundleId: "com.example.z6",
  priority: 10,
  payload: { aps: { alert: { title: "Thread", body: "Done: Project" } } },
};
const androidCard = {
  platform: "android",
  token: "fcm-token",
  kind: "liveactivity",
  bundleId: "com.example.z6",
  payload: { data: { t3_kind: "agent_activity" }, android: { priority: "HIGH" } },
};

describe("push gateway", () => {
  it("refuses a request without a known credential and sends nothing", async () => {
    const h = await setup();
    const response = await h.post({ deliveries: [iosAlert] }, "Bearer wrong");
    expect(response.status).toBe(401);
    expect(h.outbound).toEqual([]);
  });

  it("forwards each delivery and answers one result per delivery, in order", async () => {
    const h = await setup();
    h.answers.set("api.push.apple.com", () =>
      Response.json({ reason: "Unregistered" }, { status: 410 }),
    );
    const response = await h.post({
      deliveries: [iosAlert, androidCard, { ...iosAlert, bundleId: "com.other.app" }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [
        { ok: false, status: 410, reason: "Unregistered" },
        { ok: true, status: 200 },
        { ok: false, status: 403, reason: "TopicNotAllowed" },
      ],
    });
    const fcmSend = h.outbound.find((request) => request.url.includes("messages:send"));
    expect(await fcmSend?.json()).toMatchObject({
      message: { token: "fcm-token", android: { restricted_package_name: "com.example.z6" } },
    });
    // The disallowed delivery never left the gateway.
    expect(h.outbound.filter((request) => request.url.includes("push.apple.com"))).toHaveLength(1);
  });

  it("answers a platform it has no keys for as unavailable", async () => {
    const h = await setup({ FCM_SERVICE_ACCOUNT: undefined });
    const response = await h.post({ deliveries: [androidCard] });
    expect(await response.json()).toEqual({
      results: [{ ok: false, status: 403, reason: "FcmNotConfigured" }],
    });
  });

  it("applies the per-credential rate limit", async () => {
    const keys: string[] = [];
    const h = await setup({
      RATE_LIMITER: {
        limit: ({ key }) => {
          keys.push(key);
          return Promise.resolve({ success: false });
        },
      },
    });
    const response = await h.post({ deliveries: [iosAlert] });
    expect(response.status).toBe(429);
    expect(keys).toEqual(["laptop"]);
  });

  it("serves only the deliveries route and a health check", async () => {
    const h = await setup();
    const health = await handle(new Request("https://push.example.test/health"), h.env, h.deps);
    expect(await health.text()).toBe("ok");
    const other = await handle(new Request("https://push.example.test/"), h.env, h.deps);
    expect(other.status).toBe(404);
  });
});
