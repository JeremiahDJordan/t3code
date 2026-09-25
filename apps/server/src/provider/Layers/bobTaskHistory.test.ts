// @effect-diagnostics nodeBuiltinImport:off - fixtures write Bob's SQLite database with node:sqlite.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  bobResumeCursorTaskId,
  listBobTasks,
  makeBobResumeCursor,
  readBobTaskHistory,
} from "./bobTaskHistory.ts";

interface FixtureTask {
  readonly id: string;
  readonly projectId: string;
  readonly parentId?: string;
  readonly taskType?: "normal" | "subtask" | "subagent";
  readonly title?: string;
  readonly firstMessage?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archivedAt?: number;
}

interface FixtureMessage {
  readonly taskId: string;
  readonly role: "system" | "user" | "assistant" | "tool";
  /** A string is stored as is, so tests can write malformed JSON. */
  readonly data: unknown;
  readonly createdAt: number;
}

/** A database shaped like Bob's, with the columns T3 reads. */
function writeBobDatabase(
  databasePath: string,
  tasks: ReadonlyArray<FixtureTask>,
  messages: ReadonlyArray<FixtureMessage>,
) {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      first_message TEXT,
      directory TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      time_archived INTEGER,
      task_type TEXT NOT NULL DEFAULT 'normal'
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      role TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  for (const task of tasks) {
    database
      .prepare(
        "INSERT INTO tasks (id, project_id, parent_id, title, first_message, created_at, updated_at, time_archived, task_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        task.id,
        task.projectId,
        task.parentId ?? null,
        task.title ?? "",
        task.firstMessage ?? null,
        task.createdAt,
        task.updatedAt,
        task.archivedAt ?? null,
        task.taskType ?? "normal",
      );
  }
  for (const [index, message] of messages.entries()) {
    database
      .prepare("INSERT INTO messages (id, task_id, role, data, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        `message-${index}`,
        message.taskId,
        message.role,
        typeof message.data === "string" ? message.data : JSON.stringify(message.data),
        message.createdAt,
      );
  }
  database.close();
}

const userMessage = (taskId: string, content: string, timestamp: number): FixtureMessage => ({
  taskId,
  role: "user",
  data: { role: "user", content, _meta: { timestamp } },
  createdAt: timestamp,
});

describe("Bob resume cursor", () => {
  it("names the root task Bob reopens", () => {
    expect(makeBobResumeCursor("task-1")).toEqual({ schemaVersion: 1, sessionId: "task-1" });
    expect(bobResumeCursorTaskId(makeBobResumeCursor("task-1"))).toBe("task-1");
  });

  it("ignores cursors of other providers and versions", () => {
    expect(bobResumeCursorTaskId({ threadId: "thread-1", resume: "session-1" })).toBeUndefined();
    expect(bobResumeCursorTaskId({ schemaVersion: 2, sessionId: "task-1" })).toBeUndefined();
    expect(bobResumeCursorTaskId({ schemaVersion: 1, sessionId: "  " })).toBeUndefined();
    expect(bobResumeCursorTaskId(null)).toBeUndefined();
  });
});

it.layer(NodeServices.layer)("Bob task history", (it) => {
  const makeDatabasePath = Effect.fn("bobTaskHistory.test.makeDatabasePath")(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-bob-history-" });
    return NodePath.join(directory, "bob.db");
  });

  it.effect("lists importable root tasks newest first", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeDatabasePath();
      writeBobDatabase(
        databasePath,
        [
          { id: "older", projectId: "file:/work/app", createdAt: 1_000, updatedAt: 2_000 },
          {
            id: "newer",
            projectId: "file:///work/My%20App",
            createdAt: 3_000,
            updatedAt: 4_000,
          },
          {
            id: "subtask",
            projectId: "file:/work/app",
            parentId: "older",
            taskType: "subtask",
            createdAt: 5_000,
            updatedAt: 5_000,
          },
          {
            id: "subagent",
            projectId: "file:/work/app",
            taskType: "subagent",
            createdAt: 5_000,
            updatedAt: 5_000,
          },
          {
            id: "archived",
            projectId: "file:/work/app",
            createdAt: 5_000,
            updatedAt: 5_000,
            archivedAt: 6_000,
          },
          {
            id: "remote",
            projectId: "vscode-remote:/work/app",
            createdAt: 5_000,
            updatedAt: 5_000,
          },
          { id: "empty", projectId: "file:/work/app", createdAt: 5_000, updatedAt: 5_000 },
        ],
        [
          userMessage("older", "Fix the build", 1_100),
          { taskId: "older", role: "tool", data: { content: "ok" }, createdAt: 1_200 },
          userMessage("newer", "Add a feature", 3_100),
          ...["subtask", "subagent", "archived", "remote"].map((taskId) =>
            userMessage(taskId, "Hidden", 5_100),
          ),
          {
            taskId: "empty",
            role: "system",
            data: { content: "You are Bob" },
            createdAt: 5_100,
          },
        ],
      );

      expect(yield* listBobTasks(databasePath, 10)).toEqual([
        {
          id: "newer",
          cwd: "/work/My App",
          createdAtMs: 3_000,
          updatedAtMs: 4_000,
          messageCount: 1,
        },
        { id: "older", cwd: "/work/app", createdAtMs: 1_000, updatedAtMs: 2_000, messageCount: 2 },
      ]);
      expect((yield* listBobTasks(databasePath, 1)).map((task) => task.id)).toEqual(["newer"]);
    }).pipe(Effect.scoped),
  );

  it.effect("reads nothing from a missing database and does not create it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const databasePath = yield* makeDatabasePath();
      expect(yield* listBobTasks(databasePath, 10)).toEqual([]);
      expect(yield* readBobTaskHistory(databasePath, "task", 10)).toBeUndefined();
      expect(yield* fileSystem.exists(databasePath)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("lists tasks from a database that predates task kinds and titles", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeDatabasePath();
      const database = new NodeSqlite.DatabaseSync(databasePath);
      database.exec(`
        CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, data TEXT, created_at INTEGER);
        INSERT INTO tasks VALUES ('task', 'file:/work/app', 1000, 2000);
        INSERT INTO messages VALUES ('m1', 'task', 'user', '{"content":"Hello there"}', 1500);
      `);
      database.close();

      expect((yield* listBobTasks(databasePath, 10)).map((task) => task.id)).toEqual(["task"]);
      expect(yield* readBobTaskHistory(databasePath, "task", 10)).toMatchObject({
        title: "Hello there",
        messages: [{ role: "user", text: "Hello there", createdAt: "1970-01-01T00:00:01.500Z" }],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reads the visible conversation in the order Bob wrote it", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeDatabasePath();
      // Bob rewrites a task's messages with one created_at; only _meta.timestamp orders them.
      const rewrittenAt = 9_000;
      writeBobDatabase(
        databasePath,
        [
          {
            id: "task",
            projectId: "file:/work/app",
            title: "Fix the build\n\nIt fails on CI.",
            firstMessage: "Fix the build\n\nIt fails on CI.",
            createdAt: 1_000,
            updatedAt: 8_000,
          },
        ],
        [
          {
            taskId: "task",
            role: "assistant",
            data: { content: "Fixed it.", _meta: { timestamp: 5_000 } },
            createdAt: rewrittenAt,
          },
          {
            taskId: "task",
            role: "system",
            data: { content: "You are Bob" },
            createdAt: rewrittenAt,
          },
          {
            taskId: "task",
            role: "user",
            data: {
              content:
                "Fix the build\n\nIt fails on CI.\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Bob harness.</runtime_info>\n\n<pull_request_linking>\nLink PRs.\n</pull_request_linking>",
              _meta: { timestamp: 2_000 },
            },
            createdAt: rewrittenAt,
          },
          {
            taskId: "task",
            role: "assistant",
            data: { content: "", toolCalls: [{ name: "read_file" }], _meta: { timestamp: 3_000 } },
            createdAt: rewrittenAt,
          },
          {
            taskId: "task",
            role: "tool",
            data: { content: "build.log", _meta: { timestamp: 4_000 } },
            createdAt: rewrittenAt,
          },
          { taskId: "task", role: "assistant", data: "{not json", createdAt: rewrittenAt },
          {
            taskId: "task",
            role: "user",
            data: {
              content: "Load the following skills before answering.",
              _meta: { timestamp: 6_000, mask: "/review" },
            },
            createdAt: rewrittenAt,
          },
          {
            taskId: "task",
            role: "assistant",
            data: { content: "Looks good." },
            createdAt: 7_000,
          },
        ],
      );

      expect(yield* readBobTaskHistory(databasePath, "task", 200)).toEqual({
        task: {
          id: "task",
          cwd: "/work/app",
          createdAtMs: 1_000,
          updatedAtMs: 8_000,
          messageCount: 8,
        },
        title: "Fix the build",
        messages: [
          {
            role: "user",
            text: "Fix the build\n\nIt fails on CI.",
            createdAt: "1970-01-01T00:00:02.000Z",
          },
          { role: "assistant", text: "Fixed it.", createdAt: "1970-01-01T00:00:05.000Z" },
          { role: "user", text: "/review", createdAt: "1970-01-01T00:00:06.000Z" },
          { role: "assistant", text: "Looks good.", createdAt: "1970-01-01T00:00:07.000Z" },
        ],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the first prompt when the conversation exceeds the message limit", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeDatabasePath();
      writeBobDatabase(
        databasePath,
        [
          {
            id: "task",
            projectId: "file:/work/app",
            title: "Renamed in Bob",
            firstMessage: "Prompt 0",
            createdAt: 1_000,
            updatedAt: 9_000,
          },
        ],
        Array.from({ length: 6 }, (_, index) => ({
          taskId: "task",
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
          data: {
            content: `${index % 2 === 0 ? "Prompt" : "Reply"} ${index}`,
            _meta: { timestamp: 2_000 + index },
          },
          createdAt: 2_000 + index,
        })),
      );

      const history = yield* readBobTaskHistory(databasePath, "task", 3);
      expect(history?.title).toBe("Renamed in Bob");
      expect(history?.messages.map((message) => message.text)).toEqual([
        "Prompt 0",
        "Prompt 4",
        "Reply 5",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not read a task Bob cannot resume", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeDatabasePath();
      writeBobDatabase(
        databasePath,
        [
          {
            id: "subtask",
            projectId: "file:/work/app",
            parentId: "root",
            taskType: "subtask",
            createdAt: 1_000,
            updatedAt: 2_000,
          },
        ],
        [userMessage("subtask", "Hidden", 1_500)],
      );

      expect(yield* readBobTaskHistory(databasePath, "subtask", 200)).toBeUndefined();
      expect(yield* readBobTaskHistory(databasePath, "missing", 200)).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});
