import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  AgentMessageEnvelope,
  EnvironmentId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

import {
  type AgentThreadRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

export const AgentMessageStatus = Schema.Literals(["queued", "delivered", "failed"]);
export type AgentMessageStatus = typeof AgentMessageStatus.Type;

/**
 * One message between threads. It is written before anything is sent, keyed by the envelope's
 * `messageId`, so a retry can never make a second row; a message to a thread in this
 * environment waits here as `queued` until the check-in scheduler delivers it.
 */
export const AgentMessageRow = Schema.Struct({
  messageId: TrimmedNonEmptyString,
  kind: AgentMessageEnvelope.fields.kind,
  envelope: Schema.fromJsonString(AgentMessageEnvelope),
  senderEnvironmentId: EnvironmentId,
  senderThreadId: ThreadId,
  targetEnvironmentId: EnvironmentId,
  targetThreadId: ThreadId,
  status: AgentMessageStatus,
  createdAt: Schema.String,
  deliveredAt: Schema.NullOr(Schema.String),
});
export type AgentMessageRow = typeof AgentMessageRow.Type;

/** A thread an agent started: who started it, with which message, and how deep it nests. */
export const AgentThreadLink = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  startedByEnvironmentId: EnvironmentId,
  startedByThreadId: ThreadId,
  startedByMessageId: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  createdAt: Schema.String,
});
export type AgentThreadLink = typeof AgentThreadLink.Type;

interface ThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Messages between threads and the threads agents started. */
export class AgentThreadRepository extends Context.Service<
  AgentThreadRepository,
  {
    /** Adds a message unless one with its id exists; whether it was added. */
    readonly insertMessage: (
      row: AgentMessageRow,
    ) => Effect.Effect<boolean, AgentThreadRepositoryError>;
    readonly getMessage: (
      messageId: string,
    ) => Effect.Effect<Option.Option<AgentMessageRow>, AgentThreadRepositoryError>;
    /** Queued messages to threads in `environmentId`, oldest first. */
    readonly listQueued: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ReadonlyArray<AgentMessageRow>, AgentThreadRepositoryError>;
    readonly markDelivered: (
      messageId: string,
      deliveredAt: string,
    ) => Effect.Effect<void, AgentThreadRepositoryError>;
    readonly markFailed: (messageId: string) => Effect.Effect<void, AgentThreadRepositoryError>;
    /** Messages and thread starts a thread sent since `since`. */
    readonly countSentSince: (
      sender: ThreadRef,
      since: string,
    ) => Effect.Effect<number, AgentThreadRepositoryError>;
    /** Messages sent to a thread since `since`. */
    readonly countReceivedSince: (
      target: ThreadRef,
      since: string,
    ) => Effect.Effect<number, AgentThreadRepositoryError>;
    readonly insertLink: (
      link: AgentThreadLink,
    ) => Effect.Effect<boolean, AgentThreadRepositoryError>;
    readonly getLink: (
      thread: ThreadRef,
    ) => Effect.Effect<Option.Option<AgentThreadLink>, AgentThreadRepositoryError>;
    readonly listLinks: Effect.Effect<ReadonlyArray<AgentThreadLink>, AgentThreadRepositoryError>;
    /** Threads a thread started since `since`. */
    readonly countStartedSince: (
      startedBy: ThreadRef,
      since: string,
    ) => Effect.Effect<number, AgentThreadRepositoryError>;
    /** Fails the queued messages to a thread that is gone. */
    readonly failQueuedTo: (target: ThreadRef) => Effect.Effect<void, AgentThreadRepositoryError>;
    /** Forgets messages that ended before `before`; links stay. */
    readonly pruneMessages: (before: string) => Effect.Effect<void, AgentThreadRepositoryError>;
  }
>()("t3/persistence/AgentThreads/AgentThreadRepository") {}

function toSqlOrDecodeError(operation: string) {
  return (cause: unknown): AgentThreadRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError("AgentThreads", cause)
      : new PersistenceSqlError({ operation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Created here rather than by a numbered migration, like the fork's other tables. See FORK.md.
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_thread_messages (
      message_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      sender_environment_id TEXT NOT NULL,
      sender_thread_id TEXT NOT NULL,
      target_environment_id TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `.pipe(Effect.orDie);
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_target
    ON agent_thread_messages (target_environment_id, status, created_at)
  `.pipe(Effect.orDie);
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_sender
    ON agent_thread_messages (sender_environment_id, sender_thread_id, created_at)
  `.pipe(Effect.orDie);
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_thread_links (
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      started_by_environment_id TEXT NOT NULL,
      started_by_thread_id TEXT NOT NULL,
      started_by_message_id TEXT NOT NULL,
      depth INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (environment_id, thread_id)
    )
  `.pipe(Effect.orDie);
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_thread_links_started_by
    ON agent_thread_links (started_by_environment_id, started_by_thread_id, created_at)
  `.pipe(Effect.orDie);

  const messageColumns = sql`
    message_id AS "messageId",
    kind AS "kind",
    envelope_json AS "envelope",
    sender_environment_id AS "senderEnvironmentId",
    sender_thread_id AS "senderThreadId",
    target_environment_id AS "targetEnvironmentId",
    target_thread_id AS "targetThreadId",
    status AS "status",
    created_at AS "createdAt",
    delivered_at AS "deliveredAt"
  `;
  const linkColumns = sql`
    environment_id AS "environmentId",
    thread_id AS "threadId",
    started_by_environment_id AS "startedByEnvironmentId",
    started_by_thread_id AS "startedByThreadId",
    started_by_message_id AS "startedByMessageId",
    depth AS "depth",
    created_at AS "createdAt"
  `;

  const listQueuedRows = SqlSchema.findAll({
    Request: EnvironmentId,
    Result: AgentMessageRow,
    execute: (environmentId) => sql`
      SELECT ${messageColumns} FROM agent_thread_messages
      WHERE target_environment_id = ${environmentId} AND status = 'queued'
      ORDER BY created_at, message_id
    `,
  });
  const findMessage = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: AgentMessageRow,
    execute: (messageId) => sql`
      SELECT ${messageColumns} FROM agent_thread_messages WHERE message_id = ${messageId}
    `,
  });
  const findLink = SqlSchema.findOneOption({
    Request: Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId }),
    Result: AgentThreadLink,
    execute: ({ environmentId, threadId }) => sql`
      SELECT ${linkColumns} FROM agent_thread_links
      WHERE environment_id = ${environmentId} AND thread_id = ${threadId}
    `,
  });
  const listLinkRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AgentThreadLink,
    execute: () => sql`SELECT ${linkColumns} FROM agent_thread_links`,
  });
  const count = <E>(operation: string, query: Effect.Effect<ReadonlyArray<{ n: number }>, E>) =>
    query.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
      Effect.mapError(toSqlOrDecodeError(operation)),
    );

  return AgentThreadRepository.of({
    insertMessage: (row) =>
      sql<{ readonly id: string }>`
        INSERT INTO agent_thread_messages (
          message_id,
          kind,
          envelope_json,
          sender_environment_id,
          sender_thread_id,
          target_environment_id,
          target_thread_id,
          status,
          created_at,
          delivered_at
        )
        VALUES (
          ${row.messageId},
          ${row.kind},
          ${JSON.stringify(row.envelope)},
          ${row.senderEnvironmentId},
          ${row.senderThreadId},
          ${row.targetEnvironmentId},
          ${row.targetThreadId},
          ${row.status},
          ${row.createdAt},
          ${row.deliveredAt}
        )
        ON CONFLICT (message_id) DO NOTHING
        RETURNING message_id AS "id"
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toSqlOrDecodeError("insertAgentMessage")),
      ),
    getMessage: (messageId) =>
      findMessage(messageId).pipe(Effect.mapError(toSqlOrDecodeError("getAgentMessage"))),
    listQueued: (environmentId) =>
      listQueuedRows(environmentId).pipe(Effect.mapError(toSqlOrDecodeError("listQueuedMessages"))),
    markDelivered: (messageId, deliveredAt) =>
      sql`
        UPDATE agent_thread_messages SET status = 'delivered', delivered_at = ${deliveredAt}
        WHERE message_id = ${messageId}
      `.pipe(Effect.asVoid, Effect.mapError(toSqlOrDecodeError("markAgentMessageDelivered"))),
    markFailed: (messageId) =>
      sql`UPDATE agent_thread_messages SET status = 'failed' WHERE message_id = ${messageId}`.pipe(
        Effect.asVoid,
        Effect.mapError(toSqlOrDecodeError("markAgentMessageFailed")),
      ),
    countSentSince: (sender, since) =>
      count(
        "countAgentMessagesSent",
        sql<{ n: number }>`
          SELECT COUNT(*) AS "n" FROM agent_thread_messages
          WHERE sender_environment_id = ${sender.environmentId}
            AND sender_thread_id = ${sender.threadId}
            AND kind = 'message'
            AND created_at >= ${since}
        `,
      ),
    countReceivedSince: (target, since) =>
      count(
        "countAgentMessagesReceived",
        sql<{ n: number }>`
          SELECT COUNT(*) AS "n" FROM agent_thread_messages
          WHERE target_environment_id = ${target.environmentId}
            AND target_thread_id = ${target.threadId}
            AND kind = 'message'
            AND created_at >= ${since}
        `,
      ),
    insertLink: (link) =>
      sql<{ readonly id: string }>`
        INSERT INTO agent_thread_links (
          environment_id,
          thread_id,
          started_by_environment_id,
          started_by_thread_id,
          started_by_message_id,
          depth,
          created_at
        )
        VALUES (
          ${link.environmentId},
          ${link.threadId},
          ${link.startedByEnvironmentId},
          ${link.startedByThreadId},
          ${link.startedByMessageId},
          ${link.depth},
          ${link.createdAt}
        )
        ON CONFLICT (environment_id, thread_id) DO NOTHING
        RETURNING thread_id AS "id"
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toSqlOrDecodeError("insertAgentThreadLink")),
      ),
    getLink: (thread) =>
      findLink(thread).pipe(Effect.mapError(toSqlOrDecodeError("getAgentThreadLink"))),
    listLinks: listLinkRows(undefined).pipe(
      Effect.mapError(toSqlOrDecodeError("listAgentThreadLinks")),
    ),
    countStartedSince: (startedBy, since) =>
      count(
        "countAgentThreadsStarted",
        sql<{ n: number }>`
          SELECT COUNT(*) AS "n" FROM agent_thread_links
          WHERE started_by_environment_id = ${startedBy.environmentId}
            AND started_by_thread_id = ${startedBy.threadId}
            AND created_at >= ${since}
        `,
      ),
    failQueuedTo: (target) =>
      sql`
        UPDATE agent_thread_messages SET status = 'failed'
        WHERE target_environment_id = ${target.environmentId}
          AND target_thread_id = ${target.threadId}
          AND status = 'queued'
      `.pipe(Effect.asVoid, Effect.mapError(toSqlOrDecodeError("failQueuedAgentMessages"))),
    pruneMessages: (before) =>
      sql`
        DELETE FROM agent_thread_messages WHERE status != 'queued' AND created_at < ${before}
      `.pipe(Effect.asVoid, Effect.mapError(toSqlOrDecodeError("pruneAgentMessages"))),
  });
});

export const layer = Layer.effect(AgentThreadRepository, make);
