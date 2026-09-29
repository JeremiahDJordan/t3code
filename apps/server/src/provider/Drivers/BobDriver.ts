/**
 * BobDriver — `ProviderDriver` for IBM Bob Shell (`bob acp`).
 *
 * Bob manages its own model and login. The status check runs `bob --version`,
 * reads the sign-in the instance uses, and then the monthly Bobcoin budget, which
 * is also re-read after each turn that spends Bobcoins. Slash commands, modes and
 * a pinned team's budget come from Bob's sessions, per workspace, and the version
 * notice from the release IBM publishes.
 *
 * @module provider/Drivers/BobDriver
 */
import { BobSettings, ProviderDriverKind, type ServerSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as TmuxServer from "../../tmux/TmuxServer.ts";
import { makeBobRelayHost, sweepBobRelays } from "../acp/BobRelay.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeBobTextGeneration } from "../../textGeneration/BobTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeBobAdapter } from "../Layers/BobAdapter.ts";
import {
  buildInitialBobProviderSnapshot,
  checkBobProviderStatus,
  enrichBobSnapshot,
  makeBobCommandCatalog,
  makeBobUsageLimitsRefresh,
  withBobSessionHostStatus,
} from "../Layers/BobProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import {
  readBobPinnedTeams,
  readBobUsageLimits,
  readBobUsageProfile,
} from "../Layers/bobUsageLimits.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
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

/**
 * The Bob instances set to run Bob in tmux: those whose relays are theirs to take back. The
 * built-in instance takes its settings from `providers.bob` unless `providerInstances` has it.
 */
export function tmuxBobInstanceIds(settings: ServerSettings): ReadonlySet<string> {
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
  | Path.Path
  | ProviderEventLoggers
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
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies BobSettings;
      const textGeneration = yield* makeBobTextGeneration(effectiveConfig, processEnv);

      // An instance that runs Bob in tmux uses T3's private tmux server, as background
      // commands do.
      const relay =
        effectiveConfig.sessionHost === "tmux"
          ? yield* Effect.gen(function* () {
              const config = yield* ServerConfig;
              const tmux = yield* TmuxServer.make.pipe(
                Effect.provideServiceEffect(ProcessRunner.ProcessRunner, ProcessRunner.make()),
              );
              return yield* makeBobRelayHost({ tmux, stateDir: config.stateDir });
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
          relay
            ? relay.available.pipe(
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
      // Relays a T3 left running for an instance since removed, or switched away from tmux.
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig;
        const keeps = tmuxBobInstanceIds(yield* serverSettings.getSettings);
        yield* sweepBobRelays({ stateDir: config.stateDir, keeps: (id) => keeps.has(id) });
      }).pipe(Effect.ignore, Effect.forkIn(driverScope));
      const adapter = yield* makeBobAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        onAvailableCommands,
        onAvailableModes,
        refreshUsageLimits,
        ...(relay ? { relay } : {}),
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
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
