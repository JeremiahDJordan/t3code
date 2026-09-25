// @effect-diagnostics nodeBuiltinImport:off - Bob's task database is SQLite, and node:sqlite
// has no Effect platform service. Each read opens it read-only and closes it before returning.
/**
 * bobTaskHistory - Bob Shell conversations, read from Bob's own task database so
 * project import can offer work that ran in the `bob` CLI.
 *
 * Bob's ACP `session/resume` reopens only root tasks of the normal kind, in the
 * folder they ran in, so only unarchived root tasks with a `file:` project and a
 * user message are importable. Reads are best-effort: a missing database, an
 * older schema, or a malformed row yields less history instead of an error.
 *
 * @module provider/Layers/bobTaskHistory
 */
import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const BobResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.String,
});
const decodeBobResumeCursor = Schema.decodeUnknownOption(BobResumeCursor);

/** The resume cursor T3 stores for a Bob thread. Bob's ACP session id is its root task id. */
export function makeBobResumeCursor(taskId: string): typeof BobResumeCursor.Type {
  return { schemaVersion: 1, sessionId: taskId };
}

/** The task a stored Bob resume cursor reopens, or undefined for any other cursor. */
export function bobResumeCursorTaskId(cursor: unknown): string | undefined {
  const taskId = Option.getOrUndefined(decodeBobResumeCursor(cursor))?.sessionId.trim();
  return taskId ? taskId : undefined;
}

/** A Bob task T3 can import and resume. */
export interface BobTaskSummary {
  readonly id: string;
  /** The folder the task ran in, from its `file:` project id. */
  readonly cwd: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** Every stored message, tool and system rows included, so it changes whenever the task does. */
  readonly messageCount: number;
}

/** A visible user prompt or assistant reply of a Bob task. */
export interface BobTaskMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

/** The importable part of one Bob task. */
export interface BobTaskHistory {
  readonly task: BobTaskSummary;
  readonly title: string;
  /** The first user prompt and the newest remaining messages, oldest first. */
  readonly messages: ReadonlyArray<BobTaskMessage>;
}

const decodeTableColumn = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }));

const BobTaskRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  title: Schema.NullOr(Schema.String),
  first_message: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
  message_count: Schema.Finite,
});
const decodeBobTaskRow = Schema.decodeUnknownOption(BobTaskRow);

const BobMessageRow = Schema.Struct({
  position: Schema.Finite,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  timestamp: Schema.NullOr(Schema.Finite),
  created_at: Schema.NullOr(Schema.Finite),
});
const decodeBobMessageRow = Schema.decodeUnknownOption(BobMessageRow);

/**
 * User and assistant rows with their visible text. A user row's `_meta.mask` is what the user
 * typed when Bob expanded it (a slash command becomes a skill prompt). `json_valid` guards
 * every extraction because a malformed row would otherwise fail the whole query.
 */
const MESSAGE_ROWS = `
  SELECT rowid AS position, role, created_at,
    CASE WHEN json_valid(data) THEN
      CASE
        WHEN json_type(data, '$._meta.mask') = 'text' THEN json_extract(data, '$._meta.mask')
        WHEN json_type(data, '$.content') = 'text' THEN json_extract(data, '$.content')
      END
    END AS text,
    CASE WHEN json_valid(data) THEN
      CASE WHEN json_type(data, '$._meta.timestamp') IN ('integer', 'real')
        THEN json_extract(data, '$._meta.timestamp')
      END
    END AS timestamp
  FROM messages
  WHERE task_id = ? AND role IN ('user', 'assistant')`;
// Bob rewrites a task's messages with one `created_at`, so `_meta.timestamp` orders them.
const VISIBLE_MESSAGES = `SELECT * FROM (${MESSAGE_ROWS})
  WHERE text IS NOT NULL AND trim(text, char(32, 9, 10, 13)) <> ''`;
const MESSAGE_ORDER = "coalesce(timestamp, created_at), position";
const MESSAGE_ORDER_DESC = "coalesce(timestamp, created_at) DESC, position DESC";

/**
 * T3 sends its runtime instructions as the last text part of every Bob prompt (see
 * `RuntimeInstructions.ts`), and Bob stores them in the user message.
 */
const T3_RUNTIME_INSTRUCTIONS =
  /\s*<runtime_info>In case you're asked: you are running in T3 Code[\s\S]*$/;

/** Importable root tasks. Checks for columns older Bob databases lack are left out. */
function importableTasksQuery(
  database: NodeSqlite.DatabaseSync,
  selection: "newest" | "byId",
): string {
  const columns = new Set(
    database
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .flatMap((row) => Option.toArray(decodeTableColumn(row)).map((column) => column.name)),
  );
  const optional = (column: string) => (columns.has(column) ? `t.${column}` : "NULL");
  const conditions = [
    "t.project_id LIKE 'file:%'",
    "EXISTS (SELECT 1 FROM messages m WHERE m.task_id = t.id AND m.role = 'user')",
    ...(columns.has("parent_id") ? ["t.parent_id IS NULL"] : []),
    ...(columns.has("task_type") ? ["t.task_type = 'normal'"] : []),
    ...(columns.has("time_archived") ? ["t.time_archived IS NULL"] : []),
    ...(selection === "byId" ? ["t.id = ?"] : []),
  ];
  return `SELECT t.id, t.project_id, ${optional("title")} AS title,
      ${optional("first_message")} AS first_message, t.created_at, t.updated_at,
      (SELECT count(*) FROM messages m WHERE m.task_id = t.id) AS message_count
    FROM tasks t
    WHERE ${conditions.join(" AND ")}
    ${selection === "newest" ? "ORDER BY t.updated_at DESC, t.id LIMIT ?" : ""}`;
}

/** Runs `read` on Bob's database opened read-only; undefined when it cannot be read. */
const readBobDatabase = <A>(
  databasePath: string,
  read: (database: NodeSqlite.DatabaseSync) => A,
): Effect.Effect<A | undefined> =>
  Effect.try(() => {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      return read(database);
    } finally {
      database.close();
    }
  }).pipe(Effect.orElseSucceed(() => undefined));

/** The folder a `file:` project id names: a raw path, or a `file://` URL. */
const bobTaskCwd = Effect.fnUntraced(function* (projectId: string) {
  if (!projectId.startsWith("file:")) return undefined;
  if (!projectId.startsWith("file://")) return projectId.slice("file:".length) || undefined;
  const path = yield* Path.Path;
  return yield* Effect.try(() => new URL(projectId)).pipe(
    Effect.flatMap((url) => path.fromFileUrl(url)),
    Effect.orElseSucceed(() => undefined),
  );
});

function isoFromMillis(value: number | null): string | undefined {
  if (value === null) return undefined;
  return Option.getOrUndefined(Option.map(DateTime.make(value), DateTime.formatIso));
}

const toTaskSummary = Effect.fnUntraced(function* (row: unknown) {
  const decoded = Option.getOrUndefined(decodeBobTaskRow(row));
  const cwd = decoded === undefined ? undefined : yield* bobTaskCwd(decoded.project_id);
  const createdAt = decoded === undefined ? undefined : isoFromMillis(decoded.created_at);
  if (
    decoded === undefined ||
    cwd === undefined ||
    createdAt === undefined ||
    isoFromMillis(decoded.updated_at) === undefined ||
    decoded.id.trim().length === 0
  ) {
    return undefined;
  }
  const summary: BobTaskSummary = {
    id: decoded.id,
    cwd,
    createdAtMs: decoded.created_at,
    updatedAtMs: decoded.updated_at,
    messageCount: decoded.message_count,
  };
  return { summary, row: decoded, createdAt };
});

function firstLine(text: string | null | undefined): string | undefined {
  const line = text?.trim().split("\n")[0]?.slice(0, 100).trim();
  return line ? line : undefined;
}

/**
 * Newest importable Bob tasks first, at most `limit`. Empty when the database is missing or
 * unreadable.
 */
export const listBobTasks = Effect.fn("listBobTasks")(function* (
  databasePath: string,
  limit: number,
) {
  const rows = yield* readBobDatabase(databasePath, (database) =>
    database.prepare(importableTasksQuery(database, "newest")).all(limit),
  );
  const tasks: Array<BobTaskSummary> = [];
  for (const row of rows ?? []) {
    const task = yield* toTaskSummary(row);
    if (task !== undefined) tasks.push(task.summary);
  }
  return tasks;
});

/**
 * One importable task's visible conversation: the first user prompt and the newest remaining
 * messages, `maxMessages` in all. Tool and system rows, and replies with no text, are left
 * out. Undefined when the task is missing, not importable, or unreadable.
 */
export const readBobTaskHistory = Effect.fn("readBobTaskHistory")(function* (
  databasePath: string,
  taskId: string,
  maxMessages: number,
) {
  const snapshot = yield* readBobDatabase(databasePath, (database) => {
    // One read transaction keeps the task row and its messages consistent while Bob writes.
    database.exec("BEGIN");
    const task = database.prepare(importableTasksQuery(database, "byId")).get(taskId);
    const newest = database
      .prepare(`${VISIBLE_MESSAGES} ORDER BY ${MESSAGE_ORDER_DESC} LIMIT ?`)
      .all(taskId, Math.max(0, maxMessages));
    const firstUser = database
      .prepare(`${VISIBLE_MESSAGES} AND role = 'user' ORDER BY ${MESSAGE_ORDER} LIMIT 1`)
      .get(taskId);
    database.exec("COMMIT");
    return { task, newest, firstUser };
  });
  const task = snapshot === undefined ? undefined : yield* toTaskSummary(snapshot.task);
  if (snapshot === undefined || task === undefined) return undefined;

  const toMessage = (row: unknown) => {
    const decoded = Option.getOrUndefined(decodeBobMessageRow(row));
    const text = decoded?.text.replace(T3_RUNTIME_INSTRUCTIONS, "").trim();
    if (decoded === undefined || !text) return [];
    const message: BobTaskMessage = {
      role: decoded.role,
      text,
      createdAt:
        isoFromMillis(decoded.timestamp) ?? isoFromMillis(decoded.created_at) ?? task.createdAt,
    };
    return [{ position: decoded.position, message }];
  };
  const newest = snapshot.newest.flatMap(toMessage).toReversed();
  const firstUser = toMessage(snapshot.firstUser)[0];
  if (firstUser === undefined) return undefined;
  const retained = newest.some((entry) => entry.position === firstUser.position)
    ? newest
    : [firstUser, ...newest.slice(Math.max(0, newest.length - maxMessages + 1))];

  // Bob titles a task with its first message until it is renamed. The prompt the user typed
  // reads better than that copy, which can hold a slash command's expansion.
  const renamedTitle =
    task.row.title !== task.row.first_message ? firstLine(task.row.title) : undefined;
  return {
    task: task.summary,
    title:
      renamedTitle ??
      firstLine(firstUser.message.text) ??
      firstLine(task.row.title) ??
      "Imported thread",
    messages: retained.map((entry) => entry.message),
  } satisfies BobTaskHistory;
});
