import {
  BOB_DEFAULT_MODEL,
  type BobSettings,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  BOB_API_KEY_ALIAS_ENV,
  BOB_API_KEY_ENV,
  bobSignInMessage,
  bobSpawnEnvironment,
  readBobApiKey,
} from "../acp/BobAcpSupport.ts";
import { isBobSsoLoginExpired, readBobSsoLogin } from "./bobUsageLimits.ts";
import {
  DEFAULT_TIMEOUT_MS,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const BOB_PRESENTATION = {
  displayName: "Bob",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  // Read from Bob's task database after each turn.
  reportsContextWindow: true,
} as const;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

// Bob picks its model itself and has no `session/set_model`, so T3 offers one entry for it.
const BOB_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: BOB_DEFAULT_MODEL,
    name: "Bob (configured model)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function bobModelsFromSettings(settings: BobSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(BOB_BUILT_IN_MODELS, settings.customModels, EMPTY_CAPABILITIES);
}

const buildBobSnapshot = (settings: BobSettings, probe: ProviderProbeResult) =>
  Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: bobModelsFromSettings(settings),
      probe,
    }),
  );

const DISABLED_PROBE: ProviderProbeResult = {
  installed: false,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  message: "Bob is disabled in T3 Code settings.",
};

export const buildInitialBobProviderSnapshot = (
  settings: BobSettings,
): Effect.Effect<ServerProviderDraft> =>
  buildBobSnapshot(
    settings,
    settings.enabled
      ? {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking Bob Shell availability...",
        }
      : DISABLED_PROBE,
  );

/**
 * Sign-in from the login Bob stored. An expired login still counts when Bob can renew it,
 * which it does when the next session starts.
 */
const readBobSsoAuth = (environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const login = yield* readBobSsoLogin(environment);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    return login && (login.refreshable || !isBobSsoLoginExpired(login, nowMs))
      ? ({ status: "authenticated", type: "sso", label: "IBM SSO" } as const)
      : ({ status: "unauthenticated" } as const);
  }).pipe(Effect.orElseSucceed(() => ({ status: "unknown" }) as const));

/**
 * Runs `bob --version` and reads the sign-in the instance's auth method uses: the SSO login
 * Bob stored, or an API key in the environment. Opening a session would start MCP servers,
 * so license and workspace problems surface when a session starts instead.
 */
export const checkBobProviderStatus = Effect.fn("checkBobProviderStatus")(function* (
  settings: BobSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  if (!settings.enabled) {
    return yield* buildBobSnapshot(settings, DISABLED_PROBE);
  }

  const apiKey = environment[BOB_API_KEY_ENV];
  const aliasApiKey = environment[BOB_API_KEY_ALIAS_ENV];
  // Bob exits before doing anything when both are set to different values. SSO drops both.
  if (settings.authMethod === "apiKey" && apiKey && aliasApiKey && apiKey !== aliasApiKey) {
    return yield* buildBobSnapshot(settings, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `${BOB_API_KEY_ENV} and ${BOB_API_KEY_ALIAS_ENV} are set to different values, so Bob will not start. Unset ${BOB_API_KEY_ALIAS_ENV}.`,
    });
  }

  const command = settings.binaryPath || "bob";
  const spawnEnvironment = bobSpawnEnvironment(settings.authMethod, environment);
  const versionResult = yield* resolveSpawnCommand(command, ["--version"], {
    env: spawnEnvironment,
  }).pipe(
    Effect.flatMap((spawnCommand) =>
      spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: spawnEnvironment,
          shell: spawnCommand.shell,
        }),
      ),
    ),
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return yield* buildBobSnapshot(settings, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Bob Shell (`bob`) is not installed or not on PATH."
        : "Failed to execute Bob Shell health check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return yield* buildBobSnapshot(settings, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Bob Shell is installed but timed out while running `bob --version`.",
    });
  }
  const output = versionResult.success.value;
  // `bob --version` prints the version, then a `commit:` line.
  const version = parseGenericCliVersion(output.stdout.split(/\r?\n/, 1)[0] ?? "");
  if (output.code !== 0) {
    return yield* buildBobSnapshot(settings, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Bob Shell is installed but failed to run.",
    });
  }

  const auth: ServerProviderAuth =
    settings.authMethod === "apiKey"
      ? readBobApiKey(environment)
        ? { status: "authenticated", type: "api_key", label: "Bob API key" }
        : { status: "unauthenticated" }
      : yield* readBobSsoAuth(environment);
  return yield* buildBobSnapshot(settings, {
    installed: true,
    version,
    status: auth.status === "unauthenticated" ? "error" : "ready",
    auth,
    ...(auth.status === "unauthenticated"
      ? { message: bobSignInMessage(settings.authMethod) }
      : auth.status === "unknown"
        ? { message: "Could not read Bob's IBM sign-in. It is checked when a session starts." }
        : {}),
  });
});
