import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WorkflowSourceStore from "./WorkflowSourceStore.ts";

const run = { kind: "run", name: "judged-review", phases: [{ title: "Review" }] };
const claudeWorkflow = { phases: [{ index: 0, title: "Plan" }], agents: [] };

const insertSubagent = (id: string, payload: object) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_subagents (
        subagent_id, thread_id, run_id, parent_node_id, provider, driver, provider_instance_id,
        provider_thread_id, child_thread_id, origin, status, started_at, completed_at, updated_at,
        payload_json
      )
      VALUES (
        ${id}, 'thread:parent', NULL, 'node:root', 't3-workflow', 'codex', 't3-workflow', NULL,
        NULL, 'app_owned', 'completed', NULL, NULL, '2026-10-08T00:00:00.000Z',
        ${JSON.stringify({ id, ...payload })}
      )
    `;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      )
      VALUES (
        ${`event:${id}`}, 'thread', 'thread:parent', ${id === "node:legacy" ? 1 : 2},
        'subagent.updated', '2026-10-08T00:00:00.000Z', 'server',
        ${JSON.stringify({ id, ...payload })}, '{}', 2
      )
    `;
  });

const readPayloads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const subagents = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_subagents ORDER BY subagent_id
  `;
  const events = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_events ORDER BY sequence
  `;
  return {
    subagents: subagents.map((row) => JSON.parse(row.payload_json)),
    events: events.map((row) => JSON.parse(row.payload_json)),
  };
});

describe("WorkflowSourceStore", () => {
  it.effect("moves a T3 workflow's card facts from `workflow` to `t3Workflow`, once", () =>
    Effect.gen(function* () {
      yield* insertSubagent("node:legacy", { workflow: run });
      yield* insertSubagent("node:claude", { workflow: claudeWorkflow });

      yield* Layer.build(WorkflowSourceStore.layer).pipe(Effect.scoped);
      const moved = yield* readPayloads;
      expect(moved.subagents).toEqual([
        { id: "node:claude", workflow: claudeWorkflow },
        { id: "node:legacy", t3Workflow: run },
      ]);
      expect(moved.events).toEqual([
        { id: "node:legacy", t3Workflow: run },
        { id: "node:claude", workflow: claudeWorkflow },
      ]);

      // A second start finds nothing to move and leaves the rows alone.
      yield* Layer.build(WorkflowSourceStore.layer).pipe(Effect.scoped);
      expect(yield* readPayloads).toEqual(moved);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
