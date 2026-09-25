// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  bobContextWindow,
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
  tokensRecorded: true,
};
const secondTurn: BobTaskCosts = {
  input: 30_000,
  output: 1_500,
  cacheRead: 24_000,
  cacheWrite: 1_500,
  cost: 0.118,
  contextTokens: 18_500,
  tokensRecorded: true,
};
/** A reading from Bob 2.0.5 or later, which stores only Bobcoins and the context size. */
const costOnlyTurn: BobTaskCosts = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.044,
  contextTokens: 11_000,
  tokensRecorded: false,
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

  it("reports only the context size and Bobcoins when Bob kept no token counts", () => {
    expect(bobThreadTokenUsage(costOnlyTurn, firstTurn)).toEqual({
      usedTokens: 11_000,
      cost: { amount: 0.044, unit: "Bobcoins" },
    });
  });
});

describe("bobContextWindow", () => {
  it("assumes the router's usual model when Bob pins none", () => {
    expect(bobContextWindow(undefined)).toBe(270_000);
    expect(bobContextWindow("  ")).toBe(270_000);
  });

  it("uses the window of the model Bob's settings pin, and none for an unknown one", () => {
    expect(bobContextWindow("wxO-model")).toBe(1_000_000);
    expect(bobContextWindow("fast")).toBe(200_000);
    expect(bobContextWindow("ultra")).toBeUndefined();
  });
});

describe("bobThreadTokenUsage with a context window", () => {
  it("reports the window with and without Bob's token counts", () => {
    expect(bobThreadTokenUsage(secondTurn, firstTurn, 270_000).maxTokens).toBe(270_000);
    expect(
      bobThreadTokenUsage({ ...secondTurn, tokensRecorded: false }, firstTurn, 270_000),
    ).toEqual({
      usedTokens: 18_500,
      maxTokens: 270_000,
      cost: { amount: 0.118, unit: "Bobcoins" },
    });
    expect(bobThreadTokenUsage(secondTurn, firstTurn).maxTokens).toBeUndefined();
  });

  it("drops an assumed window the context has outgrown, keeping a full one", () => {
    const outgrown = { ...secondTurn, contextTokens: 300_000 };
    const usage = bobThreadTokenUsage(outgrown, firstTurn, 270_000);
    expect(usage.usedTokens).toBe(300_000);
    expect(usage).not.toHaveProperty("maxTokens");
    expect(bobThreadTokenUsage({ ...outgrown, tokensRecorded: false }, firstTurn, 270_000)).toEqual(
      { usedTokens: 300_000, cost: { amount: 0.118, unit: "Bobcoins" } },
    );
    expect(
      bobThreadTokenUsage({ ...secondTurn, contextTokens: 270_000 }, firstTurn, 270_000).maxTokens,
    ).toBe(270_000);
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

  it("reports the turn's tokens as unavailable, not zero, when Bob kept no counts", () => {
    expect(bobTurnTokenUsage(costOnlyTurn, undefined, true)).toEqual({
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: false,
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
        { id: "session-3", costs: '{"cost":0.044,"contextTokens":11000}' },
      ]);
      expect(yield* readBobTaskCosts(databasePath, "session-1")).toEqual(firstTurn);
      expect(yield* readBobTaskCosts(databasePath, "session-2")).toBeUndefined();
      // Bob 2.0.5 and later store no token counts.
      expect(yield* readBobTaskCosts(databasePath, "session-3")).toEqual(costOnlyTurn);
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
