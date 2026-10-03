/**
 * Bob tasks that already back a T3 thread, which the onboarding import leaves out: T3 started
 * or continued them there, and importing them would duplicate that thread.
 *
 * Threads from before orchestration V2 name their task in their legacy runtime row. Threads
 * since then, and migrated threads re-linked to their task (`bobThreadRelink`), name it in
 * their V2 provider thread. Reading only the first source would offer every Bob thread started
 * after the V2 migration for import again.
 *
 * @module project/bobTasksInThreads
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { ProviderSessionRuntime } from "../persistence/ProviderSessionRuntime.ts";
import { bobResumeCursorTaskId } from "../provider/bobTaskHistory.ts";

/** Whether `threadId` is the thread an import of `taskId` created, from any Bob instance. */
function isImportOf(threadId: string, taskId: string): boolean {
  return threadId.startsWith("import:") && threadId.endsWith(`:${taskId}`);
}

/** Bob tasks bound to a T3 thread other than their own import. */
export const readBobTasksInThreads = Effect.fn("readBobTasksInThreads")(function* (
  legacyRuntimes: ReadonlyArray<
    Pick<ProviderSessionRuntime, "threadId" | "providerName" | "resumeCursor">
  >,
) {
  const sql = yield* SqlClient.SqlClient;
  const providerThreads = yield* sql<{
    readonly thread_id: string | null;
    readonly native_id: string | null;
  }>`
    SELECT thread_id, json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id
    FROM orchestration_v2_projection_provider_threads
    WHERE driver = 'bob'
  `;
  const bindings = [
    ...legacyRuntimes.flatMap((runtime) =>
      runtime.providerName === "bob"
        ? [{ threadId: runtime.threadId, taskId: bobResumeCursorTaskId(runtime.resumeCursor) }]
        : [],
    ),
    ...providerThreads.map((row) => ({ threadId: row.thread_id, taskId: row.native_id })),
  ];
  const taskIds = new Set<string>();
  for (const { threadId, taskId } of bindings) {
    if (threadId && taskId && !isImportOf(threadId, taskId)) taskIds.add(taskId);
  }
  return taskIds;
});
