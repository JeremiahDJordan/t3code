import {
  AGENT_MESSAGE_CONTEXT_KIND,
  AGENT_MESSAGE_MAX_CHARS,
  type AgentMessageEnvelope,
  BackgroundCommandId,
  EnvironmentId,
  CHECK_IN_CONTEXT_KIND,
  COMPOSER_CONTEXT_MAX_RECORDS,
  type CheckInId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
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
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { agentMessageText, waitNoticeText } from "../agentThreads/agentThreadMessage.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentThreads from "../persistence/AgentThreads.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadBackgroundCommands from "../persistence/ThreadBackgroundCommands.ts";
import * as ThreadCheckIns from "../persistence/ThreadCheckIns.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckInScheduler from "./CheckInScheduler.ts";

const PROJECT_ID = ProjectId.make("project-1");
const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-1");
const OTHER_THREAD_ID = ThreadId.make("thread-2");
const START = Date.parse("2026-09-28T12:00:00.000Z");
const MINUTE = 60_000;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** A thread whose last turn finished at `completedAt`, or one still running without it. */
function thread(
  options: {
    readonly id?: ThreadId;
    readonly completedAt?: number;
    readonly running?: boolean;
    readonly pendingApproval?: boolean;
  } = {},
): OrchestrationThreadShell {
  const completedAt = options.completedAt ?? START - MINUTE;
  const id = options.id ?? THREAD_ID;
  return {
    id,
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
      threadId: id,
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
  // Each thread's recent messages, as its detail snapshot shows them.
  const replies = yield* Ref.make(new Map<ThreadId, ReadonlyArray<OrchestrationMessage>>());
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
        AgentThreads.layer,
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
          getThreadDetailSnapshot: (threadId, window) =>
            Effect.gen(function* () {
              const shell = (yield* Ref.get(shells)).get(threadId);
              if (shell === undefined) return Option.none();
              const all = (yield* Ref.get(replies)).get(threadId) ?? [];
              // Pages by turn, each starting at a user message, newest first like the real query.
              const starts = all.flatMap((entry, index) =>
                index === 0 || entry.role === "user" ? [index] : [],
              );
              const end =
                window?.beforeCursor === undefined ? starts.length : Number(window.beforeCursor);
              const first =
                window?.turnLimit === undefined ? 0 : Math.max(0, end - window.turnLimit);
              return Option.some({
                snapshotSequence: 1,
                thread: {
                  ...shell,
                  deletedAt: null,
                  messages: all.slice(starts[first] ?? 0, starts[end] ?? all.length),
                  proposedPlans: [],
                  activities: [],
                  checkpoints: [],
                },
                page: {
                  beforeCursor: first > 0 ? String(first) : null,
                  hasMore: first > 0,
                  snapshotSequence: 1,
                },
              });
            }),
        }),
        ServerSettings.layerTest(settings),
        Layer.mock(ServerEnvironment)({
          getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
        }),
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
  const agentThreads = Context.get(context, AgentThreads.AgentThreadRepository);
  const sql = Context.get(context, SqlClient.SqlClient);
  const at = (ms: number) => TestClock.setTime(ms).pipe(Effect.andThen(scheduler.runDueNow));
  const setThread = (
    shell: OrchestrationThreadShell | undefined,
    threadId: ThreadId = shell?.id ?? THREAD_ID,
  ) =>
    Ref.update(shells, (all) => {
      const next = new Map(all);
      if (shell) next.set(shell.id, shell);
      else next.delete(threadId);
      return next;
    });
  const setReplies = (threadId: ThreadId, messages: ReadonlyArray<OrchestrationMessage>) =>
    Ref.update(replies, (all) => new Map(all).set(threadId, messages));
  const messageStatus = (messageId: string) =>
    sql<{ readonly status: string; readonly deliveredAt: string | null }>`
      SELECT status, delivered_at AS "deliveredAt" FROM agent_thread_messages
      WHERE message_id = ${messageId}
    `.pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    );
  return {
    scheduler,
    commands,
    agentThreads,
    dispatched,
    at,
    setThread,
    setReplies,
    messageStatus,
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

const records = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.turn.start" ? [command.message.context?.records ?? []] : [],
  );

const WAITED_ON = { environmentId: ENVIRONMENT_ID, threadId: OTHER_THREAD_ID };

/** A message another thread's agent sent to `to`, waiting to be delivered. */
function queuedMessage(
  messageId: string,
  to: ThreadId,
  createdAt: number,
  body = "Is the release branch green?",
): AgentThreads.AgentMessageRow {
  const sender = { environmentId: ENVIRONMENT_ID, threadId: ThreadId.make("thread-sender") };
  const envelope: AgentMessageEnvelope = {
    version: 1,
    messageId,
    kind: "message",
    from: { ...sender, threadTitle: "Fix the build" },
    to: { environmentId: ENVIRONMENT_ID, threadId: to },
    sentAt: iso(createdAt),
    conversationId: messageId,
    depth: 0,
    body,
  };
  return {
    messageId,
    kind: "message",
    envelope,
    senderEnvironmentId: sender.environmentId,
    senderThreadId: sender.threadId,
    targetEnvironmentId: ENVIRONMENT_ID,
    targetThreadId: to,
    status: "queued",
    createdAt: iso(createdAt),
    deliveredAt: null,
  };
}

function message(
  role: OrchestrationMessage["role"],
  text: string,
  createdAt: number,
): OrchestrationMessage {
  return {
    id: MessageId.make(`message-${createdAt}`),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: iso(createdAt),
    updatedAt: iso(createdAt),
  };
}

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

describe("CheckInScheduler agent threads", () => {
  it.effect("delivers a queued message once its thread is idle, as its own record", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { agentThreads, dispatched, at, messageStatus } = yield* makeHarness();
        const row = queuedMessage("message-1", THREAD_ID, START);
        yield* agentThreads.insertMessage(row);

        yield* at(START);
        const all = yield* Ref.get(dispatched);
        expect(texts(all)).toEqual([agentMessageText(row.envelope)]);
        expect(all[0]).toMatchObject({ threadId: THREAD_ID });
        expect(records(all)).toEqual([
          [
            {
              version: 1,
              contextId: "agent-message-message-1",
              label: 'From "Fix the build"',
              kind: AGENT_MESSAGE_CONTEXT_KIND,
              payload: row.envelope,
            },
          ],
        ]);
        expect(yield* messageStatus("message-1")).toEqual({
          status: "delivered",
          deliveredAt: iso(START),
        });

        // Delivered once: the next sweep has nothing for the thread.
        yield* at(START + 10 * MINUTE);
        expect(texts(yield* Ref.get(dispatched))).toHaveLength(1);
      }),
    ),
  );

  it.effect("holds a message while its thread works", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { agentThreads, dispatched, at, setThread, messageStatus } = yield* makeHarness();
        yield* setThread(thread({ running: true }));
        yield* agentThreads.insertMessage(queuedMessage("message-1", THREAD_ID, START));

        yield* at(START + 5 * MINUTE);
        expect(yield* Ref.get(dispatched)).toEqual([]);
        expect((yield* messageStatus("message-1"))?.status).toBe("queued");

        const finished = START + 6 * MINUTE;
        yield* setThread(thread({ completedAt: finished }));
        yield* at(finished + CheckInScheduler.CHECK_IN_IDLE_GRACE_MS);
        expect(texts(yield* Ref.get(dispatched))).toHaveLength(1);
        expect((yield* messageStatus("message-1"))?.status).toBe("delivered");
      }),
    ),
  );

  it.effect("sends a message and a due check-in for the same thread in one message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, agentThreads, dispatched, at, messageStatus } = yield* makeHarness();
        const checkIn = yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the build.",
          inMinutes: 1,
          repeatEveryMinutes: null,
        });
        const row = queuedMessage("message-1", THREAD_ID, START);
        yield* agentThreads.insertMessage(row);

        yield* at(START + MINUTE);
        const all = yield* Ref.get(dispatched);
        expect(texts(all)).toEqual([
          `[T3 Code check-in] Check the build.\n\n${agentMessageText(row.envelope)}`,
        ]);
        expect(records(all)[0]?.map((record) => record.kind)).toEqual([
          CHECK_IN_CONTEXT_KIND,
          AGENT_MESSAGE_CONTEXT_KIND,
        ]);
        expect(String(all[0]?.commandId)).toBe(
          `server:notices:${[`check-in:${checkIn.id}:1`, "agent-message:message-1"].toSorted().join("+")}`,
        );
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
        expect((yield* messageStatus("message-1"))?.status).toBe("delivered");
      }),
    ),
  );

  it.effect("sends only the messages that fit the provider's input, and the rest next turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { agentThreads, dispatched, at, setThread, messageStatus } = yield* makeHarness();
        const ids = Array.from({ length: 8 }, (_, index) => `message-${index}`);
        yield* Effect.forEach(ids, (id, index) =>
          agentThreads.insertMessage(
            queuedMessage(id, THREAD_ID, START + index, "x".repeat(AGENT_MESSAGE_MAX_CHARS)),
          ),
        );

        yield* at(START + MINUTE);
        const [first] = texts(yield* Ref.get(dispatched));
        expect(first?.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
        expect(records(yield* Ref.get(dispatched))[0]).toHaveLength(7);
        for (const id of ids.slice(0, 7)) {
          expect((yield* messageStatus(id))?.status).toBe("delivered");
        }
        expect((yield* messageStatus("message-7"))?.status).toBe("queued");

        // The turn those started ends, and the last one goes in the next.
        const finished = START + 5 * MINUTE;
        yield* setThread(thread({ completedAt: finished }));
        yield* at(finished + CheckInScheduler.CHECK_IN_IDLE_GRACE_MS);
        const [, second] = records(yield* Ref.get(dispatched));
        expect(second?.map((record) => record.contextId)).toEqual(["agent-message-message-7"]);
        expect((yield* messageStatus("message-7"))?.status).toBe("delivered");
      }),
    ),
  );

  it.effect("sizes a turn's messages by the provider input their context links expand to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { agentThreads, dispatched, at, setThread } = yield* makeHarness();
        // Forwarded links to context the message does not carry: each expands for the provider.
        const linked = (id: string) => {
          const links = Array.from(
            { length: 50 },
            (_, index) => `[f](t3-context://v1/file/${id}-${index})`,
          ).join(" ");
          return `${links} ${"x".repeat(AGENT_MESSAGE_MAX_CHARS - links.length - 1)}`;
        };
        // Seven fit the provider's input as written, but not once expanded.
        const ids = Array.from({ length: 7 }, (_, index) => `message-${index}`);
        yield* Effect.forEach(ids, (id, index) =>
          agentThreads.insertMessage(queuedMessage(id, THREAD_ID, START + index, linked(id))),
        );

        yield* at(START + MINUTE);
        const [text] = texts(yield* Ref.get(dispatched));
        const [sent] = records(yield* Ref.get(dispatched));
        expect(
          projectComposerContextForProvider({ text: text ?? "", records: sent ?? [] }).length,
        ).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
        const queued = yield* agentThreads.listQueued(ENVIRONMENT_ID);
        expect(queued.length).toBeGreaterThan(0);
        expect((sent?.length ?? 0) + queued.length).toBe(7);

        const finished = START + 5 * MINUTE;
        yield* setThread(thread({ completedAt: finished }));
        yield* at(finished + CheckInScheduler.CHECK_IN_IDLE_GRACE_MS);
        expect(yield* agentThreads.listQueued(ENVIRONMENT_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("sends at most a message's records in one turn, and the rest next turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, agentThreads, dispatched, at, setThread } = yield* makeHarness();
        yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the build.",
          inMinutes: 1,
          repeatEveryMinutes: null,
        });
        yield* Effect.forEach(
          // With the check-in, one more than a message may carry.
          Array.from({ length: COMPOSER_CONTEXT_MAX_RECORDS }, (_, index) => index),
          (index) =>
            agentThreads.insertMessage(
              queuedMessage(`message-${String(index).padStart(3, "0")}`, THREAD_ID, START),
            ),
        );

        yield* at(START + MINUTE);
        const [first] = records(yield* Ref.get(dispatched));
        expect(first).toHaveLength(COMPOSER_CONTEXT_MAX_RECORDS);
        expect(first?.[0]?.kind).toBe(CHECK_IN_CONTEXT_KIND);
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
        expect(
          (yield* agentThreads.listQueued(ENVIRONMENT_ID)).map((row) => row.messageId),
        ).toEqual(["message-199"]);

        const finished = START + 5 * MINUTE;
        yield* setThread(thread({ completedAt: finished }));
        yield* at(finished + CheckInScheduler.CHECK_IN_IDLE_GRACE_MS);
        expect(records(yield* Ref.get(dispatched))[1]).toHaveLength(1);
        expect(yield* agentThreads.listQueued(ENVIRONMENT_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("fails a message to a thread that no longer exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { agentThreads, dispatched, at, messageStatus } = yield* makeHarness();
        yield* agentThreads.insertMessage(
          queuedMessage("message-1", ThreadId.make("thread-gone"), START),
        );

        yield* at(START);
        expect(yield* Ref.get(dispatched)).toEqual([]);
        expect(yield* messageStatus("message-1")).toEqual({ status: "failed", deliveredAt: null });
        expect(yield* agentThreads.listQueued(ENVIRONMENT_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("does not count a turn that finished before the wait began", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread } = yield* makeHarness();
        yield* setThread(thread({ id: OTHER_THREAD_ID, completedAt: START - MINUTE }));
        const wait = yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          target: WAITED_ON,
          title: "Review the docs",
          note: "",
        });
        expect(wait).toMatchObject({
          note: 'Wait for "Review the docs" to finish its turn.',
          repeatEveryMinutes: null,
          nextAt: iso(START + 24 * 60 * MINUTE),
          waitsFor: { ...WAITED_ON, title: "Review the docs" },
        });

        yield* at(START + 10 * MINUTE);
        expect(yield* Ref.get(dispatched)).toEqual([]);
        expect(yield* scheduler.list(THREAD_ID)).toEqual([wait]);
      }),
    ),
  );

  it.effect("tells a waiting thread when the other finishes a turn, quoting its reply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, setReplies } = yield* makeHarness();
        yield* setThread(thread({ id: OTHER_THREAD_ID, completedAt: START - MINUTE }));
        const wait = yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          target: WAITED_ON,
          title: "Review the docs",
          note: "Merge its branch.",
        });

        const finished = START + 5 * MINUTE;
        yield* setThread(thread({ id: OTHER_THREAD_ID, completedAt: finished }));
        yield* setReplies(OTHER_THREAD_ID, [
          message("assistant", "An answer from before the wait.", START - 2 * MINUTE),
          message("user", "Fix the docs.", START + MINUTE),
          message("assistant", "Docs fixed; see PR 12.", finished - 1_000),
          message("system", "Turn finished.", finished),
        ]);
        yield* at(finished + CheckInScheduler.CHECK_IN_IDLE_GRACE_MS);

        const all = yield* Ref.get(dispatched);
        expect(all[0]).toMatchObject({ threadId: THREAD_ID });
        expect(texts(all)).toEqual([
          waitNoticeText({
            title: "Review the docs",
            target: WAITED_ON,
            note: "Merge its branch.",
            outcome: { kind: "finished", reply: "Docs fixed; see PR 12." },
          }),
        ]);
        expect(records(all)).toEqual([
          [
            {
              version: 1,
              contextId: `check-in-${wait.id}-1`,
              label: "Thread finished",
              kind: CHECK_IN_CONTEXT_KIND,
              payload: { checkInId: wait.id, waitsFor: wait.waitsFor },
            },
          ],
        ]);
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("tells a waiting thread when the other was archived or deleted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread } = yield* makeHarness();
        yield* setThread(thread({ id: OTHER_THREAD_ID, running: true }));
        yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          target: WAITED_ON,
          title: "Review the docs",
          note: "",
        });

        yield* setThread(undefined, OTHER_THREAD_ID);
        yield* at(START + MINUTE);
        const [text] = texts(yield* Ref.get(dispatched));
        expect(text).toContain("was archived or deleted before it finished a turn.");
        expect(records(yield* Ref.get(dispatched))[0]?.[0]?.label).toBe("Stopped waiting");
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("stops waiting at the repeat limit, and says so", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread } = yield* makeHarness({
          checkInRepeatLimitHours: 2,
        });
        yield* setThread(thread({ id: OTHER_THREAD_ID, running: true }));
        const wait = yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          target: WAITED_ON,
          title: "Review the docs",
          note: "",
        });
        expect(wait.nextAt).toBe(iso(START + 120 * MINUTE));

        yield* at(START + 119 * MINUTE);
        expect(yield* Ref.get(dispatched)).toEqual([]);

        yield* at(START + 120 * MINUTE);
        expect(texts(yield* Ref.get(dispatched))).toEqual([
          waitNoticeText({
            title: "Review the docs",
            target: WAITED_ON,
            note: wait.note,
            outcome: { kind: "stopped-waiting", hours: 2 },
          }),
        ]);
        expect(records(yield* Ref.get(dispatched))[0]?.[0]?.label).toBe("Stopped waiting");
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("says it stopped waiting, not finished, for a thread still mid-turn at the limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, setReplies } = yield* makeHarness({
          checkInRepeatLimitHours: 1,
        });
        yield* setThread(thread({ id: OTHER_THREAD_ID, running: true }));
        yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          target: WAITED_ON,
          title: "Review the docs",
          note: "",
        });
        // A finished message partway through the turn is not the end of the turn.
        yield* setReplies(OTHER_THREAD_ID, [
          message("assistant", "Looking at the docs now.", START + 30 * MINUTE),
        ]);

        yield* at(START + 60 * MINUTE);
        const [text] = texts(yield* Ref.get(dispatched));
        expect(text).toContain("Stopped waiting for");
        expect(text).not.toContain("finished its turn");
        expect(text).not.toContain("Looking at the docs now.");
      }),
    ),
  );

  it.effect("reports a turn that finished before the limit as finished, though seen after", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, setReplies } = yield* makeHarness({
          checkInRepeatLimitHours: 1,
        });
        yield* setThread(thread({ id: OTHER_THREAD_ID, running: true }));
        const wait = yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          target: WAITED_ON,
          title: "Review the docs",
          note: "",
        });

        // It finishes halfway to the limit, and no sweep runs until an hour past it, as when the
        // server was down in between.
        const finished = START + 30 * MINUTE;
        yield* setThread(thread({ id: OTHER_THREAD_ID, completedAt: finished }));
        yield* setReplies(OTHER_THREAD_ID, [
          message("assistant", "Docs fixed; see PR 12.", finished - 1_000),
        ]);
        yield* at(START + 120 * MINUTE);

        expect(texts(yield* Ref.get(dispatched))).toEqual([
          waitNoticeText({
            title: "Review the docs",
            target: WAITED_ON,
            note: wait.note,
            outcome: { kind: "finished", reply: "Docs fixed; see PR 12." },
          }),
        ]);
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  // Its user messages carry its client's clock, which can be behind the server's.
  const quotesReplyAfterMoreTurns = (userClockSkewMs: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, setReplies } = yield* makeHarness();
        yield* setThread(thread({ running: true }));
        yield* setThread(thread({ id: OTHER_THREAD_ID, running: true }));
        const wait = yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          target: WAITED_ON,
          title: "Ship PR 42",
          note: "",
        });

        // It finishes while the waiting thread is busy, then runs three more turns.
        const finished = START + 5 * MINUTE;
        const later = (turn: number) => [
          message("user", `Request ${turn}`, finished + turn * MINUTE + userClockSkewMs),
          message("assistant", `Result ${turn}`, finished + turn * MINUTE + 1_000),
        ];
        yield* setThread(thread({ id: OTHER_THREAD_ID, completedAt: finished }));
        yield* setReplies(OTHER_THREAD_ID, [
          message("user", "Ship PR 42.", START + MINUTE),
          message("assistant", "Original result: PR 42 is ready.", finished - 1_000),
        ]);
        yield* at(finished + CheckInScheduler.CHECK_IN_IDLE_GRACE_MS);
        expect(yield* Ref.get(dispatched)).toEqual([]);

        yield* setReplies(OTHER_THREAD_ID, [
          message("user", "Ship PR 42.", START + MINUTE),
          message("assistant", "Original result: PR 42 is ready.", finished - 1_000),
          ...later(2),
          ...later(3),
          ...later(4),
        ]);
        yield* setThread(thread({ id: OTHER_THREAD_ID, completedAt: finished + 5 * MINUTE }));
        const idle = START + 20 * MINUTE;
        yield* setThread(thread({ completedAt: idle }));
        yield* at(idle + CheckInScheduler.CHECK_IN_IDLE_GRACE_MS);

        expect(texts(yield* Ref.get(dispatched))).toEqual([
          waitNoticeText({
            title: "Ship PR 42",
            target: WAITED_ON,
            note: wait.note,
            outcome: { kind: "finished", reply: "Original result: PR 42 is ready." },
          }),
        ]);
      }),
    );

  it.effect("quotes the reply that ended the turn after the other thread runs more turns", () =>
    quotesReplyAfterMoreTurns(0),
  );

  it.effect("quotes that reply when the other thread's client clock is behind", () =>
    quotesReplyAfterMoreTurns(-60 * MINUTE),
  );

  it.effect("does not count waits against a thread's check-ins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, setThread } = yield* makeHarness();
        yield* setThread(thread({ id: OTHER_THREAD_ID }));
        yield* Effect.replicateEffect(
          scheduler.scheduleWait({
            threadId: THREAD_ID,
            target: WAITED_ON,
            title: "Review the docs",
            note: "",
          }),
          3,
        );
        const schedule = scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check.",
          inMinutes: 10,
          repeatEveryMinutes: null,
        });
        yield* Effect.replicateEffect(schedule, 5);
        const sixth = yield* Effect.flip(schedule);
        expect(sixth.detail).toContain("already has 5 check-ins");
        expect(yield* scheduler.list(THREAD_ID)).toHaveLength(8);
      }),
    ),
  );
});
