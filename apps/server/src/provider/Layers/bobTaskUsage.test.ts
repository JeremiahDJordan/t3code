// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  type BobTaskCosts,
  bobThreadTokenUsage,
  bobTurnTokenUsage,
  readBobTaskCosts,
  resolveBobTaskDatabasePath,
} from "./bobTaskUsage.ts";

/** A database shaped like Bob's, holding one task row per entry. */
function writeBobTaskDatabase(
  databasePath: string,
  rows: ReadonlyArray<{ readonly id: string; readonly costs: string | null }>,
) {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, costs TEXT)");
  for (const row of rows) {
    database.prepare("INSERT INTO tasks (id, costs) VALUES (?, ?)").run(row.id, row.costs);
  }
  database.close();
}

const firstTurn: BobTaskCosts = {
  input: 12_000,
  output: 800,
  cacheRead: 9_000,
  cacheWrite: 1_000,
  cost: 0.05,
  contextTokens: 12_800,
};
const secondTurn: BobTaskCosts = {
  input: 30_000,
  output: 1_500,
  cacheRead: 24_000,
  cacheWrite: 1_500,
  cost: 0.118,
  contextTokens: 18_500,
};

describe("bobThreadTokenUsage", () => {
  it("reports the context size, running totals, the change since the last reading, and Bobcoins", () => {
    expect(bobThreadTokenUsage(secondTurn, firstTurn)).toEqual({
      usedTokens: 18_500,
      totalProcessedTokens: 31_500,
      inputTokens: 30_000,
      cachedInputTokens: 24_000,
      outputTokens: 1_500,
      lastInputTokens: 18_000,
      lastCachedInputTokens: 15_000,
      lastOutputTokens: 700,
      cost: { amount: 0.118, unit: "Bobcoins" },
    });
  });

  it("counts a whole reading as new when Bob's totals went down", () => {
    expect(bobThreadTokenUsage(firstTurn, secondTurn).lastInputTokens).toBe(12_000);
  });
});

describe("bobTurnTokenUsage", () => {
  it("reports what the turn spent since it began", () => {
    expect(bobTurnTokenUsage(secondTurn, firstTurn, true)).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      inputTokens: 18_000,
      cachedInputTokens: 15_000,
      cacheCreationTokens: 500,
      outputTokens: 700,
      hasSubagents: false,
    });
    expect(bobTurnTokenUsage(firstTurn, undefined, false)).toMatchObject({
      usageStatus: "partial",
      inputTokens: 12_000,
      outputTokens: 800,
    });
  });
});

it.layer(NodeServices.layer)("Bob task database", (it) => {
  it.effect("resolves the database Bob opens for the spawn environment", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(resolveBobTaskDatabasePath({ HOME: "/home/dev" }, path)).toBe(
        NodePath.join("/home/dev", ".bob", "db", "bob.db"),
      );
      expect(resolveBobTaskDatabasePath({ HOME: "/home/dev", NODE_ENV: "development" }, path)).toBe(
        NodePath.join("/home/dev", ".bob", "dev-db", "bob.db"),
      );
    }),
  );

  it.effect("reads a task's running totals", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-bob-db-" });
      const databasePath = NodePath.join(directory, "bob.db");
      writeBobTaskDatabase(databasePath, [
        {
          id: "session-1",
          costs:
            '{"input":12000,"output":800,"cacheRead":9000,"cacheWrite":1000,"cost":0.05,"contextTokens":12800}',
        },
        { id: "session-2", costs: null },
      ]);
      expect(yield* readBobTaskCosts(databasePath, "session-1")).toEqual(firstTurn);
      expect(yield* readBobTaskCosts(databasePath, "session-2")).toBeUndefined();
      expect(yield* readBobTaskCosts(databasePath, "unknown")).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("skips usage when the database or its costs column is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-bob-db-" });
      expect(
        yield* readBobTaskCosts(NodePath.join(directory, "missing.db"), "session-1"),
      ).toBeUndefined();
      // Opening read-only must not create the file.
      expect(yield* fs.exists(NodePath.join(directory, "missing.db"))).toBe(false);

      const olderDatabasePath = NodePath.join(directory, "older.db");
      const database = new NodeSqlite.DatabaseSync(olderDatabasePath);
      database.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
      database.close();
      expect(yield* readBobTaskCosts(olderDatabasePath, "session-1")).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});
