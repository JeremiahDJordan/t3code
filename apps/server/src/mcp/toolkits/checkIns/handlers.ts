import type { ThreadBackgroundCommand, ThreadCheckIn } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BackgroundCommands from "../../../checkIns/BackgroundCommands.ts";
import * as CheckInScheduler from "../../../checkIns/CheckInScheduler.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CheckInsToolkit } from "./tools.ts";

function summaryOf(checkIn: ThreadCheckIn) {
  return {
    checkInId: checkIn.id,
    note: checkIn.note,
    nextAt: checkIn.nextAt,
    repeatEveryMinutes: checkIn.repeatEveryMinutes,
    endsAt: checkIn.endsAt,
    waitingForIdle: checkIn.dueSince !== null,
    waitsForThreadId: checkIn.waitsFor?.threadId ?? null,
  };
}

function commandSummaryOf(command: ThreadBackgroundCommand) {
  return {
    backgroundCommandId: command.id,
    command: command.command,
    status: command.status,
    exitStatus: command.exitStatus,
    startedAt: command.startedAt,
    endedAt: command.endedAt,
    stdoutPath: command.stdoutPath,
    stderrPath: command.stderrPath,
    statusEveryMinutes: command.statusEveryMinutes,
    notifyOn: command.notifyOn ?? null,
    muted: command.muted ?? false,
  };
}

const make = Effect.gen(function* () {
  const scheduler = yield* CheckInScheduler.CheckInScheduler;
  const backgroundCommands = yield* BackgroundCommands.BackgroundCommands;
  // Every T3 credential carries `orchestration`; the project's check-in setting is checked by
  // the services when something is scheduled or started.
  const scope = McpInvocationContext.requireMcpCapability("orchestration");

  return CheckInsToolkit.of({
    schedule_check_in: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* scope;
        const checkIn = yield* scheduler.schedule({
          threadId,
          note: input.note,
          inMinutes: input.inMinutes,
          repeatEveryMinutes: input.repeatEveryMinutes ?? null,
        });
        return summaryOf(checkIn);
      }),
    list_scheduled: () =>
      Effect.gen(function* () {
        const { threadId } = yield* scope;
        const checkIns = yield* scheduler.list(threadId);
        const commands = yield* backgroundCommands.list(threadId);
        return { checkIns: checkIns.map(summaryOf), commands: commands.map(commandSummaryOf) };
      }),
    cancel_check_in: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* scope;
        // An agent may cancel only its own thread's check-ins.
        const cancelled = yield* scheduler.cancel(input.checkInId, threadId);
        return { cancelled };
      }),
    start_background_command: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* scope;
        const command = yield* backgroundCommands.start({
          threadId,
          command: input.command,
          statusEveryMinutes: input.statusEveryMinutes ?? null,
          note: input.note ?? "",
          tailLines: input.tailLines ?? 0,
          notifyOn: input.notifyOn ?? null,
        });
        return {
          backgroundCommandId: command.id,
          stdoutPath: command.stdoutPath,
          stderrPath: command.stderrPath,
          startedAt: command.startedAt,
        };
      }),
    stop_background_command: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* scope;
        // An agent may stop only its own thread's commands, and hears nothing back about them.
        const stopping = yield* backgroundCommands.stop(
          input.backgroundCommandId,
          "agent",
          threadId,
        );
        return { stopping };
      }),
    mute_background_command: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* scope;
        // An agent may mute only its own thread's commands.
        const updated = yield* backgroundCommands.setMuted(
          input.backgroundCommandId,
          input.muted,
          threadId,
        );
        return { updated };
      }),
    watch_thread: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* scope;
        const wait = yield* scheduler.scheduleWait({
          threadId,
          targetThreadId: input.threadId,
          note: input.note ?? "",
        });
        return { waitId: wait.id, stopsWaitingAt: wait.nextAt };
      }),
    cancel_wait: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* scope;
        const waits = yield* scheduler.list(threadId);
        if (!waits.some((wait) => wait.id === input.waitId && wait.waitsFor !== undefined)) {
          return { cancelled: false };
        }
        return { cancelled: yield* scheduler.cancel(input.waitId, threadId) };
      }),
  });
});

export const CheckInsToolkitHandlersLive = CheckInsToolkit.toLayer(make);
