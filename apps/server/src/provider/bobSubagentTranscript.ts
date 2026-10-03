/**
 * bobSubagentTranscript - the steps of one of Bob's subagent runs, read from Bob's task database.
 *
 * Bob's ACP mode streams only the root task's updates, so T3 sees a subagent start and finish
 * but nothing in between. Bob keeps the subagent's whole conversation on the parent task's
 * `spawn_subagent` tool message, whose tool call id is the T3 task id. Reads are best-effort: a
 * missing database, row, or field yields fewer steps instead of an error.
 *
 * @module provider/Layers/bobSubagentTranscript
 */
import type { TaskTranscript, TaskTranscriptEntry } from "./taskTranscript.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { finishTaskTranscript } from "./taskTranscript.ts";
import { readBobDatabase } from "./bobDatabase.ts";

/** The parent's tool message for one subagent run. `idx_messages_task` keeps this indexed. */
const SUBAGENT_TOOL_MESSAGE = `SELECT data FROM messages
  WHERE task_id = ? AND role = 'tool' AND json_valid(data)
    AND json_extract(data, '$.toolUsage.signature.id') = ?
  LIMIT 1`;

const BobSubagentToolMessage = Schema.Struct({ messages: Schema.Array(Schema.Unknown) });
const decodeBobSubagentToolMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(BobSubagentToolMessage),
);

const BobNestedMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Schema.Unknown),
  toolUsage: Schema.optional(
    Schema.Struct({
      signature: Schema.optional(
        Schema.Struct({
          name: Schema.optional(Schema.String),
          arguments: Schema.optional(Schema.Unknown),
          isError: Schema.optional(Schema.Boolean),
        }),
      ),
      labels: Schema.optional(Schema.Struct({ displayName: Schema.optional(Schema.String) })),
    }),
  ),
  _meta: Schema.optional(Schema.Struct({ hide: Schema.optional(Schema.Unknown) })),
});
const decodeBobNestedMessage = Schema.decodeUnknownOption(BobNestedMessage);

/** A message's text: Bob stores a string, or text parts for multimodal content. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      (part as Record<string, unknown>).type === "text" &&
      typeof (part as Record<string, unknown>).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n")
    .trim();
}

function argumentRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A tool call's title from Bob's own label, such as `List Files in {path}`, with its arguments
 * filled in. Falls back to the tool's name when a placeholder has no plain argument.
 */
export function bobToolTitle(
  displayName: string | undefined,
  name: string | undefined,
  args: Record<string, unknown>,
): string {
  let unfilled = false;
  const filled = displayName?.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = args[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
    unfilled = true;
    return "";
  });
  return (!unfilled && filled?.trim()) || name?.trim() || "Tool";
}

/** A command is the input worth reading; anything else shows its arguments. */
function toolInput(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === "string") return args.command.trim() || undefined;
  return Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : undefined;
}

function toEntry(raw: unknown): TaskTranscriptEntry | undefined {
  const message = Option.getOrUndefined(decodeBobNestedMessage(raw));
  if (message === undefined || message._meta?.hide === true) return undefined;
  const text = contentText(message.content);
  switch (message.role) {
    case "user":
      return text ? { _tag: "prompt", text } : undefined;
    case "assistant":
      return text ? { _tag: "message", text } : undefined;
    case "tool": {
      const signature = message.toolUsage?.signature;
      const args = argumentRecord(signature?.arguments);
      const input = toolInput(args);
      return {
        _tag: "tool",
        title: bobToolTitle(message.toolUsage?.labels?.displayName, signature?.name, args),
        ...(input ? { input } : {}),
        ...(text ? { output: text } : {}),
        failed: signature?.isError === true,
      };
    }
    default:
      // System prompts and anything newer Bob adds.
      return undefined;
  }
}

/** The steps of a subagent's conversation before its report (see `finishTaskTranscript`). */
export function bobSubagentTranscriptEntries(messages: ReadonlyArray<unknown>): TaskTranscript {
  return finishTaskTranscript(messages.flatMap((message) => toEntry(message) ?? []));
}

/**
 * The steps of the subagent run by tool call `toolCallId` in Bob task `parentTaskId`. Empty when
 * Bob has not stored the run or the database cannot be read.
 */
export const readBobSubagentTranscript = Effect.fn("readBobSubagentTranscript")(function* (
  databasePath: string,
  parentTaskId: string,
  toolCallId: string,
) {
  const data = yield* readBobDatabase(
    databasePath,
    (database) => database.prepare(SUBAGENT_TOOL_MESSAGE).get(parentTaskId, toolCallId)?.data,
  );
  const stored =
    typeof data === "string"
      ? Option.getOrUndefined(decodeBobSubagentToolMessage(data))
      : undefined;
  return stored === undefined
    ? ({ entries: [] } satisfies TaskTranscript)
    : bobSubagentTranscriptEntries(stored.messages);
});
