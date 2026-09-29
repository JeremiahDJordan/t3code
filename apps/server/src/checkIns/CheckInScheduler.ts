import {
  CHECK_IN_CONTEXT_KIND,
  CHECK_INS_PER_THREAD_MAX,
  CheckInError,
  CheckInId,
  CommandId,
  MessageId,
  OrchestrationMessageContext,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadCheckIn,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { threadHasQueuedTurnStart } from "../orchestration/ThreadSettlementPolicy.ts";
import * as ThreadCheckIns from "../persistence/ThreadCheckIns.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { checkInMessageText } from "./checkInMessage.ts";

export interface ScheduleCheckInInput {
  readonly threadId: ThreadId;
  readonly note: string;
  readonly inMinutes: number;
  /** Null for a one-time check-in. */
  readonly repeatEveryMinutes: number | null;
}

/**
 * Keeps the check-ins agents schedule and sends each into its thread as a new turn once it is
 * due and the thread is idle. It never interrupts a turn, and a repeat that falls due while an
 * earlier one is still waiting is skipped rather than queued behind it.
 */
export class CheckInScheduler extends Context.Service<
  CheckInScheduler,
  {
    readonly schedule: (input: ScheduleCheckInInput) => Effect.Effect<ThreadCheckIn, CheckInError>;
    /**
     * Whether a check-in with that id was scheduled. With `threadId`, only that thread's check-ins
     * can be cancelled, which is what an agent may do; the user may cancel any.
     */
    readonly cancel: (
      checkInId: CheckInId,
      threadId?: ThreadId,
    ) => Effect.Effect<boolean, CheckInError>;
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadCheckIn>, CheckInError>;
    /** A thread's check-ins: the whole list first, then again after every change. */
    readonly stream: (threadId: ThreadId) => Stream.Stream<ReadonlyArray<ThreadCheckIn>>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves once queued sweeps have run; tests wait on it instead of sleeping. */
    readonly drain: Effect.Effect<void>;
    /** Delivers whatever is due now and waits for it; the timer does this on its own. */
    readonly runDueNow: Effect.Effect<void>;
  }
>()("t3/checkIns/CheckInScheduler") {}

/**
 * How long a thread must have been idle before a check-in goes in, so a message the user queued
 * in their app for the end of the turn is sent first.
 */
export const CHECK_IN_IDLE_GRACE_MS = 3_000;
const SWEEP_INTERVAL = "15 seconds";

function timestampMs(value: string | null | undefined): number {
  if (value == null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function isoAt(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

/**
 * Whether the thread can take a check-in now: no turn running or about to start, nothing
 * waiting on the user, and idle for at least the grace period.
 */
export function threadReadyForCheckIn(shell: OrchestrationThreadShell, nowMs: number): boolean {
  const status = shell.session?.status;
  if (status === "starting" || status === "running") return false;
  if (shell.latestTurn?.state === "running") return false;
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (threadHasQueuedTurnStart(shell, isoAt(nowMs))) return false;
  const idleSince = Math.max(
    timestampMs(shell.latestTurn?.completedAt),
    timestampMs(shell.session?.updatedAt),
  );
  return nowMs - idleSince >= CHECK_IN_IDLE_GRACE_MS;
}

/** The first repeat after `nowMs`, skipping those that fell due while an earlier one waited. */
export function nextRepeatAt(nextAt: string, everyMinutes: number, nowMs: number): string {
  const everyMs = everyMinutes * 60_000;
  const from = Date.parse(nextAt);
  const skipped = Math.floor((nowMs - from) / everyMs) + 1;
  return isoAt(from + Math.max(1, skipped) * everyMs);
}

/** Marks what fell due by `nowMs`, and moves each repeating check-in's next time past it. */
export function advanceDueCheckIn(checkIn: ThreadCheckIn, nowMs: number): ThreadCheckIn {
  if (Date.parse(checkIn.nextAt) > nowMs) return checkIn;
  if (checkIn.repeatEveryMinutes === null) {
    return checkIn.dueSince === null ? { ...checkIn, dueSince: checkIn.nextAt } : checkIn;
  }
  return {
    ...checkIn,
    dueSince: checkIn.dueSince ?? checkIn.nextAt,
    nextAt: nextRepeatAt(checkIn.nextAt, checkIn.repeatEveryMinutes, nowMs),
  };
}

/** Whether this delivery is a check-in's last: one-time, or its next repeat is past its end. */
export function isLastDelivery(checkIn: ThreadCheckIn): boolean {
  return (
    checkIn.repeatEveryMinutes === null ||
    (checkIn.endsAt !== null && Date.parse(checkIn.nextAt) > Date.parse(checkIn.endsAt))
  );
}

const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

const make = Effect.gen(function* () {
  const repository = yield* ThreadCheckIns.ThreadCheckInRepository;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.unbounded<ThreadId>();

  const failure = (detail: string) => (cause: unknown) =>
    Effect.logWarning(detail, { cause }).pipe(Effect.andThen(new CheckInError({ detail })));

  const list: CheckInScheduler["Service"]["list"] = (threadId) =>
    repository
      .listByThread(threadId)
      .pipe(Effect.catch(failure("Could not read this thread's check-ins.")));

  const publish = (threadIds: Iterable<ThreadId>) =>
    Effect.forEach(threadIds, (threadId) => PubSub.publish(changes, threadId), { discard: true });

  const schedule: CheckInScheduler["Service"]["schedule"] = Effect.fn("CheckInScheduler.schedule")(
    function* (input) {
      const shell = yield* snapshots
        .getThreadShellById(input.threadId)
        .pipe(Effect.catch(failure("Could not read this thread.")));
      if (Option.isNone(shell)) {
        return yield* new CheckInError({ detail: "This thread is archived or no longer exists." });
      }
      const settings = yield* settingsService.getSettings.pipe(
        Effect.catch(failure("Could not read T3 Code's settings.")),
      );
      const resolved = resolveProjectSettings(settings, shell.value.projectId).settings;
      if (!resolved.enableAgentCheckIns) {
        return yield* new CheckInError({
          detail: "Check-ins are turned off for this project in T3 Code's settings.",
        });
      }
      const existing = yield* list(input.threadId);
      if (existing.length >= CHECK_INS_PER_THREAD_MAX) {
        return yield* new CheckInError({
          detail: `This thread already has ${CHECK_INS_PER_THREAD_MAX} check-ins. Cancel one first; list_scheduled shows them.`,
        });
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const checkIn: ThreadCheckIn = {
        id: CheckInId.make(`ci-${uuid}`),
        threadId: input.threadId,
        note: input.note.trim(),
        repeatEveryMinutes: input.repeatEveryMinutes,
        nextAt: isoAt(nowMs + input.inMinutes * 60_000),
        endsAt:
          input.repeatEveryMinutes === null
            ? null
            : isoAt(nowMs + resolved.checkInRepeatLimitHours * 3_600_000),
        dueSince: null,
        deliveredCount: 0,
        createdAt: isoAt(nowMs),
      };
      yield* repository.insert(checkIn).pipe(Effect.catch(failure("Could not save the check-in.")));
      yield* publish([input.threadId]);
      return checkIn;
    },
  );

  const cancel: CheckInScheduler["Service"]["cancel"] = Effect.fn("CheckInScheduler.cancel")(
    function* (checkInId, threadId) {
      const candidates = yield* (
        threadId === undefined ? repository.listAll : repository.listByThread(threadId)
      ).pipe(Effect.catch(failure("Could not read the check-ins.")));
      const checkIn = candidates.find((candidate) => candidate.id === checkInId);
      if (checkIn === undefined) return false;
      const removed = yield* repository
        .remove(checkInId)
        .pipe(Effect.catch(failure("Could not cancel the check-in.")));
      yield* publish([checkIn.threadId]);
      return removed;
    },
  );

  const stream: CheckInScheduler["Service"]["stream"] = (threadId) =>
    Stream.callback<ReadonlyArray<ThreadCheckIn>>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          // Subscribed before the first read, so a change in between is re-read, not missed.
          const current = () =>
            list(threadId).pipe(
              Effect.tap((checkIns) => Effect.sync(() => Queue.offerUnsafe(mailbox, checkIns))),
              Effect.ignore,
            );
          yield* current();
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === threadId),
            Stream.runForEach(current),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  /** Sends one due check-in into its thread and records the delivery. */
  const deliver = Effect.fn("CheckInScheduler.deliver")(function* (
    shell: OrchestrationThreadShell,
    checkIn: ThreadCheckIn,
    nowMs: number,
  ) {
    const delivery = checkIn.deliveredCount + 1;
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        // Fixed per delivery, so a retry after a crash between dispatch and the write below
        // is deduplicated by the engine instead of sending the check-in twice.
        commandId: CommandId.make(`server:check-in:${checkIn.id}:${delivery}`),
        threadId: shell.id,
        message: {
          messageId: MessageId.make(`check-in:${checkIn.id}:${delivery}`),
          role: "user",
          text: checkInMessageText(checkIn, nowMs),
          attachments: [],
          context: decodeMessageContext({
            version: 1,
            records: [
              {
                version: 1,
                contextId: `check-in-${checkIn.id}-${delivery}`,
                label: "Check-in",
                kind: CHECK_IN_CONTEXT_KIND,
                payload: { checkInId: checkIn.id },
              },
            ],
          }),
        },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdAt: isoAt(nowMs),
      })
      .pipe(
        // The thread refused the turn; retrying the same message would be refused again.
        Effect.catchTag("OrchestrationCommandInvariantError", (error) =>
          Effect.logWarning("check-in delivery refused", {
            checkInId: checkIn.id,
            detail: error.message,
          }),
        ),
      );
    yield* isLastDelivery(checkIn)
      ? repository.remove(checkIn.id).pipe(Effect.asVoid)
      : repository.update({ ...checkIn, dueSince: null, deliveredCount: delivery });
  });

  const sweep = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const rows = yield* repository.listAll;
    const changed = new Set<ThreadId>();
    const waiting = new Map<ThreadId, Array<ThreadCheckIn>>();
    for (const row of rows) {
      const advanced = advanceDueCheckIn(row, nowMs);
      if (advanced !== row) {
        yield* repository.update(advanced);
        changed.add(row.threadId);
      }
      if (advanced.dueSince !== null) {
        const due = waiting.get(row.threadId) ?? [];
        due.push(advanced);
        waiting.set(row.threadId, due);
      }
    }
    for (const [threadId, due] of waiting) {
      const shell = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(shell)) {
        // Archived or deleted while the check-in waited; the domain event normally got here first.
        yield* repository.removeByThread(threadId);
        changed.add(threadId);
        continue;
      }
      if (!threadReadyForCheckIn(shell.value, nowMs)) continue;
      // One per sweep: the delivery starts a turn, and the next waits until that one ends.
      const [first] = due.toSorted((a, b) => timestampMs(a.dueSince) - timestampMs(b.dueSince));
      if (first === undefined) continue;
      yield* deliver(shell.value, first, nowMs);
      changed.add(threadId);
    }
    yield* publish(changed);
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logWarning("check-in sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const worker = yield* makeDrainableWorker(() => sweep);

  const removeThread = (threadId: ThreadId) =>
    repository.removeByThread(threadId).pipe(
      Effect.andThen(publish([threadId])),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not remove a thread's check-ins", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const start: CheckInScheduler["Service"]["start"] = Effect.fn("CheckInScheduler.start")(
    function* () {
      const scope = yield* Effect.scope;
      const events = yield* engine.subscribeDomainEvents;
      const processEvent = (event: OrchestrationEvent) => {
        switch (event.type) {
          case "thread.archived":
          case "thread.deleted":
            return removeThread(event.payload.threadId);
          case "thread.session-set": {
            const status = event.payload.session.status;
            if (status === "running" || status === "starting") return Effect.void;
            // Look again once the grace period has passed, rather than at the next timer.
            return Effect.sleep(CHECK_IN_IDLE_GRACE_MS + 100).pipe(
              Effect.andThen(worker.enqueue(undefined)),
              Effect.forkIn(scope),
              Effect.asVoid,
            );
          }
        }
        return Effect.void;
      };
      yield* forkParked(
        worker
          .enqueue(undefined)
          .pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid),
      );
      yield* forkParked(Stream.runForEach(events, processEvent));
    },
  );

  return CheckInScheduler.of({
    schedule,
    cancel,
    list,
    stream,
    start,
    drain: worker.drain,
    runDueNow: worker.enqueue(undefined).pipe(Effect.andThen(worker.drain)),
  });
});

export const layer = Layer.effect(CheckInScheduler, make);
