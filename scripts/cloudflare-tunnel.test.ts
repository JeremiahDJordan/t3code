import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import {
  accessAppBody,
  type CloudflareFetch,
  dnsRecordBody,
  makeCloudflareApi,
  resolveNames,
  resolveOriginPort,
  runSetup,
  runStatus,
  runTeardown,
  type SetupOptions,
  servicePolicyBody,
  tunnelIngress,
  zoneCandidates,
  findZone,
} from "./cloudflare-tunnel.ts";

const ACCOUNT = "acct";
const HOSTNAME = "z6.example.com";
const API_TOKEN = "api-token-value";
const TUNNEL_TOKEN = "tunnel-token-value";
const CLIENT_SECRET = "client-secret-value";

interface Row {
  id: string;
  [key: string]: unknown;
}

/** An in-memory slice of the Cloudflare API, keyed the way the real endpoints are. */
const makeFakeCloudflare = (seed: { zones?: Array<Row> } = {}) => {
  const state = {
    zones: seed.zones ?? [{ id: "zone-example", name: "example.com" }],
    tunnels: [] as Array<Row>,
    configs: new Map<string, unknown>(),
    dns: [] as Array<Row>,
    policies: [] as Array<Row>,
    apps: [] as Array<Row>,
    tokens: [] as Array<Row>,
  };
  const calls: Array<string> = [];
  let nextId = 1;
  const id = (prefix: string) => `${prefix}-${nextId++}`;
  const ok = (result: unknown, list?: Array<unknown>) =>
    new Response(
      JSON.stringify({
        success: true,
        errors: [],
        result,
        ...(list ? { result_info: { page: 1, per_page: 50, total_count: list.length } } : {}),
      }),
      { status: 200 },
    );
  const list = (rows: Array<unknown>) => ok(rows, rows);
  const fail = (status: number, message: string) =>
    new Response(JSON.stringify({ success: false, errors: [{ code: 1, message }] }), { status });
  const appView = (app: Row) => ({
    ...app,
    policies: (app.policies as Array<{ id: string; precedence: number }>).map((link) => ({
      ...state.policies.find((policy) => policy.id === link.id),
      precedence: link.precedence,
    })),
  });

  const fetch: CloudflareFetch = async (input, init) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Row) : undefined;
    calls.push(`${method} ${path}`);
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${API_TOKEN}`);
    const query = url.searchParams;
    const account = `/accounts/${ACCOUNT}`;
    let match: RegExpMatchArray | null;

    if (method === "GET" && path === "/zones") {
      return list(state.zones.filter((zone) => zone.name === query.get("name")));
    }
    if (path === `${account}/cfd_tunnel`) {
      if (method === "GET") {
        return list(state.tunnels.filter((tunnel) => tunnel.name === query.get("name")));
      }
      const tunnel = { id: id("tunnel"), name: body?.name, config_src: body?.config_src };
      state.tunnels.push(tunnel);
      return ok(tunnel);
    }
    if ((match = path.match(/^\/accounts\/acct\/cfd_tunnel\/([^/]+)(\/[a-z]+)?$/))) {
      const [, tunnelId = "", sub] = match;
      if (sub === "/configurations") {
        if (method === "PUT") state.configs.set(tunnelId, body?.config);
        return ok({ tunnel_id: tunnelId, config: state.configs.get(tunnelId) ?? null });
      }
      if (sub === "/token") return ok(TUNNEL_TOKEN);
      if (sub === "/connections") return ok([]);
      if (method === "DELETE") {
        state.tunnels = state.tunnels.filter((tunnel) => tunnel.id !== tunnelId);
        return ok({ id: tunnelId });
      }
    }
    if ((match = path.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/))) {
      const recordId = match[2];
      if (method === "GET") {
        return list(state.dns.filter((record) => record.name === query.get("name.exact")));
      }
      if (method === "POST") {
        const record = { ...body, id: id("dns") };
        state.dns.push(record);
        return ok(record);
      }
      if (method === "PUT") {
        state.dns = state.dns.map((record) =>
          record.id === recordId ? { ...body, id: recordId } : record,
        );
        return ok({ ...body, id: recordId });
      }
      state.dns = state.dns.filter((record) => record.id !== recordId);
      return ok({ id: recordId });
    }
    for (const [collection, prefix] of [
      ["policies", "policy"],
      ["apps", "app"],
      ["service_tokens", "token"],
    ] as const) {
      const key = collection === "service_tokens" ? "tokens" : collection;
      const base = `${account}/access/${collection}`;
      const view = (row: Row) => (key === "apps" ? appView(row) : row);
      if (path === base && method === "GET") return list(state[key].map(view));
      if (path === base && method === "POST") {
        const row: Row = { ...body, id: id(prefix) };
        if (key === "tokens") {
          row.client_id = `${row.id}.access`;
          row.expires_at = "2027-10-17T00:00:00Z";
          state.tokens.push(row);
          return ok({ ...row, client_secret: CLIENT_SECRET });
        }
        state[key].push(row);
        return ok(view(row));
      }
      if ((match = path.match(new RegExp(`^${base}/([^/]+)(/rotate)?$`)))) {
        const [, rowId, rotate] = match;
        const row = state[key].find((entry) => entry.id === rowId);
        if (!row) return fail(404, "not found");
        if (rotate) return ok({ ...row, client_secret: `${CLIENT_SECRET}-rotated` });
        if (method === "PUT") {
          state[key] = state[key].map((entry) =>
            entry.id === rowId ? { ...body, id: rowId } : entry,
          );
          return ok({ ...body, id: rowId });
        }
        state[key] = state[key].filter((entry) => entry.id !== rowId);
        return ok({ id: rowId });
      }
    }
    return fail(404, `no fake route for ${method} ${path}`);
  };

  const writes = () => calls.filter((call) => !call.startsWith("GET "));
  return { state, calls, writes, fetch };
};

const setupOptions: SetupOptions = {
  email: "owner@example.com",
  port: 3773,
  secureChannel: false,
  rotateServiceToken: false,
  serviceTokenDuration: "8760h",
};

const makeContext = (fake: ReturnType<typeof makeFakeCloudflare>, lines: Array<string>) => ({
  api: makeCloudflareApi(Redacted.make(API_TOKEN), fake.fetch),
  accountId: ACCOUNT,
  names: resolveNames({
    hostname: HOSTNAME,
    tunnelName: Option.none(),
    accessAppName: Option.none(),
    serviceTokenName: Option.none(),
  }),
  say: (line: string) => Effect.sync(() => void lines.push(line)),
});

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("cloudflare-tunnel", () => {
  it("routes the hostname to the server, or to the encrypted gateway with --secure-channel", () => {
    assert.equal(resolveOriginPort({ port: Option.none(), secureChannel: false }), 3773);
    assert.equal(resolveOriginPort({ port: Option.none(), secureChannel: true }), 3774);
    assert.equal(resolveOriginPort({ port: Option.some(4000), secureChannel: true }), 4000);
    assert.deepStrictEqual(tunnelIngress(HOSTNAME, 3774), [
      { hostname: HOSTNAME, service: "http://localhost:3774" },
      { service: "http_status:404" },
    ]);
  });

  it("builds the DNS record and Access payloads Cloudflare expects", () => {
    assert.deepStrictEqual(dnsRecordBody(HOSTNAME, "t-1"), {
      type: "CNAME",
      name: HOSTNAME,
      content: "t-1.cfargotunnel.com",
      proxied: true,
      ttl: 1,
      comment: "Z6 Code tunnel (scripts/cloudflare-tunnel.ts)",
    });
    assert.deepStrictEqual(servicePolicyBody("phone", "tok-1"), {
      name: "phone",
      decision: "non_identity",
      include: [{ service_token: { token_id: "tok-1" } }],
    });
    const app = accessAppBody("Z6", HOSTNAME, ["p-owner", "p-phone"]);
    assert.equal(app.type, "self_hosted");
    assert.equal(app.domain, HOSTNAME);
    assert.deepStrictEqual(app.destinations, [{ type: "public", uri: HOSTNAME }]);
    assert.deepStrictEqual(app.policies, [
      { id: "p-owner", precedence: 1 },
      { id: "p-phone", precedence: 2 },
    ]);
  });

  it.effect("finds the longest zone that holds the hostname", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(zoneCandidates("a.sub.example.com"), [
        "a.sub.example.com",
        "sub.example.com",
        "example.com",
      ]);
      const fake = makeFakeCloudflare({
        zones: [
          { id: "zone-example", name: "example.com" },
          { id: "zone-sub", name: "sub.example.com" },
        ],
      });
      const api = makeCloudflareApi(Redacted.make(API_TOKEN), fake.fetch);
      assert.equal((yield* findZone(api, ACCOUNT, "a.sub.example.com")).id, "zone-sub");
      assert.equal((yield* findZone(api, ACCOUNT, "z6.example.com")).id, "zone-example");
      const missing = yield* Effect.flip(findZone(api, ACCOUNT, "z6.example.org"));
      assert.match(missing.message, /No zone/);
    }),
  );

  it.effect("creates every missing resource, then changes nothing on a second run", () =>
    Effect.gen(function* () {
      const fake = makeFakeCloudflare();
      const first: Array<string> = [];
      yield* runSetup(makeContext(fake, first), setupOptions);
      assert.deepStrictEqual(fake.writes(), [
        `POST /accounts/${ACCOUNT}/cfd_tunnel`,
        `PUT /accounts/${ACCOUNT}/cfd_tunnel/tunnel-1/configurations`,
        "POST /zones/zone-example/dns_records",
        `POST /accounts/${ACCOUNT}/access/service_tokens`,
        `POST /accounts/${ACCOUNT}/access/policies`,
        `POST /accounts/${ACCOUNT}/access/policies`,
        `POST /accounts/${ACCOUNT}/access/apps`,
      ]);
      assert.equal(fake.state.tunnels[0]?.config_src, "cloudflare");
      assert.deepStrictEqual(fake.state.configs.get("tunnel-1"), {
        ingress: tunnelIngress(HOSTNAME, 3773),
      });
      assert.equal(fake.state.dns[0]?.content, "tunnel-1.cfargotunnel.com");
      assert.deepStrictEqual(fake.state.policies[0]?.include, [
        { email: { email: "owner@example.com" } },
      ]);
      assert.deepStrictEqual(fake.state.policies[1]?.include, [
        { service_token: { token_id: "token-3" } },
      ]);
      const output = first.join("\n");
      assert.equal(occurrences(output, CLIENT_SECRET), 1);
      assert.include(output, `sudo cloudflared service install ${TUNNEL_TOKEN}`);
      assert.include(output, `t3 pair --base-url https://${HOSTNAME}`);
      assert.include(output, "token-3.access");

      const callsBefore = fake.calls.length;
      const second: Array<string> = [];
      yield* runSetup(makeContext(fake, second), setupOptions);
      assert.deepStrictEqual(
        fake.calls.slice(callsBefore).filter((call) => !call.startsWith("GET ")),
        [],
      );
      const rerun = second.join("\n");
      assert.notInclude(rerun, CLIENT_SECRET);
      assert.include(rerun, "--rotate-service-token");
    }),
  );

  it.effect("repairs drift and rotates the token only when asked", () =>
    Effect.gen(function* () {
      const fake = makeFakeCloudflare();
      yield* runSetup(makeContext(fake, []), setupOptions);
      fake.state.dns = fake.state.dns.map((record) => ({
        ...record,
        content: "old.cfargotunnel.com",
      }));
      const callsBefore = fake.calls.length;
      const lines: Array<string> = [];
      yield* runSetup(makeContext(fake, lines), {
        ...setupOptions,
        email: "new@example.com",
        rotateServiceToken: true,
      });
      assert.deepStrictEqual(
        fake.calls.slice(callsBefore).filter((call) => !call.startsWith("GET ")),
        [
          "PUT /zones/zone-example/dns_records/dns-2",
          `POST /accounts/${ACCOUNT}/access/service_tokens/token-3/rotate`,
          `PUT /accounts/${ACCOUNT}/access/policies/policy-4`,
        ],
      );
      assert.equal(occurrences(lines.join("\n"), `${CLIENT_SECRET}-rotated`), 1);
    }),
  );

  it.effect("points the tunnel at the gateway and pairs over the encrypted route", () =>
    Effect.gen(function* () {
      const fake = makeFakeCloudflare();
      const lines: Array<string> = [];
      yield* runSetup(makeContext(fake, lines), {
        ...setupOptions,
        port: resolveOriginPort({ port: Option.none(), secureChannel: true }),
        secureChannel: true,
      });
      assert.deepStrictEqual(fake.state.configs.get("tunnel-1"), {
        ingress: tunnelIngress(HOSTNAME, 3774),
      });
      const output = lines.join("\n");
      assert.include(output, `t3 pair --secure-channel --base-url https://${HOSTNAME}`);
      assert.include(
        output,
        `--secure-channel-port 3774 --secure-channel-origin https://${HOSTNAME}`,
      );
    }),
  );

  it.effect("status only reads", () =>
    Effect.gen(function* () {
      const fake = makeFakeCloudflare();
      yield* runSetup(makeContext(fake, []), setupOptions);
      const callsBefore = fake.calls.length;
      const lines: Array<string> = [];
      yield* runStatus(makeContext(fake, lines));
      assert.isTrue(fake.calls.slice(callsBefore).every((call) => call.startsWith("GET ")));
      const output = lines.join("\n");
      assert.include(output, "points at the tunnel");
      assert.include(output, "expires 2027-10-17T00:00:00Z");
      assert.notInclude(output, CLIENT_SECRET);
    }),
  );

  it.effect("teardown lists without --yes and deletes everything setup made with it", () =>
    Effect.gen(function* () {
      const fake = makeFakeCloudflare();
      yield* runSetup(makeContext(fake, []), setupOptions);
      fake.state.dns.push({
        id: "dns-other",
        type: "CNAME",
        name: HOSTNAME,
        content: "elsewhere.example.net",
      });
      const callsBefore = fake.calls.length;
      const preview: Array<string> = [];
      yield* runTeardown(makeContext(fake, preview), { yes: false });
      assert.deepStrictEqual(
        fake.calls.slice(callsBefore).filter((call) => !call.startsWith("GET ")),
        [],
      );
      assert.include(preview.join("\n"), "--yes");

      yield* runTeardown(makeContext(fake, []), { yes: true });
      assert.deepStrictEqual(
        fake.calls.slice(callsBefore).filter((call) => !call.startsWith("GET ")),
        [
          `DELETE /accounts/${ACCOUNT}/access/apps/app-6`,
          `DELETE /accounts/${ACCOUNT}/access/policies/policy-4`,
          `DELETE /accounts/${ACCOUNT}/access/policies/policy-5`,
          `DELETE /accounts/${ACCOUNT}/access/service_tokens/token-3`,
          "DELETE /zones/zone-example/dns_records/dns-2",
          `DELETE /accounts/${ACCOUNT}/cfd_tunnel/tunnel-1`,
        ],
      );
      assert.deepStrictEqual(
        fake.state.dns.map((record) => record.id),
        ["dns-other"],
      );
    }),
  );
});
