import { BackgroundCommandId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import * as ThreadBackgroundCommands from "./ThreadBackgroundCommands.ts";

describe("ThreadBackgroundCommandRepository", () => {
  it.effect("adds the match columns to a table from before they existed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The table as the first release of background commands created it, with one command.
      yield* sql`
        CREATE TABLE thread_background_commands (
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
      `;
      yield* sql`
        INSERT INTO thread_background_commands (
          background_command_id, thread_id, command, cwd, job_dir, stdout_path, stderr_path,
          tmux_session, status, started_at, note, tail_lines
        ) VALUES (
          'bg-old', 'thread-1', 'make test', '/repo', '/repo/.t3/jobs/bg-old',
          '/repo/.t3/jobs/bg-old/stdout.log', '/repo/.t3/jobs/bg-old/stderr.log', 't3-bg-old',
          'running', '2026-09-28T12:00:00.000Z', '', 0
        )
      `;

      const repository = Context.get(
        yield* Layer.build(ThreadBackgroundCommands.layer),
        ThreadBackgroundCommands.ThreadBackgroundCommandRepository,
      );
      const old = yield* repository.listByThread(ThreadId.make("thread-1"));
      assert.lengthOf(old, 1);
      assert.strictEqual(old[0]?.notifyOn, null);
      assert.strictEqual(old[0]?.matchBytesNoticed, 0);
      assert.strictEqual(old[0]?.muted, false);

      yield* repository.recordNotice(BackgroundCommandId.make("bg-old"), {
        kind: "match",
        nextStatusAt: null,
        stdoutBytes: 10,
        stderrBytes: 0,
        matchBytes: 64,
        matchesAt: "2026-09-28T12:21:00.000Z",
      });
      const noticed = yield* repository.get(BackgroundCommandId.make("bg-old"));
      assert.strictEqual(noticed?.matchNoticesSent, 1);
      assert.strictEqual(noticed?.statusNoticesSent, 0);
      assert.strictEqual(noticed?.matchBytesNoticed, 64);
      assert.strictEqual(noticed?.lastMatchNoticeAt, "2026-09-28T12:21:00.000Z");
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
  );
});
