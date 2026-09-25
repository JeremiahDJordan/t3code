// @effect-diagnostics nodeBuiltinImport:off - the suite writes Bob-shaped SQLite databases with
// node:sqlite, as Bob does, and keeps them open like a running Bob.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import { readBobUsage } from "./bobUsageReader.ts";

const T = Date.parse("2026-08-01T10:00:00.000Z");
const MINUTE = 60_000;

interface BobTaskRow {
  readonly id: string;
  readonly parentId?: string;
  readonly model?: string;
  readonly updatedAt: number;
}

interface BobMessageRow {
  readonly id: string;
  readonly taskId: string;
  readonly role: string;
  /** Written verbatim, so a test can store malformed JSON. */
  readonly data: string;
}

let dir: string;
let databasePath: string;
let open: NodeSqlite.DatabaseSync | undefined;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bob-usage-reader-test-"));
  databasePath = NodePath.join(dir, "bob.db");
});

afterEach(async () => {
  open?.close();
  open = undefined;
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

/**
 * A database with the columns of Bob's `tasks` and `messages` that usage reads,
 * left open in WAL mode without checkpoints, as a running Bob holds it.
 */
function writeBobDatabase(tasks: readonly BobTaskRow[], messages: readonly BobMessageRow[]) {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  open = database;
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, env TEXT, costs TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_tasks_updated ON tasks(updated_at DESC, id DESC);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_task ON messages(task_id, created_at);
  `);
  for (const task of tasks) {
    database
      .prepare(
        "INSERT INTO tasks (id, project_id, parent_id, env, created_at, updated_at) VALUES (?, 'file:/work', ?, ?, ?, ?)",
      )
      .run(
        task.id,
        task.parentId ?? null,
        task.model === undefined ? null : JSON.stringify({ model: { id: task.model } }),
        task.updatedAt - 10 * MINUTE,
        task.updatedAt,
      );
  }
  for (const message of messages) {
    database
      .prepare("INSERT INTO messages (id, task_id, role, data, created_at) VALUES (?, ?, ?, ?, ?)")
      // Bob re-inserts rows, so `created_at` is later than the request.
      .run(message.id, message.taskId, message.role, message.data, T + 24 * 60 * MINUTE);
  }
  return database;
}

/** An assistant message as Bob stores it, with its request's spend in `_meta`. */
function assistant(
  id: string,
  taskId: string,
  timestamp: number,
  spend: Record<string, number> | undefined,
): BobMessageRow {
  return {
    id,
    taskId,
    role: "assistant",
    data: JSON.stringify({
      role: "assistant",
      id,
      content: "Done.",
      _meta: { timestamp, ...(spend === undefined ? {} : { spend }) },
    }),
  };
}

async function readRecords(sinceMs: number) {
  const result = await readBobUsage(databasePath, sinceMs);
  assert.isFalse(result.error);
  assert.isFalse(result.missing);
  return result.files
    .flatMap((file) => file.records)
    .toSorted((a, b) => a.timestampMs - b.timestampMs);
}

describe("readBobUsage", () => {
  it("reads each charged request with its Bobcoins, time, model, and root session", async () => {
    writeBobDatabase(
      [
        { id: "task-a", model: "premium-ide", updatedAt: T + 10 * MINUTE },
        // A subagent without a model of its own.
        { id: "task-b", parentId: "task-a", updatedAt: T + 10 * MINUTE },
      ],
      [
        { ...assistant("user-1", "task-a", T - MINUTE, { cost: 9 }), role: "user" },
        assistant("m-1", "task-a", T, { cost: 0.05, contextTokens: 12_000 }),
        // Older Bob kept token counts; `input` includes cache reads and writes.
        assistant("m-2", "task-a", T + MINUTE, {
          input: 20_669,
          output: 166,
          cacheRead: 19_539,
          cacheWrite: 1_129,
          cost: 0.04,
          contextTokens: 20_835,
          reasoningTokens: 0,
        }),
        // Cancelled before Bob charged it.
        assistant("m-3", "task-a", T + 2 * MINUTE, undefined),
        { id: "m-4", taskId: "task-a", role: "assistant", data: "{not json" },
        assistant("m-5", "task-b", T + 4 * MINUTE, { cost: 0.01, contextTokens: 500 }),
      ],
    );

    const noTokens = {
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    assert.deepStrictEqual(await readRecords(T - 60 * MINUTE), [
      {
        provider: "bob",
        timestampMs: T,
        model: "premium-ide",
        sessionId: "task-a",
        totals: { uncachedInputTokens: 12_000, ...noTokens },
        reportedCostUsd: null,
        credits: { amount: 0.05, unit: "Bobcoins" },
        fast: false,
        dedupeKey: "bob:m-1",
      },
      {
        provider: "bob",
        timestampMs: T + MINUTE,
        model: "premium-ide",
        sessionId: "task-a",
        totals: {
          uncachedInputTokens: 1,
          cachedInputTokens: 19_539,
          cacheCreationTokens: 1_129,
          outputTokens: 166,
          reasoningTokens: 0,
        },
        reportedCostUsd: null,
        credits: { amount: 0.04, unit: "Bobcoins" },
        fast: false,
        dedupeKey: "bob:m-2",
      },
      {
        provider: "bob",
        timestampMs: T + 4 * MINUTE,
        model: "bob",
        sessionId: "task-a",
        totals: { uncachedInputTokens: 500, ...noTokens },
        reportedCostUsd: null,
        credits: { amount: 0.01, unit: "Bobcoins" },
        fast: false,
        dedupeKey: "bob:m-5",
      },
    ]);
  });

  it("skips tasks Bob last updated, and requests made, before the window", async () => {
    const database = writeBobDatabase(
      [
        { id: "old", model: "premium-ide", updatedAt: T - 2 * 24 * 60 * MINUTE },
        { id: "new", model: "premium-ide", updatedAt: T },
      ],
      [
        assistant("m-old", "old", T - 2 * 24 * 60 * MINUTE, { cost: 1, contextTokens: 10 }),
        // The task was updated in the window, but this request was not.
        assistant("m-early", "new", T - 2 * 60 * MINUTE, { cost: 4, contextTokens: 40 }),
        assistant("m-new", "new", T, { cost: 2, contextTokens: 20 }),
      ],
    );
    assert.deepStrictEqual(
      (await readRecords(T - 60 * MINUTE)).map((record) => record.dedupeKey),
      ["bob:m-new"],
    );

    // A write Bob has not checkpointed out of its WAL is still read.
    database
      .prepare("INSERT INTO messages (id, task_id, role, data, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        "m-later",
        "new",
        "assistant",
        assistant("m-later", "new", T + MINUTE, { cost: 3, contextTokens: 30 }).data,
        T,
      );
    assert.deepStrictEqual(
      (await readRecords(T - 60 * MINUTE)).map((record) => record.dedupeKey),
      ["bob:m-new", "bob:m-later"],
    );
    assert.isAbove((await NodeFSP.stat(`${databasePath}-wal`)).size, 0);
  });

  it("reports a missing database without creating it", async () => {
    assert.deepStrictEqual(await readBobUsage(databasePath, 0), {
      files: [],
      missing: true,
      error: false,
    });
    assert.isFalse(
      await NodeFSP.access(databasePath).then(
        () => true,
        () => false,
      ),
    );
  });

  it("reads older task tables and reports a database it cannot read", async () => {
    const database = new NodeSqlite.DatabaseSync(databasePath);
    open = database;
    database.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, data TEXT);
    `);
    database.prepare("INSERT INTO tasks (id) VALUES ('task-a')").run();
    database
      .prepare("INSERT INTO messages (id, task_id, role, data) VALUES (?, ?, ?, ?)")
      .run("m-1", "task-a", "assistant", assistant("m-1", "task-a", T, { cost: 0.5 }).data);
    const [record] = await readRecords(0);
    assert.deepInclude(record, { model: "bob", sessionId: "task-a", dedupeKey: "bob:m-1" });

    database.exec("DROP TABLE messages");
    const unreadable = await readBobUsage(databasePath, 0);
    assert.isTrue(unreadable.error);
    assert.isFalse(unreadable.missing);
  });
});
