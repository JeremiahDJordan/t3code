// @effect-diagnostics nodeBuiltinImport:off - runs a script's command as a process group it can kill.
/**
 * A workflow script's `exec(command, opts)`: one shell command in a checkout,
 * run in the sandbox of Bob's commands where the host has one, bounded in time
 * and output, and journaled per coordinator thread, so a Retry replays a
 * command that finished instead of running it again. The journal also keeps
 * the agents whose results the engine discarded, which a Retry must not reuse.
 */
import * as NodeChildProcess from "node:child_process";

import type { ProviderInteractionMode, RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import {
  type BobSandboxMode,
  bobSandboxAvailable,
  commandSandboxSpawn,
} from "../provider/acp/bobSandbox.ts";
import { WORKFLOW_VALUE_MAX_BYTES } from "./WorkflowSandboxProtocol.ts";

export const EXEC_DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const EXEC_MAX_TIMEOUT_MS = 60 * 60_000;
/**
 * The tail of each stream a result keeps. Both, escaped as JSON, must fit the
 * 1 MB a value may take into the script; `fitted` cuts them further when not.
 */
export const EXEC_OUTPUT_MAX_BYTES = 256 * 1024;
/** How long a command's pipes may stay open after it exited, held by a process that left its group. */
const PIPE_GRACE_MS = 2_000;

export const WorkflowExecResult = Schema.Struct({
  /** Null when a signal ended the command, as a timeout's kill does. */
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  stderr: Schema.String,
  timedOut: Schema.Boolean,
});
export type WorkflowExecResult = typeof WorkflowExecResult.Type;

export class WorkflowExecRefusedError extends Schema.TaggedError<WorkflowExecRefusedError>()(
  "WorkflowExecRefusedError",
  { reason: Schema.Literals(["no-sandbox", "unsandboxable-path"]) },
) {
  override get message(): string {
    return this.reason === "no-sandbox"
      ? "This host has no sandbox for commands, so exec() runs only in a workflow started from a thread in Full access."
      : "Commands cannot be sandboxed in this checkout: its path runs through a symlink, or holds a character a sandbox profile cannot name.";
  }
}

export class WorkflowExecSpawnError extends Schema.TaggedError<WorkflowExecSpawnError>()(
  "WorkflowExecSpawnError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The command could not be started.";
  }
}

export class WorkflowExecJournalError extends Schema.TaggedError<WorkflowExecJournalError>()(
  "WorkflowExecJournalError",
  {
    operation: Schema.Literals(["read", "record", "forget"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} a workflow command's result.`;
  }
}

/** How a command runs: in the sandbox, writing its checkout or not; as the user; or not at all. */
export type WorkflowExecPlan =
  | { readonly kind: "sandboxed"; readonly mode: BobSandboxMode; readonly network: boolean }
  | { readonly kind: "unsandboxed" }
  | { readonly kind: "refused" };

/**
 * Where the host has a sandbox, a command always runs in it: writing only a
 * workspace's worktree, and only when the coordinator may edit (not
 * Supervised, not plan mode), never the run's base checkout; reaching the
 * network only in Full access. Without one, only Full access runs it, as the user.
 */
export function planWorkflowExec(input: {
  readonly sandboxAvailable: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** Whether the command runs in a workspace's worktree rather than the base checkout. */
  readonly workspace: boolean;
}): WorkflowExecPlan {
  const fullAccess = input.runtimeMode === "full-access";
  if (!input.sandboxAvailable) return fullAccess ? { kind: "unsandboxed" } : { kind: "refused" };
  const writes =
    input.workspace &&
    input.runtimeMode !== "approval-required" &&
    input.interactionMode !== "plan";
  return {
    kind: "sandboxed",
    mode: writes ? "workspace-write" : "read-only",
    network: fullAccess,
  };
}

/** Names like a credential's, which Bob's sandbox shell also keeps from every command. */
const CREDENTIAL_NAME = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;
/** T3's own variables, and Electron's, which would make an Electron app a command starts run as Node. */
const T3_NAME = /^(T3CODE_|T3_|ELECTRON_RUN_AS_NODE$)/;

/**
 * A command's environment: the server's, without credentials or T3's own
 * variables, then the script's `env`, which is the script's to choose.
 */
export function workflowExecEnvironment(
  server: NodeJS.ProcessEnv,
  script: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(server)) {
    if (value === undefined || CREDENTIAL_NAME.test(name) || T3_NAME.test(name)) continue;
    environment[name] = value;
  }
  return { ...environment, ...script };
}

/** A stream's output: the text kept of it, and how many bytes before that were cut. */
export interface WorkflowExecOutput {
  readonly text: string;
  readonly cut: number;
}

/** The last `max` bytes written to a stream, and how many came before them. */
function makeTail(max: number) {
  const chunks: Array<Buffer> = [];
  let size = 0;
  let dropped = 0;
  return {
    push: (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      while (chunks.length > 1 && size - chunks[0]!.length >= max) {
        size -= chunks[0]!.length;
        dropped += chunks.shift()!.length;
      }
    },
    output: (): WorkflowExecOutput => {
      const all = Buffer.concat(chunks);
      const kept = all.length > max ? all.subarray(all.length - max) : all;
      return { text: kept.toString("utf8"), cut: dropped + all.length - kept.length };
    },
  };
}

/** Output that lost its first `bytes`, saying so on a line of its own. */
const withCut = (text: string, bytes: number) =>
  bytes === 0 ? text : `[exec: the first ${bytes} bytes of output were cut]\n${text}`;

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");
const toJsonText = Schema.encodeSync(Schema.fromJsonString(WorkflowExecResult));
const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowExecResult));

/**
 * The result, cut to fit into the script: output escaped as JSON, control
 * characters say, can take six times its bytes, so the longer stream loses
 * more of its start until the whole is under the limit.
 */
export function fitted(input: {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: WorkflowExecOutput;
  readonly stderr: WorkflowExecOutput;
}): WorkflowExecResult {
  const streams = { stdout: input.stdout, stderr: input.stderr };
  const build = (): WorkflowExecResult => ({
    exitCode: input.exitCode,
    stdout: withCut(streams.stdout.text, streams.stdout.cut),
    stderr: withCut(streams.stderr.text, streams.stderr.cut),
    timedOut: input.timedOut,
  });
  let result = build();
  while (utf8Bytes(toJsonText(result)) > WORKFLOW_VALUE_MAX_BYTES - 1024) {
    const key = streams.stdout.text.length >= streams.stderr.text.length ? "stdout" : "stderr";
    const { text, cut } = streams[key];
    const kept = text.slice(Math.floor(text.length / 4));
    streams[key] = { text: kept, cut: cut + utf8Bytes(text) - utf8Bytes(kept) };
    result = build();
  }
  return result;
}

export interface WorkflowExecRun {
  readonly command: string;
  readonly cwd: string;
  /** Whether `cwd` is a workspace's worktree, which a command may change, rather than the base checkout. */
  readonly workspace: boolean;
  /** The coordinator's modes, which decide what the command may reach. */
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
}

export class WorkflowExec extends Context.Service<
  WorkflowExec,
  {
    /** Runs the command to its end, or kills its process group when interrupted. */
    readonly run: (
      input: WorkflowExecRun,
    ) => Effect.Effect<WorkflowExecResult, WorkflowExecRefusedError | WorkflowExecSpawnError>;
    /** The result a call of the run's script recorded on an earlier attempt. */
    readonly recorded: (
      threadId: ThreadId,
      callId: string,
    ) => Effect.Effect<Option.Option<WorkflowExecResult>, WorkflowExecJournalError>;
    readonly record: (
      threadId: ThreadId,
      callId: string,
      result: WorkflowExecResult,
    ) => Effect.Effect<void, WorkflowExecJournalError>;
    /**
     * Records that the engine discarded a finished agent's result, as a read-only
     * workspace that changed does, so a Retry starts the call again rather than reuse it.
     */
    readonly discard: (
      threadId: ThreadId,
      taskId: string,
    ) => Effect.Effect<void, WorkflowExecJournalError>;
    readonly discarded: (
      threadId: ThreadId,
      taskId: string,
    ) => Effect.Effect<boolean, WorkflowExecJournalError>;
    /** Drops a run's results and discards once it finished, when no Retry can replay them. */
    readonly forget: (threadId: ThreadId) => Effect.Effect<void, WorkflowExecJournalError>;
  }
>()("t3/workflow/WorkflowExec") {}

/** The command that ends Windows process `pid` with every process under it. */
const windowsTreeKill = (pid: number) => ({
  command: "taskkill",
  args: ["/T", "/F", "/PID", String(pid)],
});

/**
 * Kills the process group `child` leads. Windows has no groups, so while the
 * shell runs, `taskkill /T` ends it and every process under it; once it exited
 * its pid may name another process, and what it left running is out of reach.
 */
export const killTree = (
  child: {
    readonly pid?: number | undefined;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    readonly kill: (signal: NodeJS.Signals) => boolean;
  },
  platform: NodeJS.Platform,
  spawn: (
    command: string,
    args: ReadonlyArray<string>,
  ) => {
    readonly once: (event: "error" | "exit", listener: (code: number | null) => void) => unknown;
  } = (command, args) =>
    NodeChildProcess.spawn(command, [...args], { stdio: "ignore", windowsHide: true }),
): Effect.Effect<void> => {
  const pid = child.pid;
  if (pid === undefined) return Effect.void;
  if (platform !== "win32") {
    return Effect.sync(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The group is gone already.
        child.kill("SIGKILL");
      }
    });
  }
  if (child.exitCode !== null || child.signalCode !== null) return Effect.void;
  return Effect.callback<void>((resume) => {
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      // Without taskkill the shell alone still ends.
      if (code !== 0) child.kill("SIGKILL");
      resume(Effect.void);
    };
    const kill = windowsTreeKill(pid);
    try {
      const killer = spawn(kill.command, kill.args);
      killer.once("error", () => settle(null));
      killer.once("exit", settle);
    } catch {
      settle(null);
    }
  });
};

/** Runs a spawned command to its result, killing its group past `timeoutMs` or when interrupted. */
const runProcess = (
  launch: { readonly command: string; readonly args: ReadonlyArray<string> },
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeoutMs: number;
    readonly platform: NodeJS.Platform;
  },
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const exited = Deferred.makeUnsafe<number | null, WorkflowExecSpawnError>();
      const closed = Deferred.makeUnsafe<void>();
      const stdout = makeTail(EXEC_OUTPUT_MAX_BYTES);
      const stderr = makeTail(EXEC_OUTPUT_MAX_BYTES);
      const child = yield* Effect.try({
        try: () =>
          NodeChildProcess.spawn(launch.command, [...launch.args], {
            cwd: options.cwd,
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"],
            // Its own process group, so a kill reaches what the command started.
            detached: options.platform !== "win32",
            // Windows has no `/bin/sh`; only Full access reaches here, unsandboxed.
            shell: options.platform === "win32",
            windowsHide: true,
          }),
        catch: (cause) => new WorkflowExecSpawnError({ cause }),
      });
      child.stdout?.on("data", stdout.push);
      child.stderr?.on("data", stderr.push);
      child.on("error", (cause) =>
        Deferred.doneUnsafe(exited, Effect.fail(new WorkflowExecSpawnError({ cause }))),
      );
      child.on("exit", (code) => Deferred.doneUnsafe(exited, Effect.succeed(code)));
      child.on("close", () => Deferred.doneUnsafe(closed, Effect.void));
      const kill = Effect.suspend(() => killTree(child, options.platform));
      return yield* restore(
        Effect.gen(function* () {
          const inTime = yield* Deferred.await(exited).pipe(
            Effect.timeoutOption(Duration.millis(options.timeoutMs)),
          );
          if (Option.isNone(inTime)) yield* kill;
          const exitCode = Option.isSome(inTime) ? inTime.value : yield* Deferred.await(exited);
          // What the command left running in its group does not outlive it, nor does a process
          // that left the group hold its result back for long by keeping the pipes open.
          yield* kill;
          yield* Deferred.await(closed).pipe(Effect.timeoutOption(Duration.millis(PIPE_GRACE_MS)));
          child.stdout?.destroy();
          child.stderr?.destroy();
          return fitted({
            exitCode,
            stdout: stdout.output(),
            stderr: stderr.output(),
            timedOut: Option.isNone(inTime),
          });
        }),
      ).pipe(
        // Spawned without a gap for an interruption to fall into, and never left running.
        Effect.onInterrupt(() => kill.pipe(Effect.andThen(Deferred.await(exited)), Effect.ignore)),
      );
    }),
  );

export const layer = Layer.effect(
  WorkflowExec,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig.ServerConfig;
    const platform = yield* HostProcess.Platform;
    const serverEnvironment = yield* HostProcess.Environment;

    // Created here rather than by a numbered migration, as `workflow_sources` is. See FORK.md.
    yield* sql`
      CREATE TABLE IF NOT EXISTS workflow_exec_results (
        thread_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, call_id)
      )
    `.pipe(Effect.orDie);
    yield* sql`
      CREATE TABLE IF NOT EXISTS workflow_discarded_results (
        thread_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, task_id)
      )
    `.pipe(Effect.orDie);

    const run = Effect.fn("WorkflowExec.run")(function* (input: WorkflowExecRun) {
      const plan = planWorkflowExec({
        sandboxAvailable: bobSandboxAvailable(platform),
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        workspace: input.workspace,
      });
      if (plan.kind === "refused") {
        return yield* new WorkflowExecRefusedError({ reason: "no-sandbox" });
      }
      const env = workflowExecEnvironment(serverEnvironment, input.env);
      const launch =
        plan.kind === "unsandboxed"
          ? platform === "win32"
            ? { command: input.command, args: [] }
            : { command: "/bin/sh", args: ["-c", input.command] }
          : commandSandboxSpawn({
              platform,
              command: input.command,
              cwd: input.cwd,
              mode: plan.mode,
              network: plan.network,
              environment: env,
              cacheDir: config.providerStatusCacheDir,
              stateDir: config.stateDir,
            });
      if (launch === undefined) {
        return yield* new WorkflowExecRefusedError({ reason: "unsandboxable-path" });
      }
      return yield* runProcess(launch, {
        cwd: input.cwd,
        env,
        timeoutMs: input.timeoutMs,
        platform,
      });
    });

    const recorded = Effect.fn("WorkflowExec.recorded")(function* (
      threadId: ThreadId,
      callId: string,
    ) {
      const rows = yield* sql<{ readonly resultJson: string }>`
        SELECT result_json AS "resultJson" FROM workflow_exec_results
        WHERE thread_id = ${threadId} AND call_id = ${callId}
      `.pipe(
        Effect.mapError((cause) => new WorkflowExecJournalError({ operation: "read", cause })),
      );
      const row = rows[0];
      if (row === undefined) return Option.none();
      return Option.some(
        yield* decodeResult(row.resultJson).pipe(
          Effect.mapError((cause) => new WorkflowExecJournalError({ operation: "read", cause })),
        ),
      );
    });

    const record = Effect.fn("WorkflowExec.record")(function* (
      threadId: ThreadId,
      callId: string,
      result: WorkflowExecResult,
    ) {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO workflow_exec_results (thread_id, call_id, result_json, created_at)
        VALUES (${threadId}, ${callId}, ${toJsonText(result)}, ${createdAt})
        ON CONFLICT(thread_id, call_id) DO NOTHING
      `.pipe(
        Effect.mapError((cause) => new WorkflowExecJournalError({ operation: "record", cause })),
      );
    });

    const discard = Effect.fn("WorkflowExec.discard")(function* (
      threadId: ThreadId,
      taskId: string,
    ) {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO workflow_discarded_results (thread_id, task_id, created_at)
        VALUES (${threadId}, ${taskId}, ${createdAt})
        ON CONFLICT(thread_id, task_id) DO NOTHING
      `.pipe(
        Effect.mapError((cause) => new WorkflowExecJournalError({ operation: "record", cause })),
      );
    });

    const discarded = Effect.fn("WorkflowExec.discarded")(function* (
      threadId: ThreadId,
      taskId: string,
    ) {
      const rows = yield* sql<{ readonly taskId: string }>`
        SELECT task_id AS "taskId" FROM workflow_discarded_results
        WHERE thread_id = ${threadId} AND task_id = ${taskId}
      `.pipe(
        Effect.mapError((cause) => new WorkflowExecJournalError({ operation: "read", cause })),
      );
      return rows.length > 0;
    });

    const forget = Effect.fn("WorkflowExec.forget")(function* (threadId: ThreadId) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM workflow_exec_results WHERE thread_id = ${threadId}`;
            yield* sql`DELETE FROM workflow_discarded_results WHERE thread_id = ${threadId}`;
          }),
        )
        .pipe(
          Effect.mapError((cause) => new WorkflowExecJournalError({ operation: "forget", cause })),
        );
    });

    return WorkflowExec.of({ run, recorded, record, discard, discarded, forget });
  }),
);
