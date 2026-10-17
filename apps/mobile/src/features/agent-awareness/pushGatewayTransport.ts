/**
 * Fork: the push gateway registration RPCs, over each server's own connection. Kept apart from
 * `pushGatewayRegistration.ts` so that module does not pull in the connection stack.
 */
import { createPushDeviceEnvironmentAtoms } from "@t3tools/client-runtime/state/pushDevices";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import type { PushGatewayTransport } from "./pushGatewayRegistration";

const pushDeviceEnvironment = createPushDeviceEnvironmentAtoms(connectionAtomRuntime);

// A server that is offline must not hold registration with the others.
const REQUEST_TIMEOUT_MS = 15_000;

function withTimeout(operation: Promise<boolean>): Promise<boolean> {
  return Promise.race([
    operation.catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), REQUEST_TIMEOUT_MS)),
  ]);
}

const options = { reportFailure: false, reportDefect: false } as const;

export const environmentTransport: PushGatewayTransport = {
  register: (environmentId, input) =>
    withTimeout(
      runAtomCommand(
        appAtomRegistry,
        pushDeviceEnvironment.register,
        { environmentId, input },
        options,
      ).then((result) => result._tag === "Success"),
    ),
  registerLiveActivity: (environmentId, input) =>
    withTimeout(
      runAtomCommand(
        appAtomRegistry,
        pushDeviceEnvironment.registerLiveActivity,
        { environmentId, input },
        options,
      ).then((result) => result._tag === "Success"),
    ),
  unregister: (environmentId, deviceId) =>
    withTimeout(
      runAtomCommand(
        appAtomRegistry,
        pushDeviceEnvironment.unregister,
        { environmentId, input: { deviceId } },
        options,
      ).then((result) => result._tag === "Success"),
    ),
};
