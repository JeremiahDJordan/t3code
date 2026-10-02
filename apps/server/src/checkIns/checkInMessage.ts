import type { ThreadCheckIn } from "@t3tools/contracts";

/** `20 minutes`, `1 hour`, `2 hours 30 minutes`. */
export function formatCheckInMinutes(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  const part = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;
  if (hours === 0) return part(rest, "minute");
  return rest === 0 ? part(hours, "hour") : `${part(hours, "hour")} ${part(rest, "minute")}`;
}

/**
 * What T3 sends into the thread when a check-in is delivered. It opens with a plain marker, so
 * the agent, and anyone reading the thread in an app that does not label check-ins, can tell T3
 * sent it rather than the user.
 */
export function checkInMessageText(
  checkIn: Pick<ThreadCheckIn, "id" | "note" | "repeatEveryMinutes" | "nextAt" | "endsAt">,
  nowMs: number,
): string {
  if (checkIn.repeatEveryMinutes === null) {
    return `[T3 Code check-in] ${checkIn.note}`;
  }
  const every = formatCheckInMinutes(checkIn.repeatEveryMinutes);
  const header = `[T3 Code check-in, every ${every}] ${checkIn.note}`;
  const endsAtMs = checkIn.endsAt === null ? null : Date.parse(checkIn.endsAt);
  if (endsAtMs !== null && Date.parse(checkIn.nextAt) > endsAtMs) {
    return `${header}\n\nThis is the last one: the check-in has reached its end time. Schedule another if you still need it.`;
  }
  const next = formatCheckInMinutes((Date.parse(checkIn.nextAt) - nowMs) / 60_000);
  const ends =
    endsAtMs === null ? "" : ` It stops in ${formatCheckInMinutes((endsAtMs - nowMs) / 60_000)}.`;
  return `${header}\n\nThe next one is in ${next}.${ends} To stop it sooner, call cancel_check_in with checkInId "${checkIn.id}".`;
}
