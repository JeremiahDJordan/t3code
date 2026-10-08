// @effect-diagnostics nodeBuiltinImport:off - starts the sandbox process and speaks line-delimited JSON with it.
/**
 * Runs workflow scripts in a process of their own (WorkflowSandboxProcess.ts),
 * one per run or `meta` read, so script code never runs on the server's
 * thread. The process stops a script itself at its soft CPU and memory limits,
 * with the line it stopped at; the server times each stretch of script work
 * the process reports and kills it past a hard deadline, which also bounds
 * builtins that never check the soft one. A crash takes only that process.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  type HostMessage,
  makeLineSplitter,
  type SandboxLimits,
  SandboxMessage,
  type SandboxOp,
  WORKFLOW_SANDBOX_COMMAND,
  WORKFLOW_VALUE_MAX_BYTES,
  HostMessage as HostMessageSchema,
} from "./WorkflowSandboxProtocol.ts";

/** CPU a script may use between host calls before it is stopped. */
const DEFAULT_CPU_SLICE_MS = 250;
/** CPU a run may use in all. */
const DEFAULT_CPU_TOTAL_MS = 10_000;
/** Loading QuickJS in a fresh process, before any script work. */
const STARTUP_MS = 30_000;
/** Past the soft limit, room for a builtin that never checks it, then a kill. */
const hardSliceMs = (limits: SandboxLimits) => limits.cpuSliceMs * 4 + 1_000;
const HARD_TOTAL_GRACE_MS = 2_000;

export class WorkflowScriptError extends Schema.TaggedError<WorkflowScriptError>()(
  "WorkflowScriptError",
  {
    /** The script's own error text, or why the sandbox stopped it. */
    reason: Schema.String,
    line: Schema.NullOr(Schema.Number),
  },
) {
  override get message(): string {
    return this.line === null ? this.reason : `Line ${this.line}: ${this.reason}`;
  }
}

export const isWorkflowScriptError = Schema.is(WorkflowScriptError);

/**
 * What a running script can reach. `agent` and `workspace` resolve to JSON
 * values; a failure rejects the script's promise with its message, which the
 * script may catch.
 */
export interface WorkflowSandboxHost<R> {
  readonly agent: (
    request: unknown,
    context: { readonly phase: string | null },
  ) => Effect.Effect<unknown, WorkflowScriptError, R>;
  readonly workspace: (request: unknown) => Effect.Effect<unknown, WorkflowScriptError, R>;
  readonly phase: (title: string) => Effect.Effect<void, never, R>;
  readonly log: (message: string) => Effect.Effect<void, never, R>;
}

export interface WorkflowSandboxOptions {
  readonly cpuSliceMs?: number;
  readonly cpuTotalMs?: number;
}

/** How the server starts a sandbox process. */
export interface WorkflowSandboxLauncher {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export class WorkflowSandbox extends Context.Service<
  WorkflowSandbox,
  {
    /** The script's `meta`, read by running the body with every hook stubbed to stop it. */
    readonly readMeta: (
      source: string,
      options?: WorkflowSandboxOptions,
    ) => Effect.Effect<unknown, WorkflowScriptError>;
    /** Runs the script to its result. Interrupting the effect kills the process. */
    readonly run: <R>(input: {
      readonly source: string;
      readonly args: unknown;
      readonly host: WorkflowSandboxHost<R>;
      readonly options?: WorkflowSandboxOptions;
    }) => Effect.Effect<unknown, WorkflowScriptError, R>;
  }
>()("t3/workflow/WorkflowSandbox") {}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodeSandboxMessage = Schema.decodeUnknownResult(Schema.fromJsonString(SandboxMessage));
const encodeHostMessage = Schema.encodeSync(Schema.fromJsonString(HostMessageSchema));

const scriptError = (reason: string, line: number | null = null) =>
  new WorkflowScriptError({
    // Error text reaches timelines and terminals: no control characters.
    // eslint-disable-next-line no-control-regex -- removing control characters is the point.
    reason: reason.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""),
    line,
  });

const tooLarge = (what: string) =>
  scriptError(`${what} is larger than ${WORKFLOW_VALUE_MAX_BYTES / 1024 / 1024} MB of JSON.`);

const limitsOf = (options: WorkflowSandboxOptions | undefined): SandboxLimits => ({
  cpuSliceMs: options?.cpuSliceMs ?? DEFAULT_CPU_SLICE_MS,
  cpuTotalMs: options?.cpuTotalMs ?? DEFAULT_CPU_TOTAL_MS,
});

type Incoming =
  | SandboxMessage
  | { readonly type: "exit"; readonly code: number | null; readonly stderr: string }
  | { readonly type: "garbled" };

/**
 * The environment a sandbox process starts with: enough for Node to run, and
 * none of the server's credentials.
 */
const sandboxEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

const make = (launcher: WorkflowSandboxLauncher) => {
  /** A sandbox process for the scope, killed when the scope closes. */
  const openProcess = Effect.gen(function* () {
    const incoming = yield* Queue.unbounded<Incoming>();
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeChildProcess.spawn(launcher.command, [...launcher.args], {
          stdio: ["pipe", "pipe", "pipe"],
          // Electron runs the server; its binary must start as plain Node.
          env: sandboxEnvironment(),
          windowsHide: true,
        }),
      ),
      (child) =>
        Effect.sync(() => {
          child.stdin.destroy();
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }),
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
    });
    child.stdin.on("error", () => undefined);
    // Every line must be a message: a dropped one would leave the run
    // waiting forever, so anything else ends it.
    const split = makeLineSplitter();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = split(chunk);
      for (const line of lines ?? [""]) {
        const decoded = decodeSandboxMessage(line);
        Queue.offerUnsafe(
          incoming,
          Result.isSuccess(decoded) ? decoded.success : { type: "garbled" },
        );
      }
    });
    const exited = (code: number | null) =>
      Queue.offerUnsafe(incoming, { type: "exit", code, stderr });
    child.on("error", () => exited(null));
    // After stdout closes, so no message the process wrote before exiting is lost.
    child.on("close", (code) => exited(code));
    const send = (message: HostMessage) =>
      Effect.sync(() => {
        if (child.stdin.writable) child.stdin.write(`${encodeHostMessage(message)}\n`);
      });
    return { incoming, send };
  });

  /**
   * Starts the process's work and follows it to its result's JSON text,
   * handing each hook call to `onOp` and timing each stretch of script work.
   */
  const drive = <R>(
    process_: Effect.Success<typeof openProcess>,
    start: HostMessage,
    limits: SandboxLimits,
    onOp: (op: SandboxOp) => Effect.Effect<void, never, R>,
  ) =>
    Effect.gen(function* () {
      yield* process_.send(start);
      const hardSlice = hardSliceMs(limits);
      const hardTotal = limits.cpuTotalMs + HARD_TOTAL_GRACE_MS;
      let started = false;
      let busySince: number | null = null;
      let spent = 0;
      while (true) {
        const now = yield* Clock.currentTimeMillis;
        const wait = !started
          ? STARTUP_MS
          : busySince === null
            ? undefined
            : Math.max(
                0,
                Math.min(hardSlice - (now - busySince), hardTotal - spent - (now - busySince)),
              );
        const next =
          wait === undefined
            ? Option.some(yield* Queue.take(process_.incoming))
            : yield* Queue.take(process_.incoming).pipe(
                Effect.timeoutOption(Duration.millis(wait)),
              );
        if (Option.isNone(next)) {
          // The scope's finalizer kills the process.
          if (!started) return yield* scriptError("The workflow sandbox did not start.");
          const elapsed = (yield* Clock.currentTimeMillis) - (busySince ?? 0);
          return yield* scriptError(
            spent + elapsed >= hardTotal
              ? `The script used more than ${limits.cpuTotalMs / 1000} s of CPU in all and was stopped.`
              : "The script ran too long without waiting on agent() and was stopped.",
          );
        }
        const message = next.value;
        switch (message.type) {
          case "busy":
            started = true;
            busySince = yield* Clock.currentTimeMillis;
            break;
          case "idle":
            if (busySince !== null) spent += (yield* Clock.currentTimeMillis) - busySince;
            busySince = null;
            break;
          case "op": {
            // Server-side work for the op is not the script's time.
            const handledFrom = yield* Clock.currentTimeMillis;
            yield* onOp(message.op);
            if (busySince !== null) {
              busySince += (yield* Clock.currentTimeMillis) - handledFrom;
            }
            break;
          }
          case "garbled":
            yield* Effect.logWarning("Workflow sandbox process sent an unreadable message");
            return yield* scriptError(
              "The workflow sandbox sent a message the server could not read.",
            );
          case "done":
            return message.json;
          case "failed":
            return yield* scriptError(message.reason, message.line);
          case "exit":
            yield* Effect.logWarning("Workflow sandbox process exited early", {
              code: message.code,
              stderr: message.stderr,
            });
            return yield* scriptError(
              `The workflow sandbox stopped unexpectedly${message.code === null ? "" : ` (exit code ${message.code})`}.`,
            );
        }
      }
    });

  const parseResultJson = (text: string) =>
    Result.match(decodeJson(text), {
      onFailure: () => Effect.fail(scriptError("The workflow's result is not JSON data.")),
      onSuccess: (value) => Effect.succeed(value),
    });

  const readMeta: WorkflowSandbox["Service"]["readMeta"] = (source, options) =>
    Effect.scoped(
      Effect.gen(function* () {
        const process_ = yield* openProcess;
        const limits = limitsOf(options);
        const text = yield* drive(
          process_,
          { type: "start", mode: "meta", source, limits },
          limits,
          () => Effect.void,
        );
        const read = (yield* parseResultJson(text)) as {
          readonly missing?: true;
          readonly problem?: string;
          readonly meta?: unknown;
        };
        if (read.missing) return yield* scriptError("The script's meta was never assigned.");
        if (read.problem !== undefined) {
          return yield* scriptError(`meta must be plain data: ${read.problem}.`);
        }
        return read.meta;
      }),
    ).pipe(Effect.withSpan("WorkflowSandbox.readMeta"));

  const run: WorkflowSandbox["Service"]["run"] = (input) =>
    Effect.gen(function* () {
      const argsJson = yield* Result.match(encodeJson(input.args ?? null), {
        onFailure: () => Effect.fail(scriptError("args must be JSON data.")),
        onSuccess: (text) => Effect.succeed(text),
      });
      if (utf8Bytes(argsJson) > WORKFLOW_VALUE_MAX_BYTES) return yield* tooLarge("args");
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const process_ = yield* openProcess;
          const fibers = yield* FiberSet.make<void, never>();
          const limits = limitsOf(input.options);
          let currentPhase: string | null = null;

          const settle = (id: number, exit: Exit.Exit<unknown, WorkflowScriptError>) => {
            if (Exit.isFailure(exit)) {
              const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
              return process_.send({
                type: "reject",
                id,
                message: failure?._tag === "Fail" ? failure.error.message : "The call failed.",
              });
            }
            if (exit.value === null || exit.value === undefined) {
              return process_.send({ type: "settle", id, json: null });
            }
            const json = encodeJson(exit.value);
            if (Result.isFailure(json)) {
              return process_.send({ type: "reject", id, message: "The result is not JSON data." });
            }
            return utf8Bytes(json.success) > WORKFLOW_VALUE_MAX_BYTES
              ? process_.send({
                  type: "reject",
                  id,
                  message: "The result is larger than 1 MB of JSON.",
                })
              : process_.send({ type: "settle", id, json: json.success });
          };

          // Hook calls run in script order: a phase change applies to the
          // agents started after it, and calls start in the order they were made.
          const onOp = (op: SandboxOp) => {
            if (op.type !== "call") {
              if (op.type === "log") return input.host.log(op.text);
              currentPhase = op.text.trim() || null;
              return input.host.phase(op.text);
            }
            const request = Result.getOrElse(decodeJson(op.payload), () => null);
            const work =
              op.kind === "agent"
                ? input.host.agent(request, { phase: currentPhase })
                : input.host.workspace(request);
            return FiberSet.run(
              fibers,
              work.pipe(
                Effect.exit,
                Effect.flatMap((exit) => settle(op.id, exit)),
              ),
            ).pipe(Effect.asVoid);
          };

          const text = yield* drive(
            process_,
            { type: "start", mode: "run", source: input.source, argsJson, limits },
            limits,
            onOp,
          );
          return yield* parseResultJson(text);
        }),
      );
    }).pipe(Effect.withSpan("WorkflowSandbox.run"));

  return WorkflowSandbox.of({ readMeta, run });
};

/** Starts sandbox processes through this install's own CLI. */
export const layer = Layer.effect(
  WorkflowSandbox,
  Effect.gen(function* () {
    const self = yield* resolveSelfInvocation();
    return make({
      command: self.command,
      args: selfInvocationArgs(self, [WORKFLOW_SANDBOX_COMMAND]),
    });
  }),
);

/**
 * Starts sandbox processes from the source `bin.ts` with this Node, for tests,
 * which run under vitest rather than the CLI.
 */
export const layerTest = Layer.succeed(
  WorkflowSandbox,
  make({
    command: process.execPath,
    args: [NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)), WORKFLOW_SANDBOX_COMMAND],
  }),
);

/** Starts a stand-in process instead, for tests of the server's side of the protocol. */
export const layerWithLauncher = (launcher: WorkflowSandboxLauncher) =>
  Layer.succeed(WorkflowSandbox, make(launcher));
