import {
  BOB_DEFAULT_MODEL,
  type BobSettings,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderUsageLimits,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { AcpSessionMode } from "../acp/AcpRuntimeModel.ts";
import {
  BOB_API_KEY_ALIAS_ENV,
  BOB_API_KEY_ENV,
  bobSignInMessage,
  bobSpawnEnvironment,
  readBobApiKey,
} from "../acp/BobAcpSupport.ts";
import { type BobUsageProfile, isBobSsoLoginExpired, readBobSsoLogin } from "./bobUsageLimits.ts";
import { createProviderVersionAdvisory, ProviderVersionCache } from "../providerMaintenance.ts";
import {
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

const BOB_PRESENTATION = {
  displayName: "Bob",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  // Read from Bob's task database after each turn.
  reportsContextWindow: true,
} as const;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

// Bob picks its model itself and has no `session/set_model`, so T3 offers one entry for it and
// no custom models, which Bob could not switch to.
const BOB_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: BOB_DEFAULT_MODEL,
    name: "Bob (configured model)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/** Bob's snapshot for a status check result. */
const buildBobSnapshot = (settings: BobSettings, probe: ProviderProbeResult) =>
  Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: BOB_BUILT_IN_MODELS,
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

export const BOB_SSO_UNCONFIRMED_MESSAGE =
  "Couldn't confirm Bob's IBM SSO sign-in. If sessions fail, run `bob` in a terminal to sign in.";

/**
 * Sign-in from the login Bob stored. An expired login still counts when Bob can renew it,
 * which it does when the next session starts. Bob's token file is undocumented, so any
 * other finding leaves sign-in unknown instead of hiding a working Bob; a real sign-in
 * failure is reported by Bob when a session starts.
 */
const readBobSsoAuth = (environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const login = yield* readBobSsoLogin(environment);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    return login && (login.refreshable || !isBobSsoLoginExpired(login, nowMs))
      ? ({ status: "authenticated", type: "sso", label: "IBM SSO" } as const)
      : ({ status: "unknown" } as const);
  });

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
        ? { message: BOB_SSO_UNCONFIRMED_MESSAGE }
        : {}),
  });
});

/** The workspaces whose commands Bob's snapshot keeps, the registry's limit too. */
const MAX_BOB_WORKSPACES = 16;

/** The model option that picks the Bob mode a thread's turns run in. */
export const BOB_MODE_OPTION_ID = "mode";
/** Bob's default mode, and the one T3's Plan toggle uses, which the Mode option leaves out. */
export const BOB_AGENT_MODE_ID = "agent";
export const BOB_PLAN_MODE_ID = "plan";

/**
 * The Mode option for the modes Bob's sessions offered: Agent, Bob's other modes (Ask and any
 * custom modes) but not Plan, which T3's Plan toggle selects. Undefined when there is no choice.
 */
function bobModeDescriptor(
  modes: ReadonlyArray<AcpSessionMode>,
): ProviderOptionDescriptor | undefined {
  const agent = modes.find((mode) => mode.id === BOB_AGENT_MODE_ID);
  const others = modes.filter(
    (mode) => mode.id !== BOB_AGENT_MODE_ID && mode.id !== BOB_PLAN_MODE_ID,
  );
  if (!agent || others.length === 0) return undefined;
  return {
    id: BOB_MODE_OPTION_ID,
    label: "Mode",
    type: "select",
    options: [agent, ...others].flatMap((mode) => {
      const label = mode.name.trim() || mode.id;
      const description = mode.description?.trim();
      return [
        {
          id: mode.id,
          label,
          ...(description ? { description } : {}),
          ...(mode.id === BOB_AGENT_MODE_ID ? { isDefault: true } : {}),
        },
      ];
    }),
    currentValue: BOB_AGENT_MODE_ID,
  };
}

/** Each mode once, in the order the workspaces first offered them. */
function mergeBobModes(
  modesByWorkspace: ReadonlyMap<string, ReadonlyArray<AcpSessionMode>>,
): ReadonlyArray<AcpSessionMode> {
  const merged = new Map<string, AcpSessionMode>();
  for (const modes of modesByWorkspace.values()) {
    for (const mode of modes) if (!merged.has(mode.id)) merged.set(mode.id, mode);
  }
  return [...merged.values()];
}

/** Bob's models with the Mode option, when Bob's sessions offered a choice of modes. */
function withBobModeOption(
  models: ReadonlyArray<ServerProviderModel>,
  modes: ReadonlyArray<AcpSessionMode>,
): ReadonlyArray<ServerProviderModel> {
  const descriptor = bobModeDescriptor(modes);
  if (!descriptor) return models;
  return models.map((model) =>
    model.slug === BOB_DEFAULT_MODEL
      ? { ...model, capabilities: createModelCapabilities({ optionDescriptors: [descriptor] }) }
      : model,
  );
}

/**
 * T3's slash commands for the ones Bob reported. Bob runs a command only when the whole prompt
 * is `/name args`, so a name that cannot be written that way is left out, and so is `/compact`,
 * which Bob does not have.
 */
function bobSlashCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): Array<ServerProviderSlashCommand> {
  const seen = new Set([COMPACT_SLASH_COMMAND.name]);
  return commands.flatMap((command) => {
    const name = command.name.trim();
    if (!name || /[\s/]/.test(name) || seen.has(name)) return [];
    seen.add(name);
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

/**
 * Bob reports its slash commands (the skills its current mode allows, and MCP prompts as
 * `server:command`) and its modes only inside a session, so each workspace keeps what its latest
 * session reported, across health refreshes. Bob does not expand `$skill` mentions, so its skills
 * are offered only as these commands and the snapshot lists no skills. Custom modes can belong to
 * one project, but a model's options are the same everywhere, so the Mode option lists the modes
 * of every workspace kept.
 */
export const makeBobCommandCatalog = Effect.fn("makeBobCommandCatalog")(function* (
  provider: ServerProviderShape,
) {
  const workspaces = yield* SubscriptionRef.make<NonNullable<ServerProvider["workspaceSnapshots"]>>(
    [],
  );
  const modesByWorkspace = yield* SubscriptionRef.make<
    ReadonlyMap<string, ReadonlyArray<AcpSessionMode>>
  >(new Map());
  /**
   * Records a workspace with new commands, or with the ones it has when none are given. Bob
   * re-sends its commands on every mode switch, so a list the workspace already has leaves
   * it untouched instead of pushing an identical snapshot to every client.
   */
  const recordWorkspace = (
    cwd: string,
    slashCommands: ReadonlyArray<ServerProviderSlashCommand> | undefined,
  ) =>
    Effect.flatMap(DateTime.now, (now) =>
      SubscriptionRef.modifySome(workspaces, (entries) => {
        const existing = entries.find((entry) => entry.cwd === cwd);
        if (existing && slashCommands && Equal.equals(existing.slashCommands, slashCommands)) {
          return [existing, Option.none()] as const;
        }
        const entry = {
          cwd,
          checkedAt: DateTime.formatIso(now),
          slashCommands: slashCommands ?? existing?.slashCommands ?? [],
          skills: [],
          ...(existing?.usageLimits ? { usageLimits: existing.usageLimits } : {}),
        };
        return [
          entry,
          Option.some(
            [...entries.filter((other) => other.cwd !== cwd), entry].slice(-MAX_BOB_WORKSPACES),
          ),
        ] as const;
      }),
    );
  const getSnapshot = Effect.all([
    provider.getSnapshot,
    SubscriptionRef.get(workspaces),
    SubscriptionRef.get(modesByWorkspace),
  ]).pipe(
    Effect.map(([snapshot, workspaceSnapshots, modes]) => {
      const withModes = {
        ...snapshot,
        models: withBobModeOption(snapshot.models, mergeBobModes(modes)),
      };
      return workspaceSnapshots.length > 0 ? { ...withModes, workspaceSnapshots } : withModes;
    }),
  );
  return {
    snapshot: {
      ...provider,
      getSnapshot,
      refresh: provider.refresh.pipe(Effect.andThen(getSnapshot)),
      streamChanges: Stream.mergeAll(
        [
          provider.streamChanges.pipe(Stream.map(() => undefined)),
          SubscriptionRef.changes(workspaces).pipe(Stream.map(() => undefined)),
          SubscriptionRef.changes(modesByWorkspace).pipe(Stream.map(() => undefined)),
        ],
        { concurrency: "unbounded" },
      ).pipe(Stream.mapEffect(() => getSnapshot)),
    } satisfies ServerProviderShape,
    /** The snapshot as a workspace sees it, which also starts keeping that workspace. */
    snapshotForCwd: (cwd: string) =>
      Effect.gen(function* () {
        const workspace = yield* recordWorkspace(cwd, undefined);
        return {
          ...(yield* getSnapshot),
          checkedAt: workspace.checkedAt,
          slashCommands: workspace.slashCommands,
          skills: workspace.skills,
        };
      }),
    /** Replaces a workspace's commands with the ones a Bob session there just reported. */
    onAvailableCommands: (commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>, cwd: string) =>
      recordWorkspace(cwd, bobSlashCommands(commands)).pipe(Effect.asVoid),
    /**
     * Sets the limits of the team a workspace pins, or clears them so the instance's apply.
     * Keeps the workspace like a session there would.
     */
    setWorkspaceUsageLimits: (cwd: string, usageLimits: ServerProviderUsageLimits | undefined) =>
      Effect.flatMap(DateTime.now, (now) =>
        SubscriptionRef.modifySome(workspaces, (entries) => {
          const existing = entries.find((entry) => entry.cwd === cwd);
          if (existing ? Equal.equals(existing.usageLimits, usageLimits) : !usageLimits) {
            return [undefined, Option.none()] as const;
          }
          const entry = {
            cwd,
            checkedAt: existing?.checkedAt ?? DateTime.formatIso(now),
            slashCommands: existing?.slashCommands ?? [],
            skills: [],
            ...(usageLimits ? { usageLimits } : {}),
          };
          return [
            undefined,
            Option.some(
              [...entries.filter((other) => other.cwd !== cwd), entry].slice(-MAX_BOB_WORKSPACES),
            ),
          ] as const;
        }),
      ),
    /** Replaces a workspace's modes with the ones a Bob session there just offered. */
    onAvailableModes: (modes: ReadonlyArray<AcpSessionMode>, cwd: string) =>
      SubscriptionRef.modifySome(modesByWorkspace, (current) => {
        if (Equal.equals(current.get(cwd), modes)) return [undefined, Option.none()] as const;
        const next = new Map([...current].filter(([other]) => other !== cwd));
        next.set(cwd, modes);
        return [undefined, Option.some(new Map([...next].slice(-MAX_BOB_WORKSPACES)))] as const;
      }),
  };
});

/**
 * Re-reads Bob's budgets for folders, when a session starts in one and after a turn there
 * spends Bobcoins (`spent`): the instance's monthly bar, and the bar of the team a folder
 * pins. A start in a folder without a pin needs no read. Folders queue, and each read takes
 * every folder queued so far, so turns that end together share one read. A failed read
 * leaves every bar as it was.
 */
export const makeBobUsageLimitsRefresh = Effect.fn("makeBobUsageLimitsRefresh")(function* (input: {
  readonly readProfile: Effect.Effect<BobUsageProfile>;
  readonly readPinnedTeams: (cwd: string) => Effect.Effect<ReadonlyArray<string>>;
  readonly applyUsageLimits: ServerProviderShape["applyUsageLimits"];
  readonly setWorkspaceUsageLimits: (
    cwd: string,
    usageLimits: ServerProviderUsageLimits | undefined,
  ) => Effect.Effect<void>;
}) {
  const lock = yield* Semaphore.make(1);
  const queued = new Map<string, boolean>();
  const readQueued = Effect.gen(function* () {
    // Taken before the first yield, so a folder queued meanwhile waits for the next read.
    const batch = [...queued];
    queued.clear();
    const folders = yield* Effect.forEach(batch, ([cwd, spent]) =>
      input.readPinnedTeams(cwd).pipe(Effect.map((pinnedTeams) => ({ cwd, spent, pinnedTeams }))),
    );
    for (const folder of folders) {
      if (!folder.spent && folder.pinnedTeams.length === 0) {
        yield* input.setWorkspaceUsageLimits(folder.cwd, undefined);
      }
    }
    const needed = folders.filter((folder) => folder.spent || folder.pinnedTeams.length > 0);
    if (needed.length === 0) return;
    const profile = yield* input.readProfile;
    const { checkedAt, windows, unavailable } = profile.usage.usageLimits;
    if (unavailable?.reason === "probeFailed") return;
    if (!unavailable && windows.length > 0) {
      yield* input.applyUsageLimits({ checkedAt, windows });
    }
    for (const folder of needed) {
      yield* input.setWorkspaceUsageLimits(
        folder.cwd,
        profile.pinnedTeamUsage(folder.pinnedTeams)?.usageLimits,
      );
    }
  });
  return (cwd: string, spent: boolean) =>
    Effect.suspend(() => {
      queued.set(cwd, spent || queued.get(cwd) === true);
      return lock.withPermit(readQueued);
    });
});

/**
 * IBM publishes the latest Bob Shell release here, and its installer downloads that release.
 * The `@ibm/bob` npm package is an empty placeholder, so the npm registry cannot say.
 */
const BOB_LATEST_VERSION_URL =
  "https://s3.us-south.cloud-object-storage.appdomain.cloud/bob-shell/bobshell2-version.txt";
const BOB_INSTALL_COMMAND = "curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash";
const BOB_LATEST_VERSION_TIMEOUT = Duration.seconds(4);
const BOB_LATEST_VERSION_CACHE_TTL = Duration.hours(1);

/** The latest Bob Shell release, or null when IBM's version file can't be read in time. */
const fetchBobLatestVersion = HttpClient.get(BOB_LATEST_VERSION_URL).pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.flatMap((response) => response.text),
  Effect.timeoutOption(BOB_LATEST_VERSION_TIMEOUT),
  Effect.map((text) => {
    const version = Option.getOrUndefined(text)?.trim();
    return version && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null;
  }),
  Effect.orElseSucceed(() => null),
);

/** The latest Bob Shell release, cached for an hour alongside the npm version lookups. */
const resolveBobLatestVersion = Effect.gen(function* () {
  const cache = yield* ProviderVersionCache;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const cached = cache.get(BOB_LATEST_VERSION_URL);
  if (cached && cached.expiresAt > now) return cached.version;
  const version = yield* fetchBobLatestVersion;
  cache.set(BOB_LATEST_VERSION_URL, {
    expiresAt: now + Duration.toMillis(BOB_LATEST_VERSION_CACHE_TTL),
    version,
  });
  return version;
});

/**
 * Adds the version notice: the installed Bob and, when update checks are on, whether IBM has
 * released a newer one. Bob updates only through IBM's installer, so the notice offers its
 * command to copy instead of a one-click update.
 */
export const enrichBobSnapshot = Effect.fn("enrichBobSnapshot")(function* (
  snapshot: ServerProvider,
  enableProviderUpdateChecks: boolean,
) {
  const checkForUpdates =
    enableProviderUpdateChecks && snapshot.enabled && snapshot.installed && !!snapshot.version;
  const latestVersion = checkForUpdates ? yield* resolveBobLatestVersion : null;
  const versionAdvisory = createProviderVersionAdvisory({
    driver: snapshot.driver,
    currentVersion: snapshot.version,
    latestVersion,
    checkedAt: checkForUpdates ? DateTime.formatIso(yield* DateTime.now) : snapshot.checkedAt,
  });
  // The installer is a shell script, so a Windows host gets no command to paste.
  const updateCommand = (yield* HostProcessPlatform) === "win32" ? null : BOB_INSTALL_COMMAND;
  return { ...snapshot, versionAdvisory: { ...versionAdvisory, updateCommand } };
});
