import {
  CHECK_IN_CONTEXT_KIND,
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

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
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
  let uuids = 0;
  const layer = CheckInScheduler.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCheckIns.layer,
        ThreadBackgroundCommands.layer,
        ThreadBackgroundCommands.changesLayer,
      ).pipe(Layer.provide(SqlitePersistenceMemory)),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Ref.update(dispatched, (all) => [...all, command]).pipe(
              Effect.andThen(Effect.flatten(Ref.get(duringDispatch))),
              Effect.as({ sequence: 1 }),
            ),
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
  const at = (ms: number) => TestClock.setTime(ms).pipe(Effect.andThen(scheduler.runDueNow));
  const setThread = (shell: OrchestrationThreadShell | undefined) =>
    Ref.update(shells, (all) => {
      const next = new Map(all);
      if (shell) next.set(shell.id, shell);
      else next.delete(THREAD_ID);
      return next;
    });
  return { scheduler, dispatched, at, setThread, duringDispatch };
});

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
