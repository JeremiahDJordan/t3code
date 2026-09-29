// @effect-diagnostics nodeBuiltinImport:off - the test runs Bob's relay in real tmux.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import {
  BobSettings,
  EnvironmentId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import { ServerConfig } from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ServerActivation } from "../../serverActivation.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import * as TmuxServer from "../../tmux/TmuxServer.ts";
import {
  BOB_TMUX_MISSING_MESSAGE,
  type BobRelayHost,
  detachBobRelayLinks,
  makeBobRelayHost,
  readBobRelayMeta,
  sweepBobRelays,
} from "../acp/BobRelay.ts";
import { makeBobAdapter } from "./BobAdapter.ts";

const tmuxInstalled = NodeChildProcess.spawnSync("tmux", ["-V"]).status === 0;
const decodeBobSettings = Schema.decodeSync(BobSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

type BobAdapter = Effect.Success<ReturnType<typeof makeBobAdapter>>;

const testLayer = TmuxServer.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bobtmux-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** A mock `bob` whose prompts take `promptDelayMs`, logging the requests it gets. */
const mockBob = (promptDelayMs: number) =>
  Effect.promise(async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bob-tmux-mock-"));
    const requestLogPath = NodePath.join(dir, "requests.ndjson");
    const binaryPath = writeFakeCli({
      directory: dir,
      name: "fake-bob",
      env: {
        T3_ACP_BOB: "1",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_DELAY_MS: String(promptDelayMs),
      },
      source: execScriptSource({ scriptPath: mockAgentPath }),
    });
    return { binaryPath, requestLogPath, taskDatabasePath: NodePath.join(dir, "bob.db") };
  });

const methodsSent = (requestLogPath: string) =>
  Effect.promise(async () =>
    (await NodeFSP.readFile(requestLogPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        const entry = JSON.parse(line) as { readonly method?: unknown };
        return typeof entry.method === "string" ? [entry.method] : [];
      }),
  );

/** Sets the running totals Bob records for a task, as Bob does on each spend. */
function writeBobTaskCosts(databasePath: string, taskId: string, costs: Record<string, number>) {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, costs TEXT)");
  database
    .prepare("INSERT INTO tasks (id, costs) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET costs = ?")
    .run(taskId, JSON.stringify(costs), JSON.stringify(costs));
  database.close();
}

/**
 * One T3's Bob adapter, in its own scope so the test can end it as T3 ending. Its attach to
 * relays left running waits for `activate`, as a server's waits for startup.
 */
const startT3 = (input: {
  readonly relay: BobRelayHost;
  readonly binaryPath: string;
  readonly taskDatabasePath: string;
  readonly enabled?: boolean;
}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const activate = yield* Deferred.make<void>();
    const adapter = yield* makeBobAdapter(
      decodeBobSettings({
        binaryPath: input.binaryPath,
        sessionHost: "tmux",
        enabled: input.enabled ?? true,
      }),
      { taskDatabasePath: input.taskDatabasePath, relay: input.relay },
    ).pipe(
      Effect.provideService(ServerActivation, Deferred.await(activate)),
      Effect.provideService(Scope.Scope, scope),
    );
    return { adapter, scope, activate };
  });

/** Listens from now on; the returned effect waits for events up to the first matching one. */
const eventsUntil = (adapter: BobAdapter, predicate: (event: ProviderRuntimeEvent) => boolean) =>
  adapter.streamEvents.pipe(
    Stream.takeUntil(predicate),
    Stream.runCollect,
    Effect.forkChild({ startImmediately: true }),
    Effect.map(Fiber.join),
  );

/** Waits until every relay says its Bob has the prompt. */
const untilPromptWithBob = (relay: BobRelayHost) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = yield* relay.scan;
      if (found.length > 0 && found.every(({ state }) => state.promptInFlight)) return;
      yield* Effect.sleep("50 millis");
    }
  });

/** The relay's tmux sessions still running. */
const relaySessions = Effect.gen(function* () {
  const tmux = yield* TmuxServer.TmuxServer;
  const sessions = yield* tmux.listSessions;
  return [...(sessions ?? [])].filter((name) => name.startsWith("t3-bob-"));
});

/** Waits until no relay session runs, as a stopped relay takes a moment to exit. */
const untilNoRelays = Effect.gen(function* () {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((yield* relaySessions).length === 0) return true;
    yield* Effect.sleep("100 millis");
  }
  return false;
});

/** Runs `body` with a fresh T3 home and its own tmux server, stopped afterwards. */
const withRelayHost = <A, E>(
  body: (
    relay: BobRelayHost,
  ) => Effect.Effect<A, E, ServerConfig | TmuxServer.TmuxServer | NodeServices.NodeServices>,
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const tmux = yield* TmuxServer.TmuxServer;
    const relay = yield* makeBobRelayHost({ tmux, stateDir: config.stateDir });
    return yield* body(relay).pipe(Effect.ensuring(tmux.run(["kill-server"]).pipe(Effect.ignore)));
  }).pipe(Effect.provide(testLayer));

describe("BobAdapter in tmux, without tmux", () => {
  it.live("says tmux is missing instead of failing to spawn Bob", () =>
    Effect.gen(function* () {
      const bob = yield* mockBob(0);
      const unusable: BobRelayHost = {
        available: Effect.succeed(false),
        link: () => {
          throw new Error("No relay starts without tmux.");
        },
        attach: () => {
          throw new Error("No relay starts without tmux.");
        },
        scan: Effect.succeed([]),
        kill: () => Effect.void,
      };
      const t3 = yield* startT3({ relay: unusable, ...bob });
      yield* Deferred.succeed(t3.activate, undefined);
      const failure = yield* Effect.flip(
        t3.adapter.startSession({
          threadId: ThreadId.make("bob-no-tmux"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        }),
      );
      assert.include(failure.message, BOB_TMUX_MISSING_MESSAGE);
      yield* Scope.close(t3.scope, Exit.void);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe.skipIf(!tmuxInstalled)("BobAdapter in tmux, across a restart", () => {
  {
    it.live("finishes the turn T3 was running on the same Bob after T3 comes back", () =>
      withRelayHost((relay) =>
        Effect.gen(function* () {
          const bob = yield* mockBob(3_000);
          const threadId = ThreadId.make("bob-tmux-turn");
          const first = yield* startT3({ relay, ...bob });
          yield* Deferred.succeed(first.activate, undefined);
          yield* first.adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          const started = yield* eventsUntil(
            first.adapter,
            (event) => event.type === "turn.started",
          );
          yield* first.adapter
            .sendTurn({ threadId, input: "run the long test" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          const turnStarted = [...(yield* started)].find((event) => event.type === "turn.started");
          assert.isDefined(turnStarted?.turnId);
          yield* untilPromptWithBob(relay);

          // T3 is told to stop mid-turn: it lets go of Bob, and its shutdown reports nothing.
          const firstEvents = yield* eventsUntil(first.adapter, () => false);
          detachBobRelayLinks();
          yield* Scope.close(first.scope, Exit.void);
          assert.isFalse(
            [...(yield* firstEvents)].some(
              (event) => event.type === "turn.completed" || event.type === "session.exited",
            ),
          );
          assert.lengthOf(yield* relaySessions, 1);

          // The next T3 counts the thread live before it attaches, then finishes the turn.
          const second = yield* startT3({ relay, ...bob });
          assert.isTrue(yield* second.adapter.hasSession(threadId));
          const finished = yield* eventsUntil(
            second.adapter,
            (event) => event.type === "turn.completed",
          );
          yield* Deferred.succeed(second.activate, undefined);
          const events = [...(yield* finished)];
          const completed = events.find((event) => event.type === "turn.completed");
          assert.equal(completed?.turnId, turnStarted?.turnId);
          assert.deepInclude(completed?.payload, { state: "completed" });
          assert.isTrue(
            events.some(
              (event) => event.type === "turn.started" && event.turnId === turnStarted?.turnId,
            ),
          );

          // One Bob, one prompt: nothing was sent to Bob again.
          const methods = yield* methodsSent(bob.requestLogPath);
          assert.deepEqual(
            methods.filter((method) => method === "initialize" || method === "session/prompt"),
            ["initialize", "session/prompt"],
          );
          // The session then ends quietly, and the next turn starts a fresh Bob.
          assert.isTrue(yield* untilNoRelays);
          assert.deepEqual(yield* second.adapter.listSessions(), []);
          yield* Scope.close(second.scope, Exit.void);
        }),
      ),
    );

    it.live("says a message waiting for Bob was lost with the T3 that held it", () =>
      withRelayHost((relay) =>
        Effect.gen(function* () {
          const bob = yield* mockBob(3_000);
          const threadId = ThreadId.make("bob-tmux-lost-follow-up");
          const first = yield* startT3({ relay, ...bob });
          yield* Deferred.succeed(first.activate, undefined);
          yield* first.adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          const started = yield* eventsUntil(
            first.adapter,
            (event) => event.type === "turn.started",
          );
          yield* first.adapter
            .sendTurn({ threadId, input: "run the long test" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          const turnId = [...(yield* started)].find(
            (event) => event.type === "turn.started",
          )?.turnId;
          yield* untilPromptWithBob(relay);
          // A follow-up waits behind the running prompt when T3 stops.
          yield* first.adapter
            .sendTurn({ threadId, input: "then run it again" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const [found] = yield* relay.scan;
            if (found && readBobRelayMeta(found.state)?.waitingPrompts === 1) break;
            yield* Effect.sleep("50 millis");
          }
          detachBobRelayLinks();
          yield* Scope.close(first.scope, Exit.void);

          const second = yield* startT3({ relay, ...bob });
          const finished = yield* eventsUntil(
            second.adapter,
            (event) => event.type === "turn.completed",
          );
          yield* Deferred.succeed(second.activate, undefined);
          const warning = [...(yield* finished)].find((event) => event.type === "runtime.warning");
          assert.equal(warning?.turnId, turnId);
          assert.include(
            warning?.type === "runtime.warning" ? warning.payload.message : "",
            "1 message sent while Bob was working did not reach Bob",
          );
          assert.isTrue(yield* untilNoRelays);
          yield* Scope.close(second.scope, Exit.void);
        }),
      ),
    );

    it.live("stops a thread whose Bob T3 has yet to take over, and takes over the rest", () =>
      withRelayHost((relay) =>
        Effect.gen(function* () {
          const bob = yield* mockBob(3_000);
          const stopped = ThreadId.make("bob-tmux-stop-early");
          const kept = ThreadId.make("bob-tmux-kept");
          const first = yield* startT3({ relay, ...bob });
          yield* Deferred.succeed(first.activate, undefined);
          for (const threadId of [stopped, kept]) {
            yield* first.adapter.startSession({
              threadId,
              cwd: process.cwd(),
              runtimeMode: "full-access",
            });
            yield* first.adapter
              .sendTurn({ threadId, input: "work" })
              .pipe(Effect.forkChild({ startImmediately: true }));
          }
          yield* untilPromptWithBob(relay);
          detachBobRelayLinks();
          yield* Scope.close(first.scope, Exit.void);

          // The thread is stopped, as archiving it does, before T3 has attached to its Bob.
          const second = yield* startT3({ relay, ...bob });
          const keptFinished = yield* eventsUntil(
            second.adapter,
            (event) => event.type === "turn.completed" && event.threadId === kept,
          );
          const stopping = yield* second.adapter
            .stopSession(stopped)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.succeed(second.activate, undefined);
          yield* Fiber.join(stopping);
          assert.isFalse(yield* second.adapter.hasSession(stopped));

          // The attaches after it still run.
          const completed = [...(yield* keptFinished)].find(
            (event) => event.type === "turn.completed" && event.threadId === kept,
          );
          assert.deepInclude(completed?.payload, { state: "completed" });
          assert.isTrue(yield* untilNoRelays);
          yield* Scope.close(second.scope, Exit.void);
        }),
      ),
    );

    it.live("keeps a Bob whose MCP credential the next T3 takes back", () =>
      withRelayHost((relay) =>
        Effect.scoped(
          Effect.gen(function* () {
            // T3's MCP credentials, as the running server keeps them.
            const registry = Context.get(
              yield* Layer.build(
                McpSessionRegistry.layer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      Layer.succeed(
                        HttpServer.HttpServer,
                        HttpServer.HttpServer.of({
                          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
                          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
                        }),
                      ),
                      Layer.succeed(
                        ServerEnvironment.ServerEnvironment,
                        ServerEnvironment.ServerEnvironment.of({
                          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
                          getDescriptor: Effect.die("unused"),
                        }),
                      ),
                    ),
                  ),
                ),
              ),
              McpSessionRegistry.McpSessionRegistry,
            );
            const bob = yield* mockBob(2_000);
            const threadId = ThreadId.make("bob-tmux-mcp");
            const issued = yield* registry.issue({
              threadId,
              providerInstanceId: ProviderInstanceId.make("bob"),
              capabilities: new Set(["check-ins"]),
            });
            McpProviderSession.setMcpProviderSession(issued.config);
            const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

            const first = yield* startT3({ relay, ...bob });
            yield* Deferred.succeed(first.activate, undefined);
            yield* first.adapter.startSession({
              threadId,
              cwd: process.cwd(),
              runtimeMode: "full-access",
            });
            yield* first.adapter
              .sendTurn({ threadId, input: "work" })
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* untilPromptWithBob(relay);
            detachBobRelayLinks({ all: true });
            yield* Scope.close(first.scope, Exit.void);
            // A new server knows no credentials.
            yield* registry.revokeAll;
            McpProviderSession.clearAllMcpProviderSessions();

            const second = yield* startT3({ relay, ...bob });
            const finished = yield* eventsUntil(
              second.adapter,
              (event) => event.type === "turn.completed",
            );
            yield* Deferred.succeed(second.activate, undefined);
            yield* finished;
            // Bob's T3 tools work again, and it stays for the thread's next turn.
            expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
            assert.lengthOf(yield* second.adapter.listSessions(), 1);
            assert.lengthOf(yield* relaySessions, 1);
            yield* second.adapter.stopSession(threadId);
            assert.isTrue(yield* untilNoRelays);
            yield* Scope.close(second.scope, Exit.void);
            McpProviderSession.clearAllMcpProviderSessions();
          }),
        ),
      ),
    );

    it.live("reports a turn Bob finished while no T3 was running", () =>
      withRelayHost((relay) =>
        Effect.gen(function* () {
          const bob = yield* mockBob(500);
          const threadId = ThreadId.make("bob-tmux-finished");
          // The task already has spend when the turn starts.
          writeBobTaskCosts(bob.taskDatabasePath, "mock-session-1", {
            cost: 0.1,
            contextTokens: 10,
          });
          const first = yield* startT3({ relay, ...bob });
          yield* Deferred.succeed(first.activate, undefined);
          yield* first.adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          const started = yield* eventsUntil(
            first.adapter,
            (event) => event.type === "turn.started",
          );
          yield* first.adapter
            .sendTurn({ threadId, input: "quick" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          const turnId = [...(yield* started)].find(
            (event) => event.type === "turn.started",
          )?.turnId;
          yield* untilPromptWithBob(relay);
          // Killed: every link lets go at once and nothing of T3 runs after.
          detachBobRelayLinks({ all: true });
          yield* Scope.close(first.scope, Exit.void);
          // Bob spends on the turn and answers while T3 is gone.
          writeBobTaskCosts(bob.taskDatabasePath, "mock-session-1", {
            cost: 0.2,
            contextTokens: 20,
          });
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const [found] = yield* relay.scan;
            if (found?.state.promptEnded) break;
            yield* Effect.sleep("100 millis");
          }

          const second = yield* startT3({ relay, ...bob });
          const finished = yield* eventsUntil(
            second.adapter,
            (event) => event.type === "turn.completed",
          );
          yield* Deferred.succeed(second.activate, undefined);
          const events = [...(yield* finished)];
          const completed = events.find((event) => event.type === "turn.completed");
          assert.equal(completed?.turnId, turnId);
          assert.deepInclude(completed?.payload, { state: "completed" });
          // What Bob said while T3 was gone reaches the thread, in the turn.
          const said = events.flatMap((event) =>
            event.type === "content.delta" && event.turnId === turnId ? [event.payload.delta] : [],
          );
          assert.include(said.join(""), "hello from");
          // So does what it spent, measured from the turn's start and not from T3's return.
          const usage = events.find((event) => event.type === "thread.token-usage.updated");
          assert.equal(usage?.turnId, turnId);
          assert.deepInclude(usage?.payload.usage, {
            usedTokens: 20,
            cost: { amount: 0.2, unit: "Bobcoins" },
          });
          assert.isTrue(yield* untilNoRelays);
          yield* Scope.close(second.scope, Exit.void);
        }),
      ),
    );

    it.live("stops the relays of an instance that was removed, disabled or left tmux", () =>
      withRelayHost((relay) =>
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          const bob = yield* mockBob(30_000);
          const threadId = ThreadId.make("bob-tmux-orphan");
          const first = yield* startT3({ relay, ...bob });
          yield* Deferred.succeed(first.activate, undefined);
          yield* first.adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          yield* first.adapter
            .sendTurn({ threadId, input: "work" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* untilPromptWithBob(relay);
          detachBobRelayLinks({ all: true });
          yield* Scope.close(first.scope, Exit.void);

          // Its instance still runs Bob in tmux: the relay is left for it.
          expect(yield* sweepBobRelays({ stateDir: config.stateDir, keeps: () => true })).toBe(0);
          assert.lengthOf(yield* relaySessions, 1);
          // Disabled: the instance stops its own relays rather than taking them back.
          const disabled = yield* startT3({ relay, ...bob, enabled: false });
          assert.isFalse(yield* disabled.adapter.hasSession(threadId));
          assert.isTrue(yield* untilNoRelays);
          yield* Scope.close(disabled.scope, Exit.void);
        }),
      ),
    );

    it.live("sweeps a relay whose instance no longer runs Bob in tmux", () =>
      withRelayHost((relay) =>
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          const bob = yield* mockBob(30_000);
          const threadId = ThreadId.make("bob-tmux-removed");
          const first = yield* startT3({ relay, ...bob });
          yield* Deferred.succeed(first.activate, undefined);
          yield* first.adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          detachBobRelayLinks({ all: true });
          yield* Scope.close(first.scope, Exit.void);
          assert.lengthOf(yield* relaySessions, 1);

          expect(
            yield* sweepBobRelays({ stateDir: config.stateDir, keeps: (id) => id !== "bob" }),
          ).toBe(1);
          assert.isTrue(yield* untilNoRelays);
        }),
      ),
    );

    it.live("stops a Bob that was idle when T3 went away", () =>
      withRelayHost((relay) =>
        Effect.gen(function* () {
          const bob = yield* mockBob(0);
          const threadId = ThreadId.make("bob-tmux-idle");
          const first = yield* startT3({ relay, ...bob });
          yield* Deferred.succeed(first.activate, undefined);
          yield* first.adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          detachBobRelayLinks({ all: true });
          yield* Scope.close(first.scope, Exit.void);
          assert.lengthOf(yield* relaySessions, 1);

          const second = yield* startT3({ relay, ...bob });
          assert.isFalse(yield* second.adapter.hasSession(threadId));
          assert.isTrue(yield* untilNoRelays);
          assert.isTrue(Option.isNone(Option.fromNullishOr((yield* relay.scan)[0])));
          yield* Scope.close(second.scope, Exit.void);
        }),
      ),
    );
  }
});
