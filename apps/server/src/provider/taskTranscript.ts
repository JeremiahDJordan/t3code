/**
 * taskTranscript - the shape a subagent's steps take on their way to clients, whichever provider
 * recorded them: whole text in, without the report the task's result already carries, with long
 * text shortened and a long run cut to its prompt and newest steps.
 *
 * @module provider/taskTranscript
 */
import {
  type ProviderReadTaskTranscriptResult,
  TASK_RESULT_MAX_CHARS,
  type TaskTranscriptEntry,
} from "@t3tools/contracts";

/** How much of a prompt or message a step keeps. */
const TRANSCRIPT_TEXT_MAX_CHARS = 4_000;
/** How much of a report too long for the task's result the steps keep. */
const TRANSCRIPT_REPORT_MAX_CHARS = 32_000;
/** How much of a tool call's input or output a step keeps. */
const TRANSCRIPT_TOOL_TEXT_MAX_CHARS = 2_000;
/** Steps returned at most, so a long run stays a small response. */
const TRANSCRIPT_MAX_ENTRIES = 100;

function shorten(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * The steps before a subagent's report, given its whole conversation as steps, oldest first. The
 * task's result already carries the report; one too long for the result ends the steps instead,
 * so it can be read whole.
 */
export function finishTaskTranscript(
  steps: ReadonlyArray<TaskTranscriptEntry>,
): ProviderReadTaskTranscriptResult {
  const all = [...steps];
  const report = all.at(-1);
  const keepReport = report?._tag === "message" && report.text.length > TASK_RESULT_MAX_CHARS;
  if (report?._tag === "message" && !keepReport) all.pop();
  const entries = all.map((entry, index): TaskTranscriptEntry => {
    if (entry._tag === "tool") {
      return {
        ...entry,
        ...(entry.input ? { input: shorten(entry.input, TRANSCRIPT_TOOL_TEXT_MAX_CHARS) } : {}),
        ...(entry.output ? { output: shorten(entry.output, TRANSCRIPT_TOOL_TEXT_MAX_CHARS) } : {}),
      };
    }
    const kept = keepReport && index === all.length - 1;
    return {
      ...entry,
      text: shorten(entry.text, kept ? TRANSCRIPT_REPORT_MAX_CHARS : TRANSCRIPT_TEXT_MAX_CHARS),
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

/**
 * A finished task's steps as plain text under an "Earlier steps" heading, for clients that show
 * only its result's text. Each step starts with `▸`; undefined when there are none.
 */
export function earlierStepsText(transcript: ProviderReadTaskTranscriptResult): string | undefined {
  if (transcript.entries.length === 0) return undefined;
  const blocks = transcript.entries.map((entry) => {
    switch (entry._tag) {
      case "prompt":
        return `▸ Prompt\n${entry.text}`;
      case "message":
        return `▸ Note\n${entry.text}`;
      case "tool":
        return [
          `▸ ${entry.title}${entry.failed ? " (failed)" : ""}`,
          ...(entry.input ? [`Input:\n${entry.input}`] : []),
          ...(entry.output ? [`Output:\n${entry.output}`] : []),
        ].join("\n");
    }
  });
  const omitted = transcript.omittedEntries ?? 0;
  if (omitted > 0) {
    // finishTaskTranscript leaves them out between the prompt and the newest steps.
    const at = transcript.entries[0]?._tag === "prompt" ? 1 : 0;
    blocks.splice(at, 0, `▸ ${omitted} older ${omitted === 1 ? "step" : "steps"} not shown`);
  }
  return ["── Earlier steps ──", ...blocks].join("\n\n");
}
