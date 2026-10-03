// @effect-diagnostics nodeBuiltinImport:off - the test runs real tmux sessions and reads what they wrote.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSettlementService from "../orchestration-v2/ThreadSettlementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadBackgroundCommands from "../persistence/ThreadBackgroundCommands.ts";
import * as ThreadCheckIns from "../persistence/ThreadCheckIns.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import * as TmuxServer from "../tmux/TmuxServer.ts";
import * as BackgroundCommands from "./BackgroundCommands.ts";
import * as CheckInScheduler from "./CheckInScheduler.ts";

const tmuxInstalled = NodeChildProcess.spawnSync("tmux", ["-V"]).status === 0;

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const CREATED_AT = DateTime.makeUnsafe("2026-09-28T11:00:00.000Z");

/** An idle thread working in `workspace`. */
function thread(workspace: string, runtimeMode: RuntimeMode): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode,
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    branch: null,
    worktreePath: workspace,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };
}

type MessageDispatch = Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>;

/** A thread domain event, as the orchestrator streams it. */
function threadEvent(
  type: "thread.archived" | "thread.deleted",
  threadId: ThreadId = THREAD_ID,
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-${type}-${threadId}`),
    type,
    threadId,
    occurredAt: DateTime.makeUnsafe("2026-09-28T12:00:00.000Z"),
    payload: {} as never,
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
    | SqlClient.SqlClient
  >;
  readonly runtimeMode?: RuntimeMode;
  /** Domain events the services see, for tests that drive them. */
  readonly events?: Stream.Stream<OrchestrationV2DomainEvent>;
  /** Changes the thread as the services read it, each time they do. */
  readonly adjustThread?: (shell: OrchestrationV2ThreadShell) => OrchestrationV2ThreadShell;
  /** The terminals the services open, which no test needs otherwise. */
  readonly terminals?: Partial<TerminalManager["Service"]>;
  /** Runs after each read of the thread, as slow work after it would. */
  readonly afterThreadRead?: () => Effect.Effect<void>;
}) {
  const dispatched = yield* Ref.make<ReadonlyArray<MessageDispatch>>([]);
  const layer = Layer.merge(BackgroundCommands.layer, BackgroundCommands.settlementHoldsLayer).pipe(
    Layer.provideMerge(CheckInScheduler.layer),
    Layer.provideMerge(ThreadBackgroundCommands.changesLayer),
    Layer.provide(Layer.succeedContext(options.persistence)),
    Layer.provide(TmuxServer.layer.pipe(Layer.provide(ProcessRunner.layer))),
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(options.workspace, options.home),
        ServerSettings.layerTest(),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (command) =>
            command.type === "message.dispatch"
              ? Ref.update(dispatched, (all) => [...all, command]).pipe(
                  Effect.as({ sequence: 1, storedEvents: [] }),
                )
              : Effect.die(`unexpected command ${command.type}`),
          getThreadShell: () =>
            Effect.sync(() => {
              const shell = thread(options.workspace, options.runtimeMode ?? "full-access");
              return options.adjustThread?.(shell) ?? shell;
            }).pipe(Effect.tap(() => options.afterThreadRead?.() ?? Effect.void)),
          streamDomainEvents: options.events ?? Stream.empty,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(TerminalManager)(options.terminals ?? {}),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const context = yield* Layer.build(layer);
  return {
    commands: Context.get(context, BackgroundCommands.BackgroundCommands),
    scheduler: Context.get(context, CheckInScheduler.CheckInScheduler),
    /** Whether the thread is held back from settling, as a running command holds it. */
    held: Context.get(context, ThreadSettlementService.ThreadSettlementHolds).heldThreadIds.pipe(
      Effect.map((threadIds) => threadIds.has(THREAD_ID)),
    ),
    dispatched,
  };
});

const buildPersistence = Layer.build(
  Layer.mergeAll(ThreadCheckIns.layer, ThreadBackgroundCommands.layer).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
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

/** The command's process group, once its wrapper has recorded it; nothing announces that. */
const untilPid = (jobDir: string) =>
  Effect.gen(function* () {
    const pidPath = NodePath.join(jobDir, "pid");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const pid = NodeFS.existsSync(pidPath)
        ? Number.parseInt(NodeFS.readFileSync(pidPath, "utf8"), 10)
        : Number.NaN;
      if (Number.isInteger(pid) && pid > 1) return pid;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`no pid recorded in ${jobDir}`));
  });

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** Whether a process has gone, allowing its parent a moment to reap it. */
const untilGone = (pid: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (processGone(pid)) return true;
      yield* Effect.sleep("50 millis");
    }
    return false;
  });

const texts = (commands: ReadonlyArray<MessageDispatch>) => commands.map((command) => command.text);

function freshDirs() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bg-"));
  const workspace = NodePath.join(root, "work");
  NodeChildProcess.execFileSync("mkdir", ["-p", workspace]);
  return { workspace, home: NodePath.join(root, "home") };
}

/** Whether the test's own tmux server has a session by that name. */
function testTmuxHasSession(home: string, session: string): boolean {
  const socket = NodeChildProcess.execFileSync("find", [home, "-name", "t3.sock"])
    .toString()
    .trim();
  return (
    socket !== "" &&
    NodeChildProcess.spawnSync("tmux", ["-S", socket, "has-session", "-t", session]).status === 0
  );
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
        const [message] = yield* Ref.get(dispatched);
        expect(message?.notification).toEqual({
          source: { kind: "command" },
          outcome: "failed",
          summary: 'Background command "echo out; echo err >&2; exit 3" failed (exit 3)',
        });
        expect(message?.dispatchMode).toEqual({ type: "queue_after_active" });
        const text = message?.text;
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
        // The new server holds the thread back from settling until the command ends.
        expect(yield* second.held).toBe(true);
        yield* untilEnded(second.commands, second.scheduler);
        expect(yield* second.held).toBe(false);

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

  it.live("holds back a muted command's matches until it is unmuted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const { commands, scheduler, dispatched } = yield* makeHarness({ ...dirs, persistence });
        const started = yield* commands.start({
          threadId: THREAD_ID,
          command: "while [ ! -f go ]; do sleep 0.1; done; echo 'FAILED test_a'; sleep 30",
          statusEveryMinutes: null,
          note: "",
          tailLines: 0,
          notifyOn: "FAILED",
        });
        expect(yield* commands.setMuted(started.id, true)).toBe(true);
        expect((yield* commands.list(THREAD_ID))[0]?.muted).toBe(true);
        NodeFS.writeFileSync(NodePath.join(dirs.workspace, "go"), "");
        const matchesPath = NodePath.join(NodePath.dirname(started.stdoutPath), "matches.log");
        for (let attempt = 0; attempt < 100 && !NodeFS.existsSync(matchesPath); attempt += 1) {
          yield* Effect.sleep("100 millis");
        }
        yield* commands.pollNow;
        yield* scheduler.runDueNow;
        expect(texts(yield* Ref.get(dispatched))).toHaveLength(0);

        // Unmuted, the match goes out; stopped, the end is told as always.
        expect(yield* commands.setMuted(started.id, false)).toBe(true);
        yield* scheduler.runDueNow;
        expect(texts(yield* Ref.get(dispatched))[0]).toContain("FAILED test_a");
        expect(yield* commands.stop(started.id, "user")).toBe(true);
        yield* untilEnded(commands, scheduler);
        expect(texts(yield* Ref.get(dispatched))[1]).toContain("The user stopped");
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

  it.live("never signals or waits on a pid recorded before the last boot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const { commands } = yield* makeHarness({ ...dirs, persistence });
        const started = yield* commands.start({
          threadId: THREAD_ID,
          command: "sleep 30",
          statusEveryMinutes: null,
          note: "",
          tailLines: 0,
          notifyOn: null,
        });
        const jobDir = NodePath.dirname(started.stdoutPath);
        const exitPath = NodePath.join(jobDir, "exit-status");
        // The machine restarts: the command ends without T3 hearing how...
        process.kill(-(yield* untilPid(jobDir)), "SIGKILL");
        for (let attempt = 0; attempt < 100 && !NodeFS.existsSync(exitPath); attempt += 1) {
          yield* Effect.sleep("50 millis");
        }
        NodeFS.rmSync(exitPath);
        yield* SqlClient.SqlClient.pipe(
          Effect.flatMap(
            (sql) => sql`
              UPDATE thread_background_commands SET started_at = '2000-01-01T00:00:00.000Z'
              WHERE background_command_id = ${started.id}
            `,
          ),
          Effect.provide(persistence),
        );
        // ...and its old pid now leads an unrelated process group.
        const unrelated = NodeChildProcess.spawn("sleep", ["30"], {
          detached: true,
          stdio: "ignore",
        });
        NodeFS.writeFileSync(NodePath.join(jobDir, "pid"), String(unrelated.pid));

        // The stop leaves that process alone, and the command still counts as ended.
        expect(yield* commands.stop(started.id, "user")).toBe(true);
        for (let poll = 0; poll < 100; poll += 1) {
          yield* commands.pollNow;
          if ((yield* commands.list(THREAD_ID))[0]?.status !== "running") break;
        }
        expect((yield* commands.list(THREAD_ID))[0]?.status).toBe("stopped");
        expect(unrelated.exitCode).toBeNull();
        expect(unrelated.signalCode).toBeNull();
        unrelated.kill("SIGKILL");
        stopTestTmux(dirs.home);
      }),
    ),
  );

  it.live("kills an archived thread's commands at once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const { commands } = yield* makeHarness({
          ...dirs,
          persistence,
          events: Stream.fromQueue(events),
        });
        yield* commands.watch();
        const started = yield* commands.start({
          threadId: THREAD_ID,
          command: "sleep 30",
          statusEveryMinutes: null,
          note: "",
          tailLines: 0,
          notifyOn: null,
        });
        const pid = yield* untilPid(NodePath.dirname(started.stdoutPath));
        const lists = yield* Stream.toQueue(commands.stream(THREAD_ID), { capacity: "unbounded" });
        expect(yield* Queue.take(lists)).toHaveLength(1);

        yield* Queue.offer(events, threadEvent("thread.archived"));
        expect(yield* Queue.take(lists)).toEqual([]);
        expect(yield* untilGone(pid)).toBe(true);
        stopTestTmux(dirs.home);
      }),
    ),
  );

  it.live("lists the threads with a command running, for thread lists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const { commands, scheduler } = yield* makeHarness({ ...dirs, persistence });
        const threads = yield* Stream.toQueue(commands.runningThreads, { capacity: "unbounded" });
        expect(yield* Queue.take(threads)).toEqual([]);
        const started = yield* commands.start({
          threadId: THREAD_ID,
          command: "sleep 30",
          statusEveryMinutes: null,
          note: "",
          tailLines: 0,
          notifyOn: null,
        });
        expect(yield* Queue.take(threads)).toEqual([THREAD_ID]);
        yield* untilPid(NodePath.dirname(started.stdoutPath));
        expect(yield* commands.stop(started.id, "user")).toBe(true);
        yield* untilEnded(commands, scheduler);
        expect(yield* Queue.take(threads)).toEqual([]);
        stopTestTmux(dirs.home);
      }),
    ),
  );

  it.live("attaches each fresh shell to the command once, even one showing old output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        // The terminal's shell, and what was typed into it.
        let shellPid = 101;
        const typed: Array<string> = [];
        const { commands } = yield* makeHarness({
          ...dirs,
          persistence,
          terminals: {
            open: (input) =>
              Effect.succeed({
                threadId: input.threadId,
                terminalId: input.terminalId,
                cwd: input.cwd ?? dirs.workspace,
                worktreePath: null,
                status: "running" as const,
                pid: shellPid,
                // A restart restores the old terminal's output.
                history: "test 1 ok\n",
                exitCode: null,
                exitSignal: null,
                label: "zsh",
                updatedAt: "2026-09-28T11:00:00.000Z",
              }),
            write: (input) =>
              Effect.sync(() => {
                typed.push(input.data);
              }),
          },
        });
        const started = yield* commands.start({
          threadId: THREAD_ID,
          command: "sleep 30",
          statusEveryMinutes: null,
          note: "",
          tailLines: 0,
          notifyOn: null,
        });
        yield* untilPid(NodePath.dirname(started.stdoutPath));
        yield* commands.openTerminal(started.id);
        yield* commands.openTerminal(started.id);
        expect(typed).toHaveLength(1);
        expect(typed[0]).toContain("attach");
        // A new shell, as after a restart, attaches again.
        shellPid = 202;
        yield* commands.openTerminal(started.id);
        expect(typed).toHaveLength(2);
        stopTestTmux(dirs.home);
      }),
    ),
  );

  it.live("stops the commands of a thread archived while no server listened, on start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const first = yield* makeHarness({ ...dirs, persistence });
        const started = yield* first.commands.start({
          threadId: THREAD_ID,
          command: "sleep 30",
          statusEveryMinutes: null,
          note: "",
          tailLines: 0,
          notifyOn: null,
        });
        const pid = yield* untilPid(NodePath.dirname(started.stdoutPath));
        // The next server finds the thread archived, with no event to say so.
        const next = yield* makeHarness({
          ...dirs,
          persistence,
          adjustThread: (shell) => ({ ...shell, archivedAt: shell.updatedAt }),
        });
        yield* next.commands.watch();
        expect(yield* untilGone(pid)).toBe(true);
        expect(yield* next.commands.list(THREAD_ID)).toEqual([]);
        stopTestTmux(dirs.home);
      }),
    ),
  );

  it.live("cleans up a command, and a check-in, whose thread is archived while they start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        // The archive lands right after the start looked at the thread, and its cleanup gets a
        // moment to run before the start goes on, as it would during a slow save.
        let archived = false;
        let justArchived = false;
        const { commands, scheduler } = yield* makeHarness({
          ...dirs,
          persistence,
          events: Stream.fromQueue(events),
          adjustThread: (shell) => {
            if (archived) return { ...shell, archivedAt: shell.updatedAt };
            archived = true;
            justArchived = true;
            Queue.offerUnsafe(events, threadEvent("thread.archived"));
            return shell;
          },
          afterThreadRead: () =>
            Effect.suspend(() => {
              if (!justArchived) return Effect.void;
              justArchived = false;
              return Effect.sleep("100 millis");
            }),
        });
        yield* commands.watch();
        yield* scheduler.start();
        const started = yield* commands.start({
          threadId: THREAD_ID,
          command: "sleep 30",
          statusEveryMinutes: null,
          note: "",
          tailLines: 0,
          notifyOn: null,
        });
        for (let round = 0; round < 100; round++) {
          if ((yield* commands.list(THREAD_ID)).length === 0) break;
          yield* Effect.sleep("20 millis");
        }
        expect(yield* commands.list(THREAD_ID)).toEqual([]);
        // The command's tmux session went with it.
        expect(testTmuxHasSession(dirs.home, `t3-${started.id}`)).toBe(false);

        archived = false;
        yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the build.",
          inMinutes: 10,
          repeatEveryMinutes: null,
        });
        for (let round = 0; round < 50; round++) {
          if ((yield* scheduler.list(THREAD_ID)).length === 0) break;
          yield* Effect.sleep("20 millis");
        }
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
        stopTestTmux(dirs.home);
      }),
    ),
  );

  it.live("kills a deleted thread's commands and leaves no output folder behind", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const { commands } = yield* makeHarness({
          ...dirs,
          persistence,
          events: Stream.fromQueue(events),
        });
        yield* commands.watch();
        const started = yield* commands.start({
          threadId: THREAD_ID,
          command: "sleep 30",
          statusEveryMinutes: null,
          note: "",
          tailLines: 0,
          notifyOn: null,
        });
        const jobDir = NodePath.dirname(started.stdoutPath);
        const pid = yield* untilPid(jobDir);
        // The wrapper outlives its session, so it is what could write into the folder later.
        const wrapperPid = Number.parseInt(
          NodeChildProcess.execFileSync("ps", ["-o", "ppid=", "-p", String(pid)]).toString(),
          10,
        );
        const lists = yield* Stream.toQueue(commands.stream(THREAD_ID), { capacity: "unbounded" });
        expect(yield* Queue.take(lists)).toHaveLength(1);

        yield* Queue.offer(events, threadEvent("thread.deleted"));
        expect(yield* Queue.take(lists)).toEqual([]);
        expect(yield* untilGone(pid)).toBe(true);
        expect(yield* untilGone(wrapperPid)).toBe(true);
        expect(NodeFS.existsSync(jobDir)).toBe(false);
        stopTestTmux(dirs.home);
      }),
    ),
  );

  it.live("kills a command whose stop is first seen past the last stage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const repository = Context.get(
          persistence,
          ThreadBackgroundCommands.ThreadBackgroundCommandRepository,
        );
        const { commands, scheduler, dispatched } = yield* makeHarness({ ...dirs, persistence });
        const started = yield* commands.start({
          threadId: THREAD_ID,
          command: "sleep 30",
          statusEveryMinutes: null,
          note: "",
          tailLines: 0,
          notifyOn: null,
        });
        const pid = yield* untilPid(NodePath.dirname(started.stdoutPath));
        // Asked a minute ago, by a server that went down before it signalled anything.
        const askedAt = DateTime.formatIso(
          DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - 60_000),
        );
        expect(yield* repository.requestStop(started.id, "user", askedAt)).toBe(true);

        yield* untilEnded(commands, scheduler);
        expect((yield* repository.get(started.id))?.status).toBe("stopped");
        expect(yield* untilGone(pid)).toBe(true);
        expect(texts(yield* Ref.get(dispatched))[0]).toContain("The user stopped `sleep 30`");
        stopTestTmux(dirs.home);
      }),
    ),
  );

  it.live("forgets an archived thread's command ends the agent has not heard about", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        // The agent waits on the user, so it hears nothing yet.
        let waitingOnUser = true;
        const { commands, scheduler, dispatched } = yield* makeHarness({
          ...dirs,
          persistence,
          events: Stream.fromQueue(events),
          adjustThread: (shell) =>
            waitingOnUser
              ? {
                  ...shell,
                  pendingRuntimeRequest: {
                    id: "request-1" as never,
                    kind: "user_input",
                    createdAt: CREATED_AT,
                  },
                }
              : shell,
        });
        yield* commands.watch();
        yield* commands.start({
          threadId: THREAD_ID,
          command: "exit 0",
          statusEveryMinutes: null,
          note: "",
          tailLines: 0,
          notifyOn: null,
        });
        // It ends while the agent waits.
        for (let attempt = 0; attempt < 100; attempt += 1) {
          yield* commands.pollNow;
          if ((yield* commands.list(THREAD_ID))[0]?.status !== "running") break;
          yield* Effect.sleep("50 millis");
        }
        yield* scheduler.runDueNow;
        expect(texts(yield* Ref.get(dispatched))).toEqual([]);
        const lists = yield* Stream.toQueue(commands.stream(THREAD_ID), { capacity: "unbounded" });
        expect(yield* Queue.take(lists)).toMatchObject([{ status: "exited" }]);

        yield* Queue.offer(events, threadEvent("thread.archived"));
        expect(yield* Queue.take(lists)).toEqual([]);
        // Unarchived and answered later, the thread gets no turn about it.
        waitingOnUser = false;
        yield* scheduler.runDueNow;
        expect(texts(yield* Ref.get(dispatched))).toEqual([]);
        stopTestTmux(dirs.home);
      }),
    ),
  );

  it.live("tells the agent nothing about a command it stopped, and releases the thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = freshDirs();
        const persistence = yield* buildPersistence;
        const { commands, scheduler, held, dispatched } = yield* makeHarness({
          ...dirs,
          persistence,
        });
        const started = yield* commands.start({
          threadId: THREAD_ID,
          command: "sleep 30",
          statusEveryMinutes: null,
          note: "",
          tailLines: 0,
          notifyOn: null,
        });
        expect(yield* held).toBe(true);
        yield* untilPid(NodePath.dirname(started.stdoutPath));
        // The agent stops it itself, so it is told nothing and no turn starts.
        expect(yield* commands.stop(started.id, "agent")).toBe(true);
        yield* untilEnded(commands, scheduler);

        expect(yield* Ref.get(dispatched)).toEqual([]);
        expect(yield* commands.list(THREAD_ID)).toEqual([]);
        expect(yield* held).toBe(false);
        stopTestTmux(dirs.home);
      }),
    ),
  );
});
