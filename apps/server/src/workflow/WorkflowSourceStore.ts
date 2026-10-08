import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { workflowSourceHash } from "./WorkflowScript.ts";

export class WorkflowSourceStoreError extends Schema.TaggedError<WorkflowSourceStoreError>()(
  "WorkflowSourceStoreError",
  {
    operation: Schema.Literals(["put", "get"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} a workflow source.`;
  }
}

/**
 * Workflow scripts by content hash. A run stores its source once and carries
 * only the hash, so Retry reruns the exact text and Copy script returns it.
 */
export class WorkflowSourceStore extends Context.Service<
  WorkflowSourceStore,
  {
    /** Stores the source if it is new, returning its hash. */
    readonly put: (source: string) => Effect.Effect<string, WorkflowSourceStoreError>;
    readonly get: (hash: string) => Effect.Effect<Option.Option<string>, WorkflowSourceStoreError>;
  }
>()("t3/workflow/WorkflowSourceStore") {}

export const layer = Layer.effect(
  WorkflowSourceStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Created here rather than by a numbered migration. The migrator runs only ids above the
    // highest one a database has applied, so a fork's own migration id would make that database
    // skip whichever migration upstream later gives the same id. See FORK.md.
    yield* sql`
      CREATE TABLE IF NOT EXISTS workflow_sources (
        hash TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `.pipe(Effect.orDie);

    // Builds of this fork before upstream gave subagents a `workflow` field (a Claude workflow's
    // snapshot) stored a T3 workflow's card facts under that key; they now live in `t3Workflow`.
    // Moves such rows once, so their threads still decode. The events are rewritten only while
    // a projection row still had the old key, so later starts scan just the subagents table.
    yield* Effect.gen(function* () {
      yield* sql`
        UPDATE orchestration_v2_projection_subagents
        SET payload_json = json_set(
          json_remove(payload_json, '$.workflow'),
          '$.t3Workflow',
          json(json_extract(payload_json, '$.workflow'))
        )
        WHERE json_extract(payload_json, '$.workflow.kind') IN ('run', 'agent')
      `;
      const [moved] = yield* sql<{ readonly count: number }>`SELECT changes() AS count`;
      if ((moved?.count ?? 0) === 0) return;
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_set(
          json_remove(payload_json, '$.workflow'),
          '$.t3Workflow',
          json(json_extract(payload_json, '$.workflow'))
        )
        WHERE application_event_version = 2
          AND event_type = 'subagent.updated'
          AND json_extract(payload_json, '$.workflow.kind') IN ('run', 'agent')
      `;
    }).pipe(
      sql.withTransaction,
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not move T3 workflow rows to t3Workflow", cause),
      ),
    );

    const put = Effect.fn("WorkflowSourceStore.put")(function* (source: string) {
      const hash = workflowSourceHash(source);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO workflow_sources (hash, source, created_at)
        VALUES (${hash}, ${source}, ${createdAt})
        ON CONFLICT(hash) DO NOTHING
      `.pipe(Effect.mapError((cause) => new WorkflowSourceStoreError({ operation: "put", cause })));
      return hash;
    });

    const get = Effect.fn("WorkflowSourceStore.get")(function* (hash: string) {
      const rows = yield* sql<{ readonly source: string }>`
        SELECT source FROM workflow_sources WHERE hash = ${hash} LIMIT 1
      `.pipe(Effect.mapError((cause) => new WorkflowSourceStoreError({ operation: "get", cause })));
      return Option.fromNullishOr(rows[0]?.source);
    });

    return WorkflowSourceStore.of({ put, get });
  }),
);
