/**
 * This fork's step after the V1→V2 thread migration: migrated Bob threads continue their Bob
 * task. The migration keeps transcripts but not provider sessions, so a migrated thread's next
 * message would start a new Bob task. A V1 Bob thread names its task in its
 * `provider_session_runtime` row's resume cursor; this gives the migrated thread a provider
 * thread on that task, which the Bob adapter resumes like an imported Bob task.
 *
 * It runs after every shell reconcile and touches only migrated threads without an active
 * provider thread, and never a task another thread already has, so it is idempotent without a
 * ledger of its own.
 *
 * @module orchestration-v2/legacy/bobThreadRelink
 */
import {
  EventId,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { bobResumeCursorTaskId } from "../../provider/bobTaskHistory.ts";
import * as EventSink from "../EventSink.ts";
import { deriveProviderThread } from "@t3tools/provider-core/server/IdAllocator";

const BOB = ProviderDriverKind.make("bob");

interface MigratedBobThreadRow {
  readonly thread_id: string;
  readonly provider_instance_id: string;
  readonly resume_cursor_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * Point each migrated Bob thread that has not run in V2 at the Bob task its V1 session used.
 * Never fails: a thread it cannot re-link starts a new Bob task, as upstream migrates it.
 * Returns how many threads it re-linked.
 */
export const relinkMigratedBobThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSink.EventSinkV2;
  const rows = yield* sql<MigratedBobThreadRow>`
    SELECT
      thread.thread_id,
      COALESCE(runtime.provider_instance_id, thread.provider_instance_id) AS provider_instance_id,
      runtime.resume_cursor_json,
      thread.created_at,
      thread.updated_at
    FROM orchestration_v2_legacy_imports AS legacy_import
    INNER JOIN orchestration_v2_projection_threads AS thread
      ON thread.thread_id = legacy_import.thread_id
    INNER JOIN provider_session_runtime AS runtime
      ON runtime.thread_id = legacy_import.thread_id
    WHERE runtime.provider_name = 'bob'
      AND thread.active_provider_thread_id IS NULL
      AND thread.deleted_at IS NULL
    ORDER BY thread.updated_at DESC, thread.thread_id ASC
  `;
  // Two threads on one task would share a provider thread; the most recent one keeps it.
  const linkedProviderThreads = new Set<string>();
  let relinked = 0;
  for (const row of rows) {
    const taskId = bobResumeCursorTaskId(Option.getOrUndefined(decodeJson(row.resume_cursor_json)));
    if (taskId === undefined) continue;
    const threadId = ThreadId.make(row.thread_id);
    const providerInstanceId = ProviderInstanceId.make(row.provider_instance_id);
    const providerThreadId = deriveProviderThread({
      driver: BOB,
      providerInstanceId,
      nativeThreadId: taskId,
    });
    if (linkedProviderThreads.has(providerThreadId)) continue;
    linkedProviderThreads.add(providerThreadId);
    // A task an earlier start already gave a thread stays that thread's.
    const owned = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM orchestration_v2_projection_provider_threads
      WHERE provider_thread_id = ${providerThreadId}
      LIMIT 1
    `;
    if (owned.length > 0) continue;
    // The thread's own times, so re-linking does not reorder the sidebar.
    const createdAt = DateTime.makeUnsafe(row.created_at);
    const updatedAt = DateTime.makeUnsafe(row.updated_at);
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver: BOB,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver: BOB, nativeId: taskId, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      // No V2 items exist yet, so new ones get the scoped ids a fresh ACP thread gets.
      nativeMetadata: { itemIdentityVersion: 2 },
      createdAt,
      updatedAt,
    };
    // Projecting the provider thread makes it the thread's active one.
    const written = yield* eventSink
      .write({
        events: [
          {
            id: EventId.make(`fork:bob-relink:provider-thread:${threadId}`),
            type: "provider-thread.updated",
            threadId,
            driver: BOB,
            providerInstanceId,
            occurredAt: updatedAt,
            payload: providerThread,
          },
        ],
      })
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("Could not re-link a migrated Bob thread to its task", {
            threadId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
    if (written) relinked += 1;
  }
  if (relinked > 0) yield* Effect.logInfo("Re-linked migrated Bob threads", { relinked });
  return relinked;
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not re-link migrated Bob threads", { cause }).pipe(Effect.as(0)),
  ),
);
