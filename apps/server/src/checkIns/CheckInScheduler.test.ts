import {
  BackgroundCommandId,
  CHECK_IN_CONTEXT_KIND,
  type CheckInId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadBackgroundCommands from "../persistence/ThreadBackgroundCommands.ts";
import * as ThreadCheckIns from "../persistence/ThreadCheckIns.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckInScheduler from "./CheckInScheduler.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const OTHER_THREAD_ID = ThreadId.make("thread-2");
const START = Date.parse("2026-09-28T12:00:00.000Z");
const MINUTE = 60_000;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** A thread whose last turn finished at `completedAt`, or one still running without it. */
function thread(
  options: {
    readonly completedAt?: number;
    readonly running?: boolean;
    readonly pendingApproval?: boolean;
  } = {},
): OrchestrationThreadShell {
  const completedAt = options.completedAt ?? START - MINUTE;
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("bob"), model: "bob" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: options.running ? "running" : "completed",
      requestedAt: iso(completedAt - MINUTE),
      startedAt: iso(completedAt - MINUTE),
      completedAt: options.running ? null : iso(completedAt),
      assistantMessageId: null,
    },
    createdAt: iso(START - 60 * MINUTE),
    updatedAt: iso(completedAt),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId: THREAD_ID,
      status: options.running ? "running" : "ready",
      providerName: "bob",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: iso(completedAt),
    },
    latestUserMessageAt: iso(completedAt - MINUTE),
    hasPendingApprovals: options.pendingApproval ?? false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const makeHarness = Effect.fn("makeCheckInHarness")(function* (
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) {
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  // Runs during each dispatch, as a user's action landing while a delivery is in flight would.
  const duringDispatch = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const shells = yield* Ref.make(new Map([[THREAD_ID, thread()]]));
  // A check-in whose removal fails, as a database error or a crash mid-record would.
  const failRemoval = yield* Ref.make<CheckInId | null>(null);
  // A thread that refuses every turn; the engine remembers each refused command id.
  const refuseThread = yield* Ref.make<ThreadId | null>(null);
  const refused = yield* Ref.make<ReadonlySet<string>>(new Set());
  const checkIns = Layer.effect(
    ThreadCheckIns.ThreadCheckInRepository,
    Effect.gen(function* () {
      const repository = yield* ThreadCheckIns.ThreadCheckInRepository;
      return ThreadCheckIns.ThreadCheckInRepository.of({
        ...repository,
        remove: (checkInId) =>
          Effect.gen(function* () {
            if ((yield* Ref.get(failRemoval)) === checkInId) {
              return yield* new PersistenceSqlError({ operation: "removeCheckIn" });
            }
            return yield* repository.remove(checkInId);
          }),
      });
    }),
  ).pipe(Layer.provide(ThreadCheckIns.layer));
  let uuids = 0;
  const layer = CheckInScheduler.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        checkIns,
        ThreadBackgroundCommands.layer,
        ThreadBackgroundCommands.changesLayer,
      ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          // A command id already accepted is not run again, and one refused is refused again, as
          // the engine's receipts ensure.
          dispatch: (command) =>
            Effect.gen(function* () {
              if ((yield* Ref.get(refused)).has(command.commandId)) {
                return yield* new OrchestrationCommandPreviouslyRejectedError({
                  commandId: command.commandId,
                  detail: "Previously rejected.",
                });
              }
              if ("threadId" in command && command.threadId === (yield* Ref.get(refuseThread))) {
                yield* Ref.update(refused, (all) => new Set([...all, command.commandId]));
                return yield* new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "The thread refused the turn.",
                });
              }
              const accepted = yield* Ref.modify(dispatched, (all) =>
                all.some((earlier) => earlier.commandId === command.commandId)
                  ? [false, all]
                  : [true, [...all, command]],
              );
              if (accepted) yield* Effect.flatten(Ref.get(duringDispatch));
              return { sequence: 1 };
            }),
          subscribeDomainEvents: Effect.succeed(Stream.empty),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: (threadId) =>
            Ref.get(shells).pipe(Effect.map((all) => Option.fromUndefinedOr(all.get(threadId)))),
        }),
        ServerSettings.layerTest(settings),
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size).fill(++uuids),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
      ),
    ),
  );
  // Built in the test's scope, so the in-memory database outlives each call.
  const context = yield* Layer.build(layer);
  const scheduler = Context.get(context, CheckInScheduler.CheckInScheduler);
  const commands = Context.get(context, ThreadBackgroundCommands.ThreadBackgroundCommandRepository);
  const at = (ms: number) => TestClock.setTime(ms).pipe(Effect.andThen(scheduler.runDueNow));
  const setThread = (shell: OrchestrationThreadShell | undefined) =>
    Ref.update(shells, (all) => {
      const next = new Map(all);
      if (shell) next.set(shell.id, shell);
      else next.delete(THREAD_ID);
      return next;
    });
  return {
    scheduler,
    commands,
    dispatched,
    at,
    setThread,
    duringDispatch,
    failRemoval,
    refuseThread,
  };
});

/** A running background command with status updates, whose job folder has nothing in it. */
function runningCommand(options: {
  readonly startedAt: number;
  readonly nextStatusAt: number;
}): ThreadBackgroundCommands.BackgroundCommandRow {
  const jobDir = "/nonexistent/.t3/jobs/bg-1";
  return {
    id: BackgroundCommandId.make("bg-1"),
    threadId: THREAD_ID,
    command: "vp run dev",
    cwd: "/nonexistent",
    stdoutPath: `${jobDir}/stdout.log`,
    stderrPath: `${jobDir}/stderr.log`,
    status: "running",
    exitStatus: null,
    startedAt: iso(options.startedAt),
    endedAt: null,
    statusEveryMinutes: 30,
    nextStatusAt: iso(options.nextStatusAt),
    note: "",
    tailLines: 0,
    notifyOn: null,
    stopRequestedBy: null,
    muted: false,
    jobDir,
    tmuxSession: "t3-bg-1",
    stopRequestedAt: null,
    endNoticeSent: false,
    statusNoticesSent: 0,
    stdoutBytesNoticed: 0,
    stderrBytesNoticed: 0,
    missingObservations: 0,
    matchNoticesSent: 0,
    matchBytesNoticed: 0,
    lastMatchNoticeAt: null,
  };
}

const texts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.turn.start" ? [command.message.text] : [],
  );

describe("CheckInScheduler", () => {
  it.effect("delivers a one-time check-in once it is due and the thread is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at } = yield* makeHarness();
        const checkIn = yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the desktop build.",
          inMinutes: 10,
          repeatEveryMinutes: null,
        });

        yield* at(START + 9 * MINUTE);
        expect(yield* Ref.get(dispatched)).toEqual([]);

        yield* at(START + 10 * MINUTE);
        const [command] = yield* Ref.get(dispatched);
        expect(command?.type).toBe("thread.turn.start");
        if (command?.type !== "thread.turn.start") return;
        expect(command.threadId).toBe(THREAD_ID);
        expect(command.message.text).toBe("[T3 Code check-in] Check the desktop build.");
        expect(command.message.context?.records.map((record) => record.kind)).toEqual([
          CHECK_IN_CONTEXT_KIND,
        ]);
        expect(String(command.commandId)).toBe(`server:check-in:${checkIn.id}:1`);
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("sends check-ins that fall due together in one message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at } = yield* makeHarness();
        const first = yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the build.",
          inMinutes: 10,
          repeatEveryMinutes: null,
        });
        const second = yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the deploy.",
          inMinutes: 11,
          repeatEveryMinutes: null,
        });

        // Both are due by the time the thread can take them: one turn, both notes, in order.
        yield* at(START + 12 * MINUTE);
        const all = yield* Ref.get(dispatched);
        expect(texts(all)).toEqual([
          "[T3 Code check-in] Check the build.\n\n[T3 Code check-in] Check the deploy.",
        ]);
        const [command] = all;
        if (command?.type !== "thread.turn.start") return;
        expect(command.message.context?.records).toHaveLength(2);
        // Named by its parts, sorted, so a retry after a crash is the same message.
        expect(String(command.commandId)).toBe(
          `server:notices:${[`check-in:${first.id}:1`, `check-in:${second.id}:1`].toSorted().join("+")}`,
        );
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("sends a combined message once when recording one of its parts fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, failRemoval } = yield* makeHarness();
        yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the build.",
          inMinutes: 10,
          repeatEveryMinutes: null,
        });
        const second = yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the deploy.",
          inMinutes: 11,
          repeatEveryMinutes: null,
        });

        // The message goes in, then recording the second part fails after the first is recorded.
        yield* Ref.set(failRemoval, second.id);
        yield* at(START + 12 * MINUTE);
        expect(texts(yield* Ref.get(dispatched))).toHaveLength(1);
        expect(yield* scheduler.list(THREAD_ID)).toHaveLength(2);

        // Once the turn it started ends, the retry is the same message, so it is not sent again.
        yield* Ref.set(failRemoval, null);
        yield* setThread(thread({ completedAt: START + 13 * MINUTE }));
        yield* at(START + 14 * MINUTE);
        expect(texts(yield* Ref.get(dispatched))).toEqual([
          "[T3 Code check-in] Check the build.\n\n[T3 Code check-in] Check the deploy.",
        ]);
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("keeps delivering to other threads when one thread's refused message is retried", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, failRemoval, refuseThread } =
          yield* makeHarness();
        yield* setThread({ ...thread(), id: OTHER_THREAD_ID });
        const refusedCheckIn = yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the build.",
          inMinutes: 10,
          repeatEveryMinutes: null,
        });

        // The thread refuses the turn, and recording that fails, so the check-in stays due.
        yield* Ref.set(refuseThread, THREAD_ID);
        yield* Ref.set(failRemoval, refusedCheckIn.id);
        yield* at(START + 10 * MINUTE);
        expect(yield* scheduler.list(THREAD_ID)).toHaveLength(1);

        // The retry is refused as before and its record fails again; the other thread's check-in,
        // due later in the same sweep, still goes.
        yield* scheduler.schedule({
          threadId: OTHER_THREAD_ID,
          note: "Check the deploy.",
          inMinutes: 1,
          repeatEveryMinutes: null,
        });
        yield* at(START + 11 * MINUTE);
        expect(texts(yield* Ref.get(dispatched))).toEqual(["[T3 Code check-in] Check the deploy."]);
        expect(yield* scheduler.list(OTHER_THREAD_ID)).toEqual([]);

        // Once recording works, the refused check-in is recorded and not tried again.
        yield* Ref.set(failRemoval, null);
        yield* at(START + 12 * MINUTE);
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
        expect(texts(yield* Ref.get(dispatched))).toHaveLength(1);
      }),
    ),
  );

  it.effect("waits while the thread works or needs the user, and for a moment after", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread } = yield* makeHarness();
        yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Look again.",
          inMinutes: 1,
          repeatEveryMinutes: null,
        });

        yield* setThread(thread({ running: true }));
        yield* at(START + 5 * MINUTE);
        yield* setThread(thread({ completedAt: START, pendingApproval: true }));
        yield* at(START + 6 * MINUTE);
        expect(yield* Ref.get(dispatched)).toEqual([]);
        expect((yield* scheduler.list(THREAD_ID))[0]?.dueSince).toBe(iso(START + MINUTE));

        const finished = START + 7 * MINUTE;
        yield* setThread(thread({ completedAt: finished }));
        yield* at(finished + 1_000);
        expect(yield* Ref.get(dispatched)).toEqual([]);
        yield* at(finished + CheckInScheduler.CHECK_IN_IDLE_GRACE_MS);
        expect(texts(yield* Ref.get(dispatched))).toEqual(["[T3 Code check-in] Look again."]);
      }),
    ),
  );

  it.effect("skips repeats that fall due while an earlier one waits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread } = yield* makeHarness();
        yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check CI.",
          inMinutes: 5,
          repeatEveryMinutes: 5,
        });

        yield* setThread(thread({ running: true }));
        yield* at(START + 5 * MINUTE);
        yield* at(START + 16 * MINUTE);
        yield* setThread(thread({ completedAt: START + 17 * MINUTE }));
        yield* at(START + 18 * MINUTE);

        expect(texts(yield* Ref.get(dispatched))).toHaveLength(1);
        const [waiting] = yield* scheduler.list(THREAD_ID);
        expect(waiting).toMatchObject({
          nextAt: iso(START + 20 * MINUTE),
          dueSince: null,
          deliveredCount: 1,
        });
      }),
    ),
  );

  it.effect("stops a repeating check-in at its end time and says it was the last", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at } = yield* makeHarness({ checkInRepeatLimitHours: 1 });
        const checkIn = yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Poll the deploy.",
          inMinutes: 30,
          repeatEveryMinutes: 30,
        });
        expect(checkIn.endsAt).toBe(iso(START + 60 * MINUTE));

        yield* at(START + 30 * MINUTE);
        yield* at(START + 60 * MINUTE);
        const [first, last] = texts(yield* Ref.get(dispatched));
        expect(first).toContain("The next one is in 30 minutes.");
        expect(last).toContain("This is the last one");
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("ends a command's status updates at the repeat limit, and says so", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { commands, dispatched, at } = yield* makeHarness({ checkInRepeatLimitHours: 1 });
        const id = BackgroundCommandId.make("bg-1");
        yield* commands.insertIfUnder(
          runningCommand({ startedAt: START, nextStatusAt: START + 30 * MINUTE }),
          5,
        );

        // Inside the limit: the next one is scheduled.
        yield* at(START + 30 * MINUTE);
        expect((yield* commands.get(id))?.nextStatusAt).toBe(iso(START + 60 * MINUTE));

        // The one after would fall past the hour: this is the last, and nothing more is due.
        yield* at(START + 60 * MINUTE);
        yield* at(START + 120 * MINUTE);
        const [first, last, ...more] = texts(yield* Ref.get(dispatched));
        expect(first).toContain("The next status update is in 30 minutes");
        expect(last).toContain(
          "This is the last status update: they end 1 hour after the command starts. You will still be told the moment it ends.",
        );
        expect(more).toEqual([]);
        expect(yield* commands.get(id)).toMatchObject({
          status: "running",
          nextStatusAt: null,
          statusNoticesSent: 2,
        });
      }),
    ),
  );

  it.effect("drops the check-ins of a thread that was archived or deleted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread } = yield* makeHarness();
        yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the build.",
          inMinutes: 1,
          repeatEveryMinutes: 5,
        });
        yield* setThread(undefined);
        yield* at(START + MINUTE);
        expect(yield* Ref.get(dispatched)).toEqual([]);
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("limits each thread's check-ins and honours the project switch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler } = yield* makeHarness();
        const schedule = scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check.",
          inMinutes: 10,
          repeatEveryMinutes: null,
        });
        yield* Effect.replicateEffect(schedule, 5);
        const sixth = yield* Effect.flip(schedule);
        expect(sixth.detail).toContain("already has 5 check-ins");

        const off = yield* makeHarness({
          projectSettingsOverrides: { [PROJECT_ID]: { enableAgentCheckIns: false } },
        });
        const refused = yield* Effect.flip(
          off.scheduler.schedule({
            threadId: THREAD_ID,
            note: "Check.",
            inMinutes: 10,
            repeatEveryMinutes: null,
          }),
        );
        expect(refused.detail).toContain("turned off for this project");
      }),
    ),
  );

  it.effect("keeps a check-in cancelled while its delivery was in flight cancelled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, duringDispatch } = yield* makeHarness();
        const checkIn = yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check CI.",
          inMinutes: 5,
          repeatEveryMinutes: 5,
        });
        yield* Ref.set(duringDispatch, scheduler.cancel(checkIn.id).pipe(Effect.ignore));
        yield* at(START + 5 * MINUTE);
        expect(texts(yield* Ref.get(dispatched))).toHaveLength(1);
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("lets an agent cancel only its own thread's check-ins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler } = yield* makeHarness();
        const checkIn = yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check.",
          inMinutes: 10,
          repeatEveryMinutes: null,
        });
        expect(yield* scheduler.cancel(checkIn.id, OTHER_THREAD_ID)).toBe(false);
        expect(yield* scheduler.cancel(checkIn.id, THREAD_ID)).toBe(true);
        expect(yield* scheduler.cancel(checkIn.id)).toBe(false);
      }),
    ),
  );
});
