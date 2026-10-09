import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "../persistence/Sqlite.ts";
import { bobDelegatedTaskEnded } from "./bobDelegatedTask.ts";

const ENDED_AT = "2026-10-09T00:00:00.000Z";

const insertSpawn = (childThreadId: string, targetRunId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, target_run_id, type, status,
         updated_at, payload_json)
      VALUES (${`spawn-${childThreadId}`}, 'thread-parent', ${childThreadId}, ${targetRunId},
        'subagent_spawn', 'completed', ${ENDED_AT}, '{}')
    `;
  });

const insertRow = (childThreadId: string, origin: string, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_subagents
        (subagent_id, thread_id, run_id, parent_node_id, provider, provider_thread_id,
         child_thread_id, origin, status, started_at, completed_at, updated_at, payload_json)
      VALUES (${`task-${childThreadId}`}, 'thread-parent', NULL, 'node-parent', 'bob', NULL,
        ${childThreadId}, ${origin}, ${status}, NULL, ${ENDED_AT}, ${ENDED_AT}, '{}')
    `;
  });

const insertRun = (threadId: string, ordinal: number, requestedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
         completed_at, payload_json)
      VALUES (${`run-${threadId}-${ordinal}`}, ${threadId}, ${ordinal}, 'bob', NULL, 'running',
        ${requestedAt}, NULL, '{}')
    `;
  });

it.layer(layerMemory)("bobDelegatedTaskEnded", (it) => {
  it.effect("is true only for a delegated task whose row ended with no later run", () =>
    Effect.gen(function* () {
      yield* insertRow("thread-interrupted", "app_owned", "interrupted");
      yield* insertRow("thread-running", "app_owned", "running");
      // A subagent the provider spawned itself is not T3's delegated task.
      yield* insertRow("thread-native", "provider_native", "completed");
      assert.isTrue(yield* bobDelegatedTaskEnded(ThreadId.make("thread-interrupted")));
      assert.isFalse(yield* bobDelegatedTaskEnded(ThreadId.make("thread-running")));
      assert.isFalse(yield* bobDelegatedTaskEnded(ThreadId.make("thread-native")));
      // An ordinary thread has no row.
      assert.isFalse(yield* bobDelegatedTaskEnded(ThreadId.make("thread-top-level")));
      // A turn the user added in the task's thread is theirs, even one queued before the task
      // ended, which starts after it.
      yield* insertRow("thread-followed-up", "app_owned", "completed");
      yield* insertRun("thread-followed-up", 1, "2026-10-08T23:00:00.000Z");
      assert.isTrue(yield* bobDelegatedTaskEnded(ThreadId.make("thread-followed-up")));
      yield* insertRun("thread-followed-up", 2, "2026-10-08T23:30:00.000Z");
      assert.isFalse(yield* bobDelegatedTaskEnded(ThreadId.make("thread-followed-up")));
      // The task's own run is the one its spawn started, not the thread's first.
      yield* insertRow("thread-spawned", "app_owned", "interrupted");
      yield* insertRun("thread-spawned", 1, "2026-10-08T22:00:00.000Z");
      yield* insertRun("thread-spawned", 2, "2026-10-08T23:00:00.000Z");
      yield* insertSpawn("thread-spawned", "run-thread-spawned-2");
      assert.isTrue(yield* bobDelegatedTaskEnded(ThreadId.make("thread-spawned")));
      yield* insertRun("thread-spawned", 3, "2026-10-09T01:00:00.000Z");
      assert.isFalse(yield* bobDelegatedTaskEnded(ThreadId.make("thread-spawned")));
    }),
  );
});
