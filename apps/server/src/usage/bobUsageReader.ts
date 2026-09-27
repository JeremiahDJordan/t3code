// Node fs tells a missing database apart, and node:timers yields between rows.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reads Bob Shell's per-request spend from its task database.
 *
 * Bob keeps no transcript files. Each assistant row in `messages` carries that
 * request's spend in `data._meta.spend` (Bobcoins and context size) and its
 * time in `data._meta.timestamp`; `messages.created_at` is not the request time
 * because Bob re-inserts rows. Turns cancelled or failed before an assistant
 * message still charge the task but leave no row, so they are missing here.
 *
 * Bob 2.0.5 writes no rows for subagent tasks. Their spend is only in the task's
 * running `tasks.costs`, so it is counted once, at the task's last update.
 *
 * @module bobUsageReader
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeTimersPromises from "node:timers/promises";

import type { UsageTokenTotals } from "@t3tools/contracts";

import { bobTableColumns, withBobDatabase } from "../provider/Layers/bobDatabase.ts";
import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

/** The unit Bob bills in, as its own usage display names it. */
const BOB_CREDIT_UNIT = "Bobcoins";

/** Model for tasks whose `env` does not name one, as with older Bob. */
const UNKNOWN_BOB_MODEL = "bob";

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number {
  const number = finite(value);
  return number !== null && number > 0 ? Math.round(number) : 0;
}

/**
 * Token counts for one request. Older Bob recorded `input` (including cache
 * reads and writes) and `output`. From Bob 2.0.5 only `contextTokens`, the
 * request's context size, remains; it counts as uncached input because that is
 * what the request sent, though it also holds the reply, which Bob no longer
 * separates.
 */
function bobTokenTotals(row: Record<string, unknown>): UsageTokenTotals {
  if (finite(row.input) === null && finite(row.output) === null) {
    return {
      uncachedInputTokens: count(row.contextTokens),
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
  }
  const input = count(row.input);
  const cachedInputTokens = Math.min(input, count(row.cacheRead));
  const cacheCreationTokens = Math.min(input - cachedInputTokens, count(row.cacheWrite));
  const outputTokens = count(row.output);
  return {
    uncachedInputTokens: input - cachedInputTokens - cacheCreationTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, count(row.reasoningTokens)),
  };
}

/** One query row as a usage record, or `null` for a message Bob did not charge for. */
function parseBobMessage(
  row: Record<string, unknown>,
): (UsageRecord & { readonly dedupeKey: string }) | null {
  const timestampMs = finite(row.timestampMs);
  const cost = finite(row.cost);
  if (typeof row.id !== "string" || timestampMs === null || cost === null || cost < 0) return null;
  const totals = bobTokenTotals(row);
  if (cost === 0 && totalTokens(totals) === 0) return null;
  const model = typeof row.model === "string" ? row.model.trim() : "";
  return {
    provider: "bob",
    timestampMs,
    model: model || UNKNOWN_BOB_MODEL,
    sessionId: typeof row.sessionId === "string" ? row.sessionId : "",
    totals,
    // Bobcoins are not dollars. Leaving this null keeps them out of `costUsd`.
    reportedCostUsd: null,
    credits: { amount: cost, unit: BOB_CREDIT_UNIT },
    fast: false,
    dedupeKey: `bob:${row.id}`,
  };
}

/**
 * Assistant rows of tasks touched since the window, narrowed by the indexed
 * `tasks.updated_at` (the only indexed time); rows before the window are
 * dropped after reading. `CROSS JOIN` keeps SQLite on that index rather than
 * scanning every message. The inner query pulls the small `_meta` out of each
 * large `data` once, and `OFFSET 0` stops SQLite from flattening it into the
 * outer query, which would re-read `data` per column. `json_valid` keeps one
 * malformed row from failing the query. Older Bob wrote rows for subagent
 * tasks, which count toward their parent's session. Optional columns missing
 * from older schemas fall back.
 */
function usageQuery(taskColumns: ReadonlySet<string>): { sql: string; windowed: boolean } {
  const windowed = taskColumns.has("updated_at");
  const sessionId = taskColumns.has("parent_id") ? "COALESCE(t.parent_id, t.id)" : "t.id";
  const model = taskColumns.has("env") ? taskModel("t") : "NULL";
  return {
    windowed,
    sql: `
SELECT
  id,
  taskId,
  sessionId,
  model,
  json_extract(meta, '$.timestamp') AS timestampMs,
  json_extract(meta, '$.spend.cost') AS cost,
  json_extract(meta, '$.spend.contextTokens') AS contextTokens,
  json_extract(meta, '$.spend.input') AS input,
  json_extract(meta, '$.spend.output') AS output,
  json_extract(meta, '$.spend.cacheRead') AS cacheRead,
  json_extract(meta, '$.spend.cacheWrite') AS cacheWrite,
  json_extract(meta, '$.spend.reasoningTokens') AS reasoningTokens
FROM (
  SELECT
    m.id AS id,
    t.id AS taskId,
    ${sessionId} AS sessionId,
    ${model} AS model,
    CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$._meta') END AS meta
  FROM tasks AS t
  CROSS JOIN messages AS m ON m.task_id = t.id
  WHERE m.role = 'assistant'${windowed ? " AND t.updated_at >= ?" : ""}
  LIMIT -1 OFFSET 0
)`,
  };
}

/** The model a task's `env` names, as SQL over the task aliased `alias`. */
function taskModel(alias: string): string {
  return `CASE WHEN json_valid(${alias}.env) THEN json_extract(${alias}.env, '$.model.id') END`;
}

/**
 * Subagent tasks touched since the window, with their running spend from
 * `tasks.costs`, on their parent's session. Bob 2.0.5 names no model on a
 * subagent task, so its parent's stands in. Null when the schema predates any
 * of these columns.
 */
function subagentQuery(taskColumns: ReadonlySet<string>): string | null {
  if (!["parent_id", "costs", "updated_at"].every((column) => taskColumns.has(column))) {
    return null;
  }
  const model = taskColumns.has("env") ? `COALESCE(${taskModel("t")}, ${taskModel("p")})` : "NULL";
  return `
SELECT
  t.id AS id,
  t.parent_id AS sessionId,
  ${model} AS model,
  t.updated_at AS timestampMs,
  CASE WHEN json_valid(t.costs) THEN json_extract(t.costs, '$.cost') END AS cost,
  CASE WHEN json_valid(t.costs) THEN json_extract(t.costs, '$.contextTokens') END AS contextTokens
FROM tasks AS t
LEFT JOIN tasks AS p ON p.id = t.parent_id
WHERE t.parent_id IS NOT NULL AND t.updated_at >= ?`;
}

/** Summing the same spend in another order leaves rounding dust, which is not spend. */
const BOB_CREDIT_EPSILON = 1e-9;

export interface BobUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
}

/**
 * Reads the charged requests of every task Bob updated at or after `sinceMs`.
 * The connection is read-only and closed before returning, so Bob keeps writing;
 * a busy Bob fails this source promptly rather than stalling the server.
 */
export async function readBobUsage(
  databasePath: string,
  sinceMs: number,
): Promise<BobUsageReadResult> {
  try {
    await NodeFSP.access(databasePath);
  } catch (cause) {
    const missing = (cause as { code?: unknown }).code === "ENOENT";
    return { files: [], missing, error: !missing };
  }
  const file = { path: databasePath, records: [] as UsageRecord[] };
  const seen = new Set<string>();
  // Resolves to whether the read failed; records read before a failure are kept.
  const error = await withBobDatabase(databasePath, async (database) => {
    const taskColumns = bobTableColumns(database, "tasks");
    const messageColumns = bobTableColumns(database, "messages");
    if (
      !taskColumns.has("id") ||
      !["id", "task_id", "role", "data"].every((column) => messageColumns.has(column))
    ) {
      return true;
    }
    const add = (record: ReturnType<typeof parseBobMessage>) => {
      if (record !== null && record.timestampMs >= sinceMs && !seen.has(record.dedupeKey)) {
        seen.add(record.dedupeKey);
        file.records.push(record);
      }
    };
    const { sql, windowed } = usageQuery(taskColumns);
    // Bobcoins in each task's rows, before the window drops any.
    const rowSpend = new Map<unknown, number>();
    let rows = 0;
    for (const row of database.prepare(sql).iterate(...(windowed ? [sinceMs] : []))) {
      rowSpend.set(
        row.taskId,
        (rowSpend.get(row.taskId) ?? 0) + Math.max(0, finite(row.cost) ?? 0),
      );
      add(parseBobMessage(row));
      if (++rows % 256 === 0) await NodeTimersPromises.setImmediate();
    }
    const subagents = subagentQuery(taskColumns);
    if (subagents === null) return false;
    for (const row of database.prepare(subagents).iterate(sinceMs)) {
      // What the task's rows leave out, which is all of it from Bob 2.0.5. Rows
      // an older Bob wrote carry their own tokens, so the rest carries none.
      const unrecorded = (finite(row.cost) ?? 0) - (rowSpend.get(row.id) ?? 0);
      if (unrecorded > BOB_CREDIT_EPSILON) {
        add(
          parseBobMessage({
            ...row,
            id: `task:${String(row.id)}`,
            cost: unrecorded,
            contextTokens: rowSpend.has(row.id) ? null : row.contextTokens,
          }),
        );
      }
      if (++rows % 256 === 0) await NodeTimersPromises.setImmediate();
    }
    return false;
  }).catch(() => true);
  return { files: [file], missing: false, error };
}
