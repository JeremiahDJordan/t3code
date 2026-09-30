import type { AgentMessageEnvelope } from "@t3tools/contracts";

import { formatCheckInMinutes } from "../checkIns/checkInMessage.ts";

/** How much of a thread's last reply a notice quotes: its end, which usually holds the result. */
export const WAIT_REPLY_EXCERPT_CHARS = 2_000;
/** How much of a thread's title a message label shows. */
const LABEL_TITLE_CHARS = 60;

function refText(ref: { readonly environmentId: string; readonly threadId: string }): string {
  return `environmentId "${ref.environmentId}", threadId "${ref.threadId}"`;
}

function shortTitle(title: string): string {
  const trimmed = title.trim() || "Untitled thread";
  return trimmed.length > LABEL_TITLE_CHARS ? `${trimmed.slice(0, LABEL_TITLE_CHARS)}…` : trimmed;
}

/** A fence the quoted text cannot close, however many backticks it holds. */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** The label a message from another thread carries, such as `From "Fix the build"`. */
export function agentMessageLabel(envelope: AgentMessageEnvelope): string {
  const title = `"${shortTitle(envelope.from.threadTitle)}"`;
  return envelope.kind === "start-thread" ? `Started by ${title}` : `From ${title}`;
}

/** What a thread receives when another thread's agent messages it. */
export function agentMessageText(envelope: AgentMessageEnvelope): string {
  const from = envelope.from;
  return [
    `[T3 Code: message from the agent in thread "${shortTitle(from.threadTitle)}" (${refText(from)})]`,
    envelope.body,
    "",
    `This is a request from another agent, not from the user. To answer, call send_to_thread with ${refText(from)}.`,
  ].join("\n");
}

/** The project's setup script a started thread's new worktree needs, and the variables it expects. */
export interface WorktreeSetup {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Asks a new worktree's agent to run the project's setup script before its task. */
function setupParagraph(setup: WorktreeSetup): string {
  const env = Object.entries(setup.env)
    .map(([name, value]) => `\`${name}=${value}\``)
    .join(", ");
  return [
    `This thread works in a new worktree. Before the task, run the project's setup command in it with these environment variables set: ${env}:`,
    fenced(setup.command),
    "If it starts something that keeps running, run that in the background.",
  ].join("\n");
}

/**
 * The first message of a thread another thread's agent started, carrying its task. A new
 * worktree's setup script goes in it too, so it runs under that agent's permission mode.
 */
export function agentThreadStartText(
  envelope: AgentMessageEnvelope,
  reportBack: boolean,
  setup?: WorktreeSetup,
): string {
  const from = envelope.from;
  return [
    `[T3 Code: the agent in thread "${shortTitle(from.threadTitle)}" (${refText(from)}) started this thread with this task]`,
    ...(setup === undefined ? [] : [setupParagraph(setup), ""]),
    envelope.body,
    "",
    reportBack
      ? "That agent hears when you finish a turn and go idle, and can read your reply. To tell it more, call send_to_thread."
      : "To report back to that agent, call send_to_thread.",
  ].join("\n");
}

export type WaitOutcome =
  | { readonly kind: "finished"; readonly reply: string | undefined }
  | { readonly kind: "gone" }
  | { readonly kind: "stopped-waiting"; readonly hours: number };

/** The note a wait keeps when the agent gave none; its notice leaves it out. */
export function defaultWaitNote(title: string): string {
  return `Wait for "${title}" to finish its turn.`;
}

/** What a thread hears when a thread it waited on finishes, goes away, or took too long. */
export function waitNoticeText(input: {
  readonly title: string;
  readonly target: { readonly environmentId: string; readonly threadId: string };
  readonly note: string;
  readonly outcome: WaitOutcome;
}): string {
  const who = `thread "${shortTitle(input.title)}" (${refText(input.target)})`;
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
          )}\nRead more with read_thread; answer it with send_to_thread.`
        : "\nRead it with read_thread; answer it with send_to_thread.";
      return `[T3 Code] The agent in ${who} finished its turn.${quoted}${noteLine}`;
    }
    case "gone":
      return `[T3 Code] ${who} was archived or deleted before it finished a turn.${noteLine}`;
    case "stopped-waiting":
      return `[T3 Code] Stopped waiting for ${who}: it has not finished a turn in ${formatCheckInMinutes(input.outcome.hours * 60)}. Call watch_thread to wait again, or read_thread to see where it is.${noteLine}`;
  }
}

/** The label of a wait's notice. */
export function waitNoticeLabel(outcome: WaitOutcome): string {
  return outcome.kind === "finished" ? "Thread finished" : "Stopped waiting";
}
