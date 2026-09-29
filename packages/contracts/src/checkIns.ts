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
 * new turn once the thread is idle, and never interrupts a turn to do so.
 */
export const CheckInId = TrimmedNonEmptyString.pipe(Schema.brand("CheckInId"));
export type CheckInId = typeof CheckInId.Type;

export const CHECK_IN_NOTE_MAX_CHARS = 2_000;
/** The shortest wait before a check-in, and between repeats. Each delivery is a turn, so it costs. */
export const CHECK_IN_MIN_DELAY_MINUTES = 1;
export const CHECK_IN_MIN_REPEAT_MINUTES = 5;
export const CHECK_IN_MAX_MINUTES = 24 * 60;
export const CHECK_INS_PER_THREAD_MAX = 5;

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

/**
 * The message-context record kind that marks a message T3 sent for a check-in, so clients can
 * label it. It is deliberately not in `COMPOSER_CONTEXT_KINDS`: every client carries it as an
 * unknown record, and providers never see a record the message text does not reference.
 */
export const CHECK_IN_CONTEXT_KIND = "check-in";

/** Whether a message's context records mark it as a check-in T3 delivered. */
export function isCheckInMessage(
  records: ReadonlyArray<{ readonly kind: string }> | undefined,
): boolean {
  return records?.some((record) => record.kind === CHECK_IN_CONTEXT_KIND) ?? false;
}
