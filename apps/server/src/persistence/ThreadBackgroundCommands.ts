import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  BackgroundCommandId,
  BackgroundCommandStatus,
  type BackgroundCommandStopper,
  IsoDateTime,
  NonNegativeInt,
  ThreadBackgroundCommand,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type ThreadBackgroundCommandRepositoryError,
} from "./Errors.ts";

/** A background command with the server's own bookkeeping, which clients never see. */
export const BackgroundCommandRow = Schema.Struct({
  ...ThreadBackgroundCommand.fields,
  jobDir: TrimmedNonEmptyString,
  tmuxSession: TrimmedNonEmptyString,
  stopRequestedAt: Schema.NullOr(IsoDateTime),
  /** Whether the agent has been told how it ended (or needs no telling, as after its own stop). */
  endNoticeSent: Schema.Boolean,
  statusNoticesSent: NonNegativeInt,
  /** Output sizes when the agent last heard about it, for "+N since the last update". */
  stdoutBytesNoticed: NonNegativeInt,
  stderrBytesNoticed: NonNegativeInt,
  /** Consecutive polls that found neither the session nor an exit status. */
  missingObservations: NonNegativeInt,
});
export type BackgroundCommandRow = typeof BackgroundCommandRow.Type;

/** The fields a finished command gains. */
export interface BackgroundCommandEnd {
  readonly status: Exclude<BackgroundCommandStatus, "running">;
  readonly exitStatus: string | null;
  readonly endedAt: string;
  readonly endNoticeSent: boolean;
}

export class ThreadBackgroundCommandRepository extends Context.Service<
  ThreadBackgroundCommandRepository,
  {
    /** Adds a running command unless the thread already runs `max`; whether it was added. */
    readonly insertIfUnder: (
      row: BackgroundCommandRow,
      max: number,
    ) => Effect.Effect<boolean, ThreadBackgroundCommandRepositoryError>;
    readonly get: (
      id: BackgroundCommandId,
    ) => Effect.Effect<BackgroundCommandRow | undefined, ThreadBackgroundCommandRepositoryError>;
    /** Running commands, and ended ones the agent has not been told about. */
    readonly listActive: Effect.Effect<
      ReadonlyArray<BackgroundCommandRow>,
      ThreadBackgroundCommandRepositoryError
    >;
    readonly listByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<BackgroundCommandRow>, ThreadBackgroundCommandRepositoryError>;
    /** Records the end of a still-running command; whether this call was the one that did. */
    readonly finish: (
      id: BackgroundCommandId,
      end: BackgroundCommandEnd,
    ) => Effect.Effect<boolean, ThreadBackgroundCommandRepositoryError>;
    /** Asks a running command to stop; whether it was running. */
    readonly requestStop: (
      id: BackgroundCommandId,
      by: BackgroundCommandStopper,
      at: string,
    ) => Effect.Effect<boolean, ThreadBackgroundCommandRepositoryError>;
    readonly markEndNoticeSent: (
      id: BackgroundCommandId,
    ) => Effect.Effect<void, ThreadBackgroundCommandRepositoryError>;
    readonly recordStatusNotice: (
      id: BackgroundCommandId,
      notice: {
        readonly nextStatusAt: string | null;
        readonly stdoutBytes: number;
        readonly stderrBytes: number;
      },
    ) => Effect.Effect<void, ThreadBackgroundCommandRepositoryError>;
    readonly setMissingObservations: (
      id: BackgroundCommandId,
      count: number,
    ) => Effect.Effect<void, ThreadBackgroundCommandRepositoryError>;
    readonly removeByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<void, ThreadBackgroundCommandRepositoryError>;
  }
>()("t3/persistence/ThreadBackgroundCommands/ThreadBackgroundCommandRepository") {}

// SQLite keeps booleans as integers.
const RowFromSql = Schema.Struct({
  ...BackgroundCommandRow.fields,
  endNoticeSent: Schema.Number,
});

function fromSql(row: typeof RowFromSql.Type): BackgroundCommandRow {
  return { ...row, endNoticeSent: row.endNoticeSent !== 0 };
}

function toSqlOrDecodeError(sqlOperation: string) {
  return (cause: unknown): ThreadBackgroundCommandRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError("ThreadBackgroundCommand", cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Created here rather than by a numbered migration; see FORK.md.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_background_commands (
      background_command_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      job_dir TEXT NOT NULL,
      stdout_path TEXT NOT NULL,
      stderr_path TEXT NOT NULL,
      tmux_session TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_status TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      check_in_every_minutes INTEGER,
      next_check_in_at TEXT,
      note TEXT NOT NULL,
      tail_lines INTEGER NOT NULL,
      stop_requested_by TEXT,
      stop_requested_at TEXT,
      end_notice_sent INTEGER NOT NULL DEFAULT 0,
      status_notices_sent INTEGER NOT NULL DEFAULT 0,
      stdout_bytes_noticed INTEGER NOT NULL DEFAULT 0,
      stderr_bytes_noticed INTEGER NOT NULL DEFAULT 0,
      missing_observations INTEGER NOT NULL DEFAULT 0
    )
  `.pipe(Effect.orDie);
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_background_commands_thread_id
    ON thread_background_commands (thread_id)
  `.pipe(Effect.orDie);

  const columns = sql`
    background_command_id AS "id",
    thread_id AS "threadId",
    command AS "command",
    cwd AS "cwd",
    job_dir AS "jobDir",
    stdout_path AS "stdoutPath",
    stderr_path AS "stderrPath",
    tmux_session AS "tmuxSession",
    status AS "status",
    exit_status AS "exitStatus",
    started_at AS "startedAt",
    ended_at AS "endedAt",
    check_in_every_minutes AS "statusEveryMinutes",
    next_check_in_at AS "nextStatusAt",
    note AS "note",
    tail_lines AS "tailLines",
    stop_requested_by AS "stopRequestedBy",
    stop_requested_at AS "stopRequestedAt",
    end_notice_sent AS "endNoticeSent",
    status_notices_sent AS "statusNoticesSent",
    stdout_bytes_noticed AS "stdoutBytesNoticed",
    stderr_bytes_noticed AS "stderrBytesNoticed",
    missing_observations AS "missingObservations"
  `;

  const findById = SqlSchema.findAll({
    Request: BackgroundCommandId,
    Result: RowFromSql,
    execute: (id) =>
      sql`SELECT ${columns} FROM thread_background_commands WHERE background_command_id = ${id}`,
  });
  const findActive = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RowFromSql,
    execute: () => sql`
      SELECT ${columns} FROM thread_background_commands
      WHERE status = 'running' OR end_notice_sent = 0
      ORDER BY started_at, background_command_id
    `,
  });
  const findByThread = SqlSchema.findAll({
    Request: ThreadId,
    Result: RowFromSql,
    execute: (threadId) => sql`
      SELECT ${columns} FROM thread_background_commands
      WHERE thread_id = ${threadId}
      ORDER BY started_at, background_command_id
    `,
  });

  const write = (operation: string) => (cause: unknown) =>
    new PersistenceSqlError({ operation, cause });

  return ThreadBackgroundCommandRepository.of({
    insertIfUnder: (row, max) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const counted = yield* sql<{ readonly running: number }>`
              SELECT COUNT(*) AS "running" FROM thread_background_commands
              WHERE thread_id = ${row.threadId} AND status = 'running'
            `;
            if ((counted[0]?.running ?? 0) >= max) return false;
            yield* sql`
              INSERT INTO thread_background_commands (
                background_command_id, thread_id, command, cwd, job_dir, stdout_path, stderr_path,
                tmux_session, status, exit_status, started_at, ended_at, check_in_every_minutes,
                next_check_in_at, note, tail_lines, stop_requested_by, stop_requested_at,
                end_notice_sent, status_notices_sent, stdout_bytes_noticed, stderr_bytes_noticed,
                missing_observations
              ) VALUES (
                ${row.id}, ${row.threadId}, ${row.command}, ${row.cwd}, ${row.jobDir},
                ${row.stdoutPath}, ${row.stderrPath}, ${row.tmuxSession}, ${row.status},
                ${row.exitStatus}, ${row.startedAt}, ${row.endedAt}, ${row.statusEveryMinutes},
                ${row.nextStatusAt}, ${row.note}, ${row.tailLines}, ${row.stopRequestedBy},
                ${row.stopRequestedAt}, ${row.endNoticeSent ? 1 : 0}, ${row.statusNoticesSent},
                ${row.stdoutBytesNoticed}, ${row.stderrBytesNoticed}, ${row.missingObservations}
              )
            `;
            return true;
          }),
        )
        .pipe(Effect.mapError(write("insertBackgroundCommand"))),
    get: (id) =>
      findById(id).pipe(
        Effect.map((rows) => (rows[0] ? fromSql(rows[0]) : undefined)),
        Effect.mapError(toSqlOrDecodeError("getBackgroundCommand")),
      ),
    listActive: findActive(undefined).pipe(
      Effect.map((rows) => rows.map(fromSql)),
      Effect.mapError(toSqlOrDecodeError("listActiveBackgroundCommands")),
    ),
    listByThread: (threadId) =>
      findByThread(threadId).pipe(
        Effect.map((rows) => rows.map(fromSql)),
        Effect.mapError(toSqlOrDecodeError("listThreadBackgroundCommands")),
      ),
    finish: (id, end) =>
      sql<{ readonly id: string }>`
        UPDATE thread_background_commands SET
          status = ${end.status},
          exit_status = ${end.exitStatus},
          ended_at = ${end.endedAt},
          next_check_in_at = NULL,
          end_notice_sent = ${end.endNoticeSent ? 1 : 0}
        WHERE background_command_id = ${id} AND status = 'running'
        RETURNING background_command_id AS "id"
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(write("finishBackgroundCommand")),
      ),
    requestStop: (id, by, at) =>
      sql<{ readonly id: string }>`
        UPDATE thread_background_commands SET
          stop_requested_by = COALESCE(stop_requested_by, ${by}),
          stop_requested_at = COALESCE(stop_requested_at, ${at})
        WHERE background_command_id = ${id} AND status = 'running'
        RETURNING background_command_id AS "id"
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(write("stopBackgroundCommand")),
      ),
    markEndNoticeSent: (id) =>
      sql`
        UPDATE thread_background_commands SET end_notice_sent = 1
        WHERE background_command_id = ${id}
      `.pipe(Effect.asVoid, Effect.mapError(write("markBackgroundCommandNotified"))),
    recordStatusNotice: (id, notice) =>
      sql`
        UPDATE thread_background_commands SET
          next_check_in_at = ${notice.nextStatusAt},
          status_notices_sent = status_notices_sent + 1,
          stdout_bytes_noticed = ${notice.stdoutBytes},
          stderr_bytes_noticed = ${notice.stderrBytes}
        WHERE background_command_id = ${id} AND status = 'running'
      `.pipe(Effect.asVoid, Effect.mapError(write("recordBackgroundCommandStatus"))),
    setMissingObservations: (id, count) =>
      sql`
        UPDATE thread_background_commands SET missing_observations = ${count}
        WHERE background_command_id = ${id}
      `.pipe(Effect.asVoid, Effect.mapError(write("recordBackgroundCommandMissing"))),
    removeByThread: (threadId) =>
      sql`DELETE FROM thread_background_commands WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
        Effect.mapError(write("removeThreadBackgroundCommands")),
      ),
  });
});

export const layer = Layer.effect(ThreadBackgroundCommandRepository, make);

/**
 * Threads whose background commands changed, for the per-thread streams. Both the runner and the
 * check-in scheduler (which records the notices it sends) publish here.
 */
export class BackgroundCommandChanges extends Context.Service<
  BackgroundCommandChanges,
  PubSub.PubSub<ThreadId>
>()("t3/persistence/ThreadBackgroundCommands/BackgroundCommandChanges") {}

export const changesLayer = Layer.effect(BackgroundCommandChanges, PubSub.unbounded<ThreadId>());
