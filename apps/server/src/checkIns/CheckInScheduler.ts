import {
  BACKGROUND_COMMAND_MATCH_NOTICE_MINUTES,
  CHECK_IN_WAITS_PER_THREAD_MAX,
  CHECK_INS_PER_THREAD_MAX,
  CheckInError,
  CheckInId,
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Notification,
  type OrchestrationV2ThreadShell,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { threadHasQueuedTurnStart } from "../orchestration-v2/ThreadSettlementService.ts";
import type {
  ThreadBackgroundCommandRepositoryError,
  ThreadCheckInRepositoryError,
} from "../persistence/Errors.ts";
import * as ThreadBackgroundCommands from "../persistence/ThreadBackgroundCommands.ts";
import * as ThreadCheckIns from "../persistence/ThreadCheckIns.ts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  backgroundCommandEndText,
  backgroundCommandMatchText,
  backgroundCommandStatusText,
  type NoticedMatches,
  type NoticedOutput,
} from "./backgroundCommandMessage.ts";
import {
  backgroundCommandMatchesPath,
  parseBackgroundCommandMatches,
} from "./backgroundCommandWrapper.ts";
import { checkInMessageText } from "./checkInMessage.ts";
import {
  defaultWaitNote,
  type WaitOutcome,
  type WaitTurnStatus,
  waitNoticeSummary,
  waitNoticeText,
} from "./waitMessage.ts";

export interface ScheduleCheckInInput {
  readonly threadId: ThreadId;
  readonly note: string;
  readonly inMinutes: number;
  /** Null for a one-time check-in. */
  readonly repeatEveryMinutes: number | null;
}

export interface ScheduleWaitInput {
  /** The thread that waits, and hears when the other one finishes. */
  readonly threadId: ThreadId;
  /** The thread waited on, in the same project. */
  readonly targetThreadId: ThreadId;
  readonly note: string;
}

/**
 * Keeps the check-ins agents schedule, and the waits they set on other threads, and sends what
 * is due into each thread as one notification turn once the thread is idle. It never interrupts
 * or steers a turn, and a repeat that falls due while an earlier one is still waiting is skipped
 * rather than queued behind it. Background commands' notices go out the same way.
 */
export class CheckInScheduler extends Context.Service<
  CheckInScheduler,
  {
    readonly schedule: (input: ScheduleCheckInInput) => Effect.Effect<ThreadCheckIn, CheckInError>;
    /**
     * A check-in that goes in when another thread of the project next finishes a turn, is
     * archived or deleted, or has not finished within the repeat limit.
     */
    readonly scheduleWait: (input: ScheduleWaitInput) => Effect.Effect<ThreadCheckIn, CheckInError>;
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
    /** Looks for due deliveries soon, without waiting; for a background command that ended. */
    readonly wake: Effect.Effect<void>;
  }
>()("t3/checkIns/CheckInScheduler") {}

const SWEEP_INTERVAL = "15 seconds";
/** How much of an output file's end a message may quote, whatever the line count asked for. */
const BACKGROUND_COMMAND_TAIL_MAX_BYTES = 4_096;
/** How much of the matches file one message reads, and how many matches it quotes. */
const MATCHES_READ_BYTES = 64 * 1024;
const MATCHES_SHOWN = 20;
/** The longest one-line summary a notice's row shows. */
const SUMMARY_MAX_CHARS = 120;

type NotificationOutcome = OrchestrationV2Notification["outcome"];

/** One part of a message from T3, and the record, once it is sent, that the agent was told. */
interface PreparedNotice {
  readonly key: string;
  /** What the agent reads. */
  readonly text: string;
  /** What the thread's notification row shows for this part. */
  readonly summary: string;
  readonly outcome: NotificationOutcome;
  /** Whether this part is about a background command, the one notification source it can name. */
  readonly command: boolean;
  readonly told: Effect.Effect<
    void,
    ThreadCheckInRepositoryError | ThreadBackgroundCommandRepositoryError
  >;
}

type CommandNotice = {
  readonly kind: "end" | "status" | "match";
  readonly row: ThreadBackgroundCommands.BackgroundCommandRow;
};

function timestampMs(value: string | null | undefined): number {
  if (value == null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function isoAt(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

function oneLine(text: string, max: number): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Whether the thread can take a notice now: no run active, queued or about to start, nothing
 * waiting on the user, and not archived or deleted.
 */
function threadReadyForCheckIn(shell: OrchestrationV2ThreadShell, nowMs: number): boolean {
  if (shell.archivedAt !== null || shell.deletedAt !== null) return false;
  if (shell.activeRunId !== null || shell.activityRunStatus != null) return false;
  if (shell.status === "queued") return false;
  if (shell.pendingRuntimeRequest !== null) return false;
  return !threadHasQueuedTurnStart(shell, nowMs);
}

/** The first repeat after `nowMs`, skipping those that fell due while an earlier one waited. */
function nextRepeatAt(nextAt: string, everyMinutes: number, nowMs: number): string {
  const everyMs = everyMinutes * 60_000;
  const from = Date.parse(nextAt);
  const skipped = Math.floor((nowMs - from) / everyMs) + 1;
  return isoAt(from + Math.max(1, skipped) * everyMs);
}

/** Marks what fell due by `nowMs`, and moves each repeating check-in's next time past it. */
function advanceDueCheckIn(checkIn: ThreadCheckIn, nowMs: number): ThreadCheckIn {
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

/**
 * When a running command's next status update is due, or null once it would fall past the
 * repeat limit, counted from the command's start as a check-in's is from when it was scheduled.
 */
function nextCommandStatusAt(
  row: Pick<
    ThreadBackgroundCommands.BackgroundCommandRow,
    "startedAt" | "statusEveryMinutes" | "nextStatusAt"
  >,
  limitHours: number,
  nowMs: number,
): string | null {
  if (row.statusEveryMinutes === null || row.nextStatusAt === null) return null;
  const next = nextRepeatAt(row.nextStatusAt, row.statusEveryMinutes, nowMs);
  return Date.parse(next) > Date.parse(row.startedAt) + limitHours * 3_600_000 ? null : next;
}

/** Whether this delivery is a check-in's last: one-time, or its next repeat is past its end. */
function isLastDelivery(checkIn: ThreadCheckIn): boolean {
  return (
    checkIn.repeatEveryMinutes === null ||
    (checkIn.endsAt !== null && Date.parse(checkIn.nextAt) > Date.parse(checkIn.endsAt))
  );
}

/** Failed beats stopped; completed only when every part completed; then updated. */
function combinedOutcome(outcomes: ReadonlyArray<NotificationOutcome>): NotificationOutcome {
  if (outcomes.includes("failed")) return "failed";
  if (outcomes.includes("cancelled")) return "cancelled";
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome === "completed")) {
    return "completed";
  }
  return outcomes.includes("updated") ? "updated" : "unknown";
}

/**
 * The notification row one message from T3 shows: a command source when every part is about a
 * background command, and otherwise a generic one, since older clients reject kinds they do
 * not know. The summary names the first part; the detail lists them all.
 */
function noticesNotification(
  notices: ReadonlyArray<Pick<PreparedNotice, "summary" | "outcome" | "command">>,
): OrchestrationV2Notification {
  const [first, ...rest] = notices;
  const summary =
    first === undefined
      ? "T3 Code notice"
      : rest.length === 0
        ? first.summary
        : `${oneLine(first.summary, SUMMARY_MAX_CHARS - 12)} and ${rest.length} more`;
  return {
    source:
      notices.length > 0 && notices.every((notice) => notice.command)
        ? { kind: "command" }
        : { kind: "background_task" },
    outcome: combinedOutcome(notices.map((notice) => notice.outcome)),
    summary,
    ...(rest.length === 0 ? {} : { detail: notices.map((notice) => notice.summary).join("\n") }),
  };
}

/**
 * The leading notices one turn can carry: as many as fit the provider's input. The rest stay
 * due. The first always goes, so the queue keeps moving.
 */
function noticesForOneTurn(notices: ReadonlyArray<PreparedNotice>): ReadonlyArray<PreparedNotice> {
  let length = 0;
  for (const [index, notice] of notices.entries()) {
    length += (index === 0 ? 0 : 2) + notice.text.length;
    if (index > 0 && length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) return notices.slice(0, index);
  }
  return notices;
}

/** How a command's end reads on its notification row, by how it ended. */
function commandEndOutcome(
  row: ThreadBackgroundCommands.BackgroundCommandRow,
): NotificationOutcome {
  switch (row.status) {
    case "stopped":
      return "cancelled";
    case "lost":
    case "running":
      return "unknown";
    case "exited":
      return row.exitStatus === "exit 0" ? "completed" : "failed";
  }
}

function commandEndSummary(row: ThreadBackgroundCommands.BackgroundCommandRow): string {
  const name = `"${oneLine(row.command, 60)}"`;
  switch (row.status) {
    case "stopped":
      return `Background command ${name} was stopped`;
    case "lost":
    case "running":
      return `Background command ${name} is no longer running`;
    case "exited":
      return row.exitStatus === "exit 0"
        ? `Background command ${name} finished`
        : `Background command ${name} failed (${row.exitStatus ?? "exit unknown"})`;
  }
}

const make = Effect.gen(function* () {
  const repository = yield* ThreadCheckIns.ThreadCheckInRepository;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const commands = yield* ThreadBackgroundCommands.ThreadBackgroundCommandRepository;
  const commandChanges = yield* ThreadBackgroundCommands.BackgroundCommandChanges;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  // Creating a thread's check-ins and removing them when it goes away take turns per thread.
  const lifecycle = yield* KeyedLock.make<ThreadId>();
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<ThreadId>();

  const failure = (detail: string) => (cause: unknown) =>
    Effect.logWarning(detail, { cause }).pipe(Effect.andThen(new CheckInError({ detail })));

  const list: CheckInScheduler["Service"]["list"] = (threadId) =>
    repository
      .listByThread(threadId)
      .pipe(Effect.catch(failure("Could not read this thread's check-ins.")));

  const publish = (threadIds: Iterable<ThreadId>) =>
    Effect.forEach(threadIds, (threadId) => PubSub.publish(changes, threadId), { discard: true });

  /** The thread an agent schedules for, with its project's settings, when it can take any. */
  const openThread = Effect.fn("CheckInScheduler.openThread")(function* (threadId: ThreadId) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.catch(failure("Could not read this thread.")));
    if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) {
      return yield* new CheckInError({ detail: "This thread is archived or no longer exists." });
    }
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catch(failure("Could not read T3 Code's settings.")),
    );
    const resolved = resolveProjectSettings(settings, shell.projectId).settings;
    if (!resolved.enableAgentCheckIns) {
      return yield* new CheckInError({
        detail: "Check-ins are turned off for this project in T3 Code's settings.",
      });
    }
    return { shell, settings: resolved };
  });

  const schedule: CheckInScheduler["Service"]["schedule"] = Effect.fn("CheckInScheduler.schedule")(
    function* (input) {
      // Under the thread's lock, so archiving cannot clear its check-ins between the look and the save.
      return yield* lifecycle.withLock(
        input.threadId,
        Effect.gen(function* () {
          const { settings } = yield* openThread(input.threadId);
          const existing = (yield* list(input.threadId)).filter(
            (checkIn) => checkIn.waitsFor === undefined,
          );
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
                : isoAt(nowMs + settings.checkInRepeatLimitHours * 3_600_000),
            dueSince: null,
            deliveredCount: 0,
            createdAt: isoAt(nowMs),
          };
          yield* repository
            .insert(checkIn)
            .pipe(Effect.catch(failure("Could not save the check-in.")));
          yield* publish([input.threadId]);
          return checkIn;
        }),
      );
    },
  );

  const scheduleWait: CheckInScheduler["Service"]["scheduleWait"] = Effect.fn(
    "CheckInScheduler.scheduleWait",
  )(function* (input) {
    // Under the thread's lock, as `schedule` is.
    return yield* lifecycle.withLock(
      input.threadId,
      Effect.gen(function* () {
        const { shell, settings } = yield* openThread(input.threadId);
        if (input.targetThreadId === input.threadId) {
          return yield* new CheckInError({ detail: "A thread cannot wait for itself." });
        }
        const target = yield* threads
          .getThreadShell(input.targetThreadId)
          .pipe(Effect.catch(failure("Could not read that thread.")));
        // Waits reach only the caller's project, as T3's thread tools do.
        if (
          target === null ||
          target.projectId !== shell.projectId ||
          target.archivedAt !== null ||
          target.deletedAt !== null
        ) {
          return yield* new CheckInError({
            detail: "That thread is not in this project, is archived, or no longer exists.",
          });
        }
        const waits = (yield* list(input.threadId)).filter(
          (checkIn) => checkIn.waitsFor !== undefined,
        );
        if (waits.length >= CHECK_IN_WAITS_PER_THREAD_MAX) {
          return yield* new CheckInError({
            detail: `This thread already waits on ${CHECK_IN_WAITS_PER_THREAD_MAX} threads. Cancel a wait first; list_scheduled shows them.`,
          });
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const checkIn: ThreadCheckIn = {
          id: CheckInId.make(`ci-${uuid}`),
          threadId: input.threadId,
          note: input.note.trim() || defaultWaitNote(target.title),
          repeatEveryMinutes: null,
          // When it stops waiting; it goes in sooner once the other thread finishes a turn.
          nextAt: isoAt(nowMs + settings.checkInRepeatLimitHours * 3_600_000),
          endsAt: null,
          dueSince: null,
          deliveredCount: 0,
          createdAt: isoAt(nowMs),
          waitsFor: { threadId: target.id, title: target.title },
        };
        yield* repository.insert(checkIn).pipe(Effect.catch(failure("Could not save the wait.")));
        yield* publish([input.threadId]);
        return checkIn;
      }),
    );
  });

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

  /**
   * Sends what is due for a thread as one notification message from T3, queued behind any
   * active turn so it never steers one, then records each part as told, all or none. The ids
   * are fixed by the parts, so a retry of the same parts after a crash or failure between the
   * dispatch and the records is answered from the orchestrator's receipt instead of arriving
   * twice.
   */
  const deliverNotices = (threadId: ThreadId, notices: ReadonlyArray<PreparedNotice>) =>
    Effect.gen(function* () {
      const [only] = notices;
      if (only === undefined) return;
      const key =
        notices.length === 1
          ? only.key
          : `notices:${notices
              .map((notice) => notice.key)
              .toSorted()
              .join("+")}`;
      const refused = (detail: string) =>
        Effect.logWarning("check-in delivery refused", { key, detail });
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:${key}`),
          threadId,
          messageId: MessageId.make(key),
          text: notices.map((notice) => notice.text).join("\n\n"),
          attachments: [],
          notification: noticesNotification(notices),
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.asVoid,
          // The thread refused the message, now or on an earlier try whose record failed; the
          // same message would be refused again, so its parts are recorded as told.
          Effect.catchTags({
            OrchestratorCommandRejectedError: (error) => refused(error.message),
            OrchestratorCommandPreviouslyRejectedError: (error) => refused(error.message),
            OrchestratorSubagentThreadReadOnlyError: (error) => refused(error.message),
          }),
        );
      // Together, so a failed record keeps every part due and the retry is the same message.
      yield* sql.withTransaction(
        Effect.forEach(notices, (notice) => notice.told, { discard: true }),
      );
    });

  /** A due check-in's part of a message, and its delivery record. */
  const prepareCheckIn = (checkIn: ThreadCheckIn, nowMs: number): PreparedNotice => {
    const delivery = checkIn.deliveredCount + 1;
    return {
      key: `check-in:${checkIn.id}:${delivery}`,
      text: checkInMessageText(checkIn, nowMs),
      summary: `Check-in: ${oneLine(checkIn.note, SUMMARY_MAX_CHARS - 10)}`,
      outcome: "updated",
      command: false,
      told: isLastDelivery(checkIn)
        ? repository.remove(checkIn.id).pipe(Effect.asVoid)
        : repository.update({ ...checkIn, dueSince: null, deliveredCount: delivery }),
    };
  };

  /**
   * When a wait fell due: when its thread finished a turn since the wait began and is idle, now
   * if the thread is gone, or null while it has not. The finish time, not when a sweep saw it,
   * so a turn that ended before the wait's end time is never reported as a timeout, and one
   * that ended before its thread was archived is reported as finished.
   */
  const waitDueAt = (checkIn: ThreadCheckIn, nowMs: number) =>
    Effect.gen(function* () {
      const target = checkIn.waitsFor;
      if (target === undefined) return null;
      const shell = yield* threads.getThreadShell(target.threadId);
      if (shell === null || shell.deletedAt !== null) return nowMs;
      const completedAt =
        shell.latestRunCompletedAt == null
          ? Number.NEGATIVE_INFINITY
          : DateTime.toEpochMillis(shell.latestRunCompletedAt);
      if (shell.archivedAt !== null) {
        const finishedFirst =
          completedAt > timestampMs(checkIn.createdAt) &&
          completedAt <= DateTime.toEpochMillis(shell.archivedAt);
        return finishedFirst ? completedAt : nowMs;
      }
      return threadReadyForCheckIn(shell, nowMs) && completedAt > timestampMs(checkIn.createdAt)
        ? completedAt
        : null;
    });

  /**
   * The turn that ended a wait: the newest run of the thread that finished after the wait began
   * and by the time it fell due, how it ended, and the last finished reply it wrote; none when
   * no turn did.
   * Not one a turn started since wrote: the waiting thread can be busy long enough for its
   * target to run more turns.
   */
  const waitRun = Effect.fn("CheckInScheduler.waitRun")(function* (
    threadId: ThreadId,
    sinceMs: number,
    dueAtMs: number,
  ) {
    const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
    const completedMs = (run: (typeof runs)[number]) =>
      run.completedAt === null ? Number.NEGATIVE_INFINITY : DateTime.toEpochMillis(run.completedAt);
    const run = runs
      .filter((candidate) => completedMs(candidate) > sinceMs && completedMs(candidate) <= dueAtMs)
      .toSorted((left, right) => completedMs(right) - completedMs(left))[0];
    if (run === undefined) return undefined;
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageRunIds: [run.id],
      messageRoles: ["assistant"],
    });
    const reply = messages
      .filter((message) => !message.streaming && message.text.trim() !== "")
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
      )
      .at(-1)?.text;
    const status: WaitTurnStatus =
      run.status === "completed" || run.status === "failed" ? run.status : "cancelled";
    return { reply, status };
  });

  /**
   * A due wait's part of a message: why it ended, and for a thread that finished a turn, the
   * reply that ended it. A wait that fell due before its end time did so because its thread
   * finished a turn or went away; one due at its end time stopped waiting.
   */
  const prepareWait = Effect.fn("CheckInScheduler.prepareWait")(function* (
    checkIn: ThreadCheckIn,
    target: NonNullable<ThreadCheckIn["waitsFor"]>,
    nowMs: number,
  ) {
    const shell = yield* threads.getThreadShell(target.threadId);
    const since = timestampMs(checkIn.createdAt);
    const dueAt = timestampMs(checkIn.dueSince);
    const dueEarly = dueAt < timestampMs(checkIn.nextAt);
    // A turn the thread finished by the time the wait fell due ends it, whatever the thread's
    // state is now: archived after that turn it still finished. A wait that fell due when the
    // thread was archived first also counts a turn it finished once restored, by the wait's end
    // time; restored without one, it finished nothing. A deleted thread's records may be gone.
    const deleted = shell === null || shell.deletedAt !== null;
    const ended =
      dueEarly && !deleted
        ? ((yield* waitRun(target.threadId, since, dueAt)) ??
          (shell.archivedAt === null
            ? yield* waitRun(target.threadId, since, Math.min(nowMs, timestampMs(checkIn.nextAt)))
            : undefined))
        : undefined;
    const outcome: WaitOutcome =
      ended !== undefined
        ? { kind: "finished", reply: ended.reply, status: ended.status }
        : dueEarly
          ? { kind: "gone" }
          : {
              kind: "stopped-waiting",
              hours: Math.round((timestampMs(checkIn.nextAt) - since) / 3_600_000),
            };
    return {
      key: `check-in:${checkIn.id}:1`,
      text: waitNoticeText({
        title: target.title,
        threadId: target.threadId,
        note: checkIn.note,
        outcome,
      }),
      summary: waitNoticeSummary(target.title, outcome),
      outcome: outcome.kind === "finished" ? outcome.status : "unknown",
      command: false,
      told: repository.remove(checkIn.id).pipe(Effect.asVoid),
    } satisfies PreparedNotice;
  });

  /** A background command's output file as a message reports it. */
  const noticedOutput = (filePath: string, bytesBefore: number, tailLines: number) =>
    Effect.gen(function* () {
      const bytes = yield* fs.stat(filePath).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => 0),
      );
      const tail =
        tailLines > 0 && bytes > 0 ? yield* readTail(filePath, bytes, tailLines) : undefined;
      return { path: filePath, bytes, bytesBefore, tail } satisfies NoticedOutput;
    });

  /** The last `lines` lines within the file's last few KB, so one huge line cannot flood a turn. */
  const readTail = (filePath: string, bytes: number, lines: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const length = Math.min(bytes, BACKGROUND_COMMAND_TAIL_MAX_BYTES);
        const file = yield* fs.open(filePath, { flag: "r" });
        yield* file.seek(BigInt(bytes - length), "start");
        const chunk = yield* file.readAlloc(length);
        const all = (Option.isSome(chunk) ? new TextDecoder().decode(chunk.value) : "").split("\n");
        // Read from the middle of the file, the first line is partial.
        const whole = length < bytes ? all.slice(1) : all;
        while (whole.length > 0 && whole.at(-1) === "") whole.pop();
        return whole.slice(-lines).join("\n") || undefined;
      }),
    ).pipe(Effect.orElseSucceed(() => undefined));

  const matchesSize = (row: ThreadBackgroundCommands.BackgroundCommandRow) =>
    fs.stat(backgroundCommandMatchesPath(row.jobDir)).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );

  /**
   * The matches the agent has not heard about: the first ones to quote, and how far into the
   * matches file the message covers. A message that cannot quote them all points to the file
   * and covers it to the end, so a pattern that matches too much cannot flood the thread.
   */
  const readNewMatches = (row: ThreadBackgroundCommands.BackgroundCommandRow) =>
    Effect.gen(function* () {
      if (row.notifyOn === null) return undefined;
      const size = yield* matchesSize(row);
      if (size <= row.matchBytesNoticed) return undefined;
      const path = backgroundCommandMatchesPath(row.jobDir);
      const length = Math.min(size - row.matchBytesNoticed, MATCHES_READ_BYTES);
      const bytes = yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(path, { flag: "r" });
          yield* file.seek(BigInt(row.matchBytesNoticed), "start");
          return Option.getOrElse(yield* file.readAlloc(length), () => new Uint8Array());
        }),
      ).pipe(Effect.orElseSucceed(() => new Uint8Array()));
      // Only whole lines: the wrapper may be writing the last one.
      const end = bytes.lastIndexOf(10);
      if (end === -1) return undefined;
      const all = parseBackgroundCommandMatches(new TextDecoder().decode(bytes.subarray(0, end)));
      const readToEnd = row.matchBytesNoticed + length >= size;
      return {
        matches: {
          path,
          shown: all.slice(0, MATCHES_SHOWN),
          more: all.length > MATCHES_SHOWN || !readToEnd,
        } satisfies NoticedMatches,
        bytes: readToEnd ? row.matchBytesNoticed + end + 1 : size,
      };
    });

  /** Whether new matches are waiting and the last message about matches is far enough back. */
  const matchesDue = (row: ThreadBackgroundCommands.BackgroundCommandRow, nowMs: number) =>
    Effect.gen(function* () {
      if (row.notifyOn === null) return false;
      if (
        row.lastMatchNoticeAt !== null &&
        nowMs - Date.parse(row.lastMatchNoticeAt) < BACKGROUND_COMMAND_MATCH_NOTICE_MINUTES * 60_000
      ) {
        return false;
      }
      return (yield* matchesSize(row)) > row.matchBytesNoticed;
    });

  /** How a background command ended, as part of a message, and the record that it was told. */
  const prepareCommandEnd = Effect.fn("CheckInScheduler.prepareCommandEnd")(function* (
    row: ThreadBackgroundCommands.BackgroundCommandRow,
  ) {
    const stdout = yield* noticedOutput(row.stdoutPath, row.stdoutBytesNoticed, row.tailLines);
    const stderr = yield* noticedOutput(row.stderrPath, row.stderrBytesNoticed, row.tailLines);
    const found = yield* readNewMatches(row);
    return {
      key: `background-command:${row.id}:end`,
      text: backgroundCommandEndText(row, stdout, stderr, found?.matches),
      summary: commandEndSummary(row),
      outcome: commandEndOutcome(row),
      command: true,
      told: Effect.gen(function* () {
        if (found) yield* commands.recordEndMatches(row.id, found.bytes);
        yield* commands.markEndNoticeSent(row.id);
        yield* PubSub.publish(commandChanges, row.threadId);
      }),
    } satisfies PreparedNotice;
  });

  /**
   * A message about a running command: a status update, or new lines matching its pattern.
   * A status update also quotes new matches. Nothing is sent for a command that has in fact
   * just ended, whose end message says it all.
   */
  const prepareCommandUpdate = Effect.fn("CheckInScheduler.prepareCommandUpdate")(function* (
    row: ThreadBackgroundCommands.BackgroundCommandRow,
    shell: OrchestrationV2ThreadShell,
    nowMs: number,
    kind: "status" | "match",
  ) {
    const ended = yield* fs
      .exists(`${row.jobDir}/exit-status`)
      .pipe(Effect.orElseSucceed(() => false));
    if (ended) return undefined;
    const found = yield* readNewMatches(row);
    if (kind === "match" && found === undefined) return undefined;
    const stdout = yield* noticedOutput(row.stdoutPath, row.stdoutBytesNoticed, row.tailLines);
    const stderr = yield* noticedOutput(row.stderrPath, row.stderrBytesNoticed, row.tailLines);
    const status = kind === "status" || found === undefined;
    // Status updates stop at the same limit as repeating check-ins; the end message still comes.
    const limitHours = status
      ? resolveProjectSettings(yield* settingsService.getSettings, shell.projectId).settings
          .checkInRepeatLimitHours
      : undefined;
    const nextStatusAt =
      limitHours === undefined ? row.nextStatusAt : nextCommandStatusAt(row, limitHours, nowMs);
    const told = Effect.gen(function* () {
      yield* commands.recordNotice(row.id, {
        kind: status ? "status" : "match",
        nextStatusAt,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        matchBytes: found?.bytes ?? row.matchBytesNoticed,
        matchesAt: found ? isoAt(nowMs) : null,
      });
      yield* PubSub.publish(commandChanges, row.threadId);
    });
    const name = `"${oneLine(row.command, 60)}"`;
    return (
      status
        ? {
            key: `background-command:${row.id}:status:${row.statusNoticesSent + 1}`,
            text: backgroundCommandStatusText(
              { ...row, nextStatusAt },
              stdout,
              stderr,
              nowMs,
              found?.matches,
              nextStatusAt === null ? limitHours : undefined,
            ),
            summary: `Status of background command ${name}`,
            outcome: "updated",
            command: true,
            told,
          }
        : {
            key: `background-command:${row.id}:match:${row.matchNoticesSent + 1}`,
            text: backgroundCommandMatchText(row, stdout, stderr, nowMs, found.matches),
            summary: `Background command ${name} printed matching lines`,
            outcome: "updated",
            command: true,
            told,
          }
    ) satisfies PreparedNotice;
  });

  /** One thread's due notices, in the order the agent reads them, sent as one message. */
  const deliverToThread = Effect.fn("CheckInScheduler.deliverToThread")(function* (
    shell: OrchestrationV2ThreadShell,
    due: ReadonlyArray<CommandNotice>,
    checkIns: ReadonlyArray<ThreadCheckIn>,
    nowMs: number,
  ) {
    // Commands' ends first, then check-ins and waits in the order they fell due, then running
    // commands' status and matching lines.
    const notices: Array<PreparedNotice> = [];
    for (const notice of due) {
      if (notice.kind === "end") notices.push(yield* prepareCommandEnd(notice.row));
    }
    for (const checkIn of checkIns.toSorted(
      (a, b) => timestampMs(a.dueSince) - timestampMs(b.dueSince),
    )) {
      notices.push(
        checkIn.waitsFor === undefined
          ? prepareCheckIn(checkIn, nowMs)
          : yield* prepareWait(checkIn, checkIn.waitsFor, nowMs),
      );
    }
    for (const notice of due) {
      if (notice.kind === "end") continue;
      const prepared = yield* prepareCommandUpdate(notice.row, shell, nowMs, notice.kind);
      if (prepared) notices.push(prepared);
    }
    yield* deliverNotices(shell.id, noticesForOneTurn(notices));
  });

  const sweep = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const rows = yield* repository.listAll;
    const changed = new Set<ThreadId>();
    const waiting = new Map<ThreadId, Array<ThreadCheckIn>>();
    for (const row of rows) {
      // A wait goes in once its thread has finished a turn, or when it stops waiting. A target
      // that cannot be read now is looked at again on the next sweep.
      const waitDue =
        row.waitsFor !== undefined && row.dueSince === null
          ? yield* waitDueAt(row, nowMs).pipe(Effect.orElseSucceed(() => null))
          : null;
      const advanced =
        waitDue !== null ? { ...row, dueSince: isoAt(waitDue) } : advanceDueCheckIn(row, nowMs);
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
    // Background commands whose end the agent has not heard, and due status updates.
    const commandNotices = new Map<ThreadId, Array<CommandNotice>>();
    for (const row of yield* commands.listActive) {
      // A muted command still reports how it ended; its messages while it runs wait.
      const notice: CommandNotice | undefined =
        row.status !== "running"
          ? { kind: "end", row }
          : row.muted
            ? undefined
            : row.nextStatusAt !== null && Date.parse(row.nextStatusAt) <= nowMs
              ? { kind: "status", row }
              : (yield* matchesDue(row, nowMs))
                ? { kind: "match", row }
                : undefined;
      if (notice === undefined) continue;
      const due = commandNotices.get(row.threadId) ?? [];
      due.push(notice);
      commandNotices.set(row.threadId, due);
    }
    for (const threadId of new Set([...waiting.keys(), ...commandNotices.keys()])) {
      // One thread's failed read or delivery leaves its notices due and must not hold up others.
      yield* Effect.gen(function* () {
        const shell = yield* threads.getThreadShell(threadId);
        if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) {
          // Archived or deleted while the check-in waited; the domain event normally got here first.
          if (waiting.has(threadId)) {
            yield* lifecycle.withLock(threadId, repository.removeByThread(threadId));
            changed.add(threadId);
          }
          return;
        }
        if (!threadReadyForCheckIn(shell, nowMs)) return;
        // A thread stopped by its provider's usage limit holds its queue until it resumes; a
        // notice sent now would fail on the same limit, so it waits with the queue.
        if (shell.lastErrorClass === "usage_limit") return;
        const checkIns = waiting.get(threadId) ?? [];
        if (checkIns.length > 0) changed.add(threadId);
        yield* deliverToThread(shell, commandNotices.get(threadId) ?? [], checkIns, nowMs);
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("check-in delivery failed", { threadId, cause: Cause.pretty(cause) }),
        ),
      );
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
    lifecycle.withLock(threadId, repository.removeByThread(threadId)).pipe(
      Effect.andThen(publish([threadId])),
      // Threads waiting on this one hear that it went away.
      Effect.andThen(worker.enqueue(undefined)),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not remove a thread's check-ins", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  /**
   * Threads archived or deleted while no server listened, as across a restart, are told only by
   * their state. Run once the event stream is joined, so none slips between the two.
   */
  const removeCheckInsOfGoneThreads = Effect.gen(function* () {
    const threadIds = new Set((yield* repository.listAll).map((row) => row.threadId));
    for (const threadId of threadIds) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) {
        yield* removeThread(threadId);
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not remove check-ins of gone threads", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.archived":
      case "thread.deleted":
        return removeThread(event.threadId);
      case "run.updated":
        // A finished turn may leave its thread idle for what is due, or end a wait on it.
        return ThreadManagementService.isTerminalRunStatus(event.payload.status)
          ? worker.enqueue(undefined)
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  const start: CheckInScheduler["Service"]["start"] = Effect.fn("CheckInScheduler.start")(
    function* () {
      yield* forkParked(
        worker
          .enqueue(undefined)
          .pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid),
      );
      yield* forkParked(
        Effect.gen(function* () {
          yield* Stream.runForEach(threads.streamDomainEvents, processEvent).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("check-in event stream failed", { cause: Cause.pretty(cause) }),
            ),
            Effect.forkScoped,
          );
          yield* removeCheckInsOfGoneThreads;
        }),
      );
    },
  );

  return CheckInScheduler.of({
    schedule,
    scheduleWait,
    cancel,
    list,
    stream,
    start,
    drain: worker.drain,
    runDueNow: worker.enqueue(undefined).pipe(Effect.andThen(worker.drain)),
    wake: worker.enqueue(undefined).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(CheckInScheduler, make);
