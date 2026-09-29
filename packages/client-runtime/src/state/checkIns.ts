import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** The check-ins agents scheduled in a thread, and the user's way to cancel one. */
export function createCheckInEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** A thread's pending check-ins, pushed again after every change. */
    threadCheckIns: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:check-ins:thread",
      tag: WS_METHODS.subscribeThreadCheckIns,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:check-ins:cancel",
      tag: WS_METHODS.checkInCancel,
    }),
    /** A thread's background commands that run or whose end the agent has not heard yet. */
    threadBackgroundCommands: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:background-commands:thread",
      tag: WS_METHODS.subscribeThreadBackgroundCommands,
    }),
    stopBackgroundCommand: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:background-commands:stop",
      tag: WS_METHODS.backgroundCommandStop,
    }),
    openBackgroundCommandTerminal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:background-commands:open-terminal",
      tag: WS_METHODS.backgroundCommandOpenTerminal,
    }),
  };
}
