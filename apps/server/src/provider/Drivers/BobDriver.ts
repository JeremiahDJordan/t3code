/**
 * BobDriver — `ProviderDriver` for IBM Bob Shell (`bob acp`).
 *
 * Bob manages its own model and login. The status check runs `bob --version`,
 * reads the sign-in the instance uses, and then the monthly Bobcoin budget. Slash
 * commands, modes and a pinned team's budget come from Bob's sessions, per workspace,
 * and the version notice from the release IBM publishes.
 *
 * @module provider/Drivers/BobDriver
 */
import {
  BobSettings,
  ProviderDriverKind,
  ProviderThreadId,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { makeBobAdapterV2 } from "../../orchestration-v2/Adapters/BobAdapterV2.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderContinuationRequests from "../../orchestration-v2/ProviderContinuationRequests.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeBobTextGeneration } from "../../textGeneration/BobTextGeneration.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ServerActivation } from "../../serverActivation.ts";
import * as TmuxServer from "../../tmux/TmuxServer.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { makeBobAutoJudgeForSettings } from "../acp/bobAutoJudge.ts";
import {
  type AdoptableBobRelay,
  bobRelayHasTurn,
  makeBobRelayHost,
  makeBobRelays,
  readBobRelayMeta,
} from "../acp/BobRelay.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialBobProviderSnapshot,
  checkBobProviderStatus,
  enrichBobSnapshot,
  makeBobCommandCatalog,
  makeBobUsageLimitsRefresh,
  withBobSessionHostStatus,
} from "../Layers/BobProvider.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import { readBobSubagentTranscript } from "../Layers/bobSubagentTranscript.ts";
import {
  readBobConfiguredModel,
  readBobPinnedTeams,
  readBobUsageLimits,
  readBobUsageProfile,
} from "../Layers/bobUsageLimits.ts";
import {
  bobContextWindow,
  readBobTaskCosts,
  resolveBobTaskDatabasePath,
} from "../Layers/bobTaskUsage.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  type ProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);
const decodeBobSettingsOption = Schema.decodeUnknownOption(BobSettings);

const DRIVER_KIND = ProviderDriverKind.make("bob");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

/**
 * The Bob instances set to run Bob in tmux: those whose relays are theirs to take back. The
 * built-in instance takes its settings from `providers.bob` unless `providerInstances` has it.
 */
function tmuxBobInstanceIds(settings: ServerSettings): ReadonlySet<string> {
  const instances: Record<string, { readonly driver: string; readonly config?: unknown }> = {
    ...(!Object.hasOwn(settings.providerInstances, DRIVER_KIND)
      ? { [DRIVER_KIND]: { driver: DRIVER_KIND, config: settings.providers.bob } }
      : {}),
    ...settings.providerInstances,
  };
  return new Set(
    Object.entries(instances).flatMap(([instanceId, instance]) =>
      instance.driver === DRIVER_KIND &&
      Option.exists(
        decodeBobSettingsOption(instance.config ?? {}),
        (config) => config.sessionHost === "tmux",
      )
        ? [instanceId]
        : [],
    ),
  );
}

/**
 * The tmux instances whose relays this process already looked through. Only the first build of
 * an instance after T3 starts finds relays a T3 before it left; a rebuild after a settings change
 * would find its own sessions' relays.
 */
const instancesWithScannedRelays = new Set<string>();

export type BobDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const BobDriver: ProviderDriver<BobSettings, BobDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Bob",
    supportsMultipleInstances: true,
  },
  configSchema: BobSettings,
  defaultConfig: (): BobSettings => decodeBobSettings({}),
  /** Builds one Bob instance: its snapshot, its per-workspace command catalog, and its adapter. */
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const selfInvocation = yield* resolveSelfInvocation();
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const processEnv = mergeProviderInstanceEnvironment(environment);
      // Bob keeps its sessions in its task database, and any instance reading the same one can
      // resume them, whatever it signs in with. So a thread moves between such instances, such
      // as from an SSO login to an API key when one account runs out of Bobcoins.
      const taskDatabasePath = resolveBobTaskDatabasePath(processEnv, path);
      const continuationIdentity: ProviderContinuationIdentity = {
        driverKind: DRIVER_KIND,
        continuationKey: `bob:db:${taskDatabasePath}`,
      };
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies BobSettings;
      const textGeneration = yield* makeBobTextGeneration(effectiveConfig, processEnv);
      // An instance that runs Bob in tmux uses T3's private tmux server, as background commands do.
      const relayHost =
        effectiveConfig.sessionHost === "tmux"
          ? yield* Effect.gen(function* () {
              const tmux = yield* TmuxServer.make.pipe(
                Effect.provideServiceEffect(ProcessRunner.ProcessRunner, ProcessRunner.make()),
              );
              return yield* makeBobRelayHost({ tmux, stateDir: serverConfig.stateDir });
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail: `Could not prepare Bob's tmux sessions: ${cause.message}`,
                    cause,
                  }),
              ),
            )
          : undefined;

      const checkProvider = checkBobProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.flatMap((snapshot) =>
          effectiveConfig.enabled && snapshot.installed && snapshot.auth.status === "authenticated"
            ? readBobUsageLimits(effectiveConfig.authMethod, processEnv).pipe(
                Effect.map(({ usageLimits, plan }) => ({
                  ...snapshot,
                  // The plan names the account where other providers name their subscription.
                  ...(plan ? { auth: { ...snapshot.auth, label: plan } } : {}),
                  usageLimits,
                })),
              )
            : Effect.succeed(snapshot),
        ),
        Effect.flatMap((snapshot) =>
          relayHost
            ? relayHost.available.pipe(
                Effect.map((tmuxAvailable) => withBobSessionHostStatus(snapshot, tmuxAvailable)),
              )
            : Effect.succeed(snapshot),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const managedSnapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<BobSettings>
      >({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialBobProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        /** Adds the version notice after each status check. */
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichBobSnapshot(currentSnapshot, settings.enableProviderUpdateChecks).pipe(
            Effect.flatMap(publishSnapshot),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Bob snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const {
        snapshot,
        onAvailableCommands,
        onAvailableModes,
        setWorkspaceUsageLimits,
        snapshotForCwd,
      } = yield* makeBobCommandCatalog(managedSnapshot);
      const refreshUsageLimits = yield* makeBobUsageLimitsRefresh({
        readProfile: readBobUsageProfile(effectiveConfig.authMethod, processEnv).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
        readPinnedTeams: (cwd) =>
          readBobPinnedTeams(cwd).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        applyUsageLimits: snapshot.applyUsageLimits,
        setWorkspaceUsageLimits,
      });
      const driverScope = yield* Effect.scope;
      // In Auto, the model that judges the tool calls the rules leave to what the user asked.
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      const autoJudge = makeBobAutoJudgeForSettings({
        settings: effectiveConfig,
        environment: processEnv,
        cacheDir: serverConfig.providerStatusCacheDir,
        platform: yield* HostProcessPlatform,
        httpClient,
        log: (message) => void runFork(Effect.logWarning(message)),
      });
      yield* Scope.addFinalizer(driverScope, autoJudge.close);
      // Bob's relays from before this start: those no instance runs any more stop, this
      // instance's idle ones stop, and each still running a prompt gets a run to finish it in.
      const adoptable = new Map<string, AdoptableBobRelay>();
      const scanned = yield* Deferred.make<void>();
      if (relayHost === undefined || instancesWithScannedRelays.has(instanceId)) {
        yield* Deferred.succeed(scanned, undefined);
      } else {
        instancesWithScannedRelays.add(instanceId);
        // Startup recovery cancels every run it finds, so the runs that finish Bob's prompts wait
        // until the server is live.
        const activation = yield* ServerActivation;
        yield* Effect.gen(function* () {
          const keeps = tmuxBobInstanceIds(yield* serverSettings.getSettings);
          const owners: Array<{ readonly threadId: string; readonly providerThreadId: string }> =
            [];
          for (const { relayId, state } of yield* relayHost.scan) {
            const meta = readBobRelayMeta(state);
            if (meta === undefined || !keeps.has(meta.instanceId)) {
              yield* relayHost.kill(relayId);
              continue;
            }
            if (meta.instanceId !== instanceId) continue;
            if (!bobRelayHasTurn(state) || meta.sessionId === undefined) {
              yield* relayHost.kill(relayId);
              continue;
            }
            adoptable.set(meta.sessionId, { relayId, autoApprove: meta.autoApprove === true });
            if (meta.threadId !== undefined && meta.providerThreadId !== undefined) {
              owners.push({ threadId: meta.threadId, providerThreadId: meta.providerThreadId });
            }
          }
          yield* Deferred.succeed(scanned, undefined);
          yield* activation ?? Effect.void;
          for (const owner of owners) {
            yield* continuationRequests.offer({
              threadId: ThreadId.make(owner.threadId),
              providerThreadId: ProviderThreadId.make(owner.providerThreadId),
              driver: DRIVER_KIND,
              detail: null,
              notification: {
                source: { kind: "background_task" },
                outcome: "updated",
                summary: "Bob kept working while T3 Code restarted",
              },
            });
          }
        }).pipe(
          Effect.ignore,
          Effect.ensuring(Deferred.succeed(scanned, undefined)),
          Effect.forkIn(driverScope),
        );
      }
      const platform = yield* HostProcessPlatform;
      const orchestrationAdapter = makeBobAdapterV2({
        platform,
        ...(relayHost
          ? {
              relays: makeBobRelays({
                host: relayHost,
                instanceId,
                adoptable,
                ready: Deferred.await(scanned),
              }),
            }
          : {}),
        instanceId,
        settings: effectiveConfig,
        environment: processEnv,
        childProcessSpawner: spawner,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        selfInvocation,
        onAvailableCommands,
        onAvailableModes,
        autoJudge: autoJudge.judge,
        // Bob reads its model setting on every turn, so the window follows it. That window is
        // assumed, so a context larger than it proves it wrong and is reported without one.
        readTaskUsage: (sessionId) =>
          Effect.gen(function* () {
            const costs = yield* readBobTaskCosts(taskDatabasePath, sessionId);
            if (!costs) return undefined;
            const window = bobContextWindow(yield* readBobConfiguredModel(processEnv));
            return {
              used: costs.contextTokens,
              size: window !== undefined && costs.contextTokens <= window ? window : 0,
              bobcoins: costs.cost,
            };
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.orElseSucceed(() => undefined),
          ),
        readSubagentSteps: (parentSessionId, toolCallId) =>
          readBobSubagentTranscript(taskDatabasePath, parentSessionId, toolCallId),
        onBobcoinsSpent: (cwd) =>
          refreshUsageLimits(cwd, true).pipe(Effect.forkIn(driverScope), Effect.asVoid),
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: loggers.native,
            provider: DRIVER_KIND,
            threadId,
          }),
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        /**
         * A workspace sees the commands Bob's latest session there reported. Opening one also
         * reads the budget of a team it pins, so its bar is right before Bob first runs there.
         */
        snapshotForCwd: (cwd) =>
          effectiveConfig.enabled
            ? snapshotForCwd(cwd).pipe(
                Effect.tap(() =>
                  refreshUsageLimits(cwd, false).pipe(Effect.forkIn(driverScope), Effect.asVoid),
                ),
              )
            : snapshot.getSnapshot,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
