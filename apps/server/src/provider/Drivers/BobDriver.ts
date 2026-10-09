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
  type BobRule,
  type BobRuleScope,
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
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { bobDelegatedTaskEnded } from "../bobDelegatedTask.ts";
import { readBobStartingThread } from "../bobUserMessages.ts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeBobAdapterV2 } from "../../orchestration-v2/Adapters/BobAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/continuationRequests";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeBobTextGeneration } from "../../textGeneration/BobTextGeneration.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ServerActivation } from "../../serverActivation.ts";
import * as TmuxServer from "../../tmux/TmuxServer.ts";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { type BobAutoJudge, makeBobAutoJudgeForSettings } from "../acp/bobAutoJudge.ts";
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
} from "../BobProvider.ts";
import * as ProviderEventLoggers from "../ProviderEventLoggers.ts";
import { readBobSubagentTranscript } from "../bobSubagentTranscript.ts";
import {
  readBobConfiguredModel,
  readBobPinnedTeams,
  readBobUsageLimits,
  readBobUsageProfile,
} from "../bobUsageLimits.ts";
import { bobContextWindow, readBobTaskCosts, resolveBobTaskDatabasePath } from "../bobTaskUsage.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  type ProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

const decodeBobSettings = Schema.decodeSync(BobSettings);
const decodeBobSettingsOption = Schema.decodeUnknownOption(BobSettings);

const DRIVER_KIND = ProviderDriverKind.make("bob");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

/** The Bob instances set to run Bob in tmux: those whose relays are theirs to take back. */
function tmuxBobInstanceIds(settings: ServerSettings): ReadonlySet<string> {
  return new Set(
    Object.entries(settings.providerInstances).flatMap(([instanceId, instance]) =>
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
  | ProviderHost.ProviderHost
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
      const host = yield* ProviderHost.ProviderHost;
      // The server's database, for the user's messages a delegated Bob task works under; without
      // it every call such a task leaves to the reviewer asks.
      const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
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
              return yield* makeBobRelayHost({ tmux, stateDir: host.paths.stateDir });
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

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, host.settings);
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
      const judgePlatform = yield* HostProcessPlatform;
      const makeJudge = () =>
        makeBobAutoJudgeForSettings({
          settings: effectiveConfig,
          environment: processEnv,
          cacheDir: host.paths.providerStatusCacheDir,
          platform: judgePlatform,
          httpClient,
          log: (message) => void runFork(Effect.logWarning(message)),
        });
      // A settings change rebuilds this driver while Bob's open sessions keep its adapter, so the
      // reviewer closes once the driver and every Bob runtime holding it are done, and a runtime
      // such a session starts later gets a new one.
      let currentJudge = makeJudge();
      let judgeHolders = 1;
      const releaseJudge = Effect.suspend(() =>
        --judgeHolders === 0 ? currentJudge.close : Effect.void,
      );
      yield* Scope.addFinalizer(driverScope, releaseJudge);
      const firstJudge = currentJudge.judge;
      const autoJudge: BobAutoJudge | undefined = firstJudge && {
        name: firstJudge.name,
        judge: (input) =>
          Effect.suspend(
            () =>
              currentJudge.judge?.judge(input) ??
              Effect.succeed({ decision: "ask" as const, reason: "no reviewer" }),
          ),
        extract: (text) =>
          Effect.suspend(() => currentJudge.judge?.extract?.(text) ?? Effect.succeed(undefined)),
        warm: Effect.suspend(() => currentJudge.judge?.warm ?? Effect.void),
      };
      // The user's permission rules, shared by every Bob instance and kept apart from this
      // instance's settings, so a rule a card adds neither restarts Bob nor waits for a new thread.
      const savedRules = (settings: {
        bobRules: ReadonlyArray<BobRule>;
        bobRuleScope: BobRuleScope;
      }) => ({
        rules: settings.bobRules,
        scope: settings.bobRuleScope,
      });
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
          const owners: Array<{
            readonly threadId: string;
            readonly providerThreadId: string;
            readonly relayId: string;
            readonly sessionId: string;
          }> = [];
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
            adoptable.set(meta.sessionId, {
              relayId,
              autoApprove: meta.autoApprove === true,
              mode: meta.mode,
            });
            if (meta.threadId !== undefined && meta.providerThreadId !== undefined) {
              owners.push({
                threadId: meta.threadId,
                providerThreadId: meta.providerThreadId,
                relayId,
                sessionId: meta.sessionId,
              });
            }
          }
          yield* Deferred.succeed(scanned, undefined);
          yield* activation ?? Effect.void;
          for (const owner of owners) {
            // A delegated task's answer was taken when recovery ended its row; finishing its
            // prompt would answer no one, beside a Retry doing the same work.
            const ended = Option.isSome(sql)
              ? yield* bobDelegatedTaskEnded(ThreadId.make(owner.threadId)).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql.value),
                )
              : false;
            if (ended) {
              adoptable.delete(owner.sessionId);
              yield* relayHost.kill(owner.relayId);
              continue;
            }
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
        host,
        selfInvocation,
        onAvailableCommands,
        onAvailableModes,
        autoJudge,
        holdAutoJudge: Effect.acquireRelease(
          Effect.sync(() => {
            if (judgeHolders++ === 0) currentJudge = makeJudge();
          }),
          () => releaseJudge,
        ).pipe(Effect.asVoid),
        readStartingThread: (threadId) =>
          Option.match(sql, {
            onNone: () => Effect.succeed(undefined),
            onSome: (client) =>
              readBobStartingThread(threadId).pipe(
                Effect.provideService(SqlClient.SqlClient, client),
              ),
          }),
        rules: {
          get: serverSettings.getSettings.pipe(
            Effect.map(savedRules),
            Effect.orElseSucceed(() => ({ rules: [], scope: "thread" as const })),
          ),
          subscribe: serverSettings.subscribeChanges.pipe(Effect.map(Stream.map(savedRules))),
          // Applied to the saved rules under the settings lock, beside edits from Settings.
          add: (rule, scope) =>
            serverSettings
              .updateSettings({ bobRuleScope: scope, bobRuleChanges: { add: [rule] } })
              .pipe(
                Effect.as(true),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not save a Bob permission rule", cause).pipe(
                    Effect.as(false),
                  ),
                ),
              ),
        },
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
