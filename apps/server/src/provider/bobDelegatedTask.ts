import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Whether a thread is a task another agent delegated whose answer was already taken: its row
 * ended, as recovery ends a delegated task's row when T3 restarts mid-turn, and the thread has no
 * run after the task's own. A Bob prompt kept running in tmux for such a thread would answer no
 * one, beside a Retry doing the same work, so its relay is stopped rather than adopted. A run the
 * user added there is theirs and is kept, even one queued before the task ended. The task's own
 * run is the one its spawn started, as `task_status` reads it, else the thread's first. False when
 * the row cannot be read.
 */
export const bobDelegatedTaskEnded = (
  threadId: ThreadId,
): Effect.Effect<boolean, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string; readonly later: number }>`
      SELECT task.status AS status, (
        SELECT COUNT(*) FROM orchestration_v2_projection_runs AS run
        WHERE run.thread_id = task.child_thread_id
          AND run.ordinal > COALESCE(
            (
              SELECT own.ordinal
              FROM orchestration_v2_projection_context_transfers AS spawn
              JOIN orchestration_v2_projection_runs AS own ON own.run_id = spawn.target_run_id
              WHERE spawn.type = 'subagent_spawn'
                AND spawn.source_thread_id = task.thread_id
                AND spawn.target_thread_id = task.child_thread_id
            ),
            (
              SELECT MIN(earliest.ordinal) FROM orchestration_v2_projection_runs AS earliest
              WHERE earliest.thread_id = task.child_thread_id
            )
          )
      ) AS later
      FROM orchestration_v2_projection_subagents AS task
      WHERE task.child_thread_id = ${threadId} AND task.origin = 'app_owned'
    `;
    return rows.some(
      (row) =>
        ["completed", "failed", "cancelled", "interrupted"].includes(row.status) && row.later === 0,
    );
  }).pipe(Effect.orElseSucceed(() => false));
