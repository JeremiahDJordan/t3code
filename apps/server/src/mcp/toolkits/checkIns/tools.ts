import {
  BACKGROUND_COMMAND_MAX_CHARS,
  BACKGROUND_COMMAND_TAIL_MAX_LINES,
  BACKGROUND_COMMANDS_PER_THREAD_MAX,
  BackgroundCommandError,
  BackgroundCommandId,
  BackgroundCommandStatus,
  CHECK_IN_MAX_MINUTES,
  CHECK_IN_MIN_DELAY_MINUTES,
  CHECK_IN_MIN_REPEAT_MINUTES,
  CHECK_IN_NOTE_MAX_CHARS,
  CheckInError,
  CheckInId,
  IsoDateTime,
  McpCapabilityUnavailableError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as BackgroundCommands from "../../../checkIns/BackgroundCommands.ts";
import * as CheckInScheduler from "../../../checkIns/CheckInScheduler.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  CheckInScheduler.CheckInScheduler,
  BackgroundCommands.BackgroundCommands,
];

const Minutes = (minimum: number, description: string) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum: CHECK_IN_MAX_MINUTES })).annotate({
    description,
  });

export const ScheduleCheckInInput = Schema.Struct({
  inMinutes: Minutes(
    CHECK_IN_MIN_DELAY_MINUTES,
    `Minutes until the first check-in, ${CHECK_IN_MIN_DELAY_MINUTES} to ${CHECK_IN_MAX_MINUTES}.`,
  ),
  note: TrimmedNonEmptyString.check(Schema.isMaxLength(CHECK_IN_NOTE_MAX_CHARS)).annotate({
    description:
      "What to do when it arrives, written to your future self, for example: Check whether the desktop build in terminal 2 finished; if it failed, read the log and fix the error.",
  }),
  repeatEveryMinutes: Schema.optional(
    Minutes(
      CHECK_IN_MIN_REPEAT_MINUTES,
      `Repeat at this interval, ${CHECK_IN_MIN_REPEAT_MINUTES} to ${CHECK_IN_MAX_MINUTES} minutes, until cancelled or its end time. Omit for a one-time check-in.`,
    ),
  ),
});
export type ScheduleCheckInInput = typeof ScheduleCheckInInput.Type;

const CheckInSummary = Schema.Struct({
  checkInId: CheckInId,
  note: Schema.String,
  nextAt: IsoDateTime,
  repeatEveryMinutes: Schema.NullOr(Schema.Int),
  endsAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When a repeating check-in stops on its own; null for a one-time one.",
  }),
  waitingForIdle: Schema.Boolean.annotate({
    description: "True when it is due and waits for this thread to be idle.",
  }),
});

export const ScheduleCheckInResult = CheckInSummary;

const BackgroundCommandSummary = Schema.Struct({
  backgroundCommandId: BackgroundCommandId,
  command: Schema.String,
  status: BackgroundCommandStatus,
  exitStatus: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  stdoutPath: Schema.String,
  stderrPath: Schema.String,
  statusEveryMinutes: Schema.NullOr(Schema.Int),
});

export const ListScheduledResult = Schema.Struct({
  checkIns: Schema.Array(CheckInSummary),
  commands: Schema.Array(BackgroundCommandSummary),
});
export type ListScheduledResult = typeof ListScheduledResult.Type;

export const CancelCheckInInput = Schema.Struct({ checkInId: CheckInId });
export const CancelCheckInResult = Schema.Struct({
  cancelled: Schema.Boolean.annotate({
    description:
      "False when no check-in of this thread has that id, for example one already delivered.",
  }),
});

export const StartBackgroundCommandInput = Schema.Struct({
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(BACKGROUND_COMMAND_MAX_CHARS)).annotate({
    description: "The shell command line, run with a login shell in this thread's folder.",
  }),
  statusEveryMinutes: Schema.optional(
    Minutes(
      CHECK_IN_MIN_REPEAT_MINUTES,
      `Also send a status update at this interval while it runs, ${CHECK_IN_MIN_REPEAT_MINUTES} to ${CHECK_IN_MAX_MINUTES} minutes. Omit to hear only when it ends.`,
    ),
  ),
  note: Schema.optional(
    Schema.String.check(Schema.isMaxLength(CHECK_IN_NOTE_MAX_CHARS)).annotate({
      description:
        "What to do when you hear about it, written to your future self, for example: If it failed, read the end of stderr and fix the error.",
    }),
  ),
  tailLines: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: BACKGROUND_COMMAND_TAIL_MAX_LINES }),
    ).annotate({
      description:
        "Quote this many of the last lines of stdout and stderr in each message about it (at most a few KB). Default 0: read the files yourself.",
    }),
  ),
});

export const StartBackgroundCommandResult = Schema.Struct({
  backgroundCommandId: BackgroundCommandId,
  stdoutPath: Schema.String,
  stderrPath: Schema.String,
  startedAt: IsoDateTime,
});

export const StopBackgroundCommandInput = Schema.Struct({
  backgroundCommandId: BackgroundCommandId,
});
export const StopBackgroundCommandResult = Schema.Struct({
  stopping: Schema.Boolean.annotate({
    description: "False when no running command of this thread has that id.",
  }),
});

export const CheckInToolError = Schema.Union([
  McpCapabilityUnavailableError,
  CheckInError,
  BackgroundCommandError,
]);

const ScheduleCheckInTool = Tool.make("schedule_check_in", {
  description: `Ask T3 Code to send you a message in this thread later, so you can check on slow work (a long build or test run, CI, a deploy) instead of waiting in a loop. It arrives as a new turn once you are idle and never interrupts a turn. Repeating check-ins stop at their end time. Each delivery is a turn and costs usage, so choose the longest interval that works, and cancel check-ins you no longer need. A thread holds at most 5.`,
  parameters: ScheduleCheckInInput,
  success: ScheduleCheckInResult,
  failure: CheckInToolError,
  dependencies,
})
  .annotate(Tool.Title, "Schedule a check-in")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ListScheduledTool = Tool.make("list_scheduled", {
  description:
    "List this thread's pending check-ins and its background commands that are running or whose end you have not been told yet.",
  success: ListScheduledResult,
  failure: CheckInToolError,
  dependencies,
})
  .annotate(Tool.Title, "List scheduled check-ins")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CancelCheckInTool = Tool.make("cancel_check_in", {
  description: "Cancel one of this thread's check-ins by its id.",
  parameters: CancelCheckInInput,
  success: CancelCheckInResult,
  failure: CheckInToolError,
  dependencies,
})
  .annotate(Tool.Title, "Cancel a check-in")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const StartBackgroundCommandTool = Tool.make("start_background_command", {
  description: `Run a long shell command (a build, a long test suite, a deploy) in the background on the machine running T3 Code, in this thread's folder. Use it instead of your shell tool for anything that may take more than a few minutes: it keeps running after your turn ends and even if T3 Code restarts. Its stdout and stderr go to the files whose paths are returned; read them with your own tools when you need to. T3 Code tells you the moment it ends, as a new turn with how it ended and the file sizes, and with statusEveryMinutes also how it is doing on that schedule. After starting it, end your turn and wait to be told; do not poll. It needs this thread in Full access and tmux on the machine. A thread runs at most ${BACKGROUND_COMMANDS_PER_THREAD_MAX} at once.`,
  parameters: StartBackgroundCommandInput,
  success: StartBackgroundCommandResult,
  failure: CheckInToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start a background command")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const StopBackgroundCommandTool = Tool.make("stop_background_command", {
  description:
    "Stop one of this thread's background commands: Ctrl-C first, then harder if it does not stop. You are not sent an end message for a command you stopped.",
  parameters: StopBackgroundCommandInput,
  success: StopBackgroundCommandResult,
  failure: CheckInToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop a background command")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CheckInsToolkit = Toolkit.make(
  ScheduleCheckInTool,
  ListScheduledTool,
  CancelCheckInTool,
  StartBackgroundCommandTool,
  StopBackgroundCommandTool,
);
