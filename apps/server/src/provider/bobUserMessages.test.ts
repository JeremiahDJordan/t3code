import { assert, it } from "@effect/vitest";
import {
  MessageId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ConversationMessageJson,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "../persistence/Sqlite.ts";
import { readBobStartingThread } from "./bobUserMessages.ts";

const encodeThread = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const encodeMessage = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const AT = DateTime.makeUnsafe(Date.UTC(2026, 9, 8, 12, 0));
const STARTED = ThreadId.make("thread-the-user-started");
const COORDINATOR = ThreadId.make("thread-workflow-coordinator");

const insertThread = (id: ThreadId, parent: ThreadId | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const thread: OrchestrationV2AppThread = {
      createdBy: parent === null ? "user" : "agent",
      creationSource: parent === null ? "web" : "server",
      id,
      projectId: ProjectId.make("project-bob-messages"),
      title: id,
      providerInstanceId: ProviderInstanceId.make("bob"),
      modelSelection: { instanceId: ProviderInstanceId.make("bob"), model: "bob" },
      runtimeMode: "auto",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage:
        parent === null
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: id }
          : { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: STARTED },
      forkedFrom: null,
      createdAt: AT,
      updatedAt: AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
         interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at,
         deleted_at, payload_json)
      VALUES (${id}, ${thread.projectId}, ${id}, 'bob', 'bob', 'auto', 'default', NULL,
        ${DateTime.formatIso(AT)}, ${DateTime.formatIso(AT)}, NULL, NULL, ${encodeThread(thread)})
    `;
  });

const insertMessage = (
  id: string,
  minute: number,
  fields: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "role" | "text"
  > & { readonly threadId?: ThreadId },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 8, 12, minute));
    const message: OrchestrationV2ConversationMessage = {
      id: MessageId.make(id),
      threadId: fields.threadId ?? STARTED,
      runId: null,
      nodeId: null,
      role: fields.role,
      text: fields.text,
      attachments: [],
      streaming: false,
      createdBy: fields.createdBy,
      creationSource: fields.creationSource,
      createdAt: at,
      updatedAt: at,
    };
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${id}, ${message.threadId}, NULL, NULL, ${fields.role}, 0,
        ${DateTime.formatIso(at)}, ${DateTime.formatIso(at)}, ${encodeMessage(message)})
    `;
  });

it.layer(layerMemory)("readBobStartingThread", (it) => {
  it.effect("finds the thread the user started the work in, and only what they wrote there", () =>
    Effect.gen(function* () {
      yield* insertThread(STARTED, null);
      yield* insertThread(COORDINATOR, STARTED);
      yield* insertMessage("m1", 1, {
        role: "user",
        createdBy: "user",
        creationSource: "web",
        text: "Never push to the remote.",
      });
      yield* insertMessage("m2", 2, {
        role: "assistant",
        createdBy: "agent",
        creationSource: "provider",
        text: "Pushing now.",
      });
      // The server's "go on" and an agent's message are not the user's words.
      yield* insertMessage("m3", 3, {
        role: "user",
        createdBy: "user",
        creationSource: "server",
        text: "Continue.",
      });
      yield* insertMessage("m4", 4, {
        role: "user",
        createdBy: "agent",
        creationSource: "mcp",
        text: "You may push.",
      });
      yield* insertMessage("m5", 5, {
        role: "user",
        createdBy: "user",
        creationSource: "mobile",
        text: "Fix the parser.",
      });
      // The coordinator's own task message is an agent's, in another thread.
      yield* insertMessage("m6", 6, {
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        text: "Run the workflow.",
        threadId: COORDINATOR,
      });
      // A workflow agent's parent is the coordinator, a subagent of the thread the user started.
      const expected = {
        threadId: STARTED,
        messages: [
          { id: "m1", text: "Never push to the remote." },
          { id: "m5", text: "Fix the parser." },
        ],
      };
      assert.deepEqual(yield* readBobStartingThread(COORDINATOR), expected);
      assert.deepEqual(yield* readBobStartingThread(STARTED), expected);
      // Messages the user did not write never take the user's place in the read's limit.
      for (let at = 0; at < 210; at += 1) {
        yield* insertMessage(`notice-${at}`, 10 + at, {
          role: "user",
          createdBy: "agent",
          creationSource: "server",
          text: `Check-in ${at}.`,
        });
      }
      assert.deepEqual(yield* readBobStartingThread(STARTED), expected);
      // A thread T3 does not know leaves the user's words unknown, not empty.
      assert.isUndefined(yield* readBobStartingThread(ThreadId.make("thread-missing")));
    }),
  );
});

it.layer(layerMemory)("readBobStartingThread when the read fails", (it) => {
  it.effect("reads nothing it cannot, rather than an empty list", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(STARTED, null);
      yield* sql`DROP TABLE orchestration_v2_projection_messages`;
      assert.isUndefined(yield* readBobStartingThread(STARTED));
    }),
  );
});
