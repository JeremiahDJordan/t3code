import { assert, describe, it } from "@effect/vitest";
import type { PushGatewayDelivery } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as PushGatewayClient from "./PushGatewayClient.ts";

const delivery: PushGatewayDelivery = {
  platform: "ios",
  token: "apns",
  kind: "alert",
  bundleId: "com.example.z6",
  apsEnvironment: "production",
  priority: 10,
  payload: { aps: { alert: { title: "Thread", body: "Done: Project" } } },
};

const withGateway = (respond: (body: { deliveries: unknown[] }) => Response) => {
  const requests: Array<{ url: string; authorization: string | null; count: number }> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const raw = init?.body;
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array);
      const body = JSON.parse(text) as { deliveries: unknown[] };
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        count: body.deliveries.length,
      });
      return Promise.resolve(respond(body));
    },
    { preconnect: () => {} },
  );
  const client = PushGatewayClient.make({
    url: "https://push.example.test",
    credential: Redacted.make("secret"),
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
  return { client, requests };
};

describe("PushGatewayClient", () => {
  it.effect("posts deliveries with the credential and returns the results in order", () =>
    Effect.gen(function* () {
      const { client, requests } = withGateway(() =>
        Response.json({
          results: [
            { ok: true, status: 200 },
            { ok: false, status: 410, reason: "Unregistered" },
          ],
        }),
      );
      const results = yield* (yield* client).send([delivery, delivery]);
      assert.deepStrictEqual(results, [
        { ok: true, status: 200 },
        { ok: false, status: 410, reason: "Unregistered" },
      ]);
      assert.deepStrictEqual(requests, [
        {
          url: "https://push.example.test/v1/deliveries",
          authorization: "Bearer secret",
          count: 2,
        },
      ]);
    }),
  );

  it.effect("splits large batches to the gateway's limit", () =>
    Effect.gen(function* () {
      const { client, requests } = withGateway((body) =>
        Response.json({ results: body.deliveries.map(() => ({ ok: true, status: 200 })) }),
      );
      const results = yield* (yield* client).send(Array.from({ length: 150 }, () => delivery));
      assert.lengthOf(results, 150);
      assert.deepStrictEqual(
        requests.map((request) => request.count),
        [100, 50],
      );
    }),
  );

  it.effect("fails on a refused request or a short answer", () =>
    Effect.gen(function* () {
      const refused = withGateway(() => new Response("bad credential", { status: 401 }));
      const unauthorized = yield* (yield* refused.client).send([delivery]).pipe(Effect.flip);
      assert.strictEqual(unauthorized.status, 401);
      const short = withGateway(() => Response.json({ results: [] }));
      const mismatch = yield* (yield* short.client).send([delivery]).pipe(Effect.flip);
      assert.include(mismatch.detail, "expected 1 results");
    }),
  );
});
