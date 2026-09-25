// node:sqlite reads Bob Shell's live task database; Node fs tells a missing one apart.
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
 * @module bobUsageReader
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

import type { UsageTokenTotals } from "@t3tools/contracts";

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
 * malformed row from failing the query. Subagent tasks count toward their
 * parent's session. Optional columns missing from older schemas fall back.
 */
function usageQuery(taskColumns: ReadonlySet<unknown>): { sql: string; windowed: boolean } {
  const windowed = taskColumns.has("updated_at");
  const sessionId = taskColumns.has("parent_id") ? "COALESCE(t.parent_id, t.id)" : "t.id";
  const model = taskColumns.has("env")
    ? "CASE WHEN json_valid(t.env) THEN json_extract(t.env, '$.model.id') END"
    : "NULL";
  return {
    windowed,
    sql: `
SELECT
  id,
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

function columns(database: NodeSqlite.DatabaseSync, table: string): ReadonlySet<unknown> {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
}

export interface BobUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
}

/**
 * Reads the charged requests of every task Bob updated at or after `sinceMs`.
 * The connection is read-only and closed before returning, so Bob keeps writing.
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
  let error = false;
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    // A busy Bob should fail this source promptly rather than stalling the
    // server while SQLite waits for its writer.
    database.exec("PRAGMA busy_timeout = 100");
    const taskColumns = columns(database, "tasks");
    const messageColumns = columns(database, "messages");
    if (
      !taskColumns.has("id") ||
      !["id", "task_id", "role", "data"].every((column) => messageColumns.has(column))
    ) {
      error = true;
    } else {
      const { sql, windowed } = usageQuery(taskColumns);
      let rows = 0;
      for (const row of database.prepare(sql).iterate(...(windowed ? [sinceMs] : []))) {
        const record = parseBobMessage(row);
        if (record !== null && record.timestampMs >= sinceMs && !seen.has(record.dedupeKey)) {
          seen.add(record.dedupeKey);
          file.records.push(record);
        }
        if (++rows % 256 === 0) await NodeTimersPromises.setImmediate();
      }
    }
  } catch {
    error = true;
  } finally {
    database?.close();
  }
  return { files: [file], missing: false, error };
}
