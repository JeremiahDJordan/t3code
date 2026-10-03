/**
 * taskTranscript - the steps of a subagent run that its provider stores but does not stream, as
 * they go into the subagent's thread: whole text in, without the report the subagent's result
 * already carries, with long text shortened and a long run cut to its prompt and newest steps.
 *
 * @module provider/taskTranscript
 */

/** One step of a subagent's run. */
export type TaskTranscriptEntry =
  /** What the subagent was asked to do. */
  | { readonly _tag: "prompt"; readonly text: string }
  /** Text the subagent wrote between tool calls. */
  | { readonly _tag: "message"; readonly text: string }
  | {
      readonly _tag: "tool";
      readonly title: string;
      readonly input?: string;
      readonly output?: string;
      readonly failed: boolean;
    };

export interface TaskTranscript {
  readonly entries: ReadonlyArray<TaskTranscriptEntry>;
  /** Older steps left out, after the prompt, so the newest ones fit. */
  readonly omittedEntries?: number;
}

/** How much of a prompt or message a step keeps. */
const TRANSCRIPT_TEXT_MAX_CHARS = 4_000;
/** How much of a tool call's input or output a step keeps. */
const TRANSCRIPT_TOOL_TEXT_MAX_CHARS = 2_000;
/** Steps kept at most, so a long run stays a small part of the thread. */
const TRANSCRIPT_MAX_ENTRIES = 100;

function shorten(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * The steps before a subagent's report, given its whole conversation as steps, oldest first. The
 * subagent's result already carries the report.
 */
export function finishTaskTranscript(steps: ReadonlyArray<TaskTranscriptEntry>): TaskTranscript {
  const all = [...steps];
  if (all.at(-1)?._tag === "message") all.pop();
  const entries = all.map((entry): TaskTranscriptEntry => {
    if (entry._tag !== "tool") {
      return { ...entry, text: shorten(entry.text, TRANSCRIPT_TEXT_MAX_CHARS) };
    }
    return {
      ...entry,
      ...(entry.input ? { input: shorten(entry.input, TRANSCRIPT_TOOL_TEXT_MAX_CHARS) } : {}),
      ...(entry.output ? { output: shorten(entry.output, TRANSCRIPT_TOOL_TEXT_MAX_CHARS) } : {}),
    };
  });
  if (entries.length <= TRANSCRIPT_MAX_ENTRIES) return { entries };
  const head = entries[0]?._tag === "prompt" ? entries.slice(0, 1) : [];
  const tail = entries.slice(entries.length - (TRANSCRIPT_MAX_ENTRIES - head.length));
  return {
    entries: [...head, ...tail],
    omittedEntries: entries.length - head.length - tail.length,
  };
}
