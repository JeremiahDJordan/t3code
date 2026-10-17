#!/usr/bin/env node
/**
 * Sets up, inspects and removes the owner's Cloudflare Tunnel + Access route to a Z6 Code
 * server, the steps docs/user/remote-access.md describes for the Cloudflare dashboard.
 *
 *   node scripts/cloudflare-tunnel.ts setup --hostname z6.example.com --email you@example.com
 *   node scripts/cloudflare-tunnel.ts status --hostname z6.example.com
 *   node scripts/cloudflare-tunnel.ts teardown --hostname z6.example.com --yes
 *
 * Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment, so the token
 * never sits in argv or shell history. Create the token at dash.cloudflare.com/profile/api-tokens
 * with these permissions:
 *
 *   Account  Cloudflare Tunnel              Edit
 *   Account  Access: Apps and Policies      Edit
 *   Account  Access: Service Tokens         Edit
 *   Zone     Zone                           Read   (finds the zone that holds the hostname)
 *   Zone     DNS                            Edit   (for the zone that holds the hostname)
 *
 * Every step finds its resource by name (the Access application by hostname) and reuses it,
 * so running setup again changes only what drifted. The service token's secret is returned by
 * Cloudflare only when the token is created or rotated; it is printed then and never stored.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

const API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_SERVER_PORT = 3773;
const DEFAULT_SECURE_CHANNEL_PORT = 3774;

class CloudflareApiError extends Schema.TaggedError<CloudflareApiError>()("CloudflareApiError", {
  method: Schema.String,
  path: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  detail: Schema.String,
}) {
  override get message(): string {
    const status = this.status === undefined ? "" : ` (HTTP ${this.status})`;
    return `Cloudflare ${this.method} ${this.path} failed${status}: ${this.detail}`;
  }
}

class CloudflareSetupError extends Schema.TaggedError<CloudflareSetupError>()(
  "CloudflareSetupError",
  { message: Schema.String },
) {}

export type CloudflareFetch = (url: string, init: RequestInit) => Promise<Response>;
type Method = "GET" | "POST" | "PUT" | "DELETE";

const ResultInfo = Schema.Struct({
  page: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  per_page: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  total_count: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const Envelope = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          code: Schema.optionalKey(Schema.Number),
          message: Schema.String,
        }),
      ),
    ),
  ),
  result: Schema.optionalKey(Schema.Unknown),
  result_info: Schema.optionalKey(Schema.NullOr(ResultInfo)),
});
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
type Envelope = typeof Envelope.Type;

export interface CloudflareApi {
  readonly request: (
    method: Method,
    path: string,
    options?: { readonly query?: Record<string, string>; readonly body?: unknown },
  ) => Effect.Effect<Envelope, CloudflareApiError>;
}

/** The one place that talks to Cloudflare; tests hand it a fake fetch. */
export const makeCloudflareApi = (
  apiToken: Redacted.Redacted<string>,
  fetchImpl: CloudflareFetch = fetch,
): CloudflareApi => ({
  request: (method, path, options = {}) =>
    Effect.gen(function* () {
      const url = new URL(`${API_BASE}${path}`);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        url.searchParams.set(key, value);
      }
      const init: RequestInit = {
        method,
        headers: {
          authorization: `Bearer ${Redacted.value(apiToken)}`,
          "content-type": "application/json",
        },
      };
      if (options.body !== undefined) init.body = encodeJson(options.body);
      const response = yield* Effect.tryPromise({
        try: () => fetchImpl(url.href, init),
        catch: (cause) => new CloudflareApiError({ method, path, detail: String(cause) }),
      });
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          new CloudflareApiError({ method, path, status: response.status, detail: String(cause) }),
      });
      const envelope = decodeEnvelope(text);
      if (Option.isNone(envelope)) {
        return yield* new CloudflareApiError({
          method,
          path,
          status: response.status,
          detail: "the response is not Cloudflare API JSON",
        });
      }
      if (!response.ok || !envelope.value.success) {
        const detail = (envelope.value.errors ?? []).map((error) => error.message).join("; ");
        return yield* new CloudflareApiError({
          method,
          path,
          status: response.status,
          detail: detail || "request refused",
        });
      }
      return envelope.value;
    }),
});

const nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

const Zone = Schema.Struct({ id: Schema.String, name: Schema.String });
const Tunnel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  config_src: nullable(Schema.String),
  status: nullable(Schema.String),
});
const IngressRule = Schema.Struct({ hostname: nullable(Schema.String), service: Schema.String });
const TunnelConfiguration = Schema.Struct({
  config: nullable(Schema.Struct({ ingress: nullable(Schema.Array(IngressRule)) })),
});
const TunnelConnector = Schema.Struct({
  id: Schema.String,
  version: nullable(Schema.String),
  conns: nullable(Schema.Array(Schema.Struct({ colo_name: nullable(Schema.String) }))),
});
const DnsRecord = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  name: Schema.String,
  content: Schema.String,
  proxied: nullable(Schema.Boolean),
});
const AccessPolicy = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  decision: Schema.String,
  include: nullable(Schema.Array(Schema.Unknown)),
});
const AccessApp = Schema.Struct({
  id: Schema.String,
  name: nullable(Schema.String),
  domain: nullable(Schema.String),
  type: nullable(Schema.String),
  policies: nullable(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: nullable(Schema.String),
        decision: nullable(Schema.String),
        precedence: nullable(Schema.Number),
      }),
    ),
  ),
});
const ServiceToken = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  client_id: Schema.String,
  expires_at: nullable(Schema.String),
});
const ServiceTokenWithSecret = Schema.Struct({
  id: Schema.String,
  client_id: Schema.String,
  client_secret: Schema.String,
});

type Zone = typeof Zone.Type;
type Tunnel = typeof Tunnel.Type;
type DnsRecord = typeof DnsRecord.Type;
type AccessPolicy = typeof AccessPolicy.Type;
type AccessApp = typeof AccessApp.Type;
type ServiceToken = typeof ServiceToken.Type;

const decodeResult =
  <S extends Schema.Constraint & { readonly DecodingServices: never }>(schema: S) =>
  (method: Method, path: string, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        (error) =>
          new CloudflareApiError({
            method,
            path,
            detail: `unexpected response: ${error.message}`,
          }),
      ),
    );

const getOne =
  <S extends Schema.Constraint & { readonly DecodingServices: never }>(schema: S) =>
  (api: CloudflareApi, method: Method, path: string, body?: unknown) =>
    api
      .request(method, path, body === undefined ? {} : { body })
      .pipe(Effect.flatMap((envelope) => decodeResult(schema)(method, path, envelope.result)));

const listAll = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
  schema: S,
  api: CloudflareApi,
  path: string,
  query: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const items: Array<S["Type"]> = [];
    for (let page = 1; ; page += 1) {
      const envelope = yield* api.request("GET", path, { query: { ...query, page: `${page}` } });
      const pageItems = yield* decodeResult(Schema.Array(schema))("GET", path, envelope.result);
      items.push(...pageItems);
      const info = envelope.result_info;
      const perPage = info?.per_page ?? 0;
      const total = info?.total_count ?? 0;
      if (pageItems.length === 0 || perPage === 0 || page * perPage >= total) return items;
    }
  });

/** Most specific first, so the longest zone that holds the hostname wins. */
export const zoneCandidates = (hostname: string): ReadonlyArray<string> => {
  const labels = hostname.split(".");
  return labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
};

export const findZone = (api: CloudflareApi, accountId: string, hostname: string) =>
  Effect.gen(function* () {
    for (const candidate of zoneCandidates(hostname)) {
      const zones = yield* listAll(Zone, api, "/zones", {
        name: candidate,
        "account.id": accountId,
      });
      const zone = zones.find((entry) => entry.name.toLowerCase() === candidate);
      if (zone) return zone;
    }
    return yield* new CloudflareSetupError({
      message: `No zone in this Cloudflare account holds ${hostname}. Add the domain to Cloudflare first, or check that the API token can read its zone.`,
    });
  });

export const resolveOriginPort = (options: {
  readonly port: Option.Option<number>;
  readonly secureChannel: boolean;
}) =>
  Option.getOrElse(options.port, () =>
    options.secureChannel ? DEFAULT_SECURE_CHANNEL_PORT : DEFAULT_SERVER_PORT,
  );

export const tunnelIngress = (hostname: string, port: number) => [
  { hostname, service: `http://localhost:${port}` },
  { service: "http_status:404" },
];

export const tunnelTarget = (tunnelId: string) => `${tunnelId}.cfargotunnel.com`;

export const dnsRecordBody = (hostname: string, tunnelId: string) => ({
  type: "CNAME",
  name: hostname,
  content: tunnelTarget(tunnelId),
  proxied: true,
  ttl: 1,
  comment: "Z6 Code tunnel (scripts/cloudflare-tunnel.ts)",
});

export const ownerPolicyBody = (name: string, email: string) => ({
  name,
  decision: "allow",
  include: [{ email: { email } }],
});

// `non_identity` is the dashboard's "Service Auth": no login page, only the token's headers.
export const servicePolicyBody = (name: string, serviceTokenId: string) => ({
  name,
  decision: "non_identity",
  include: [{ service_token: { token_id: serviceTokenId } }],
});

// The whole hostname, not a path: /api, /oauth, /.well-known, /ws, /mcp, /pair and the UI
// all have to sit behind the same Access session.
export const accessAppBody = (
  name: string,
  hostname: string,
  policyIds: ReadonlyArray<string>,
) => ({
  name,
  type: "self_hosted",
  domain: hostname,
  destinations: [{ type: "public", uri: hostname }],
  app_launcher_visible: false,
  policies: policyIds.map((id, index) => ({ id, precedence: index + 1 })),
});

interface Names {
  readonly hostname: string;
  readonly tunnelName: string;
  readonly accessAppName: string;
  readonly ownerPolicyName: string;
  readonly servicePolicyName: string;
  readonly serviceTokenName: string;
}

export const resolveNames = (options: {
  readonly hostname: string;
  readonly tunnelName: Option.Option<string>;
  readonly accessAppName: Option.Option<string>;
  readonly serviceTokenName: Option.Option<string>;
}): Names => {
  const hostname = options.hostname.toLowerCase();
  const accessAppName = Option.getOrElse(options.accessAppName, () => `Z6 Code ${hostname}`);
  return {
    hostname,
    tunnelName: Option.getOrElse(options.tunnelName, () => `z6-${hostname.replaceAll(".", "-")}`),
    accessAppName,
    ownerPolicyName: `${accessAppName} owner`,
    servicePolicyName: `${accessAppName} service token`,
    serviceTokenName: Option.getOrElse(options.serviceTokenName, () => `Z6 Code ${hostname} phone`),
  };
};

interface Context {
  readonly api: CloudflareApi;
  readonly accountId: string;
  readonly names: Names;
  /** Goes to stdout only; it carries the service token secret once. */
  readonly say: (line: string) => Effect.Effect<void>;
}

const accountPath = (context: Context, path: string) => `/accounts/${context.accountId}${path}`;
const sameJson = (left: unknown, right: unknown) => encodeJson(left) === encodeJson(right);

const findTunnel = (context: Context) =>
  listAll(Tunnel, context.api, accountPath(context, "/cfd_tunnel"), {
    name: context.names.tunnelName,
    is_deleted: "false",
  }).pipe(
    Effect.map((tunnels) => tunnels.find((tunnel) => tunnel.name === context.names.tunnelName)),
  );

const findDnsRecords = (context: Context, zone: Zone) =>
  listAll(DnsRecord, context.api, `/zones/${zone.id}/dns_records`, {
    "name.exact": context.names.hostname,
  });

const findPolicy = (context: Context, name: string) =>
  listAll(AccessPolicy, context.api, accountPath(context, "/access/policies")).pipe(
    Effect.map((policies) => policies.find((policy) => policy.name === name)),
  );

const findApp = (context: Context) =>
  listAll(AccessApp, context.api, accountPath(context, "/access/apps")).pipe(
    Effect.map((apps) =>
      apps.find(
        (app) => app.type === "self_hosted" && app.domain?.toLowerCase() === context.names.hostname,
      ),
    ),
  );

const findServiceToken = (context: Context) =>
  listAll(ServiceToken, context.api, accountPath(context, "/access/service_tokens")).pipe(
    Effect.map((tokens) => tokens.find((token) => token.name === context.names.serviceTokenName)),
  );

const ensureTunnel = (context: Context) =>
  Effect.gen(function* () {
    const existing = yield* findTunnel(context);
    if (existing) {
      if (existing.config_src !== "cloudflare") {
        return yield* new CloudflareSetupError({
          message: `Tunnel ${existing.name} is managed by a local cloudflared config file, so its routes can't be set from here. Pass another --tunnel-name.`,
        });
      }
      yield* context.say(`Tunnel ${existing.name}: exists (${existing.id})`);
      return existing;
    }
    const path = accountPath(context, "/cfd_tunnel");
    const created = yield* getOne(Tunnel)(context.api, "POST", path, {
      name: context.names.tunnelName,
      config_src: "cloudflare",
    });
    yield* context.say(`Tunnel ${created.name}: created (${created.id})`);
    return created;
  });

const ensureIngress = (context: Context, tunnel: Tunnel, port: number) =>
  Effect.gen(function* () {
    const path = accountPath(context, `/cfd_tunnel/${tunnel.id}/configurations`);
    const current = yield* getOne(TunnelConfiguration)(context.api, "GET", path);
    const wanted = tunnelIngress(context.names.hostname, port);
    const currentRules = (current.config?.ingress ?? []).map((rule) =>
      rule.hostname
        ? { hostname: rule.hostname, service: rule.service }
        : { service: rule.service },
    );
    if (sameJson(currentRules, wanted)) {
      yield* context.say(`Tunnel route: ${context.names.hostname} -> ${wanted[0]?.service}`);
      return;
    }
    yield* context.api.request("PUT", path, { body: { config: { ingress: wanted } } });
    yield* context.say(`Tunnel route: set ${context.names.hostname} -> ${wanted[0]?.service}`);
  });

const ensureDns = (context: Context, zone: Zone, tunnel: Tunnel) =>
  Effect.gen(function* () {
    const records = yield* findDnsRecords(context, zone);
    const wanted = dnsRecordBody(context.names.hostname, tunnel.id);
    const other = records.find((record) => record.type !== "CNAME");
    if (other) {
      return yield* new CloudflareSetupError({
        message: `${context.names.hostname} already has a ${other.type} record. Remove it in the Cloudflare dashboard, or pick another --hostname.`,
      });
    }
    const existing = records[0];
    if (existing && existing.content === wanted.content && existing.proxied === true) {
      yield* context.say(`DNS: ${context.names.hostname} CNAME ${wanted.content} (proxied)`);
      return;
    }
    if (existing) {
      const path = `/zones/${zone.id}/dns_records/${existing.id}`;
      yield* context.api.request("PUT", path, { body: wanted });
      yield* context.say(
        `DNS: updated ${context.names.hostname} CNAME ${wanted.content} (was ${existing.content})`,
      );
      return;
    }
    yield* context.api.request("POST", `/zones/${zone.id}/dns_records`, { body: wanted });
    yield* context.say(`DNS: created ${context.names.hostname} CNAME ${wanted.content} (proxied)`);
  });

const printSecret = (context: Context, clientId: string, clientSecret: string) =>
  context.say(
    [
      "",
      "  Service token for the phone. Cloudflare shows the secret only now; copy it to the",
      "  phone or a password manager. It is not saved anywhere.",
      "",
      `    Client ID      ${clientId}`,
      `    Client secret  ${clientSecret}`,
      "",
    ].join("\n"),
  );

const ensureServiceToken = (
  context: Context,
  options: { readonly rotate: boolean; readonly duration: string },
) =>
  Effect.gen(function* () {
    const existing = yield* findServiceToken(context);
    const name = context.names.serviceTokenName;
    if (!existing) {
      const path = accountPath(context, "/access/service_tokens");
      const created = yield* getOne(ServiceTokenWithSecret)(context.api, "POST", path, {
        name,
        duration: options.duration,
      });
      yield* context.say(`Service token ${name}: created`);
      yield* printSecret(context, created.client_id, created.client_secret);
      return { id: created.id, clientId: created.client_id, secretShown: true };
    }
    if (options.rotate) {
      const path = accountPath(context, `/access/service_tokens/${existing.id}/rotate`);
      const rotated = yield* getOne(ServiceTokenWithSecret)(context.api, "POST", path, {});
      yield* context.say(`Service token ${name}: rotated; the old secret no longer works`);
      yield* printSecret(context, rotated.client_id, rotated.client_secret);
      return { id: existing.id, clientId: rotated.client_id, secretShown: true };
    }
    const expiry = existing.expires_at ? `, expires ${existing.expires_at}` : "";
    yield* context.say(
      `Service token ${name}: exists${expiry}. Its secret was shown when it was created; pass --rotate-service-token for a new one.`,
    );
    return { id: existing.id, clientId: existing.client_id, secretShown: false };
  });

const ensurePolicy = (
  context: Context,
  body: { readonly name: string; readonly decision: string; readonly include: unknown },
) =>
  Effect.gen(function* () {
    const existing = yield* findPolicy(context, body.name);
    if (
      existing &&
      existing.decision === body.decision &&
      sameJson(existing.include, body.include)
    ) {
      yield* context.say(`Access policy ${body.name}: exists`);
      return existing.id;
    }
    if (existing) {
      const path = accountPath(context, `/access/policies/${existing.id}`);
      yield* context.api.request("PUT", path, { body });
      yield* context.say(`Access policy ${body.name}: updated`);
      return existing.id;
    }
    const path = accountPath(context, "/access/policies");
    const created = yield* getOne(AccessPolicy)(context.api, "POST", path, body);
    yield* context.say(`Access policy ${body.name}: created`);
    return created.id;
  });

const linkedPolicyIds = (app: AccessApp) =>
  [...(app.policies ?? [])]
    .sort((left, right) => (left.precedence ?? 0) - (right.precedence ?? 0))
    .map((policy) => policy.id);

const ensureApp = (context: Context, policyIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const existing = yield* findApp(context);
    const body = accessAppBody(context.names.accessAppName, context.names.hostname, policyIds);
    if (existing && existing.name === body.name && sameJson(linkedPolicyIds(existing), policyIds)) {
      yield* context.say(`Access application ${body.name}: exists`);
      return;
    }
    if (existing) {
      const path = accountPath(context, `/access/apps/${existing.id}`);
      yield* context.api.request("PUT", path, { body });
      yield* context.say(`Access application ${body.name}: updated`);
      return;
    }
    yield* context.api.request("POST", accountPath(context, "/access/apps"), { body });
    yield* context.say(`Access application ${body.name}: created for ${context.names.hostname}`);
  });

export interface SetupOptions {
  readonly email: string;
  readonly port: number;
  readonly secureChannel: boolean;
  readonly rotateServiceToken: boolean;
  readonly serviceTokenDuration: string;
}

const nextSteps = (
  names: Names,
  options: SetupOptions,
  details: {
    readonly tunnelToken: string;
    readonly clientId: string;
    readonly secretShown: boolean;
  },
) => {
  const origin = `https://${names.hostname}`;
  const serve = options.secureChannel
    ? [
        `  2. Start Z6 Code with its encrypted gateway on port ${options.port}:`,
        `       t3 serve --secure-channel-port ${options.port} --secure-channel-origin ${origin}`,
        `     or turn on Settings -> Connections -> End-to-end encrypted tunnel with ${origin}.`,
      ]
    : [`  2. Keep Z6 Code serving on port ${options.port} on this machine.`];
  const pair = options.secureChannel
    ? `t3 pair --secure-channel --base-url ${origin}`
    : `t3 pair --base-url ${origin}`;
  const secret = details.secretShown
    ? "the secret printed above"
    : "the secret you saved (or rerun setup with --rotate-service-token)";
  return [
    "",
    "Next steps",
    "  1. Install the connector on this machine. The command carries the tunnel's token,",
    "     which lets anyone run this tunnel; don't share it.",
    `       sudo cloudflared service install ${details.tunnelToken}`,
    ...serve,
    "  3. Create a pairing link:",
    `       ${pair}`,
    '  4. On the phone, add the environment from that link, turn on "Behind Cloudflare Access",',
    "     and enter the service token:",
    `       Client ID      ${details.clientId}`,
    `       Client secret  ${secret}`,
    ...(options.secureChannel
      ? []
      : [`  In a browser, open ${origin} and sign in to Access as ${options.email}.`]),
  ].join("\n");
};

export const runSetup = (context: Context, options: SetupOptions) =>
  Effect.gen(function* () {
    const zone = yield* findZone(context.api, context.accountId, context.names.hostname);
    yield* context.say(`Zone: ${zone.name}`);
    const tunnel = yield* ensureTunnel(context);
    yield* ensureIngress(context, tunnel, options.port);
    yield* ensureDns(context, zone, tunnel);
    const token = yield* ensureServiceToken(context, {
      rotate: options.rotateServiceToken,
      duration: options.serviceTokenDuration,
    });
    const ownerPolicyId = yield* ensurePolicy(
      context,
      ownerPolicyBody(context.names.ownerPolicyName, options.email),
    );
    const servicePolicyId = yield* ensurePolicy(
      context,
      servicePolicyBody(context.names.servicePolicyName, token.id),
    );
    yield* ensureApp(context, [ownerPolicyId, servicePolicyId]);
    const tunnelToken = yield* getOne(Schema.String)(
      context.api,
      "GET",
      accountPath(context, `/cfd_tunnel/${tunnel.id}/token`),
    );
    yield* context.say(
      nextSteps(context.names, options, {
        tunnelToken,
        clientId: token.clientId,
        secretShown: token.secretShown,
      }),
    );
  });

export const runStatus = (context: Context) =>
  Effect.gen(function* () {
    const { hostname } = context.names;
    const zone = yield* findZone(context.api, context.accountId, hostname);
    yield* context.say(`Zone: ${zone.name}`);
    const tunnel = yield* findTunnel(context);
    if (tunnel) {
      yield* context.say(
        `Tunnel ${tunnel.name}: ${tunnel.status ?? "unknown"} (${tunnel.id}, managed by ${tunnel.config_src ?? "unknown"})`,
      );
      const connectors = yield* getOne(Schema.Array(TunnelConnector))(
        context.api,
        "GET",
        accountPath(context, `/cfd_tunnel/${tunnel.id}/connections`),
      );
      for (const connector of connectors) {
        const colos = (connector.conns ?? []).map((conn) => conn.colo_name ?? "?").join(", ");
        yield* context.say(
          `  connector ${connector.id} (cloudflared ${connector.version ?? "?"}): ${colos || "no connections"}`,
        );
      }
      if (connectors.length === 0) yield* context.say("  no connector is running");
      const configuration = yield* getOne(TunnelConfiguration)(
        context.api,
        "GET",
        accountPath(context, `/cfd_tunnel/${tunnel.id}/configurations`),
      );
      for (const rule of configuration.config?.ingress ?? []) {
        yield* context.say(`  route ${rule.hostname ?? "*"} -> ${rule.service}`);
      }
    } else {
      yield* context.say(`Tunnel ${context.names.tunnelName}: missing`);
    }
    const records = yield* findDnsRecords(context, zone);
    if (records.length === 0) yield* context.say(`DNS: no record for ${hostname}`);
    for (const record of records) {
      const proxied = record.proxied ? "proxied" : "not proxied";
      const points =
        tunnel && record.content === tunnelTarget(tunnel.id) ? ", points at the tunnel" : "";
      yield* context.say(
        `DNS: ${record.name} ${record.type} ${record.content} (${proxied}${points})`,
      );
    }
    const app = yield* findApp(context);
    if (app) {
      yield* context.say(`Access application ${app.name ?? app.id}: protects ${hostname}`);
      for (const policy of app.policies ?? []) {
        yield* context.say(`  policy ${policy.name ?? policy.id} (${policy.decision ?? "?"})`);
      }
    } else {
      yield* context.say(`Access application for ${hostname}: missing`);
    }
    const token = yield* findServiceToken(context);
    yield* context.say(
      token
        ? `Service token ${token.name}: client ID ${token.client_id}, expires ${token.expires_at ?? "never"}`
        : `Service token ${context.names.serviceTokenName}: missing`,
    );
  });

interface Removal {
  readonly label: string;
  readonly method: "DELETE";
  readonly path: string;
}

const planTeardown = (context: Context) =>
  Effect.gen(function* () {
    const removals: Array<Removal> = [];
    const remove = (label: string, path: string) =>
      removals.push({ label, method: "DELETE", path });
    const app = yield* findApp(context);
    if (app) {
      remove(
        `Access application ${app.name ?? app.id}`,
        accountPath(context, `/access/apps/${app.id}`),
      );
    }
    for (const name of [context.names.ownerPolicyName, context.names.servicePolicyName]) {
      const policy = yield* findPolicy(context, name);
      if (policy)
        remove(`Access policy ${name}`, accountPath(context, `/access/policies/${policy.id}`));
    }
    const token = yield* findServiceToken(context);
    if (token) {
      remove(
        `Service token ${token.name}`,
        accountPath(context, `/access/service_tokens/${token.id}`),
      );
    }
    const zone = yield* findZone(context.api, context.accountId, context.names.hostname);
    const tunnel = yield* findTunnel(context);
    // Only a record that routes to a tunnel; anything else at the hostname isn't ours.
    for (const record of yield* findDnsRecords(context, zone)) {
      const ours = tunnel
        ? record.content === tunnelTarget(tunnel.id)
        : record.content.endsWith(".cfargotunnel.com");
      if (record.type === "CNAME" && ours) {
        remove(
          `DNS record ${record.name} CNAME ${record.content}`,
          `/zones/${zone.id}/dns_records/${record.id}`,
        );
      }
    }
    if (tunnel) remove(`Tunnel ${tunnel.name}`, accountPath(context, `/cfd_tunnel/${tunnel.id}`));
    return removals;
  });

export const runTeardown = (context: Context, options: { readonly yes: boolean }) =>
  Effect.gen(function* () {
    const removals = yield* planTeardown(context);
    if (removals.length === 0) {
      yield* context.say(`Nothing to remove for ${context.names.hostname}.`);
      return;
    }
    if (!options.yes) {
      yield* context.say("Would delete:");
      for (const removal of removals) yield* context.say(`  ${removal.label}`);
      yield* context.say("Run again with --yes to delete them.");
      return;
    }
    for (const removal of removals) {
      yield* context.api.request(removal.method, removal.path).pipe(
        Effect.mapError((error) =>
          error.detail.includes("active connections")
            ? new CloudflareSetupError({
                message: `${removal.label} still has a running connector. Stop it with \`sudo cloudflared service uninstall\`, then run teardown again.`,
              })
            : error,
        ),
      );
      yield* context.say(`Deleted ${removal.label}`);
    }
  });

const HostnameSchema = Schema.String.check(
  Schema.isPattern(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i),
);

const nameFlags = {
  hostname: Flag.String("hostname").pipe(
    Flag.withSchema(HostnameSchema),
    Flag.withDescription("Public hostname for the server, such as z6.example.com (no https://)."),
  ),
  tunnelName: Flag.String("tunnel-name").pipe(
    Flag.withDescription("Tunnel name. Defaults to z6-<hostname with dashes>."),
    Flag.optional,
  ),
  accessAppName: Flag.String("access-app-name").pipe(
    Flag.withDescription("Access application name. Defaults to Z6 Code <hostname>."),
    Flag.optional,
  ),
  serviceTokenName: Flag.String("service-token-name").pipe(
    Flag.withDescription("Service token name. Defaults to Z6 Code <hostname> phone."),
    Flag.optional,
  ),
};

const makeContext = (flags: Parameters<typeof resolveNames>[0]) =>
  Effect.gen(function* () {
    const apiToken = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
    return {
      api: makeCloudflareApi(apiToken),
      accountId,
      names: resolveNames(flags),
      say: (line: string) => Console.log(line),
    } satisfies Context;
  });

const setupCommand = Command.make("setup", {
  ...nameFlags,
  email: Flag.String("email").pipe(
    Flag.withSchema(Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/))),
    Flag.withDescription("Email Access lets in from a browser."),
  ),
  port: Flag.Int("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription(
      "Local port the tunnel sends traffic to. Defaults to 3773, or 3774 with --secure-channel.",
    ),
    Flag.optional,
  ),
  secureChannel: Flag.Boolean("secure-channel").pipe(
    Flag.withDescription(
      "Route the hostname to the end-to-end encrypted gateway instead of the server.",
    ),
    Flag.withDefault(false),
  ),
  rotateServiceToken: Flag.Boolean("rotate-service-token").pipe(
    Flag.withDescription(
      "Issue a new secret for an existing service token; the old one stops working.",
    ),
    Flag.withDefault(false),
  ),
  serviceTokenDuration: Flag.String("service-token-duration").pipe(
    Flag.withDescription("How long a new service token lasts, such as 8760h or forever."),
    Flag.withDefault("8760h"),
  ),
}).pipe(
  Command.withDescription("Create or update the tunnel, DNS record and Access application."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const context = yield* makeContext(flags);
      yield* runSetup(context, {
        email: flags.email,
        port: resolveOriginPort(flags),
        secureChannel: flags.secureChannel,
        rotateServiceToken: flags.rotateServiceToken,
        serviceTokenDuration: flags.serviceTokenDuration,
      });
    }),
  ),
);

const statusCommand = Command.make("status", nameFlags).pipe(
  Command.withDescription("Show the tunnel, DNS record, Access application and service token."),
  Command.withHandler((flags) => makeContext(flags).pipe(Effect.flatMap(runStatus))),
);

const teardownCommand = Command.make("teardown", {
  ...nameFlags,
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Delete; without it, only list what would be deleted."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Delete what setup created for the hostname."),
  Command.withHandler((flags) =>
    makeContext(flags).pipe(Effect.flatMap((context) => runTeardown(context, flags))),
  ),
);

const cloudflareTunnelCommand = Command.make("cloudflare-tunnel").pipe(
  Command.withDescription("Reach a Z6 Code server through your Cloudflare Tunnel behind Access."),
  Command.withSubcommands([setupCommand, statusCommand, teardownCommand]),
);

if (import.meta.main) {
  Command.run(cloudflareTunnelCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
