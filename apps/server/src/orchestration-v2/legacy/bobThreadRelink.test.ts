import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import { deriveProviderThread } from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";

const databaseLayer = SqlitePersistenceMemory;
const storesProvided = Layer.mergeAll(
  databaseLayer,
  EventStore.layer.pipe(Layer.provideMerge(databaseLayer)),
  ProjectionStore.layer.pipe(Layer.provideMerge(databaseLayer)),
);
const eventSinkProvided = EventSink.layer.pipe(Layer.provide(storesProvided));
const TestLayer = Layer.mergeAll(
  storesProvided,
  eventSinkProvided,
  LegacyV1ThreadImporter.layer.pipe(
    Layer.provide(Layer.mergeAll(storesProvided, eventSinkProvided)),
  ),
  ProjectionMaintenance.layer.pipe(Layer.provide(storesProvided)),
);

const UPDATED_AT = "2026-09-20T12:00:00.000Z";

/** A V1 thread as the fork's V1 server left it: its row, two messages and its runtime row. */
const insertV1Thread = Effect.fn("insertV1Thread")(function* (input: {
  readonly threadId: string;
  readonly instanceId: string;
  readonly providerName: string;
  readonly resumeCursorJson: string | null;
  readonly deletedAt?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const modelSelection = `{"instanceId":"${input.instanceId}","model":"default"}`;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at,
      settled_override, settled_at, unsettled_at, snoozed_until, snoozed_at, pinned_at,
      pin_order_key, linked_pull_request_json, deleted_at
    ) VALUES (
      ${input.threadId}, 'project:bob', ${input.threadId}, ${modelSelection}, 'full-access',
      'default', NULL, NULL, NULL, '2026-09-01T10:00:00.000Z', ${UPDATED_AT}, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, ${input.deletedAt ?? null}
    )
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, attachments_json, is_streaming,
      created_at, updated_at
    ) VALUES
      (${`${input.threadId}:1`}, ${input.threadId}, NULL, 'user', 'Fix the build', '[]', 0,
        '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z'),
      (${`${input.threadId}:2`}, ${input.threadId}, NULL, 'assistant', 'Fixed', '[]', 0,
        '2026-09-01T10:01:00.000Z', '2026-09-01T10:01:00.000Z')
  `;
  yield* sql`
    INSERT INTO provider_session_runtime (
      thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
      last_seen_at, resume_cursor_json, runtime_payload_json
    ) VALUES (
      ${input.threadId}, ${input.providerName}, ${input.instanceId}, ${input.providerName},
      'full-access', 'stopped', ${UPDATED_AT}, ${input.resumeCursorJson}, '{"cwd":"/work/bob"}'
    )
  `;
});

it.layer(TestLayer)("relinkMigratedBobThreads", (it) => {
  it.effect("points migrated Bob threads at their Bob task, once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'project:bob', 'Bob project', '/work/bob', NULL, '[]',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL
        )
      `;
      // The fork's V1 cursor, with the turn start times its rollback used.
      yield* insertV1Thread({
        threadId: "thread:bob",
        instanceId: "bob_api",
        providerName: "bob",
        resumeCursorJson: '{"schemaVersion":1,"sessionId":"task-1","turnStartedAt":[1,null]}',
      });
      // Two V1 threads on one task: the first keeps it, on every start.
      yield* insertV1Thread({
        threadId: "thread:bob-same-task",
        instanceId: "bob_api",
        providerName: "bob",
        resumeCursorJson: '{"schemaVersion":1,"sessionId":"task-1"}',
      });
      yield* insertV1Thread({
        threadId: "thread:bob-unreadable",
        instanceId: "bob",
        providerName: "bob",
        resumeCursorJson: '{"threadId":"thread:bob-unreadable"}',
      });
      yield* insertV1Thread({
        threadId: "thread:bob-deleted",
        instanceId: "bob",
        providerName: "bob",
        resumeCursorJson: '{"schemaVersion":1,"sessionId":"task-2"}',
        deletedAt: UPDATED_AT,
      });
      yield* insertV1Thread({
        threadId: "thread:codex",
        instanceId: "codex",
        providerName: "codex",
        resumeCursorJson: '{"threadId":"codex-thread"}',
      });

      yield* importer.reconcileShells;
      // A later start finds nothing left to re-link.
      yield* importer.reconcileShells;

      const bob = yield* projections.getThreadProjection(ThreadId.make("thread:bob"));
      const providerThreadId = deriveProviderThread({
        driver: ProviderDriverKind.make("bob"),
        providerInstanceId: ProviderInstanceId.make("bob_api"),
        nativeThreadId: "task-1",
      });
      assert.equal(bob.thread.activeProviderThreadId, providerThreadId);
      assert.deepEqual(bob.thread.updatedAt, DateTime.makeUnsafe(UPDATED_AT));
      assert.deepStrictEqual(
        bob.providerThreads.map((thread) => ({
          id: thread.id,
          providerInstanceId: thread.providerInstanceId,
          nativeThreadRef: thread.nativeThreadRef,
          status: thread.status,
        })),
        [
          {
            id: providerThreadId,
            providerInstanceId: ProviderInstanceId.make("bob_api"),
            nativeThreadRef: {
              driver: ProviderDriverKind.make("bob"),
              nativeId: "task-1",
              strength: "strong",
            },
            status: "idle",
          },
        ],
      );
      for (const threadId of [
        "thread:bob-same-task",
        "thread:bob-unreadable",
        "thread:bob-deleted",
        "thread:codex",
      ]) {
        const untouched = yield* projections.getThreadProjection(ThreadId.make(threadId));
        assert.isNull(untouched.thread.activeProviderThreadId, threadId);
        assert.lengthOf(untouched.providerThreads, 0, threadId);
      }
      const relinkEvents = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events
        WHERE event_type = 'provider-thread.updated'
      `;
      assert.equal(relinkEvents[0]?.count, 1);
      assert.isTrue((yield* maintenance.verify).valid);
    }),
  );
});
