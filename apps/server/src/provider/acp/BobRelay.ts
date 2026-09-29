// @effect-diagnostics nodeBuiltinImport:off - T3 reaches each relay over a Unix socket and lstats its folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { RuntimeMode } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { ToolKind } from "effect-acp/schema";

import type { TmuxServer } from "../../tmux/TmuxServer.ts";
import { BOB_RELAY_SOURCE } from "./bobRelaySource.ts";

/**
 * Bob in tmux: a Bob instance set to run in tmux starts each `bob acp` under a small relay in a
 * pane on T3's own tmux server (see `bobRelaySource.ts`), so Bob and the commands it runs keep
 * going when T3 stops or is killed. This side speaks the relay's socket protocol and gives the
 * ACP runtime an ordinary child process handle, so the runtime and effect-acp are unchanged.
 */

const BobTaskCostsMeta = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  cost: Schema.Number,
  contextTokens: Schema.Number,
  tokensRecorded: Schema.Boolean,
});

/** A tool call the running turn has open: what a T3 attaching later needs to show it. */
const BobRelayTool = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(ToolKind),
  command: Schema.optionalKey(Schema.String),
});
export type BobRelayTool = typeof BobRelayTool.Type;
const isToolKind = Schema.is(ToolKind);

export function toBobRelayTool(tool: {
  readonly toolCallId: string;
  readonly title?: string | undefined;
  readonly kind?: string | undefined;
  readonly command?: string | undefined;
}): BobRelayTool {
  return {
    toolCallId: tool.toolCallId,
    ...(tool.title ? { title: tool.title } : {}),
    ...(isToolKind(tool.kind) ? { kind: tool.kind } : {}),
    ...(tool.command ? { command: tool.command } : {}),
  };
}

/**
 * What the relay keeps about its session for the T3 that attaches next: whose it is, and the
 * turn that was running with its open tool calls.
 */
export const BobRelayMeta = Schema.Struct({
  threadId: Schema.String,
  instanceId: Schema.String,
  cwd: Schema.String,
  runtimeMode: RuntimeMode,
  sessionId: Schema.optional(Schema.String),
  modeId: Schema.optional(Schema.String),
  turnStartedAt: Schema.optional(Schema.Array(Schema.NullOr(Schema.Number))),
  turn: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        plan: Schema.Boolean,
        costsAtStart: Schema.optional(BobTaskCostsMeta),
      }),
    ),
  ),
  tools: Schema.optional(Schema.Array(BobRelayTool)),
  /** Messages sent during the turn still waiting for Bob, which only the T3 holding them knows. */
  waitingPrompts: Schema.optional(Schema.Number),
  /**
   * The T3 MCP session Bob was given, so a T3 that attaches after a restart can take its
   * credential back and Bob keeps its T3 tools. Kept only in the relay's memory, as Bob keeps it.
   */
  mcp: Schema.optional(
    Schema.Struct({
      environmentId: Schema.String,
      threadId: Schema.String,
      providerSessionId: Schema.String,
      providerInstanceId: Schema.String,
      endpoint: Schema.String,
      authorizationHeader: Schema.String,
      capabilities: Schema.Array(Schema.String),
      agentDeviceEnvironment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
});
export type BobRelayMeta = typeof BobRelayMeta.Type;

const RelayExit = {
  code: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  error: Schema.optional(Schema.String),
};
const RelayState = Schema.Struct({
  t: Schema.Literal("state"),
  bobPid: Schema.NullOr(Schema.Number),
  exited: Schema.NullOr(Schema.Struct(RelayExit)),
  promptInFlight: Schema.Boolean,
  promptEnded: Schema.Boolean,
  meta: Schema.Unknown,
});
export type BobRelayState = typeof RelayState.Type;
const RelayFrame = Schema.Union([
  RelayState,
  Schema.Struct({ t: Schema.Literal("out"), seq: Schema.Number, line: Schema.String }),
  Schema.Struct({ t: Schema.Literal("err"), data: Schema.String }),
  Schema.Struct({ t: Schema.Literal("exit"), ...RelayExit }),
]);
type RelayFrame = typeof RelayFrame.Type;
const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(RelayFrame));
const encodeFrame = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeMeta = Schema.decodeUnknownOption(BobRelayMeta);

/** The relay's meta as T3 wrote it, or none for a relay some other build started. */
export function readBobRelayMeta(state: BobRelayState): BobRelayMeta | undefined {
  return Option.getOrUndefined(decodeMeta(state.meta));
}

const relayError = (method: string, description: string, cause?: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "BobRelay",
    method,
    description,
    ...(cause === undefined ? {} : { cause }),
  });

interface FrameWaiter {
  readonly t: RelayFrame["t"];
  readonly deferred: Deferred.Deferred<Option.Option<RelayFrame>>;
}

/** One socket to a relay: frames out, frames in, split on newlines. */
class RelaySocket {
  readonly socket: NodeNet.Socket;
  private rest = "";
  private readonly waiters = new Set<FrameWaiter>();
  onFrame: (frame: RelayFrame) => void = () => {};
  onClose: () => void = () => {};
  afterData: () => void = () => {};
  closed = false;

  constructor(socket: NodeNet.Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.rest += chunk;
      let index: number;
      while ((index = this.rest.indexOf("\n")) >= 0) {
        const line = this.rest.slice(0, index);
        this.rest = this.rest.slice(index + 1);
        const frame = decodeFrame(line);
        if (Option.isNone(frame)) continue;
        for (const waiter of this.waiters) {
          if (waiter.t !== frame.value.t) continue;
          this.waiters.delete(waiter);
          Deferred.doneUnsafe(waiter.deferred, Effect.succeedSome(frame.value));
        }
        this.onFrame(frame.value);
      }
      this.afterData();
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiters) {
        Deferred.doneUnsafe(waiter.deferred, Effect.succeedNone);
      }
      this.waiters.clear();
      this.onClose();
    });
  }

  write(frame: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.socket.write(`${encodeFrame(frame)}\n`);
    } catch {
      // A relay that went away; its close handler reports it.
    }
  }

  /** The next frame of type `t`, or undefined when the socket closes or time runs out. */
  next<T extends RelayFrame["t"]>(
    t: T,
    timeout: Duration.Input,
  ): Effect.Effect<Extract<RelayFrame, { t: T }> | undefined> {
    const waiters = this.waiters;
    const closed = () => this.closed;
    return Effect.gen(function* () {
      if (closed()) return undefined;
      const waiter: FrameWaiter = {
        t,
        deferred: yield* Deferred.make<Option.Option<RelayFrame>>(),
      };
      waiters.add(waiter);
      const frame = yield* Deferred.await(waiter.deferred).pipe(
        Effect.timeoutOption(timeout),
        Effect.ensuring(Effect.sync(() => waiters.delete(waiter))),
      );
      return Option.getOrUndefined(Option.flatten(frame)) as
        | Extract<RelayFrame, { t: T }>
        | undefined;
    });
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** Fails with `NotFound` when nothing listens at the socket, as a relay that is gone. */
const connectOnce = (socketPath: string) =>
  Effect.callback<RelaySocket, PlatformError.PlatformError>((resume) => {
    const socket = NodeNet.connect(socketPath);
    const onError = (cause: NodeJS.ErrnoException) =>
      resume(
        Effect.fail(
          PlatformError.systemError({
            _tag: cause.code === "ECONNREFUSED" || cause.code === "ENOENT" ? "NotFound" : "Unknown",
            module: "BobRelay",
            method: "connect",
            description: `Could not reach Bob's relay: ${cause.message}`,
            cause,
          }),
        ),
      );
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resume(Effect.succeed(new RelaySocket(socket)));
    });
    return Effect.sync(() => socket.destroy());
  });

/** A relay just started in tmux listens within moments; keep trying for a few seconds. */
const connectWhenListening = (socketPath: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; ; attempt += 1) {
      const connected = yield* Effect.option(connectOnce(socketPath));
      if (Option.isSome(connected)) return connected.value;
      if (attempt >= 100) {
        return yield* relayError("connect", "Bob's relay did not start listening.");
      }
      yield* Effect.sleep("50 millis");
    }
  });

/** Links that could hold a running turn when T3 is told to stop. */
const liveLinks = new Set<LinkState>();
let shutdownHooked = false;

/**
 * Lets go of relays as T3 stops: the ones running a turn, or with `all` every one, as when T3
 * is killed. Their Bobs keep running, and the next T3 attaches to them.
 */
export function detachBobRelayLinks(options?: { readonly all?: boolean }): void {
  for (const link of liveLinks) {
    if (options?.all === true || link.busy) link.detach();
  }
}

/**
 * T3 is stopping: every link with a turn running lets go of its relay now, before shutdown
 * cancels the turn and closes Bob. It listens ahead of the listeners already added, such as
 * runMain's, so it runs before their shutdown starts.
 */
function hookShutdownSignals(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const onSignal = (signal: NodeJS.Signals) => {
    detachBobRelayLinks();
    // Only this listener: keep the signal's default of ending the process.
    if (process.listenerCount(signal) === 1) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    }
  };
  process.prependListener("SIGTERM", onSignal);
  process.prependListener("SIGINT", onSignal);
}

class LinkState {
  socket: RelaySocket | undefined;
  private readonly queued: Array<Record<string, unknown>> = [];
  busy = false;
  detached = false;

  send(frame: Record<string, unknown>): void {
    if (this.detached) return;
    if (this.socket) this.socket.write(frame);
    else this.queued.push(frame);
  }

  connected(socket: RelaySocket): void {
    this.socket = socket;
    for (const frame of this.queued.splice(0)) socket.write(frame);
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    liveLinks.delete(this);
    this.socket?.destroy();
  }
}

/** One thread's Bob, running under a relay. */
export interface BobRelayLink {
  /**
   * For the Bob runtime: its one spawn starts `bob acp` under a new relay in tmux, or, for a
   * link from `attach`, takes over the relay's running Bob.
   */
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Merges into what the relay keeps for the T3 that attaches next. */
  readonly setMeta: (meta: Partial<BobRelayMeta>) => Effect.Effect<void>;
  /** A turn began: a T3 told to stop while it runs leaves Bob running. */
  readonly turnStarted: (turn: NonNullable<BobRelayMeta["turn"]>) => Effect.Effect<void>;
  /** The turn's `turn.completed` is out, so the relay can forget its reply. */
  readonly turnSettled: Effect.Effect<void>;
  /** After attaching: sends what Bob said while no T3 was listening. */
  readonly replay: Effect.Effect<void>;
  /** The next `session/prompt` takes over the prompt that was running instead of reaching Bob. */
  readonly adoptNextPrompt: Effect.Effect<void>;
  /** Whether T3 let go of the relay because it is stopping. */
  readonly detached: Effect.Effect<boolean>;
}

export interface FoundBobRelay {
  readonly relayId: string;
  readonly state: BobRelayState;
}

/** Why an instance set to run Bob in tmux cannot, for its status and for a session start. */
export const BOB_TMUX_MISSING_MESSAGE =
  "This instance runs Bob in tmux, which needs tmux 3.2 or later on the machine running T3 Code. Install it (for example `brew install tmux` or `apt install tmux`), or set Where Bob runs to With T3 Code in Settings → Providers.";

export interface BobRelayHost {
  /** Whether a usable tmux is installed, without which no relay starts. */
  readonly available: Effect.Effect<boolean>;
  /** A link that starts a new relay when the runtime spawns Bob. */
  readonly link: (meta: BobRelayMeta) => BobRelayLink;
  /** A link to a relay found by `scan`, whose Bob is already running. */
  readonly attach: (relayId: string) => BobRelayLink;
  /** The relays of this T3 home and what each holds; stale sockets are removed. */
  readonly scan: Effect.Effect<ReadonlyArray<FoundBobRelay>>;
  /** Stops a relay and its Bob. */
  readonly kill: (relayId: string) => Effect.Effect<void>;
}

// A Unix socket path must fit in `sun_path` (104 bytes on macOS, 108 on Linux).
const MAX_SOCKET_PATH = 100;
const RELAY_ID_LENGTH = 12;
const SESSION_PREFIX = "t3-bob-";

/**
 * Where a T3 home's relays listen: its state directory when the socket paths fit, else a folder
 * named for the state directory in the user's runtime directory, or the system temp directory.
 */
const relaySocketDir = (stateDir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const dir = path.join(stateDir, "bob-tmux");
    const relaySocketPath = path.join(dir, `${"0".repeat(RELAY_ID_LENGTH)}.sock`);
    if (Buffer.byteLength(relaySocketPath) <= MAX_SOCKET_PATH) return dir;
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(stateDir))
      .pipe(Effect.orDie);
    const hash = [...new Uint8Array(digest).slice(0, 6)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return path.join(process.env.XDG_RUNTIME_DIR || NodeOS.tmpdir(), `t3-bob-${hash}`);
  });

/**
 * Fails unless `dir` is a real folder (not a link) that only this user owns and can reach.
 * Skipped where there are no POSIX owners.
 */
const ensurePrivateDir = (dir: string) =>
  Effect.gen(function* () {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const notPrivate = relayError(
      "start",
      `Bob relay socket folder ${dir} is not a private folder owned by you.`,
    );
    const stat = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(dir),
      catch: () => notPrivate,
    });
    if (stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0) return;
    return yield* notPrivate;
  });

/**
 * A relay's state; "gone" when nothing listens at its socket, or undefined when no state comes
 * back, as from a relay too busy to answer in time.
 */
const peekRelay = (socketPath: string) =>
  Effect.gen(function* () {
    const socket = yield* Effect.result(connectOnce(socketPath));
    if (Result.isFailure(socket)) {
      return socket.failure.reason._tag === "NotFound" ? ("gone" as const) : undefined;
    }
    socket.success.write({ t: "status" });
    const state = yield* socket.success.next("state", "3 seconds");
    socket.success.destroy();
    return state;
  });

/**
 * The relays answering in `socketDir`. Sockets nothing listens at are removed; one whose relay
 * does not answer is left for the next scan.
 */
const scanRelays = (socketDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs.readDirectory(socketDir).pipe(Effect.orElseSucceed(() => []));
    const found: Array<FoundBobRelay> = [];
    for (const name of names) {
      if (!name.endsWith(".sock")) continue;
      const relayId = name.slice(0, -".sock".length);
      const socketPath = path.join(socketDir, name);
      const state = yield* peekRelay(socketPath);
      if (state === "gone") {
        // The relay is gone and left its socket behind.
        yield* fs.remove(socketPath).pipe(Effect.ignore);
        continue;
      }
      if (state !== undefined) found.push({ relayId, state });
    }
    return found;
  });

/** Asks a relay to stop its Bob and exit; whether it answered. */
const killRelay = (socketPath: string) =>
  Effect.gen(function* () {
    const socket = yield* Effect.option(connectOnce(socketPath));
    if (Option.isNone(socket)) return false;
    socket.value.write({ t: "kill" });
    socket.value.socket.end();
    return true;
  });

/**
 * Stops the relays no Bob instance will take back: those whose instance was removed or no
 * longer runs Bob in tmux. Any Bob instance runs it at startup, so relays a T3 left running
 * for an instance since removed do not wait out their day.
 */
export const sweepBobRelays = (input: {
  readonly stateDir: string;
  /** Whether the instance with this id runs Bob in tmux. */
  readonly keeps: (instanceId: string) => boolean;
}): Effect.Effect<number, never, FileSystem.FileSystem | Path.Path | Crypto.Crypto> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const socketDir = yield* relaySocketDir(input.stateDir);
    let stopped = 0;
    for (const { relayId, state } of yield* scanRelays(socketDir)) {
      const meta = readBobRelayMeta(state);
      if (meta && input.keeps(meta.instanceId)) continue;
      if (yield* killRelay(path.join(socketDir, `${relayId}.sock`))) stopped += 1;
    }
    return stopped;
  });

/** Builds the relay host for one T3 home, writing the relay script to its state directory. */
export const makeBobRelayHost = (input: {
  readonly tmux: TmuxServer["Service"];
  readonly stateDir: string;
}): Effect.Effect<
  BobRelayHost,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const { tmux } = input;
    const dir = path.join(input.stateDir, "bob-tmux");
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
    const scriptPath = path.join(dir, "relay.mjs");
    yield* fs.writeFileString(scriptPath, BOB_RELAY_SOURCE);
    const socketDir = yield* relaySocketDir(input.stateDir);
    yield* fs.makeDirectory(socketDir, { recursive: true, mode: 0o700 });
    // Whoever controls a folder in a shared temp directory could stand in for a relay and be
    // handed Bob's environment and T3's MCP credential.
    if (socketDir !== dir) yield* ensurePrivateDir(socketDir);
    const socketPathOf = (relayId: string) => path.join(socketDir, `${relayId}.sock`);

    /**
     * The child process handle over a connected relay. Bob's stdout lines arrive as `out`
     * frames, acknowledged as they are read; `exit` ends them. A detached link's streams never
     * end, so the runtime T3 is shutting down does not see Bob stop.
     */
    const makeHandle = (
      state: LinkState,
      socket: RelaySocket,
      pid: number | null,
      relayId: string,
    ) =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const stderr = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const exitCode = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const encoder = new TextEncoder();
        let exited = false;
        let highestSeq = 0;
        let ackedSeq = 0;
        const finish = (code: number) => {
          if (exited) return;
          exited = true;
          Queue.endUnsafe(stdout);
          Queue.endUnsafe(stderr);
          Deferred.doneUnsafe(exitCode, Effect.succeed(ChildProcessSpawner.ExitCode(code)));
        };
        socket.onFrame = (frame) => {
          switch (frame.t) {
            case "out":
              highestSeq = Math.max(highestSeq, frame.seq);
              Queue.offerUnsafe(stdout, encoder.encode(`${frame.line}\n`));
              return;
            case "err":
              Queue.offerUnsafe(stderr, encoder.encode(frame.data));
              return;
            case "exit":
              finish(frame.code ?? 1);
              return;
            case "state":
              return;
          }
        };
        socket.afterData = () => {
          if (highestSeq <= ackedSeq) return;
          ackedSeq = highestSeq;
          socket.write({ t: "ack", seq: ackedSeq });
        };
        // A relay that went away on its own took Bob with it.
        socket.onClose = () => {
          if (!state.detached) finish(1);
        };
        const decoder = new TextDecoder();
        let pendingInput = "";
        const stdin = Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            pendingInput += decoder.decode(chunk, { stream: true });
            let index: number;
            while ((index = pendingInput.indexOf("\n")) >= 0) {
              const line = pendingInput.slice(0, index);
              pendingInput = pendingInput.slice(index + 1);
              if (line.length > 0) state.send({ t: "in", line });
            }
          }),
        );
        const kill = Effect.gen(function* () {
          if (state.detached || exited) return;
          liveLinks.delete(state);
          state.send({ t: "kill" });
          // The relay stops Bob and exits; if it does not, its tmux session goes.
          const closed = yield* socket.next("exit", "4 seconds");
          if (closed === undefined && !socket.closed) {
            yield* tmux.killSession(`${SESSION_PREFIX}${relayId}`);
          }
          socket.destroy();
          finish(1);
        });
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(pid ?? 0),
          exitCode: Deferred.await(exitCode),
          isRunning: Effect.sync(() => !exited),
          kill: () => kill,
          stdin,
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.fromQueue(stderr),
          all: Stream.merge(Stream.fromQueue(stdout), Stream.fromQueue(stderr)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      });

    const withLink = (
      state: LinkState,
      spawn: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"],
    ): BobRelayLink => ({
      spawner: ChildProcessSpawner.make(spawn),
      setMeta: (meta) => Effect.sync(() => state.send({ t: "meta", meta })),
      turnStarted: (turn) =>
        Effect.sync(() => {
          state.busy = true;
          state.send({ t: "meta", meta: { turn, tools: [] } });
        }),
      turnSettled: Effect.sync(() => {
        state.busy = false;
        state.send({ t: "settled" });
        state.send({ t: "meta", meta: { turn: null, tools: [] } });
      }),
      replay: Effect.sync(() => state.send({ t: "replay" })),
      adoptNextPrompt: Effect.sync(() => state.send({ t: "adopt" })),
      detached: Effect.sync(() => state.detached),
    });

    const register = (state: LinkState) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          hookShutdownSignals();
          liveLinks.add(state);
        }),
        () => Effect.sync(() => liveLinks.delete(state)),
      );

    const link: BobRelayHost["link"] = (meta) => {
      const state = new LinkState();
      return withLink(state, (command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") {
            return yield* PlatformError.badArgument({
              module: "BobRelay",
              method: "spawn",
              description: "Bob's relay runs a single command.",
            });
          }
          const relayId = (yield* crypto.randomUUIDv4.pipe(Effect.orDie))
            .replaceAll("-", "")
            .slice(0, RELAY_ID_LENGTH);
          const socketPath = socketPathOf(relayId);
          const session = `${SESSION_PREFIX}${relayId}`;
          yield* tmux
            .newSession({
              name: session,
              argv: [process.execPath, scriptPath, socketPath],
              // The desktop app's backend runs under Electron.
              env: { ELECTRON_RUN_AS_NODE: "1" },
            })
            .pipe(Effect.mapError((cause) => relayError("spawn", cause.message, cause)));
          const started = yield* Effect.gen(function* () {
            const socket = yield* connectWhenListening(socketPath);
            state.connected(socket);
            const options = command.options;
            const env =
              options.extendEnv === false ? { ...options.env } : { ...process.env, ...options.env };
            socket.write({
              t: "start",
              command: command.command,
              args: command.args,
              cwd: options.cwd,
              env: Object.fromEntries(
                Object.entries(env).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
              meta,
            });
            const reply = yield* socket.next("state", "10 seconds");
            if (reply === undefined) {
              return yield* relayError("spawn", "Bob's relay did not start Bob.");
            }
            if (reply.exited?.error) {
              return yield* PlatformError.systemError({
                _tag: "NotFound",
                module: "BobRelay",
                method: "spawn",
                description: reply.exited.error,
                pathOrDescriptor: command.command,
              });
            }
            return { socket, reply };
          }).pipe(
            Effect.tapError(() =>
              Effect.andThen(
                Effect.sync(() => state.socket?.destroy()),
                tmux.killSession(session),
              ),
            ),
          );
          yield* register(state);
          const handle = yield* makeHandle(state, started.socket, started.reply.bobPid, relayId);
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
    };

    const attach: BobRelayHost["attach"] = (relayId) => {
      const state = new LinkState();
      return withLink(state, () =>
        Effect.gen(function* () {
          const socket = yield* connectOnce(socketPathOf(relayId));
          yield* register(state);
          state.connected(socket);
          socket.write({ t: "attach" });
          const attached = yield* socket.next("state", "5 seconds");
          if (attached === undefined) {
            socket.destroy();
            return yield* relayError("attach", "Bob's relay did not answer.");
          }
          // It was running a turn when the last T3 let go.
          state.busy = attached.promptInFlight || attached.promptEnded;
          const handle = yield* makeHandle(state, socket, attached.bobPid, relayId);
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
    };

    const scan: BobRelayHost["scan"] = scanRelays(socketDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

    const kill: BobRelayHost["kill"] = (relayId) =>
      killRelay(socketPathOf(relayId)).pipe(
        // A relay that does not answer is gone or stuck; its tmux session goes either way.
        Effect.flatMap((answered) =>
          answered ? Effect.void : tmux.killSession(`${SESSION_PREFIX}${relayId}`),
        ),
      );

    return { available: tmux.available, link, attach, scan, kill } satisfies BobRelayHost;
  });
