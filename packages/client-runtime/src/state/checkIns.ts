import { type ThreadBackgroundCommand, WS_METHODS } from "@t3tools/contracts";
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
    setBackgroundCommandMuted: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:background-commands:set-muted",
      tag: WS_METHODS.backgroundCommandSetMuted,
    }),
    openBackgroundCommandTerminal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:background-commands:open-terminal",
      tag: WS_METHODS.backgroundCommandOpenTerminal,
    }),
  };
}

function everyLabel(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes > 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

const PATTERN_SHOWN_CHARS = 24;

/**
 * What the agent hears about a running command before it ends: `muted · watching for FAILED ·
 * status updates every 20m`, or empty when it hears only about the end.
 */
function backgroundCommandUpdatesLabel(command: ThreadBackgroundCommand): string {
  const pattern = command.notifyOn;
  const parts = [
    command.muted ? "muted" : undefined,
    pattern
      ? `watching for ${pattern.length > PATTERN_SHOWN_CHARS ? `${pattern.slice(0, PATTERN_SHOWN_CHARS)}…` : pattern}`
      : undefined,
    command.statusEveryMinutes === null
      ? undefined
      : `status updates every ${everyLabel(command.statusEveryMinutes)}`,
  ];
  return parts.filter((part) => part !== undefined).join(" · ");
}

/**
 * A command's row status, most telling first so a narrow row truncates the least useful part:
 * `Stopping · muted · watching for FAILED · status updates every 20m · running since 2:15 PM`, or how
 * it ended while the agent is being told. `startedAt` is the client's formatted start time, which
 * should name the day once it is not today, since commands outlive midnight.
 */
export function backgroundCommandStatusLabel(
  command: ThreadBackgroundCommand,
  startedAt: string,
): string {
  if (command.status !== "running") {
    const how =
      command.status === "lost"
        ? "Ended, exit unknown"
        : command.status === "stopped"
          ? "Stopped"
          : `Finished (${command.exitStatus ?? "exit unknown"})`;
    return `${how} · telling the agent`;
  }
  const label = [
    command.stopRequestedBy === null ? "" : "stopping",
    backgroundCommandUpdatesLabel(command),
    `running since ${startedAt}`,
  ]
    .filter((part) => part !== "")
    .join(" · ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

/** Whether the user can mute the command: its server can, and it has messages to hold back. */
export function canMuteBackgroundCommand(command: ThreadBackgroundCommand): boolean {
  return (
    command.status === "running" &&
    command.muted !== undefined &&
    (command.statusEveryMinutes !== null || Boolean(command.notifyOn))
  );
}
