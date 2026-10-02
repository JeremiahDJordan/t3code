import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Check-ins: messages an agent schedules for T3 Code to send back into its own thread later,
 * once or on repeat, such as "look at the build again in 20 minutes". T3 sends each one as a
 * notification turn once the thread is idle, and never interrupts a turn to do so. A wait is a
 * check-in that goes in when another thread finishes its turn instead of at a time.
 */
export const CheckInId = TrimmedNonEmptyString.pipe(Schema.brand("CheckInId"));
export type CheckInId = typeof CheckInId.Type;

export const CHECK_IN_NOTE_MAX_CHARS = 2_000;
/** The shortest wait before a check-in, and between repeats. Each delivery is a turn, so it costs. */
export const CHECK_IN_MIN_DELAY_MINUTES = 1;
export const CHECK_IN_MIN_REPEAT_MINUTES = 5;
export const CHECK_IN_MAX_MINUTES = 24 * 60;
export const CHECK_INS_PER_THREAD_MAX = 5;
/** Threads one thread may wait on at once, apart from its check-ins. */
export const CHECK_IN_WAITS_PER_THREAD_MAX = 20;

/** How long a repeating check-in keeps going, in hours, unless the user sets otherwise. */
export const DEFAULT_CHECK_IN_REPEAT_LIMIT_HOURS = 24;
export const CheckInRepeatLimitHours = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 30 * 24 }),
);

export const ThreadCheckIn = Schema.Struct({
  id: CheckInId,
  threadId: ThreadId,
  /** What the agent asked to be reminded of; the delivered message carries it. */
  note: TrimmedNonEmptyString,
  /** Minutes between deliveries; null for a one-time check-in. */
  repeatEveryMinutes: Schema.NullOr(PositiveInt),
  /** When it is next due. */
  nextAt: IsoDateTime,
  /** When a repeating check-in stops; null for a one-time one. */
  endsAt: Schema.NullOr(IsoDateTime),
  /** Set while it is due but waiting for the thread to be idle. */
  dueSince: Schema.NullOr(IsoDateTime),
  deliveredCount: NonNegativeInt,
  createdAt: IsoDateTime,
  /**
   * Set when the check-in waits for another thread to finish its turn instead of for a time;
   * `nextAt` is then when it stops waiting. Absent on time check-ins.
   */
  waitsFor: Schema.optionalKey(Schema.Struct({ threadId: ThreadId, title: Schema.String })),
});
export type ThreadCheckIn = typeof ThreadCheckIn.Type;

export const ThreadCheckInsInput = Schema.Struct({ threadId: ThreadId });
export type ThreadCheckInsInput = typeof ThreadCheckInsInput.Type;

export const CancelCheckInInput = Schema.Struct({ checkInId: CheckInId });
export type CancelCheckInInput = typeof CancelCheckInInput.Type;

export class CheckInError extends Schema.TaggedError<CheckInError>()("CheckInError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
