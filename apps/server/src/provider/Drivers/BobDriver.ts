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
import { BobSettings, ProviderDriverKind } from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeBobAdapterV2 } from "../../orchestration-v2/Adapters/BobAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeBobTextGeneration } from "../../textGeneration/BobTextGeneration.ts";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialBobProviderSnapshot,
  checkBobProviderStatus,
  enrichBobSnapshot,
  makeBobCommandCatalog,
  makeBobUsageLimitsRefresh,
} from "../BobProvider.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
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
import { bobUsageReader } from "./BobUsage.ts";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

const decodeBobSettings = Schema.decodeSync(BobSettings);

const DRIVER_KIND = ProviderDriverKind.make("bob");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type BobDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost
  | ProviderLatestVersions.ProviderLatestVersions
  | ServerConfig
  | ServerSettingsService;

export const BobDriver: ProviderDriver<
  BobSettings,
  BobDriverEnv,
  FileSystem.FileSystem | Path.Path
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Bob",
    supportsMultipleInstances: true,
  },
  configSchema: BobSettings,
  defaultConfig: (): BobSettings => decodeBobSettings({}),
  usage: bobUsageReader,
  /** Builds one Bob instance: its snapshot, its per-workspace command catalog, and its adapter. */
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const selfInvocation = yield* resolveSelfInvocation();
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
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
        Effect.map(stampIdentity),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
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
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
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
      const orchestrationAdapter = yield* makeBobAdapterV2({
        instanceId,
        settings: effectiveConfig,
        environment: processEnv,
        selfInvocation,
        onAvailableCommands,
        onAvailableModes,
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
