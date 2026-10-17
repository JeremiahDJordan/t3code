/**
 * Fork: with T3 Connect off, the phone registers its push identity with each connected server
 * that pushes through the owner's push gateway (the `pushGateway` capability), over that
 * server's own authenticated connection. `remoteRegistration.ts` builds the payload and calls in
 * here instead of the relay; this module only tracks which servers have it.
 */
import type {
  EnvironmentId,
  PushDeviceRegistrationInput,
  PushLiveActivityRegistrationInput,
  ServerConfig,
} from "@t3tools/contracts";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { T3_CONNECT_ENABLED } from "@t3tools/shared/forkFeatures";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";

/** Push goes through the owner's gateway whenever T3 Connect's relay is turned off. */
export function isPushGatewayMode(): boolean {
  return !T3_CONNECT_ENABLED;
}

// A registration repaints this phone's card on the server, so it repeats at most once a minute,
// like the relay's foreground reconciliation.
const REREGISTER_INTERVAL_MS = 60_000;

export interface PushGatewayTransport {
  readonly register: (
    environmentId: EnvironmentId,
    input: PushDeviceRegistrationInput,
  ) => Promise<boolean>;
  readonly registerLiveActivity: (
    environmentId: EnvironmentId,
    input: PushLiveActivityRegistrationInput,
  ) => Promise<boolean>;
  readonly unregister: (environmentId: EnvironmentId, deviceId: string) => Promise<boolean>;
}

// Installed by `startAgentAwarenessPushGateway`, so this module stays free of the connection
// stack and the relay path's tests can import it.
let installedTransport: PushGatewayTransport | null = null;

export function setPushGatewayTransport(transport: PushGatewayTransport | null): void {
  installedTransport = transport;
}

const offline: PushGatewayTransport = {
  register: () => Promise.resolve(false),
  registerLiveActivity: () => Promise.resolve(false),
  unregister: () => Promise.resolve(false),
};

const currentTransport = () => installedTransport ?? offline;

export function pushGatewayEnvironmentIds(
  configs: ReadonlyMap<EnvironmentId, ServerConfig> = appAtomRegistry.get(
    environmentServerConfigsAtom,
  ),
): ReadonlyArray<EnvironmentId> {
  return [...configs]
    .filter(([, config]) => config.environment.capabilities.pushGateway === true)
    .map(([environmentId]) => environmentId);
}

/** The gateway payload for the relay's registration body, or null without an app id. */
export function pushGatewayRegistrationInput(
  body: RelayDeviceRegistrationRequest,
): PushDeviceRegistrationInput | null {
  if (!body.bundleId) return null;
  return {
    deviceId: body.deviceId,
    label: body.label,
    platform: body.platform,
    bundleId: body.bundleId,
    ...(body.platform === "ios" && body.apsEnvironment
      ? { apsEnvironment: body.apsEnvironment }
      : {}),
    ...(body.appVersion ? { appVersion: body.appVersion } : {}),
    ...(body.pushToken ? { pushToken: body.pushToken } : {}),
    preferences: body.preferences,
  };
}

const registrations = new Map<
  EnvironmentId,
  { readonly signature: string; readonly at: number; readonly deviceId: string }
>();

export type PushGatewayRegistrationOutcome = "registered" | "failed" | "none";

export async function registerDeviceWithPushGateways(
  input: PushDeviceRegistrationInput,
  transport: PushGatewayTransport = currentTransport(),
  environmentIds: ReadonlyArray<EnvironmentId> = pushGatewayEnvironmentIds(),
  now: number = Date.now(),
): Promise<PushGatewayRegistrationOutcome> {
  if (environmentIds.length === 0) return "none";
  const signature = JSON.stringify(input);
  const results = await Promise.all(
    environmentIds.map(async (environmentId) => {
      const previous = registrations.get(environmentId);
      if (previous?.signature === signature && now - previous.at < REREGISTER_INTERVAL_MS) {
        return true;
      }
      const registered = await transport.register(environmentId, input);
      if (registered) {
        registrations.set(environmentId, { signature, at: now, deviceId: input.deviceId });
      }
      return registered;
    }),
  );
  return results.some(Boolean) ? "registered" : "failed";
}

/** Registers a Live Activity's update token with every server this phone is registered with. */
export async function registerLiveActivityWithPushGateways(
  input: PushLiveActivityRegistrationInput,
  transport: PushGatewayTransport = currentTransport(),
  environmentIds: ReadonlyArray<EnvironmentId> = pushGatewayEnvironmentIds(),
): Promise<boolean> {
  const results = await Promise.all(
    environmentIds
      .filter((environmentId) => registrations.has(environmentId))
      .map((environmentId) => transport.registerLiveActivity(environmentId, input)),
  );
  return results.some(Boolean);
}

/** Best effort before the phone forgets or disables a server; its session ending also does it. */
export async function unregisterFromPushGateway(
  environmentId: EnvironmentId,
  transport: PushGatewayTransport = currentTransport(),
): Promise<void> {
  const registration = registrations.get(environmentId);
  registrations.delete(environmentId);
  if (registration) await transport.unregister(environmentId, registration.deviceId);
}

/** Calls `onAdded` when a connected server starts offering push through a gateway. */
export function watchPushGatewayEnvironments(onAdded: () => void): () => void {
  let known = new Set(pushGatewayEnvironmentIds());
  return appAtomRegistry.subscribe(environmentServerConfigsAtom, (configs) => {
    const next = new Set(pushGatewayEnvironmentIds(configs));
    for (const environmentId of known) {
      if (!next.has(environmentId)) registrations.delete(environmentId);
    }
    const added = [...next].some((environmentId) => !known.has(environmentId));
    known = next;
    if (added) onAdded();
  });
}

export function __resetPushGatewayRegistrationsForTest(): void {
  registrations.clear();
}
