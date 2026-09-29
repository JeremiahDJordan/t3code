// @effect-diagnostics nodeBuiltinImport:off - the test runs real tmux sessions and reads what they wrote.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadBackgroundCommands from "../persistence/ThreadBackgroundCommands.ts";
import * as ThreadCheckIns from "../persistence/ThreadCheckIns.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import * as TmuxServer from "../tmux/TmuxServer.ts";
import * as BackgroundCommands from "./BackgroundCommands.ts";
import * as CheckInScheduler from "./CheckInScheduler.ts";

const tmuxInstalled = NodeChildProcess.spawnSync("tmux", ["-V"]).status === 0;

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

function thread(workspace: string, runtimeMode: RuntimeMode): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("bob"), model: "bob" },
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: workspace,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-09-28T11:00:00.000Z",
    updatedAt: "2026-09-28T11:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

/**
 * The services around real tmux and a real folder. `persistence` is shared between harnesses, as
 * the database is across a T3 restart; each harness is a fresh server's worth of services.
 */
const makeHarness = Effect.fn("makeBackgroundCommandHarness")(function* (options: {
  readonly workspace: string;
  readonly home: string;
  readonly persistence: Context.Context<
    | ThreadCheckIns.ThreadCheckInRepository
    | ThreadBackgroundCommands.ThreadBackgroundCommandRepository
  >;
  readonly runtimeMode?: RuntimeMode;
}) {
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const layer = BackgroundCommands.layer.pipe(
    Layer.provideMerge(CheckInScheduler.layer),
    Layer.provideMerge(ThreadBackgroundCommands.changesLayer),
    Layer.provide(Layer.succeedContext(options.persistence)),
    Layer.provide(TmuxServer.layer.pipe(Layer.provide(ProcessRunner.layer))),
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(options.workspace, options.home),
        ServerSettings.layerTest(),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({ sequence: 1 })),
          subscribeDomainEvents: Effect.succeed(Stream.empty),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () =>
            Effect.succeed(
              Option.some(thread(options.workspace, options.runtimeMode ?? "full-access")),
            ),
          getProjectShellById: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(TerminalManager)({}),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const context = yield* Layer.build(layer);
  return {
    commands: Context.get(context, BackgroundCommands.BackgroundCommands),
    scheduler: Context.get(context, CheckInScheduler.CheckInScheduler),
    dispatched,
  };
});

const buildPersistence = Layer.build(
  Layer.mergeAll(ThreadCheckIns.layer, ThreadBackgroundCommands.layer).pipe(
    Layer.provide(SqlitePersistenceMemory),
  ),
);

/** Polls until the thread has no running command, as the server's timer would. */
const untilEnded = (
  commands: BackgroundCommands.BackgroundCommands["Service"],
  scheduler: CheckInScheduler.CheckInScheduler["Service"],
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      yield* commands.pollNow;
      const running = (yield* commands.list(THREAD_ID)).filter((c) => c.status === "running");
      if (running.length === 0) break;
      yield* Effect.sleep("100 millis");
    }
    yield* scheduler.runDueNow;
  });

const texts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.turn.start" ? [command.message.text] : [],
  );

function freshDirs() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bg-"));
  const workspace = NodePath.join(root, "work");
  NodeChildProcess.execFileSync("mkdir", ["-p", workspace]);
  return { workspace, home: NodePath.join(root, "home") };
}

/** Stops the test's own tmux server, found by the socket its state directory names. */
function stopTestTmux(home: string) {
  const socket = NodeChildProcess.execFileSync("find", [home, "-name", "t3.sock"])
    .toString()
    .trim();
  if (socket) NodeChildProcess.spawnSync("tmux", ["-S", socket, "kill-server"]);
}

describe.skipIf(!tmuxInstalled)("BackgroundCommands (real tmux)", () => {
  it.live("records how a command ended, splits its output, and tells the agent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const { commands, scheduler, dispatched } = yield* makeHarness({ ...dirs, persistence });
        const started = yield* commands.start({
          threadId: THREAD_ID,
          command: "echo out; echo err >&2; exit 3",
          statusEveryMinutes: null,
          note: "Look at the failure.",
          tailLines: 5,
          notifyOn: null,
        });
        yield* untilEnded(commands, scheduler);

        expect(NodeFS.readFileSync(started.stdoutPath, "utf8")).toBe("out\n");
        expect(NodeFS.readFileSync(started.stderrPath, "utf8")).toContain("err\n");
        const [text] = texts(yield* Ref.get(dispatched));
        expect(text).toContain("finished: exit 3");
        expect(text).toContain(`stdout: ${started.stdoutPath} (4 bytes)`);
        expect(text).toContain("Your note: Look at the failure.");
        // Told once: the command leaves the thread's list and is not announced again.
        expect(yield* commands.list(THREAD_ID)).toEqual([]);
        yield* scheduler.runDueNow;
        expect(texts(yield* Ref.get(dispatched))).toHaveLength(1);
        stopTestTmux(dirs.home);
      }),
    ),
  );

  it.live("keeps running when the server that started it goes away", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        // The first server starts the command, then its services are dropped, as when T3 is
        // killed; the command lives on in tmux.
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* makeHarness({ ...dirs, persistence });
            return yield* first.commands.start({
              threadId: THREAD_ID,
              command: "sleep 1; echo done",
              statusEveryMinutes: null,
              note: "",
              tailLines: 0,
              notifyOn: null,
            });
          }),
        );
        const second = yield* makeHarness({ ...dirs, persistence });
        yield* untilEnded(second.commands, second.scheduler);

        expect(NodeFS.readFileSync(started.stdoutPath, "utf8")).toBe("done\n");
        expect(texts(yield* Ref.get(second.dispatched))[0]).toContain("finished: exit 0");
        stopTestTmux(dirs.home);
      }),
    ),
  );

  it.live("stops a command for the user and says the user stopped it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const { commands, scheduler, dispatched } = yield* makeHarness({ ...dirs, persistence });
        const started = yield* commands.start({
          threadId: THREAD_ID,
          command: "sleep 30",
          statusEveryMinutes: null,
          note: "",
          tailLines: 0,
          notifyOn: null,
        });
        // Give the wrapper a moment to record the command's process group.
        yield* Effect.sleep("300 millis");
        expect(yield* commands.stop(started.id, "user")).toBe(true);
        yield* untilEnded(commands, scheduler);
        expect(texts(yield* Ref.get(dispatched))[0]).toContain("The user stopped `sleep 30`");
        stopTestTmux(dirs.home);
      }),
    ),
  );

  it.live("sends matching lines while it runs, spaced out, and the rest with its end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const { commands, scheduler, dispatched } = yield* makeHarness({ ...dirs, persistence });
        // One failure now, a second once the test creates `go`.
        const started = yield* commands.start({
          threadId: THREAD_ID,
          command:
            "printf 'ok 1\\nFAILED test_a\\nok 2\\n'; while [ ! -f go ]; do sleep 0.1; done; echo 'failed test_b'; sleep 30",
          statusEveryMinutes: null,
          note: "Triage each failure.",
          tailLines: 0,
          notifyOn: "(?i)FAILED",
        });
        const matchesPath = NodePath.join(NodePath.dirname(started.stdoutPath), "matches.log");
        const untilMatches = (count: number) =>
          Effect.gen(function* () {
            for (let attempt = 0; attempt < 100; attempt += 1) {
              const text = NodeFS.existsSync(matchesPath)
                ? NodeFS.readFileSync(matchesPath, "utf8")
                : "";
              if (text.split("\n").filter(Boolean).length >= count) return;
              yield* Effect.sleep("100 millis");
            }
          });

        yield* untilMatches(1);
        yield* commands.pollNow;
        yield* scheduler.runDueNow;
        const [first] = texts(yield* Ref.get(dispatched));
        expect(first).toContain("printed lines you asked to hear about");
        // "ok 1\n" is 5 bytes, so the failing line starts at the 6th.
        expect(first).toContain("stdout byte 6: FAILED test_a");
        expect(first).toContain("Your note: Triage each failure.");
        expect(first).toContain("at most every 5 minutes");

        // A second failure within five minutes waits.
        NodeFS.writeFileSync(NodePath.join(dirs.workspace, "go"), "");
        yield* untilMatches(2);
        yield* commands.pollNow;
        yield* scheduler.runDueNow;
        expect(texts(yield* Ref.get(dispatched))).toHaveLength(1);

        // Its end brings the failure not yet told, and where the unread output starts.
        yield* Effect.sleep("300 millis");
        expect(yield* commands.stop(started.id, "user")).toBe(true);
        yield* untilEnded(commands, scheduler);
        const all = texts(yield* Ref.get(dispatched));
        expect(all).toHaveLength(2);
        expect(all[1]).toContain("stdout byte 25: failed test_b");
        // The first failure was told already.
        expect(all[1]).not.toContain("byte 6: FAILED test_a");
        expect(all[1]).toContain(
          `new since you last heard, from byte 25: tail -c +25 '${started.stdoutPath}'`,
        );
        stopTestTmux(dirs.home);
      }),
    ),
  );

  it.live("refuses a thread that is not in Full access", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const { commands } = yield* makeHarness({
          ...dirs,
          persistence,
          runtimeMode: "approval-required",
        });
        const refused = yield* Effect.flip(
          commands.start({
            threadId: THREAD_ID,
            command: "echo hi",
            statusEveryMinutes: null,
            note: "",
            tailLines: 0,
            notifyOn: null,
          }),
        );
        expect(refused.detail).toContain("Full access");
      }),
    ),
  );
});
