import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { CheckInId, EnvironmentId, ThreadCheckIn, ThreadId } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type ThreadCheckInRepositoryError,
} from "./Errors.ts";

/**
 * The check-ins agents have scheduled and T3 has not finished delivering. A delivered one-time
 * check-in, an ended repeating one and a cancelled one are deleted: the thread's messages already
 * record every delivery. A check-in that waits for another thread (`waitsFor`) keeps that thread
 * in three columns of its own.
 */
export class ThreadCheckInRepository extends Context.Service<
  ThreadCheckInRepository,
  {
    readonly listAll: Effect.Effect<ReadonlyArray<ThreadCheckIn>, ThreadCheckInRepositoryError>;
    readonly listByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadCheckIn>, ThreadCheckInRepositoryError>;
    /** Adds a check-in unless one with its id exists; whether it was added. */
    readonly insert: (
      checkIn: ThreadCheckIn,
    ) => Effect.Effect<boolean, ThreadCheckInRepositoryError>;
    /**
     * Saves a check-in's schedule and delivery count if it still exists. Never inserts, so a
     * check-in cancelled while a sweep held it stays cancelled.
     */
    readonly update: (checkIn: ThreadCheckIn) => Effect.Effect<void, ThreadCheckInRepositoryError>;
    /** Whether a check-in with that id existed. */
    readonly remove: (checkInId: CheckInId) => Effect.Effect<boolean, ThreadCheckInRepositoryError>;
    readonly removeByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<void, ThreadCheckInRepositoryError>;
  }
>()("t3/persistence/ThreadCheckIns/ThreadCheckInRepository") {}

const { waitsFor: _waitsFor, ...checkInFields } = ThreadCheckIn.fields;
const CheckInRow = Schema.Struct({
  ...checkInFields,
  waitsForEnvironmentId: Schema.NullOr(EnvironmentId),
  waitsForThreadId: Schema.NullOr(ThreadId),
  waitsForTitle: Schema.NullOr(Schema.String),
});

function fromRow(row: typeof CheckInRow.Type): ThreadCheckIn {
  const { waitsForEnvironmentId, waitsForThreadId, waitsForTitle, ...checkIn } = row;
  return waitsForEnvironmentId !== null && waitsForThreadId !== null
    ? {
        ...checkIn,
        waitsFor: {
          environmentId: waitsForEnvironmentId,
          threadId: waitsForThreadId,
          title: waitsForTitle ?? "",
        },
      }
    : checkIn;
}

function toSqlOrDecodeError(sqlOperation: string) {
  return (cause: unknown): ThreadCheckInRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError("ThreadCheckIn", cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Created here rather than by a numbered migration. The migrator runs only ids above the
  // highest one a database has applied, so a fork's own migration id would make that database
  // skip whichever migration upstream later gives the same id. See FORK.md.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_check_ins (
      check_in_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      note TEXT NOT NULL,
      repeat_every_minutes INTEGER,
      next_at TEXT NOT NULL,
      ends_at TEXT,
      due_since TEXT,
      delivered_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `.pipe(Effect.orDie);
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_check_ins_thread_id ON thread_check_ins (thread_id)
  `.pipe(Effect.orDie);

  // Columns added after the table first shipped.
  const existing = new Set(
    (yield* sql<{ readonly name: string }>`PRAGMA table_info(thread_check_ins)`.pipe(
      Effect.orDie,
    )).map((column) => column.name),
  );
  for (const name of [
    "waits_for_environment_id",
    "waits_for_thread_id",
    "waits_for_title",
  ] as const) {
    if (!existing.has(name)) {
      yield* sql.unsafe(`ALTER TABLE thread_check_ins ADD COLUMN ${name} TEXT`).pipe(Effect.orDie);
    }
  }

  const columns = sql`
    check_in_id AS "id",
    thread_id AS "threadId",
    note AS "note",
    repeat_every_minutes AS "repeatEveryMinutes",
    next_at AS "nextAt",
    ends_at AS "endsAt",
    due_since AS "dueSince",
    delivered_count AS "deliveredCount",
    created_at AS "createdAt",
    waits_for_environment_id AS "waitsForEnvironmentId",
    waits_for_thread_id AS "waitsForThreadId",
    waits_for_title AS "waitsForTitle"
  `;

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CheckInRow,
    execute: () => sql`SELECT ${columns} FROM thread_check_ins ORDER BY next_at, check_in_id`,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: ThreadId,
    Result: CheckInRow,
    execute: (threadId) => sql`
      SELECT ${columns} FROM thread_check_ins
      WHERE thread_id = ${threadId}
      ORDER BY next_at, check_in_id
    `,
  });

  const findIds = SqlSchema.findAll({
    Request: CheckInId,
    Result: Schema.Struct({ id: CheckInId }),
    execute: (checkInId) =>
      sql`SELECT check_in_id AS "id" FROM thread_check_ins WHERE check_in_id = ${checkInId}`,
  });

  return ThreadCheckInRepository.of({
    listAll: listAllRows(undefined).pipe(
      Effect.map((rows) => rows.map(fromRow)),
      Effect.mapError(toSqlOrDecodeError("listCheckIns")),
    ),
    listByThread: (threadId) =>
      listThreadRows(threadId).pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.mapError(toSqlOrDecodeError("listThreadCheckIns")),
      ),
    insert: (checkIn) =>
      sql<{ readonly id: string }>`
        INSERT INTO thread_check_ins (
          check_in_id,
          thread_id,
          note,
          repeat_every_minutes,
          next_at,
          ends_at,
          due_since,
          delivered_count,
          created_at,
          waits_for_environment_id,
          waits_for_thread_id,
          waits_for_title
        )
        VALUES (
          ${checkIn.id},
          ${checkIn.threadId},
          ${checkIn.note},
          ${checkIn.repeatEveryMinutes},
          ${checkIn.nextAt},
          ${checkIn.endsAt},
          ${checkIn.dueSince},
          ${checkIn.deliveredCount},
          ${checkIn.createdAt},
          ${checkIn.waitsFor?.environmentId ?? null},
          ${checkIn.waitsFor?.threadId ?? null},
          ${checkIn.waitsFor?.title ?? null}
        )
        ON CONFLICT (check_in_id) DO NOTHING
        RETURNING check_in_id AS "id"
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError((cause) => new PersistenceSqlError({ operation: "insertCheckIn", cause })),
      ),
    update: (checkIn) =>
      sql`
        UPDATE thread_check_ins SET
          next_at = ${checkIn.nextAt},
          ends_at = ${checkIn.endsAt},
          due_since = ${checkIn.dueSince},
          delivered_count = ${checkIn.deliveredCount}
        WHERE check_in_id = ${checkIn.id}
      `.pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new PersistenceSqlError({ operation: "updateCheckIn", cause })),
      ),
    remove: (checkInId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* findIds(checkInId);
            yield* sql`DELETE FROM thread_check_ins WHERE check_in_id = ${checkInId}`;
            return existing.length > 0;
          }),
        )
        .pipe(Effect.mapError(toSqlOrDecodeError("removeCheckIn"))),
    removeByThread: (threadId) =>
      sql`DELETE FROM thread_check_ins WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "removeThreadCheckIns", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(ThreadCheckInRepository, make);
