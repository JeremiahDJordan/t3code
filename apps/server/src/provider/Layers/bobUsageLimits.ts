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

/** Collapses repeated slashes, keeping the scheme's, and drops trailing ones, as Bob does. */
function normalizeBobGatewayUrl(url: string): string {
  return url.replace(/\/+/g, "/").replace(/:\//g, "://").replace(/\/+$/, "");
}

// Bob's settings files are JSON objects. `auth-secrets.json` maps storage keys to strings.
const decodeBobSettingsFile = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * A file Bob keeps in `~/.bob/settings`. Undefined when it is missing or not a JSON
 * object: these are Bob's private files, so T3 never fails on their contents.
 */
const readBobSettingsFile = (environment: NodeJS.ProcessEnv, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs
      .readFileString(path.join(bobHomeDirectory(environment, path), "settings", name))
      .pipe(
        Effect.flatMap(decodeBobSettingsFile),
        Effect.orElseSucceed(() => undefined),
      );
  });

/**
 * The gateway Bob uses, resolved as a started Bob resolves it: its `gatewayUrl` user
 * setting as written, which Bob applies over the environment, else `BOB_GATEWAY_URL` or
 * IBM's gateway, normalized. Bob names the SSO login's storage key after this value and
 * normalizes it for requests.
 */
const resolveBobGatewayUrl = Effect.fn("resolveBobGatewayUrl")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const configured = (yield* readBobSettingsFile(environment, "settings.json"))?.gatewayUrl;
  return typeof configured === "string" && configured
    ? configured
    : normalizeBobGatewayUrl(environment.BOB_GATEWAY_URL?.trim() || BOB_DEFAULT_GATEWAY_URL);
});

/**
 * The model pinned by Bob's `session.model` user setting, which Bob reads when a session starts
 * and sends instead of asking its router. Undefined when unset or unreadable.
 */
export const readBobConfiguredModel = Effect.fn("readBobConfiguredModel")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const session = (yield* readBobSettingsFile(environment, "settings.json"))?.session;
  const model =
    typeof session === "object" && session !== null && "model" in session
      ? session.model
      : undefined;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
});

// The login is itself a JSON string in `auth-secrets.json`.
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
 * Reads the IBM SSO login Bob stored after signing in. Undefined when none for this
 * gateway is found in a shape T3 knows. T3 only reads the file: refreshing would race
 * Bob and rotate its refresh token.
 */
export const readBobSsoLogin = Effect.fn("readBobSsoLogin")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const secrets = yield* readBobSettingsFile(environment, "auth-secrets.json");
  if (!secrets) return undefined;
  const stored = secrets[`bob.auth.tokens-${yield* resolveBobGatewayUrl(environment)}`];
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
          /** Pinned teams name the instance by its subscription. */
          subscription_id: OptionalString,
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

type BobProfileInstance = NonNullable<(typeof BobProfile.Type)["instances"]>[number];
type BobProfileTeam = NonNullable<BobProfileInstance["teams"]>[number];

/** Each team in `/admin/v1/profile`, with the ids Bob picks it by. */
function bobProfileTeams(profile: typeof BobProfile.Type) {
  return (profile.instances ?? []).flatMap((instance) =>
    (instance.teams ?? []).map((team) => {
      const teamId = team.id?.trim() || "default";
      const subscriptionId = instance.subscription_id?.trim();
      return {
        /** How Bob names the team it last picked: `<instance>:<team>`. */
        profileId: `${instance.instance_id?.trim() || "default"}:${teamId}`,
        /** How a folder pins the team: `<subscription>:<team>`. */
        pinId: subscriptionId ? `${subscriptionId}:${teamId}` : undefined,
        instance,
        team,
      };
    }),
  );
}

/** The monthly Bobcoin window of one team, and its instance's plan. */
function bobTeamUsage(
  selected: { readonly instance: BobProfileInstance; readonly team: BobProfileTeam } | undefined,
  checkedAt: string,
): BobUsage {
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
 * Maps `/admin/v1/profile` to the monthly Bobcoin window of the profile Bob
 * uses: the one last picked in Bob, else the first team of the first instance.
 */
export function bobProfileToUsage(
  profile: typeof BobProfile.Type,
  activeProfileId: string | undefined,
  checkedAt: string,
): BobUsage {
  const teams = bobProfileTeams(profile);
  return bobTeamUsage(
    teams.find((entry) => entry.profileId === activeProfileId) ?? teams[0],
    checkedAt,
  );
}

/**
 * The monthly Bobcoin window of the first of a folder's pinned teams (`<subscription>:<team>`)
 * the profile lists, which is the team Bob bills work in that folder to. Undefined when the
 * folder pins none of the user's teams.
 */
export function bobPinnedTeamUsage(
  profile: typeof BobProfile.Type,
  pinnedTeams: ReadonlyArray<string>,
  checkedAt: string,
): BobUsage | undefined {
  const teams = bobProfileTeams(profile);
  for (const pinned of pinnedTeams) {
    const team = teams.find((entry) => entry.pinId === pinned);
    if (team) return bobTeamUsage(team, checkedAt);
  }
  return undefined;
}

/** Bob's usage as its gateway reported it, for the default team and any pinned one. */
export interface BobUsageProfile {
  /** The team Bob uses where a folder pins none. */
  readonly usage: BobUsage;
  /** The team a folder's pins select, or undefined to use `usage`. */
  readonly pinnedTeamUsage: (pinnedTeams: ReadonlyArray<string>) => BobUsage | undefined;
}

// A folder's `.bob/settings.json` is a JSON object; only `session.pinnedTeams` is read.
const decodeBobWorkspaceSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      session: Schema.optional(
        Schema.Struct({ pinnedTeams: Schema.optional(Schema.Array(Schema.Unknown)) }),
      ),
    }),
  ),
);

/**
 * The teams a folder pins in its Bob settings (`<folder>/.bob/settings.json`,
 * `session.pinnedTeams`), in Bob's order. Bob IDE writes these; Bob Shell honours them in
 * trusted folders, which T3's folders are. Empty when none are pinned or the file is unreadable.
 */
export const readBobPinnedTeams = Effect.fn("readBobPinnedTeams")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(cwd, ".bob", "settings.json"))
    .pipe(Effect.orElseSucceed(() => undefined));
  const settings = text === undefined ? Option.none() : decodeBobWorkspaceSettings(text);
  if (Option.isNone(settings)) return [];
  return (settings.value.session?.pinnedTeams ?? []).flatMap((team) =>
    typeof team === "string" && team.trim() ? [team.trim()] : [],
  );
});

/**
 * Reads the monthly Bobcoin budgets from Bob's gateway with the credential the
 * instance signs in with. An expired SSO token is reported without a request,
 * because only Bob may renew it.
 */
export const readBobUsageProfile = Effect.fn("readBobUsageProfile")(function* (
  authMethod: BobAuthMethod,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  BobUsageProfile,
  never,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
> {
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
      return withoutPinnedTeams({
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: authMethod === "apiKey" ? BOB_API_KEY_REQUIRED_MESSAGE : BOB_SSO_REFRESH_MESSAGE,
        }),
      });
    }
    const gatewayUrl = normalizeBobGatewayUrl(yield* resolveBobGatewayUrl(environment));
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${gatewayUrl}/admin/v1/profile`).pipe(
        HttpClientRequest.setHeader("authorization", authorization),
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(BobProfile)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return {
      usage: bobProfileToUsage(body, activeProfileId, checkedAt),
      pinnedTeamUsage: (pinnedTeams) => bobPinnedTeamUsage(body, pinnedTeams, checkedAt),
    } satisfies BobUsageProfile;
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      withoutPinnedTeams({
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Bob could not read usage limits.",
        }),
      }),
    ),
  );
});

/** Usage read without a profile, which says nothing about pinned teams. */
function withoutPinnedTeams(usage: BobUsage): BobUsageProfile {
  return { usage, pinnedTeamUsage: () => undefined };
}

/** The monthly Bobcoin budget of the team Bob uses where a folder pins none. */
export const readBobUsageLimits = (
  authMethod: BobAuthMethod,
  environment: NodeJS.ProcessEnv = process.env,
) => readBobUsageProfile(authMethod, environment).pipe(Effect.map((profile) => profile.usage));
