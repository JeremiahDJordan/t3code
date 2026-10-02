/**
 * claudeSubagentTranscript - the steps of one of Claude's subagent runs, read from the transcript
 * Claude Code writes for it.
 *
 * Claude streams a subagent's progress to T3 but not its conversation. Claude Code keeps that in
 * `<config dir>/projects/<project>/<session id>/subagents/agent-<agent id>.jsonl`, where the agent
 * id is the T3 task id. Reads are best-effort: a missing file or a malformed line yields fewer
 * steps instead of an error.
 *
 * @module provider/Layers/claudeSubagentTranscript
 */
import type { ProviderReadTaskTranscriptResult, TaskTranscriptEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { finishTaskTranscript } from "../taskTranscript.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A content block list's text, or a plain string's. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n")
    .trim();
}

/** A tool call's title: the tool, and what it was asked when that says the most. */
function toolTitle(name: string, input: Record<string, unknown>): string {
  for (const key of ["description", "command", "file_path", "path", "pattern", "url", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return `${name}: ${value.trim().split("\n")[0]}`;
    }
  }
  return name;
}

function toolInput(input: Record<string, unknown>): string | undefined {
  if (typeof input.command === "string") return input.command.trim() || undefined;
  return Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : undefined;
}

/** The steps of a subagent's conversation before its report, from its transcript's lines. */
export function claudeSubagentTranscriptEntries(
  lines: ReadonlyArray<string>,
): ProviderReadTaskTranscriptResult {
  const steps: Array<TaskTranscriptEntry> = [];
  // A tool call's step, by tool use id, so its result fills in its output.
  const tools = new Map<string, number>();
  for (const line of lines) {
    let entry: Record<string, unknown> | undefined;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    const message = asRecord(entry?.message);
    if (!message || (entry?.type !== "user" && entry?.type !== "assistant")) continue;
    const content = message.content;
    if (entry.type === "user") {
      // A user line holds the prompt, or the results of the tool calls before it.
      const blocks = Array.isArray(content) ? content.map(asRecord) : [];
      for (const block of blocks) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const index = tools.get(block.tool_use_id);
        const step = index === undefined ? undefined : steps[index];
        if (step?._tag !== "tool" || index === undefined) continue;
        const output = contentText(block.content);
        steps[index] = {
          ...step,
          ...(output ? { output } : {}),
          failed: block.is_error === true,
        };
      }
      const text = contentText(content);
      if (text && !blocks.some((block) => block?.type === "tool_result")) {
        steps.push({ _tag: "prompt", text });
      }
      continue;
    }
    for (const block of Array.isArray(content) ? content.map(asRecord) : []) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        steps.push({ _tag: "message", text: block.text.trim() });
      } else if (block?.type === "tool_use" && typeof block.id === "string") {
        const name = typeof block.name === "string" ? block.name : "Tool";
        const input = asRecord(block.input) ?? {};
        const inputText = toolInput(input);
        tools.set(block.id, steps.length);
        steps.push({
          _tag: "tool",
          title: toolTitle(name, input),
          ...(inputText ? { input: inputText } : {}),
          failed: false,
        });
      }
    }
  }
  return finishTaskTranscript(steps);
}

/**
 * The steps of Claude subagent `agentId` in session `sessionId`, under Claude's config directory.
 * The project folder is found by the session, since Claude names it from the session's path.
 * Empty when Claude has not written the transcript or it cannot be read.
 */
export const readClaudeSubagentTranscript = Effect.fn("readClaudeSubagentTranscript")(function* (
  configDir: string,
  sessionId: string,
  agentId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const empty: ProviderReadTaskTranscriptResult = { entries: [] };
  // Ids come from Claude and the thread; neither may climb out of the config directory.
  if (![sessionId, agentId].every((id) => /^[\w-]+$/.test(id))) return empty;
  const projectsDir = path.join(configDir, "projects");
  const projects = yield* fs.readDirectory(projectsDir).pipe(Effect.orElseSucceed(() => []));
  for (const project of projects) {
    const file = path.join(projectsDir, project, sessionId, "subagents", `agent-${agentId}.jsonl`);
    const text = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.isSome(text)) {
      return claudeSubagentTranscriptEntries(text.value.split("\n").filter((line) => line.trim()));
    }
  }
  return empty;
});
