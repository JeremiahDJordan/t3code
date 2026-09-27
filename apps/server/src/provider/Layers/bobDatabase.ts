// @effect-diagnostics nodeBuiltinImport:off - Bob's task database is SQLite, and node:sqlite
// has no Effect platform service.
/**
 * bobDatabase - read-only access to Bob Shell's task database (`bob.db`), shared by the
 * adapter's usage, project import, and the Usage page.
 *
 * Bob writes the database while T3 reads it, so every read opens its own read-only
 * connection, waits only briefly for Bob's writer, and closes it before returning.
 * Opening read-only never creates a missing database.
 *
 * @module provider/Layers/bobDatabase
 */
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";

/** How long a read waits on Bob's writer before failing, so a busy Bob never stalls T3. */
const BOB_DATABASE_BUSY_TIMEOUT_MS = 100;

/**
 * Runs `read` on Bob's database opened read-only, and closes it once `read` settles, even when
 * it throws or rejects. `read` may be async, such as to yield to the event loop between rows.
 * Rejects when the database is missing or cannot be read.
 */
export async function withBobDatabase<A>(
  databasePath: string,
  read: (database: NodeSqlite.DatabaseSync) => A | PromiseLike<A>,
): Promise<A> {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec(`PRAGMA busy_timeout = ${BOB_DATABASE_BUSY_TIMEOUT_MS}`);
    return await read(database);
  } finally {
    database.close();
  }
}

/**
 * A best-effort synchronous read of Bob's database (see `withBobDatabase`). Undefined when the
 * database is missing or `read` fails, as with an older schema or a busy Bob.
 */
export const readBobDatabase = <A>(
  databasePath: string,
  read: (database: NodeSqlite.DatabaseSync) => A,
): Effect.Effect<A | undefined> =>
  Effect.tryPromise(() => withBobDatabase(databasePath, read)).pipe(
    Effect.orElseSucceed(() => undefined),
  );

/**
 * The columns of one of Bob's tables, so a query can leave out what an older Bob lacks.
 * Empty when the table does not exist.
 */
export function bobTableColumns(
  database: NodeSqlite.DatabaseSync,
  table: string,
): ReadonlySet<string> {
  return new Set(
    database
      .prepare("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
}
