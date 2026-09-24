import type {
  BobAuthMethod,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  BOB_API_KEY_REQUIRED_MESSAGE,
  bobHomeDirectory,
  readBobApiKey,
} from "../acp/BobAcpSupport.ts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const BOB_DEFAULT_GATEWAY_URL = "https://api.us-east.bob.ibm.com";
/** Bob treats a token as expired a minute early and renews it before use. */
const BOB_TOKEN_EXPIRY_SKEW_SECONDS = 60;
export const BOB_SSO_REFRESH_MESSAGE = "Run `bob` to refresh your IBM sign-in.";

/**
 * Bob's gateway, normalized as Bob normalizes it, since the gateway names the
 * storage key of the SSO login. Bob's `gatewayUrl` user setting is not read.
 */
export function resolveBobGatewayUrl(environment: NodeJS.ProcessEnv): string {
  return (environment.BOB_GATEWAY_URL?.trim() || BOB_DEFAULT_GATEWAY_URL)
    .replace(/\/+/g, "/")
    .replace(/:\//g, "://")
    .replace(/\/+$/, "");
}

// `auth-secrets.json` maps storage keys to strings; the login is itself a JSON string.
const BobAuthSecrets = Schema.Record(Schema.String, Schema.Unknown);
const decodeAuthSecrets = Schema.decodeEffect(Schema.fromJsonString(BobAuthSecrets));
const BobStoredLogin = Schema.Struct({
  token: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  /** Unix seconds, from the token's `exp` claim. */
  expiresAt: Schema.Finite,
});
const decodeStoredLogin = Schema.decodeUnknownOption(Schema.fromJsonString(BobStoredLogin));

export interface BobSsoLogin {
  readonly token: string;
  readonly expiresAt: number;
  /** Bob can renew an expired login itself. SAML logins have no refresh token. */
  readonly refreshable: boolean;
  /** The `<instance>:<team>` profile last picked in Bob, if any. */
  readonly activeProfileId: string | undefined;
}

/**
 * Reads the IBM SSO login Bob stored after signing in. Undefined when there is
 * none for this gateway. T3 only reads the file: refreshing would race Bob and
 * rotate its refresh token.
 */
export const readBobSsoLogin = Effect.fn("readBobSsoLogin")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fs
    .readFileString(path.join(bobHomeDirectory(environment, path), "settings", "auth-secrets.json"))
    .pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
      }),
    );
  const secrets = yield* decodeAuthSecrets(contents);
  const stored = secrets[`bob.auth.tokens-${resolveBobGatewayUrl(environment)}`];
  const login = typeof stored === "string" ? decodeStoredLogin(stored) : Option.none();
  if (Option.isNone(login) || !login.value.token) return undefined;
  const activeProfileId = secrets["bob.profile.active"];
  return {
    token: login.value.token,
    expiresAt: login.value.expiresAt,
    refreshable: Boolean(login.value.refreshToken),
    activeProfileId:
      typeof activeProfileId === "string" && activeProfileId ? activeProfileId : undefined,
  } satisfies BobSsoLogin;
});

export function isBobSsoLoginExpired(login: BobSsoLogin, nowMs: number): boolean {
  return nowMs / 1000 >= login.expiresAt - BOB_TOKEN_EXPIRY_SKEW_SECONDS;
}

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const BobProfile = Schema.Struct({
  instances: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          instance_id: OptionalString,
          plan_id: OptionalString,
          plan_name: OptionalString,
          teams: Schema.optional(
            Schema.NullOr(
              Schema.Array(
                Schema.Struct({
                  id: OptionalString,
                  /** Bobcoins spent this month. */
                  usage: Schema.optional(Schema.NullOr(Schema.Finite)),
                  /** Monthly Bobcoin allowance; null is unlimited. */
                  budget_limit: Schema.optional(Schema.NullOr(Schema.Finite)),
                }),
              ),
            ),
          ),
        }),
      ),
    ),
  ),
});

export interface BobUsage {
  readonly usageLimits: ServerProviderUsageLimits;
  /** The plan as Bob names it, such as `trial plan`. */
  readonly plan?: string;
}

/**
 * Maps `/admin/v1/profile` to the monthly Bobcoin window of the profile Bob
 * uses: the one last picked in Bob, else the first team of the first instance.
 */
export function bobProfileToUsage(
  profile: typeof BobProfile.Type,
  activeProfileId: string | undefined,
  checkedAt: string,
): BobUsage {
  const profiles = (profile.instances ?? []).flatMap((instance) =>
    (instance.teams ?? []).map((team) => ({
      id: `${instance.instance_id?.trim() || "default"}:${team.id?.trim() || "default"}`,
      instance,
      team,
    })),
  );
  const selected = profiles.find((entry) => entry.id === activeProfileId) ?? profiles[0];
  if (!selected) {
    return { usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }) };
  }
  const plan =
    selected.instance.plan_name?.trim() ||
    selected.instance.plan_id?.replace(/^ibm_bob_/, "").trim() ||
    undefined;
  const budget = selected.team.budget_limit;
  const usage = selected.team.usage ?? 0;
  if (budget == null || budget <= 0) {
    return {
      usageLimits: makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "This Bob team has no monthly Bobcoin limit.",
      }),
      ...(plan ? { plan } : {}),
    };
  }
  const window: ServerProviderUsageWindow = {
    id: "monthly",
    kind: "monthly",
    label: "Monthly",
    usedPercent: clampPercent((usage / budget) * 100),
  };
  return {
    usageLimits: makeUsageLimits({ checkedAt, windows: [window] }),
    ...(plan ? { plan } : {}),
  };
}

/**
 * Reads the monthly Bobcoin budget from Bob's gateway with the credential the
 * instance signs in with. An expired SSO token is reported without a request,
 * because only Bob may renew it.
 */
export const readBobUsageLimits = Effect.fn("readBobUsageLimits")(function* (
  authMethod: BobAuthMethod,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<BobUsage, never, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path> {
  const now = yield* DateTime.now;
  const checkedAt = DateTime.formatIso(now);
  return yield* Effect.gen(function* () {
    let authorization: string | undefined;
    let activeProfileId: string | undefined;
    if (authMethod === "apiKey") {
      const apiKey = readBobApiKey(environment);
      authorization = apiKey ? `apikey ${apiKey}` : undefined;
    } else {
      const login = yield* readBobSsoLogin(environment);
      if (login && !isBobSsoLoginExpired(login, DateTime.toEpochMillis(now))) {
        authorization = `Bearer ${login.token}`;
        activeProfileId = login.activeProfileId;
      }
    }
    if (!authorization) {
      return {
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: authMethod === "apiKey" ? BOB_API_KEY_REQUIRED_MESSAGE : BOB_SSO_REFRESH_MESSAGE,
        }),
      } satisfies BobUsage;
    }
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${resolveBobGatewayUrl(environment)}/admin/v1/profile`).pipe(
        HttpClientRequest.setHeader("authorization", authorization),
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(BobProfile)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return bobProfileToUsage(body, activeProfileId, checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => ({
      usageLimits: makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Bob could not read usage limits.",
      }),
    })),
  );
});
