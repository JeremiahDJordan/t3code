// @effect-diagnostics nodeBuiltinImport:off - fixtures write Bob's SQLite database with node:sqlite.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { bobTableColumns, readBobDatabase, withBobDatabase } from "./bobDatabase.ts";

it.layer(NodeServices.layer)("Bob database", (it) => {
  const makeDatabasePath = Effect.fn("bobDatabase.test.makeDatabasePath")(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-bob-database-" });
    return NodePath.join(directory, "bob.db");
  });

  it.effect("reads nothing from a missing database and does not create it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const databasePath = yield* makeDatabasePath();
      expect(yield* readBobDatabase(databasePath, () => "read")).toBeUndefined();
      expect(yield* fileSystem.exists(databasePath)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("closes the connection once a read settles, including one that fails", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeDatabasePath();
      const writer = new NodeSqlite.DatabaseSync(databasePath);
      writer.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, costs TEXT)");
      writer.close();

      const opened: Array<NodeSqlite.DatabaseSync> = [];
      expect(
        yield* readBobDatabase(databasePath, (database) => {
          opened.push(database);
          return database.prepare("SELECT count(*) AS count FROM tasks").get()?.count;
        }),
      ).toBe(0);
      expect(
        yield* readBobDatabase(databasePath, (database) => {
          opened.push(database);
          return database.prepare("SELECT missing FROM tasks").all();
        }),
      ).toBeUndefined();
      const stillOpenWhileAwaiting = yield* Effect.promise(() =>
        withBobDatabase(databasePath, async (database) => {
          opened.push(database);
          await Promise.resolve();
          return database.isOpen;
        }),
      );
      expect(stillOpenWhileAwaiting).toBe(true);
      expect(opened.map((database) => database.isOpen)).toEqual([false, false, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("lists a table's columns, and none for a table an older Bob lacks", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeDatabasePath();
      const writer = new NodeSqlite.DatabaseSync(databasePath);
      writer.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, costs TEXT)");
      writer.close();

      const columns = yield* readBobDatabase(databasePath, (database) => ({
        tasks: [...bobTableColumns(database, "tasks")],
        messages: [...bobTableColumns(database, "messages")],
      }));
      expect(columns).toEqual({ tasks: ["id", "costs"], messages: [] });
    }).pipe(Effect.scoped),
  );
});
