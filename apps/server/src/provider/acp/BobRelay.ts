// @effect-diagnostics nodeBuiltinImport:off - T3 reaches each relay over a Unix socket and lstats its folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

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

import type { TmuxServer } from "../../tmux/TmuxServer.ts";
import { BOB_RELAY_SOURCE } from "./bobRelaySource.ts";

/**
 * Bob in tmux: a Bob instance set to run in tmux starts each `bob acp` under a small relay in a
 * pane on T3's own tmux server (see `bobRelaySource.ts`), so Bob and the commands it runs keep
 * going when T3 stops or is killed. This side speaks the relay's socket protocol and gives the
 * ACP runtime an ordinary child process handle, so the runtime and effect-acp are unchanged.
 *
 * T3 cancels a run that was going when it stopped. A run that starts afterwards on the same Bob
 * task attaches to the relay and adopts Bob's running prompt, so Bob's turn finishes in it.
 */

/**
 * What the relay keeps for the T3 that attaches next: whose Bob it is and which thread's turn
 * it runs.
 */
const BobRelayMeta = Schema.Struct({
  instanceId: Schema.String,
  cwd: Schema.String,
  /** Bob's task, once the session opened. */
  sessionId: Schema.optional(Schema.String),
  /** The app thread and provider thread of the turn that runs, for the run that takes it over. */
  threadId: Schema.optional(Schema.String),
  providerThreadId: Schema.optional(Schema.String),
});
type BobRelayMeta = typeof BobRelayMeta.Type;

const RelayExit = {
  code: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  error: Schema.optional(Schema.String),
};
const RelayState = Schema.Struct({
  t: Schema.Literal("state"),
  /** The relay's protocol, absent for relays of T3 builds before adoption. */
  relay: Schema.optional(Schema.Number),
  bobPid: Schema.NullOr(Schema.Number),
  exited: Schema.NullOr(Schema.Struct(RelayExit)),
  promptInFlight: Schema.Boolean,
  promptEnded: Schema.Boolean,
  meta: Schema.Unknown,
});
type BobRelayState = typeof RelayState.Type;
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
  return state.relay === BOB_RELAY_PROTOCOL
    ? Option.getOrUndefined(decodeMeta(state.meta))
    : undefined;
}

/** The relay protocol this build speaks; relays of other builds are stopped, not attached. */
const BOB_RELAY_PROTOCOL = 2;

/** Whether a relay's Bob has a prompt no run has finished: running, or ended while T3 was away. */
export function bobRelayHasTurn(state: BobRelayState): boolean {
  return state.exited === null && (state.promptInFlight || state.promptEnded);
}

/** Joins a tool call id Bob gave and the attach that renamed it. */
const ADOPTED_TOOL_CALL_SEPARATOR = "~adopted-";

/** The id Bob gave a tool call, which its task database keeps, without an attach's renaming. */
export function nativeBobToolCallId(toolCallId: string): string {
  const index = toolCallId.indexOf(ADOPTED_TOOL_CALL_SEPARATOR);
  return index < 0 ? toolCallId : toolCallId.slice(0, index);
}

/**
 * Gives Bob's tool calls in a line new ids. A run that takes over Bob's prompt after a restart
 * shows them again, and their old ids belong to the run T3 cancelled.
 */
function renameBobRelayToolCalls(line: string, suffix: string): string {
  if (!line.includes("toolCallId")) return line;
  let message: { method?: unknown; params?: Record<string, unknown> };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return line;
  }
  const rename = (holder: unknown) => {
    if (typeof holder !== "object" || holder === null) return;
    const record = holder as Record<string, unknown>;
    if (typeof record.toolCallId === "string") record.toolCallId = `${record.toolCallId}${suffix}`;
  };
  if (message.method === "session/update") rename(message.params?.update);
  else if (message.method === "session/request_permission") rename(message.params?.toolCall);
  else return line;
  return encodeFrame(message);
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
  /** For a link that attached to a running relay: Bob has a prompt no run has taken over. */
  adoptable = false;
  /** The run on this link took over Bob's prompt. */
  adopted = false;

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

/** One Bob session's Bob, running under a relay. */
export interface BobRelayLink {
  /**
   * For the Bob runtime: its one spawn starts `bob acp` under a new relay in tmux, or, for a
   * link from `attach`, takes over the relay's running Bob.
   */
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Merges into what the relay keeps for the T3 that attaches next. */
  readonly setMeta: (meta: Partial<BobRelayMeta>) => Effect.Effect<void>;
  /** A prompt began: a T3 told to stop while it runs leaves Bob running. */
  readonly turnStarted: Effect.Effect<void>;
  /** The prompt's run is over, so the relay can forget its reply. */
  readonly turnSettled: Effect.Effect<void>;
  /**
   * For a link from `attach` whose Bob has a prompt no run took over: makes the next
   * `session/prompt` take it over instead of reaching Bob. False when there is none.
   */
  readonly adopt: Effect.Effect<boolean>;
  /** Whether this link took over a prompt Bob started for a T3 before this one. */
  readonly adopted: Effect.Effect<boolean>;
  /** Stops the relay and its Bob, as a session that closes does. */
  readonly retire: Effect.Effect<void>;
}

interface FoundBobRelay {
  readonly relayId: string;
  readonly state: BobRelayState;
}

/** Why an instance set to run Bob in tmux cannot, for its status and for a session start. */
export const BOB_TMUX_MISSING_MESSAGE =
  "This instance runs Bob in tmux, which needs tmux 3.2 or later on the machine running T3 Code. Install it (for example `brew install tmux` or `apt install tmux`), or set Where Bob runs to With T3 Code in Settings → Providers.";

interface BobRelayHost {
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
     * end, so the runtime T3 is shutting down does not see Bob stop. On a link that attached, Bob's
     * tool calls get new ids (`renameSuffix`), as the run that takes over shows them again.
     */
    const makeHandle = (
      state: LinkState,
      socket: RelaySocket,
      pid: number | null,
      relayId: string,
      renameSuffix?: string,
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
            case "out": {
              highestSeq = Math.max(highestSeq, frame.seq);
              const line =
                renameSuffix === undefined
                  ? frame.line
                  : renameBobRelayToolCalls(frame.line, renameSuffix);
              Queue.offerUnsafe(stdout, encoder.encode(`${line}\n`));
              return;
            }
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
          // A session that closes before its run took Bob's prompt over leaves Bob running for
          // the run that will.
          if (state.adoptable && !state.adopted) {
            state.detach();
            finish(1);
            return;
          }
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
    ): BobRelayLink => {
      let handle: ChildProcessSpawner.ChildProcessHandle | undefined;
      return {
        spawner: ChildProcessSpawner.make((command) =>
          spawn(command).pipe(
            Effect.tap((spawned) =>
              Effect.sync(() => {
                handle = spawned;
              }),
            ),
          ),
        ),
        setMeta: (meta) => Effect.sync(() => state.send({ t: "meta", meta })),
        turnStarted: Effect.sync(() => {
          state.busy = true;
        }),
        turnSettled: Effect.sync(() => {
          state.busy = false;
          state.send({ t: "settled" });
        }),
        adopt: Effect.sync(() => {
          if (!state.adoptable || state.adopted) return false;
          state.adopted = true;
          state.busy = true;
          state.send({ t: "adopt" });
          return true;
        }),
        adopted: Effect.sync(() => state.adopted),
        retire: Effect.suspend(() => (handle ? handle.kill().pipe(Effect.ignore) : Effect.void)),
      };
    };

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
          // Bob has a prompt that a run on this link takes over.
          state.adoptable = bobRelayHasTurn(attached);
          // Each attach renames anew: a run that takes over after a second restart must not
          // reuse the tool ids of the run that took over after the first.
          const attachment = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).slice(0, 8);
          const handle = yield* makeHandle(
            state,
            socket,
            attached.bobPid,
            relayId,
            `${ADOPTED_TOOL_CALL_SEPARATOR}${attachment}`,
          );
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

/** The relays an instance that runs Bob in tmux gives its Bob sessions. */
export interface BobRelays {
  /**
   * The link a runtime spawns Bob through: the relay that kept `resumeSessionId`'s prompt going
   * while T3 restarted, once, else a new relay.
   */
  readonly linkFor: (input: {
    readonly cwd: string;
    readonly resumeSessionId?: string | undefined;
  }) => BobRelayLink;
}

/**
 * Relays for one instance. `adoptable` holds the relays found at startup with a prompt to take
 * over, by Bob's task id, once `ready`; a link waits for it before it picks a relay, so a session
 * opening early never starts a second Bob on a task one is still running.
 */
export function makeBobRelays(input: {
  readonly host: BobRelayHost;
  readonly instanceId: string;
  readonly adoptable: Map<string, string>;
  readonly ready: Effect.Effect<void>;
}): BobRelays {
  return {
    linkFor: ({ cwd, resumeSessionId }) => {
      let chosen: BobRelayLink | undefined;
      const choose = () => {
        const relayId =
          resumeSessionId === undefined ? undefined : input.adoptable.get(resumeSessionId);
        if (relayId === undefined || resumeSessionId === undefined) {
          return input.host.link({ instanceId: input.instanceId, cwd });
        }
        input.adoptable.delete(resumeSessionId);
        return input.host.attach(relayId);
      };
      const whenChosen = <A>(use: (link: BobRelayLink) => Effect.Effect<A>, otherwise: A) =>
        Effect.suspend(() => (chosen ? use(chosen) : Effect.succeed(otherwise)));
      return {
        spawner: ChildProcessSpawner.make((command) =>
          input.ready.pipe(
            Effect.andThen(
              Effect.suspend(() => {
                chosen = choose();
                return chosen.spawner.spawn(command);
              }),
            ),
          ),
        ),
        setMeta: (meta) => whenChosen((link) => link.setMeta(meta), undefined),
        turnStarted: whenChosen((link) => link.turnStarted, undefined),
        turnSettled: whenChosen((link) => link.turnSettled, undefined),
        adopt: whenChosen((link) => link.adopt, false),
        adopted: whenChosen((link) => link.adopted, false),
        retire: whenChosen((link) => link.retire, undefined),
      };
    },
  };
}
