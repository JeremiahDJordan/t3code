import {
  BackgroundCommandId,
  type CheckInId,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorCommandRejectedError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ThreadBackgroundCommands from "../persistence/ThreadBackgroundCommands.ts";
import * as ThreadCheckIns from "../persistence/ThreadCheckIns.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckInScheduler from "./CheckInScheduler.ts";
import { waitNoticeText } from "./waitMessage.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const OTHER_THREAD_ID = ThreadId.make("thread-2");
const START = Date.parse("2026-09-28T12:00:00.000Z");
const MINUTE = 60_000;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const utc = (ms: number) => DateTime.makeUnsafe(ms);

type MessageDispatch = Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>;

/** A thread whose last run finished at `completedAt`, or one still running. */
function thread(
  options: {
    readonly id?: ThreadId;
    readonly projectId?: ProjectId;
    readonly title?: string;
    readonly completedAt?: number;
    readonly running?: boolean;
    readonly pendingApproval?: boolean;
    /** The thread is a task delegated from this one. */
    readonly delegatedFrom?: ThreadId;
  } = {},
): OrchestrationV2ThreadShell {
  const completedAt = options.completedAt ?? START - MINUTE;
  const id = options.id ?? THREAD_ID;
  const runId = RunId.make(`run-${id}-${completedAt}`);
  return {
    id,
    projectId: options.projectId ?? PROJECT_ID,
    title: options.title ?? "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    branch: null,
    worktreePath: null,
    lineage:
      options.delegatedFrom === undefined
        ? { rootThreadId: id, parentThreadId: null, relationshipToParent: null }
        : {
            rootThreadId: options.delegatedFrom,
            parentThreadId: options.delegatedFrom,
            relationshipToParent: "subagent",
          },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: runId,
    latestRunRequestedAt: utc(completedAt - MINUTE),
    latestRunStartedAt: utc(completedAt - MINUTE),
    latestRunCompletedAt: options.running ? null : utc(completedAt),
    activeRunId: options.running ? runId : null,
    activityRunStatus: options.running ? "running" : options.pendingApproval ? "waiting" : null,
    status: options.running ? "running" : options.pendingApproval ? "waiting" : "completed",
    pendingRuntimeRequest: options.pendingApproval
      ? { id: "request-1" as never, kind: "command_approval" as never, createdAt: utc(START) }
      : null,
    latestVisibleMessage: null,
    latestUserMessageAt: utc(completedAt - MINUTE),
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    itemCount: 1,
    visibleItemCount: 1,
    createdAt: utc(START - 60 * MINUTE),
    updatedAt: utc(completedAt),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };
}

/** A finished run and the assistant reply it ended with, as the projection stores them. */
interface RecordedTurn {
  readonly run: OrchestrationV2Run;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}

function turn(threadId: ThreadId, completedAt: number, reply: string | null): RecordedTurn {
  const runId = RunId.make(`run-${threadId}-${completedAt}`);
  return {
    run: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      providerThreadId: null,
      userMessageId: MessageId.make(`user-${completedAt}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      requestedAt: utc(completedAt - MINUTE),
      startedAt: utc(completedAt - MINUTE),
      completedAt: utc(completedAt),
      checkpointId: null,
      contextHandoffId: null,
    },
    messages:
      reply === null
        ? []
        : [
            {
              createdBy: "agent",
              creationSource: "provider",
              id: MessageId.make(`assistant-${completedAt}`),
              threadId,
              runId,
              nodeId: null,
              role: "assistant",
              text: reply,
              attachments: [],
              streaming: false,
              createdAt: utc(completedAt - 1_000),
              updatedAt: utc(completedAt - 1_000),
            },
          ],
  };
}

const makeHarness = Effect.fn("makeCheckInHarness")(function* (
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) {
  const dispatched = yield* Ref.make<ReadonlyArray<MessageDispatch>>([]);
  // Runs during each dispatch, as a user's action landing while a delivery is in flight would.
  const duringDispatch = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const shells = yield* Ref.make(new Map([[THREAD_ID, thread()]]));
  const turns = yield* Ref.make(new Map<ThreadId, ReadonlyArray<RecordedTurn>>());
  // A check-in whose removal fails, as a database error or a crash mid-record would.
  const failRemoval = yield* Ref.make<CheckInId | null>(null);
  // A thread that refuses every message; the orchestrator's receipts remember each refusal.
  const refuseThread = yield* Ref.make<ThreadId | null>(null);
  const refused = yield* Ref.make<ReadonlySet<string>>(new Set());
  const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
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
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          // A command id already accepted is answered from its receipt and not run again, and one
          // refused is refused again, as the orchestrator's receipts ensure.
          dispatch: (command) =>
            Effect.gen(function* () {
              if ((yield* Ref.get(refused)).has(command.commandId)) {
                return yield* new OrchestratorCommandPreviouslyRejectedError({
                  commandId: command.commandId,
                  commandType: command.type,
                  detail: "Previously rejected.",
                });
              }
              if (command.type !== "message.dispatch") {
                return yield* Effect.die(`unexpected command ${command.type}`);
              }
              if (command.threadId === (yield* Ref.get(refuseThread))) {
                yield* Ref.update(refused, (all) => new Set([...all, command.commandId]));
                return yield* new OrchestratorCommandRejectedError({
                  commandId: command.commandId,
                  commandType: command.type,
                });
              }
              const accepted = yield* Ref.modify(dispatched, (all) =>
                all.some((earlier) => earlier.commandId === command.commandId)
                  ? [false, all]
                  : [true, [...all, command]],
              );
              if (accepted) yield* Effect.flatten(Ref.get(duringDispatch));
              return { sequence: 1, storedEvents: [] };
            }),
          getThreadShell: (threadId) =>
            Ref.get(shells).pipe(Effect.map((all) => all.get(threadId) ?? null)),
          getThreadRecords: ((threadId, _fields, filter) =>
            Effect.gen(function* () {
              const all = (yield* Ref.get(turns)).get(threadId) ?? [];
              const runIds = filter?.messageRunIds;
              return {
                thread: {} as never,
                runs: all.map((recorded) => recorded.run),
                messages: all
                  .flatMap((recorded) => recorded.messages)
                  .filter(
                    (message) =>
                      (runIds === undefined ||
                        (message.runId !== null && runIds.includes(message.runId))) &&
                      (filter?.messageRoles === undefined ||
                        filter.messageRoles.includes(message.role)),
                  ),
              };
            })) as ThreadManagementService.ThreadManagementServiceShape["getThreadRecords"],
          streamDomainEvents: Stream.fromQueue(domainEvents),
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
  const checkInRepository = Context.get(context, ThreadCheckIns.ThreadCheckInRepository);
  const at = (ms: number) => TestClock.setTime(ms).pipe(Effect.andThen(scheduler.runDueNow));
  const setThread = (
    shell: OrchestrationV2ThreadShell | undefined,
    threadId: ThreadId = shell?.id ?? THREAD_ID,
  ) =>
    Ref.update(shells, (all) => {
      const next = new Map(all);
      if (shell) next.set(shell.id, shell);
      else next.delete(threadId);
      return next;
    });
  const setTurns = (threadId: ThreadId, recorded: ReadonlyArray<RecordedTurn>) =>
    Ref.update(turns, (all) => new Map(all).set(threadId, recorded));
  return {
    scheduler,
    commands,
    checkInRepository,
    dispatched,
    at,
    setThread,
    setTurns,
    duringDispatch,
    failRemoval,
    refuseThread,
    domainEvents,
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

const texts = (commands: ReadonlyArray<MessageDispatch>) => commands.map((command) => command.text);

describe("CheckInScheduler", () => {
  it.effect("delivers a one-time check-in as a queued notification once the thread is idle", () =>
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
        expect(yield* Ref.get(dispatched)).toEqual([
          {
            type: "message.dispatch",
            commandId: CommandId.make(`server:check-in:${checkIn.id}:1`),
            threadId: THREAD_ID,
            messageId: MessageId.make(`check-in:${checkIn.id}:1`),
            text: "[T3 Code check-in] Check the desktop build.",
            attachments: [],
            notification: {
              source: { kind: "background_task" },
              outcome: "updated",
              summary: "Check-in: Check the desktop build.",
            },
            // Never steers or interrupts: it waits behind any turn that started meanwhile.
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
          },
        ]);
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
        expect(all[0]?.notification).toEqual({
          source: { kind: "background_task" },
          outcome: "updated",
          summary: "Check-in: Check the build. and 1 more",
          detail: "Check-in: Check the build.\nCheck-in: Check the deploy.",
        });
        // Named by its parts, sorted, so a retry after a crash is the same message.
        expect(String(all[0]?.commandId)).toBe(
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
        yield* setThread(thread({ id: OTHER_THREAD_ID }));
        const refusedCheckIn = yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the build.",
          inMinutes: 10,
          repeatEveryMinutes: null,
        });

        // The thread refuses the message, and recording that fails, so the check-in stays due.
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

  it.effect("waits while the thread works, needs the user, or is held by its usage limit", () =>
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
        // A message the user just sent that no run has picked up yet goes first.
        yield* setThread({
          ...thread({ completedAt: START + 6 * MINUTE }),
          latestUserMessageAt: utc(START + 7 * MINUTE),
        });
        yield* at(START + 7 * MINUTE);
        expect(yield* Ref.get(dispatched)).toEqual([]);
        expect((yield* scheduler.list(THREAD_ID))[0]?.dueSince).toBe(iso(START + MINUTE));
        // A thread stopped by its usage limit holds its notices until it resumes.
        yield* setThread({
          ...thread({ completedAt: START + 8 * MINUTE }),
          status: "failed",
          lastErrorClass: "usage_limit",
        });
        yield* at(START + 8 * MINUTE);
        expect(yield* Ref.get(dispatched)).toEqual([]);

        yield* setThread(thread({ completedAt: START + 9 * MINUTE }));
        yield* at(START + 9 * MINUTE);
        expect(texts(yield* Ref.get(dispatched))).toEqual(["[T3 Code check-in] Look again."]);
      }),
    ),
  );

  it.effect("delivers when a turn ends, without waiting for the timer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, setThread, domainEvents } = yield* makeHarness();
        /** Lets the forked timer and event stream run, then waits for the sweeps they queued. */
        const settle = Effect.gen(function* () {
          for (let round = 0; round < 50; round++) {
            yield* Effect.yieldNow;
            yield* scheduler.drain;
          }
        });
        yield* setThread(thread({ running: true }));
        yield* scheduler.start();
        yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Look again.",
          inMinutes: 1,
          repeatEveryMinutes: null,
        });
        // The timer's sweep finds it due while the thread works.
        yield* TestClock.setTime(START + MINUTE);
        yield* settle;
        expect(yield* Ref.get(dispatched)).toEqual([]);

        // The turn ends and no time passes: only the run's event can start the next sweep.
        const finished = START + MINUTE;
        yield* setThread(thread({ completedAt: finished }));
        yield* Queue.offer(domainEvents, {
          id: EventId.make("event-run-finished"),
          type: "run.updated",
          threadId: THREAD_ID,
          occurredAt: utc(finished),
          payload: turn(THREAD_ID, finished, null).run,
        });
        yield* settle;
        expect(texts(yield* Ref.get(dispatched))).toEqual(["[T3 Code check-in] Look again."]);
      }),
    ),
  );

  it.effect("drops an archived thread's check-ins when it hears of the archive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, domainEvents } = yield* makeHarness();
        yield* scheduler.start();
        yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the build.",
          inMinutes: 10,
          repeatEveryMinutes: null,
        });
        yield* Queue.offer(domainEvents, {
          id: EventId.make("event-archived"),
          type: "thread.archived",
          threadId: THREAD_ID,
          occurredAt: utc(START),
          payload: {} as never,
        });
        for (let round = 0; round < 50; round++) {
          if ((yield* scheduler.list(THREAD_ID)).length === 0) break;
          yield* Effect.yieldNow;
        }
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("drops the check-ins of a thread archived while no server heard it, on start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, setThread } = yield* makeHarness();
        yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the build.",
          inMinutes: 10,
          repeatEveryMinutes: null,
        });
        // Archived before this server's listener started, as across a restart.
        yield* setThread({ ...thread(), archivedAt: utc(START) });
        yield* scheduler.start();
        for (let round = 0; round < 50; round++) {
          if ((yield* scheduler.list(THREAD_ID)).length === 0) break;
          yield* Effect.yieldNow;
        }
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
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
        const all = yield* Ref.get(dispatched);
        const [first, last, ...more] = texts(all);
        expect(first).toContain("The next status update is in 30 minutes");
        expect(last).toContain(
          "This is the last status update: they end 1 hour after the command starts. You will still be told the moment it ends.",
        );
        expect(more).toEqual([]);
        expect(all[0]?.notification).toEqual({
          source: { kind: "command" },
          outcome: "updated",
          summary: 'Status of background command "vp run dev"',
        });
        expect(yield* commands.get(id)).toMatchObject({
          status: "running",
          nextStatusAt: null,
          statusNoticesSent: 2,
        });
      }),
    ),
  );

  it.effect("tells how a command ended first, and marks a failure on its row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, commands, dispatched, at } = yield* makeHarness();
        yield* scheduler.schedule({
          threadId: THREAD_ID,
          note: "Check the deploy.",
          inMinutes: 1,
          repeatEveryMinutes: null,
        });
        const row = runningCommand({ startedAt: START, nextStatusAt: START + 30 * MINUTE });
        yield* commands.insertIfUnder(row, 5);
        yield* commands.finish(row.id, {
          status: "exited",
          exitStatus: "exit 2",
          endedAt: iso(START + MINUTE),
          endNoticeSent: false,
        });

        yield* at(START + MINUTE);
        const [message] = yield* Ref.get(dispatched);
        expect(message?.text.indexOf("vp run dev")).toBeLessThan(
          message?.text.indexOf("[T3 Code check-in]") ?? -1,
        );
        expect(message?.notification).toEqual({
          source: { kind: "background_task" },
          outcome: "failed",
          summary: 'Background command "vp run dev" failed (exit 2) and 1 more',
          detail: 'Background command "vp run dev" failed (exit 2)\nCheck-in: Check the deploy.',
        });
        expect((yield* commands.get(row.id))?.endNoticeSent).toBe(true);
      }),
    ),
  );

  it.effect("sends only the notices that fit the provider's input, and the rest next turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, checkInRepository, dispatched, at, setThread } = yield* makeHarness();
        // More due at once than one turn's input holds; only the server could store this many.
        const count = Math.ceil(PROVIDER_SEND_TURN_MAX_INPUT_CHARS / 2_000) + 5;
        yield* Effect.forEach(
          Array.from({ length: count }, (_, index) => index),
          (index) =>
            checkInRepository.insert({
              id: `ci-${String(index).padStart(3, "0")}` as CheckInId,
              threadId: THREAD_ID,
              note: "x".repeat(2_000),
              repeatEveryMinutes: null,
              nextAt: iso(START + MINUTE),
              endsAt: null,
              dueSince: null,
              deliveredCount: 0,
              createdAt: iso(START),
            }),
        );

        yield* at(START + MINUTE);
        const [first] = texts(yield* Ref.get(dispatched));
        expect(first?.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
        const left = (yield* scheduler.list(THREAD_ID)).length;
        expect(left).toBeGreaterThan(0);

        // The turn that message started ends, and the rest go in the next.
        yield* setThread(thread({ completedAt: START + 5 * MINUTE }));
        yield* at(START + 5 * MINUTE);
        expect(yield* Ref.get(dispatched)).toHaveLength(2);
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
        yield* setThread({ ...thread(), archivedAt: utc(START) });
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

describe("CheckInScheduler waits", () => {
  const TITLE = "Review the docs";

  it.effect("does not count a turn that finished before the wait began", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread } = yield* makeHarness();
        yield* setThread(
          thread({ id: OTHER_THREAD_ID, title: TITLE, completedAt: START - MINUTE }),
        );
        const wait = yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          targetThreadId: OTHER_THREAD_ID,
          note: "",
        });
        expect(wait).toMatchObject({
          note: 'Wait for "Review the docs" to finish its turn.',
          repeatEveryMinutes: null,
          nextAt: iso(START + 24 * 60 * MINUTE),
          waitsFor: { threadId: OTHER_THREAD_ID, title: TITLE },
        });

        yield* at(START + 10 * MINUTE);
        expect(yield* Ref.get(dispatched)).toEqual([]);
        expect(yield* scheduler.list(THREAD_ID)).toEqual([wait]);
      }),
    ),
  );

  it.effect(
    "refuses check-ins and waits from a delegated task, whose answer its turn's end takes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(START);
          const { scheduler, setThread } = yield* makeHarness();
          yield* setThread(thread({ id: OTHER_THREAD_ID, delegatedFrom: THREAD_ID }));
          const checkIn = yield* Effect.flip(
            scheduler.schedule({
              threadId: OTHER_THREAD_ID,
              note: "Check the tests.",
              inMinutes: 5,
              repeatEveryMinutes: null,
            }),
          );
          expect(checkIn.detail).toContain("delegated task");
          const wait = yield* Effect.flip(
            scheduler.scheduleWait({
              threadId: OTHER_THREAD_ID,
              targetThreadId: THREAD_ID,
              note: "",
            }),
          );
          expect(wait.detail).toContain("t3_thread_wait");
          expect(yield* scheduler.list(OTHER_THREAD_ID)).toEqual([]);
        }),
      ),
  );

  it.effect("refuses a wait on itself or on another project's thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, setThread } = yield* makeHarness();
        yield* setThread(
          thread({ id: OTHER_THREAD_ID, projectId: ProjectId.make("project-elsewhere") }),
        );
        const self = yield* Effect.flip(
          scheduler.scheduleWait({ threadId: THREAD_ID, targetThreadId: THREAD_ID, note: "" }),
        );
        expect(self.detail).toBe("A thread cannot wait for itself.");
        const elsewhere = yield* Effect.flip(
          scheduler.scheduleWait({
            threadId: THREAD_ID,
            targetThreadId: OTHER_THREAD_ID,
            note: "",
          }),
        );
        expect(elsewhere.detail).toContain("not in this project");
      }),
    ),
  );

  it.effect("tells a waiting thread when the other finishes a turn, quoting its reply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, setTurns } = yield* makeHarness();
        yield* setThread(thread({ id: OTHER_THREAD_ID, title: TITLE, running: true }));
        const wait = yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          targetThreadId: OTHER_THREAD_ID,
          note: "Merge its branch.",
        });

        const finished = START + 5 * MINUTE;
        yield* setThread(thread({ id: OTHER_THREAD_ID, title: TITLE, completedAt: finished }));
        yield* setTurns(OTHER_THREAD_ID, [
          turn(OTHER_THREAD_ID, START - 2 * MINUTE, "An answer from before the wait."),
          turn(OTHER_THREAD_ID, finished, "Docs fixed; see PR 12."),
        ]);
        yield* at(finished);

        const all = yield* Ref.get(dispatched);
        expect(all[0]).toMatchObject({
          threadId: THREAD_ID,
          commandId: `server:check-in:${wait.id}:1`,
          notification: {
            source: { kind: "background_task" },
            outcome: "completed",
            summary: '"Review the docs" finished its turn',
          },
        });
        expect(texts(all)).toEqual([
          waitNoticeText({
            title: TITLE,
            threadId: OTHER_THREAD_ID,
            note: "Merge its branch.",
            outcome: { kind: "finished", reply: "Docs fixed; see PR 12.", status: "completed" },
          }),
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
        yield* setThread(thread({ id: OTHER_THREAD_ID, title: TITLE, running: true }));
        yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          targetThreadId: OTHER_THREAD_ID,
          note: "",
        });

        yield* setThread(undefined, OTHER_THREAD_ID);
        yield* at(START + MINUTE);
        const [message] = yield* Ref.get(dispatched);
        expect(message?.text).toContain("was archived or deleted before it finished a turn.");
        expect(message?.notification?.summary).toBe('"Review the docs" was archived or deleted');
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("quotes a turn the other finished before it was archived", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, setTurns } = yield* makeHarness();
        yield* setThread(thread({ id: OTHER_THREAD_ID, title: TITLE, running: true }));
        yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          targetThreadId: OTHER_THREAD_ID,
          note: "",
        });
        const finishedNotice = waitNoticeText({
          title: TITLE,
          threadId: OTHER_THREAD_ID,
          note: "",
          outcome: { kind: "finished", reply: "Docs fixed; see PR 12.", status: "completed" },
        });

        // The waiting thread is busy when the other finishes, so the wait keeps its result.
        yield* setThread(thread({ running: true }));
        const finished = START + 5 * MINUTE;
        const done = thread({ id: OTHER_THREAD_ID, title: TITLE, completedAt: finished });
        yield* setThread(done);
        yield* setTurns(OTHER_THREAD_ID, [
          turn(OTHER_THREAD_ID, finished, "Docs fixed; see PR 12."),
        ]);
        yield* at(finished);
        expect(yield* Ref.get(dispatched)).toEqual([]);
        // Then the other is archived, and only then is the waiting thread free.
        yield* setThread({ ...done, archivedAt: utc(finished + MINUTE) });
        yield* setThread(thread());
        yield* at(finished + 2 * MINUTE);
        expect(texts(yield* Ref.get(dispatched))).toEqual([finishedNotice]);

        // Finished and archived before any sweep saw it finish: the same.
        const later = yield* makeHarness();
        yield* later.setThread(thread({ id: OTHER_THREAD_ID, title: TITLE, running: true }));
        yield* later.scheduler.scheduleWait({
          threadId: THREAD_ID,
          targetThreadId: OTHER_THREAD_ID,
          note: "",
        });
        const finishedLater = finished + 10 * MINUTE;
        yield* later.setThread({
          ...thread({ id: OTHER_THREAD_ID, title: TITLE, completedAt: finishedLater }),
          archivedAt: utc(finishedLater + MINUTE),
        });
        yield* later.setTurns(OTHER_THREAD_ID, [
          turn(OTHER_THREAD_ID, finishedLater, "Docs fixed; see PR 12."),
        ]);
        yield* later.at(finishedLater + 2 * MINUTE);
        expect(texts(yield* Ref.get(later.dispatched))).toEqual([finishedNotice]);
      }),
    ),
  );

  it.effect("does not report a thread archived and restored as having finished", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, setTurns } = yield* makeHarness();
        // Its last turn ended before the wait began.
        const idle = thread({ id: OTHER_THREAD_ID, title: TITLE, completedAt: START - MINUTE });
        yield* setThread(idle);
        yield* setTurns(OTHER_THREAD_ID, [
          turn(OTHER_THREAD_ID, START - MINUTE, "An answer from before the wait."),
        ]);
        yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          targetThreadId: OTHER_THREAD_ID,
          note: "",
        });
        // The waiting thread is busy while the other is archived, and then restored.
        yield* setThread(thread({ running: true }));
        yield* setThread({ ...idle, archivedAt: utc(START + MINUTE) });
        yield* at(START + 2 * MINUTE);
        yield* setThread(idle);
        yield* setThread(thread());
        yield* at(START + 3 * MINUTE);
        const [message] = yield* Ref.get(dispatched);
        expect(message?.text).toContain("was archived or deleted before it finished a turn.");
      }),
    ),
  );

  it.effect("reports a turn the other finished once restored after an archive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, setTurns } = yield* makeHarness();
        const idle = thread({ id: OTHER_THREAD_ID, title: TITLE, completedAt: START - MINUTE });
        yield* setThread(idle);
        yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          targetThreadId: OTHER_THREAD_ID,
          note: "",
        });
        // Archived while the waiting thread is busy, then restored to finish a turn.
        yield* setThread(thread({ running: true }));
        yield* setThread({ ...idle, archivedAt: utc(START + MINUTE) });
        yield* at(START + 2 * MINUTE);
        const finished = START + 3 * MINUTE;
        yield* setThread(thread({ id: OTHER_THREAD_ID, title: TITLE, completedAt: finished }));
        yield* setTurns(OTHER_THREAD_ID, [turn(OTHER_THREAD_ID, finished, "Restored and done.")]);
        yield* setThread(thread());
        yield* at(START + 4 * MINUTE);
        const [message] = yield* Ref.get(dispatched);
        expect(message?.text).toContain("finished its turn.");
        expect(message?.text).toContain("Restored and done.");
      }),
    ),
  );

  it.effect("does not count a turn the restored thread finished after the wait's end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, setTurns } = yield* makeHarness({
          checkInRepeatLimitHours: 1,
        });
        const idle = thread({ id: OTHER_THREAD_ID, title: TITLE, completedAt: START - MINUTE });
        yield* setThread(idle);
        yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          targetThreadId: OTHER_THREAD_ID,
          note: "",
        });
        yield* setThread(thread({ running: true }));
        yield* setThread({ ...idle, archivedAt: utc(START + MINUTE) });
        yield* at(START + 2 * MINUTE);
        // Restored, it finishes a turn only after the hour the wait lasts.
        const finished = START + 120 * MINUTE;
        yield* setThread(thread({ id: OTHER_THREAD_ID, title: TITLE, completedAt: finished }));
        yield* setTurns(OTHER_THREAD_ID, [turn(OTHER_THREAD_ID, finished, "Too late.")]);
        yield* setThread(thread({ running: true, completedAt: START + 121 * MINUTE }));
        yield* at(finished);
        yield* setThread(thread({ completedAt: START + 121 * MINUTE }));
        yield* at(START + 121 * MINUTE);
        const [message] = yield* Ref.get(dispatched);
        expect(message?.text).toContain("was archived or deleted before it finished a turn.");
      }),
    ),
  );

  it.effect("says when the turn the other ended failed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, setTurns } = yield* makeHarness();
        yield* setThread(thread({ id: OTHER_THREAD_ID, title: TITLE, running: true }));
        yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          targetThreadId: OTHER_THREAD_ID,
          note: "",
        });
        const ended = START + 5 * MINUTE;
        const failed = turn(OTHER_THREAD_ID, ended, null);
        yield* setThread(thread({ id: OTHER_THREAD_ID, title: TITLE, completedAt: ended }));
        yield* setTurns(OTHER_THREAD_ID, [{ ...failed, run: { ...failed.run, status: "failed" } }]);
        yield* at(ended);
        const [message] = yield* Ref.get(dispatched);
        expect(message?.notification).toMatchObject({
          outcome: "failed",
          summary: '"Review the docs" ended its turn with an error',
        });
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
        yield* setThread(thread({ id: OTHER_THREAD_ID, title: TITLE, running: true }));
        const wait = yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          targetThreadId: OTHER_THREAD_ID,
          note: "",
        });
        expect(wait.nextAt).toBe(iso(START + 120 * MINUTE));

        yield* at(START + 119 * MINUTE);
        expect(yield* Ref.get(dispatched)).toEqual([]);

        yield* at(START + 120 * MINUTE);
        expect(texts(yield* Ref.get(dispatched))).toEqual([
          waitNoticeText({
            title: TITLE,
            threadId: OTHER_THREAD_ID,
            note: wait.note,
            outcome: { kind: "stopped-waiting", hours: 2 },
          }),
        ]);
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("says it stopped waiting, not finished, for a thread still mid-turn at the limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, setTurns } = yield* makeHarness({
          checkInRepeatLimitHours: 1,
        });
        yield* setThread(thread({ id: OTHER_THREAD_ID, title: TITLE, running: true }));
        yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          targetThreadId: OTHER_THREAD_ID,
          note: "",
        });
        // An earlier run's reply is not the end of the turn still running.
        yield* setTurns(OTHER_THREAD_ID, [
          turn(OTHER_THREAD_ID, START - MINUTE, "Looking at the docs now."),
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
        const { scheduler, dispatched, at, setThread, setTurns } = yield* makeHarness({
          checkInRepeatLimitHours: 1,
        });
        yield* setThread(thread({ id: OTHER_THREAD_ID, title: TITLE, running: true }));
        const wait = yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          targetThreadId: OTHER_THREAD_ID,
          note: "",
        });

        // It finishes halfway to the limit, and no sweep runs until an hour past it, as when the
        // server was down in between.
        const finished = START + 30 * MINUTE;
        yield* setThread(thread({ id: OTHER_THREAD_ID, title: TITLE, completedAt: finished }));
        yield* setTurns(OTHER_THREAD_ID, [
          turn(OTHER_THREAD_ID, finished, "Docs fixed; see PR 12."),
        ]);
        yield* at(START + 120 * MINUTE);

        expect(texts(yield* Ref.get(dispatched))).toEqual([
          waitNoticeText({
            title: TITLE,
            threadId: OTHER_THREAD_ID,
            note: wait.note,
            outcome: { kind: "finished", reply: "Docs fixed; see PR 12.", status: "completed" },
          }),
        ]);
        expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("quotes the reply that ended the turn after the other thread runs more turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { scheduler, dispatched, at, setThread, setTurns } = yield* makeHarness();
        yield* setThread(thread({ running: true }));
        yield* setThread(thread({ id: OTHER_THREAD_ID, title: "Ship PR 42", running: true }));
        const wait = yield* scheduler.scheduleWait({
          threadId: THREAD_ID,
          targetThreadId: OTHER_THREAD_ID,
          note: "",
        });

        // It finishes while the waiting thread is busy, then runs three more turns.
        const finished = START + 5 * MINUTE;
        yield* setThread(
          thread({ id: OTHER_THREAD_ID, title: "Ship PR 42", completedAt: finished }),
        );
        yield* setTurns(OTHER_THREAD_ID, [
          turn(OTHER_THREAD_ID, finished, "Original result: PR 42 is ready."),
        ]);
        yield* at(finished);
        expect(yield* Ref.get(dispatched)).toEqual([]);

        const later = [2, 3, 4].map((index) =>
          turn(OTHER_THREAD_ID, finished + index * MINUTE, `Result ${index}`),
        );
        yield* setTurns(OTHER_THREAD_ID, [
          turn(OTHER_THREAD_ID, finished, "Original result: PR 42 is ready."),
          ...later,
        ]);
        yield* setThread(
          thread({ id: OTHER_THREAD_ID, title: "Ship PR 42", completedAt: finished + 4 * MINUTE }),
        );
        const idle = START + 20 * MINUTE;
        yield* setThread(thread({ completedAt: idle }));
        yield* at(idle);

        expect(texts(yield* Ref.get(dispatched))).toEqual([
          waitNoticeText({
            title: "Ship PR 42",
            threadId: OTHER_THREAD_ID,
            note: wait.note,
            outcome: {
              kind: "finished",
              reply: "Original result: PR 42 is ready.",
              status: "completed",
            },
          }),
        ]);
      }),
    ),
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
            targetThreadId: OTHER_THREAD_ID,
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
