import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * Fork: a phone's push registration with one server that pushes through the owner's push
 * gateway (the `pushGateway` capability).
 */
export function createPushDeviceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    register: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:push-devices:register",
      tag: WS_METHODS.pushDevicesRegister,
    }),
    registerLiveActivity: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:push-devices:register-live-activity",
      tag: WS_METHODS.pushDevicesRegisterLiveActivity,
    }),
    unregister: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:push-devices:unregister",
      tag: WS_METHODS.pushDevicesUnregister,
    }),
  };
}
