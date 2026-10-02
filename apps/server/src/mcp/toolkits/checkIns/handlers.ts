import type { ThreadBackgroundCommand, ThreadCheckIn } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BackgroundCommands from "../../../checkIns/BackgroundCommands.ts";
import * as CheckInScheduler from "../../../checkIns/CheckInScheduler.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
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
  // the services when something is scheduled or started. Every tool here acts as the calling
  // thread, so an agent signed in from outside a thread is refused.
  const caller = (operation: string) =>
    McpInvocationContext.requireMcpCapability("orchestration").pipe(
      Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, operation)),
      Effect.map((scope) => scope.thread),
    );

  return {
    schedule_check_in: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* caller("schedule_check_in");
        const checkIn = yield* scheduler.schedule({
          threadId,
          note: input.note,
          inMinutes: input.inMinutes,
          repeatEveryMinutes: input.repeatEveryMinutes ?? null,
        });
        return summaryOf(checkIn);
      }),
    ),
    list_scheduled: McpToolAccess.readsAsCaller(() =>
      Effect.gen(function* () {
        const { threadId } = yield* caller("list_scheduled");
        const checkIns = yield* scheduler.list(threadId);
        const commands = yield* backgroundCommands.list(threadId);
        return { checkIns: checkIns.map(summaryOf), commands: commands.map(commandSummaryOf) };
      }),
    ),
    cancel_check_in: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* caller("cancel_check_in");
        // An agent may cancel only its own thread's check-ins.
        const cancelled = yield* scheduler.cancel(input.checkInId, threadId);
        return { cancelled };
      }),
    ),
    start_background_command: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* caller("start_background_command");
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
    ),
    stop_background_command: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* caller("stop_background_command");
        // An agent may stop only its own thread's commands, and hears nothing back about them.
        const stopping = yield* backgroundCommands.stop(
          input.backgroundCommandId,
          "agent",
          threadId,
        );
        return { stopping };
      }),
    ),
    mute_background_command: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* caller("mute_background_command");
        // An agent may mute only its own thread's commands.
        const updated = yield* backgroundCommands.setMuted(
          input.backgroundCommandId,
          input.muted,
          threadId,
        );
        return { updated };
      }),
    ),
    watch_thread: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* caller("watch_thread");
        const wait = yield* scheduler.scheduleWait({
          threadId,
          targetThreadId: input.threadId,
          note: input.note ?? "",
        });
        return { waitId: wait.id, stopsWaitingAt: wait.nextAt };
      }),
    ),
    cancel_wait: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* caller("cancel_wait");
        const waits = yield* scheduler.list(threadId);
        if (!waits.some((wait) => wait.id === input.waitId && wait.waitsFor !== undefined)) {
          return { cancelled: false };
        }
        return { cancelled: yield* scheduler.cancel(input.waitId, threadId) };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof CheckInsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(CheckInsToolkit, make);
