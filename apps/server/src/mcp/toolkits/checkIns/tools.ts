import {
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

import * as CheckInScheduler from "../../../checkIns/CheckInScheduler.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, CheckInScheduler.CheckInScheduler];

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
export const ListScheduledResult = Schema.Struct({ checkIns: Schema.Array(CheckInSummary) });
export type ListScheduledResult = typeof ListScheduledResult.Type;

export const CancelCheckInInput = Schema.Struct({ checkInId: CheckInId });
export const CancelCheckInResult = Schema.Struct({
  cancelled: Schema.Boolean.annotate({
    description:
      "False when no check-in of this thread has that id, for example one already delivered.",
  }),
});

export const CheckInToolError = Schema.Union([McpCapabilityUnavailableError, CheckInError]);

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
  description: "List this thread's pending check-ins.",
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

export const CheckInsToolkit = Toolkit.make(
  ScheduleCheckInTool,
  ListScheduledTool,
  CancelCheckInTool,
);
