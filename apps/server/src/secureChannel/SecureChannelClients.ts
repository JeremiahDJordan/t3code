import { AuthSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export class SecureChannelClientsError extends Schema.TaggedError<SecureChannelClientsError>()(
  "SecureChannelClientsError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Secure channel client lookup failed: ${this.operation}.`;
  }
}

/**
 * Which client key each session was paired through. The gateway opens a channel only for a key
 * with a live session, or one carrying a live pairing code, and closes a key's channels when its
 * last session is revoked.
 */
export class SecureChannelClients extends Context.Service<
  SecureChannelClients,
  {
    readonly bind: (input: {
      readonly sessionId: AuthSessionId;
      readonly clientKey: string;
    }) => Effect.Effect<void, SecureChannelClientsError>;
    /** When the key's last session that is neither revoked nor expired runs out; none without one. */
    readonly pairedUntil: (
      clientKey: string,
    ) => Effect.Effect<Option.Option<DateTime.Utc>, SecureChannelClientsError>;
    readonly clientKeyOfSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<string>, SecureChannelClientsError>;
  }
>()("t3/secureChannel/SecureChannelClients") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Kept out of the numbered migrations, so the fork's schema never collides with upstream's.
  const ensureTable = yield* Effect.cached(
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE IF NOT EXISTS secure_channel_sessions (
          session_id TEXT PRIMARY KEY,
          client_key TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_secure_channel_sessions_client_key
        ON secure_channel_sessions(client_key)
      `;
    }).pipe(
      Effect.mapError(
        (cause) => new SecureChannelClientsError({ operation: "create table", cause }),
      ),
    ),
  );

  const insert = SqlSchema.void({
    Request: Schema.Struct({ sessionId: AuthSessionId, clientKey: Schema.String }),
    execute: ({ sessionId, clientKey }) =>
      sql`
        INSERT INTO secure_channel_sessions (session_id, client_key)
        VALUES (${sessionId}, ${clientKey})
        ON CONFLICT (session_id) DO UPDATE SET client_key = excluded.client_key
      `,
  });

  const findLive = SqlSchema.findAll({
    Request: Schema.Struct({ clientKey: Schema.String, now: Schema.DateTimeUtcFromString }),
    Result: Schema.Struct({ expiresAt: Schema.DateTimeUtcFromString }),
    execute: ({ clientKey, now }) =>
      sql`
        SELECT session.expires_at AS "expiresAt"
        FROM secure_channel_sessions AS channel
        JOIN auth_sessions AS session ON session.session_id = channel.session_id
        WHERE channel.client_key = ${clientKey}
          AND session.revoked_at IS NULL
          AND session.expires_at > ${now}
        ORDER BY session.expires_at DESC
        LIMIT 1
      `,
  });

  const findKey = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: AuthSessionId }),
    Result: Schema.Struct({ clientKey: Schema.String }),
    execute: ({ sessionId }) =>
      sql`
        SELECT client_key AS "clientKey"
        FROM secure_channel_sessions
        WHERE session_id = ${sessionId}
      `,
  });

  const run = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    ensureTable.pipe(
      Effect.andThen(
        effect.pipe(
          Effect.mapError((cause) => new SecureChannelClientsError({ operation, cause })),
        ),
      ),
    );

  return SecureChannelClients.of({
    bind: (input) => run("bind", insert(input)),
    pairedUntil: (clientKey) =>
      DateTime.now.pipe(
        Effect.flatMap((now) => run("pairedUntil", findLive({ clientKey, now }))),
        Effect.map((rows) => Option.fromUndefinedOr(rows[0]?.expiresAt)),
      ),
    clientKeyOfSession: (sessionId) =>
      run("clientKeyOfSession", findKey({ sessionId })).pipe(
        Effect.map((rows) => Option.fromUndefinedOr(rows[0]?.clientKey)),
      ),
  });
});

export const layer = Layer.effect(SecureChannelClients, make);
