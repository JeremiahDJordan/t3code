import { formatCheckInMinutes } from "./checkInMessage.ts";

/** How much of a thread's last reply a notice quotes: its end, which usually holds the result. */
export const WAIT_REPLY_EXCERPT_CHARS = 2_000;
/** How much of a thread's title a notice's summary shows. */
const TITLE_SHOWN_CHARS = 60;

/** A thread's title as a notice names it, shortened for its one-line summary. */
function shortThreadTitle(title: string): string {
  const trimmed = title.trim() || "Untitled thread";
  return trimmed.length > TITLE_SHOWN_CHARS ? `${trimmed.slice(0, TITLE_SHOWN_CHARS)}…` : trimmed;
}

/** A fence the quoted text cannot close, however many backticks it holds. */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** How a turn that ended a wait ended: done, failed, or stopped or interrupted. */
export type WaitTurnStatus = "completed" | "failed" | "cancelled";

const TURN_ENDED: Record<WaitTurnStatus, string> = {
  completed: "finished its turn",
  failed: "ended its turn with an error",
  cancelled: "was stopped before finishing its turn",
};

export type WaitOutcome =
  | {
      readonly kind: "finished";
      readonly reply: string | undefined;
      readonly status: WaitTurnStatus;
    }
  | { readonly kind: "gone" }
  | { readonly kind: "stopped-waiting"; readonly hours: number };

/** The note a wait keeps when the agent gave none; its notice leaves it out. */
export function defaultWaitNote(title: string): string {
  return `Wait for "${title}" to finish its turn.`;
}

/** What a thread hears when a thread it waited on finishes, goes away, or took too long. */
export function waitNoticeText(input: {
  readonly title: string;
  readonly threadId: string;
  readonly note: string;
  readonly outcome: WaitOutcome;
}): string {
  const who = `thread "${shortThreadTitle(input.title)}" (threadId "${input.threadId}")`;
  const noteLine =
    input.note && input.note !== defaultWaitNote(input.title) ? `\nYour note: ${input.note}` : "";
  switch (input.outcome.kind) {
    case "finished": {
      const reply = input.outcome.reply?.trim();
      const quoted = reply
        ? `\nThe end of its last reply:\n${fenced(
            reply.length > WAIT_REPLY_EXCERPT_CHARS
              ? `…${reply.slice(-WAIT_REPLY_EXCERPT_CHARS)}`
              : reply,
          )}\nRead more with t3_thread_read; answer it with t3_thread_send.`
        : "\nRead it with t3_thread_read; answer it with t3_thread_send.";
      return `[T3 Code] The agent in ${who} ${TURN_ENDED[input.outcome.status]}.${quoted}${noteLine}`;
    }
    case "gone":
      return `[T3 Code] ${who} was archived or deleted before it finished a turn.${noteLine}`;
    case "stopped-waiting":
      return `[T3 Code] Stopped waiting for ${who}: it has not finished a turn in ${formatCheckInMinutes(input.outcome.hours * 60)}. Call watch_thread to wait again, or t3_thread_read to see where it is.${noteLine}`;
  }
}

/** The one line a wait's notice shows in the thread. */
export function waitNoticeSummary(title: string, outcome: WaitOutcome): string {
  const name = `"${shortThreadTitle(title)}"`;
  switch (outcome.kind) {
    case "finished":
      return `${name} ${TURN_ENDED[outcome.status]}`;
    case "gone":
      return `${name} was archived or deleted`;
    case "stopped-waiting":
      return `Stopped waiting for ${name}`;
  }
}
