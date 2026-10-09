import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2ConversationMessageJson,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Whether the user wrote a message, rather than an agent, or the server on their behalf, such as
 * the "go on" after a usage limit lifts.
 */
export function isUserWritten(message: {
  readonly createdBy: string;
  readonly creationSource: string;
}): boolean {
  return (
    message.createdBy === "user" &&
    message.creationSource !== "server" &&
    message.creationSource !== "provider"
  );
}

/** One message the user wrote: its id, and what they typed, without attachments. */
export interface BobUserWrittenMessage {
  readonly id: string;
  readonly text: string;
}

const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const decodeThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

/**
 * How many of a thread's latest user messages are read: more than Auto's reviewer keeps
 * restrictions from, so the reviewer's own limits decide which go.
 */
const READ_LIMIT = 200;
/** How far up a chain of subagents the starting thread is looked for. */
const MAX_DEPTH = 32;

/** The thread delegated work started in, and what the user wrote there. */
export interface BobStartingThread {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<BobUserWrittenMessage>;
}

/**
 * The thread the work an agent was delegated started in, found from the agent's parent by going
 * up through subagent threads, such as a workflow's coordinator, to the first thread that is not
 * one; and what the user wrote there, oldest first. Auto's reviewer takes the restrictions and
 * permissions the agent works under from those messages. Reads the projection's rows directly,
 * rather than loading whole threads. Undefined when a thread on the way is missing or a read
 * fails, which the reviewer treats as restrictions it cannot see.
 */
export const readBobStartingThread = (
  parentThreadId: ThreadId,
): Effect.Effect<BobStartingThread | undefined, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let threadId = parentThreadId;
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const [row] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
      const thread =
        row === undefined ? undefined : Option.getOrUndefined(decodeThread(row.payload_json));
      if (thread === undefined) return undefined;
      const { lineage } = thread;
      if (lineage.relationshipToParent === "subagent" && lineage.parentThreadId !== null) {
        threadId = lineage.parentThreadId;
        continue;
      }
      // Only the user's own messages count toward the limit, so check-ins, wakes and agents'
      // messages cannot push them out of it; the decoded rows are checked again below.
      const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_messages
        WHERE thread_id = ${threadId} AND role = 'user'
          AND json_extract(payload_json, '$.createdBy') = 'user'
          AND json_extract(payload_json, '$.creationSource') NOT IN ('server', 'provider')
        ORDER BY updated_at DESC, message_id DESC
        LIMIT ${READ_LIMIT}
      `;
      const messages = rows
        .flatMap((message) => Option.toArray(decodeMessage(message.payload_json)))
        .filter((message) => !message.streaming && isUserWritten(message))
        .map((message) => ({ id: message.id, text: message.text }))
        .toReversed();
      return { threadId, messages };
    }
    return undefined;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not read the user's messages for Auto's reviewer", {
        parentThreadId,
        cause,
      }).pipe(Effect.as(undefined)),
    ),
  );
