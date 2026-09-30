import {
  AGENT_MESSAGE_CONTEXT_KIND,
  AGENT_THREAD_WAITS_PER_THREAD_MAX,
  BACKGROUND_COMMAND_MATCH_NOTICE_MINUTES,
  CHECK_IN_CONTEXT_KIND,
  CHECK_INS_PER_THREAD_MAX,
  COMPOSER_CONTEXT_MAX_RECORDS,
  CheckInError,
  CheckInId,
  CommandId,
  type EnvironmentId,
  MessageId,
  OrchestrationMessageContext,
  type OrchestrationEvent,
  type OrchestrationThreadDetailWindow,
  type OrchestrationThreadShell,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ThreadCheckIn,
  type ThreadId,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
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
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  agentMessageLabel,
  agentMessageText,
  defaultWaitNote,
  type WaitOutcome,
  waitNoticeLabel,
  waitNoticeText,
} from "../agentThreads/agentThreadMessage.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { threadHasQueuedTurnStart } from "../orchestration/ThreadSettlementPolicy.ts";
import * as AgentThreads from "../persistence/AgentThreads.ts";
import type {
  AgentThreadRepositoryError,
  ThreadBackgroundCommandRepositoryError,
  ThreadCheckInRepositoryError,
} from "../persistence/Errors.ts";
import * as ThreadBackgroundCommands from "../persistence/ThreadBackgroundCommands.ts";
import * as ThreadCheckIns from "../persistence/ThreadCheckIns.ts";
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
  readonly target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  /** The waited-on thread's title, as the waiting thread's rows and notice show it. */
  readonly title: string;
  readonly note: string;
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
     * A check-in that goes in when another thread next finishes a turn, is archived or deleted,
     * or has not finished within the repeat limit. Agent threads' `watch_thread` makes these.
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

/**
 * How long a thread must have been idle before a check-in goes in, so a message the user queued
 * in their app for the end of the turn is sent first.
 */
export const CHECK_IN_IDLE_GRACE_MS = 3_000;
const SWEEP_INTERVAL = "15 seconds";
/** How much of an output file's end a message may quote, whatever the line count asked for. */
const BACKGROUND_COMMAND_TAIL_MAX_BYTES = 4_096;

/** How much of the matches file one message reads, and how many matches it quotes. */
/** Older turns read per page, and pages at most, when looking back for a wait's reply. */
const WAIT_REPLY_PAGE_TURNS = 8;
const WAIT_REPLY_MAX_PAGES = 8;
const MATCHES_READ_BYTES = 64 * 1024;
const MATCHES_SHOWN = 20;

/** One part of a message from T3, and the record, once it is sent, that the agent was told. */
interface PreparedNotice {
  readonly key: string;
  readonly text: string;
  readonly label: string;
  readonly payload: Record<string, unknown>;
  /** The context record's kind and id; a check-in record keyed by `key` when absent. */
  readonly record?: { readonly kind: string; readonly contextId: string };
  readonly told: Effect.Effect<
    void,
    | ThreadCheckInRepositoryError
    | ThreadBackgroundCommandRepositoryError
    | AgentThreadRepositoryError
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

/**
 * When a running command's next status update is due, or null once it would fall past the
 * repeat limit, counted from the command's start as a check-in's is from when it was scheduled.
 */
export function nextCommandStatusAt(
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
export function isLastDelivery(checkIn: ThreadCheckIn): boolean {
  return (
    checkIn.repeatEveryMinutes === null ||
    (checkIn.endsAt !== null && Date.parse(checkIn.nextAt) > Date.parse(checkIn.endsAt))
  );
}

const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

/** The message one turn carries for `notices`: their texts, and a context record for each. */
function noticesMessage(notices: ReadonlyArray<PreparedNotice>) {
  return {
    text: notices.map((notice) => notice.text).join("\n\n"),
    context: decodeMessageContext({
      version: 1,
      records: notices.map((notice) => ({
        version: 1,
        contextId: notice.record?.contextId ?? notice.key.replace(/[^a-z0-9_-]/gi, "-"),
        label: notice.label,
        kind: notice.record?.kind ?? CHECK_IN_CONTEXT_KIND,
        payload: notice.payload,
      })),
    }),
  };
}

/**
 * The leading notices one turn can carry: a message's records at most, within the provider's
 * input as the provider reactor sends it, with the context links in the text expanded. The rest
 * stay due. The first always goes, so the queue keeps moving.
 */
function noticesForOneTurn(notices: ReadonlyArray<PreparedNotice>): ReadonlyArray<PreparedNotice> {
  const candidates = notices.slice(0, COMPOSER_CONTEXT_MAX_RECORDS);
  const { records } = noticesMessage(candidates).context;
  let text = "";
  for (const [index, notice] of candidates.entries()) {
    text = index === 0 ? notice.text : `${text}\n\n${notice.text}`;
    const providerInput = projectComposerContextForProvider({
      text,
      records: records.slice(0, index + 1),
    });
    if (index > 0 && providerInput.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
      return candidates.slice(0, index);
    }
  }
  return candidates;
}

const make = Effect.gen(function* () {
  const repository = yield* ThreadCheckIns.ThreadCheckInRepository;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const commands = yield* ThreadBackgroundCommands.ThreadBackgroundCommandRepository;
  const commandChanges = yield* ThreadBackgroundCommands.BackgroundCommandChanges;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const agentThreads = yield* AgentThreads.AgentThreadRepository;
  const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
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

  const scheduleWait: CheckInScheduler["Service"]["scheduleWait"] = Effect.fn(
    "CheckInScheduler.scheduleWait",
  )(function* (input) {
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
    const waits = (yield* list(input.threadId)).filter((checkIn) => checkIn.waitsFor !== undefined);
    if (waits.length >= AGENT_THREAD_WAITS_PER_THREAD_MAX) {
      return yield* new CheckInError({
        detail: `This thread already waits on ${AGENT_THREAD_WAITS_PER_THREAD_MAX} threads. Cancel a wait first; list_scheduled shows them.`,
      });
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const checkIn: ThreadCheckIn = {
      id: CheckInId.make(`ci-${uuid}`),
      threadId: input.threadId,
      note: input.note.trim() || defaultWaitNote(input.title),
      repeatEveryMinutes: null,
      // When it stops waiting; it goes in sooner once the other thread finishes a turn.
      nextAt: isoAt(nowMs + resolved.checkInRepeatLimitHours * 3_600_000),
      endsAt: null,
      dueSince: null,
      deliveredCount: 0,
      createdAt: isoAt(nowMs),
      waitsFor: { ...input.target, title: input.title },
    };
    yield* repository.insert(checkIn).pipe(Effect.catch(failure("Could not save the wait.")));
    yield* publish([input.threadId]);
    return checkIn;
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
   * Sends what is due for a thread as one message from T3, which starts one turn, then records
   * each part as told, all or none. The ids are fixed by the parts, so a retry of the same parts
   * after a crash or failure between the dispatch and the records is deduplicated by the engine
   * instead of arriving twice.
   */
  const deliverNotices = (
    shell: OrchestrationThreadShell,
    notices: ReadonlyArray<PreparedNotice>,
    nowMs: number,
  ) =>
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
      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`server:${key}`),
          threadId: shell.id,
          message: {
            messageId: MessageId.make(key),
            role: "user",
            ...noticesMessage(notices),
            attachments: [],
          },
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          createdAt: isoAt(nowMs),
        })
        .pipe(
          Effect.asVoid,
          // The thread refused the turn, now or on an earlier try whose record failed; the same
          // message would be refused again, so its parts are recorded as told.
          Effect.catchTag(
            ["OrchestrationCommandInvariantError", "OrchestrationCommandPreviouslyRejectedError"],
            (error) =>
              Effect.logWarning("check-in delivery refused", { key, detail: error.message }),
          ),
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
      label: "Check-in",
      payload: { checkInId: checkIn.id },
      told: isLastDelivery(checkIn)
        ? repository.remove(checkIn.id).pipe(Effect.asVoid)
        : repository.update({ ...checkIn, dueSince: null, deliveredCount: delivery }),
    };
  };

  /**
   * When a wait fell due: when its thread finished a turn since the wait began and went idle,
   * now if the thread is gone, or null while it has not. The finish time, not when a sweep saw
   * it, so a turn that ended before the wait's end time is never reported as a timeout. One in
   * another environment is never seen here; it goes in when the wait ends.
   */
  const waitDueAt = (checkIn: ThreadCheckIn, nowMs: number) =>
    Effect.gen(function* () {
      const target = checkIn.waitsFor;
      if (target === undefined || target.environmentId !== environmentId) return null;
      const shell = yield* snapshots.getThreadShellById(target.threadId);
      if (Option.isNone(shell)) return nowMs;
      const completedAt = timestampMs(shell.value.latestTurn?.completedAt);
      return threadReadyForCheckIn(shell.value, nowMs) &&
        completedAt > timestampMs(checkIn.createdAt)
        ? completedAt
        : null;
    });

  /**
   * The reply that ended a waited-on turn: the newest finished assistant message from when the
   * wait began to when the thread finished, not one written by a turn that has started since.
   * The waiting thread can be busy long enough for its target to run more turns, so this pages
   * back past them, up to `WAIT_REPLY_MAX_PAGES`.
   */
  const waitReply = Effect.fn("CheckInScheduler.waitReply")(function* (
    threadId: ThreadId,
    sinceMs: number,
    dueAtMs: number,
  ) {
    let window: OrchestrationThreadDetailWindow = { turnLimit: 2 };
    for (let page = 0; page < WAIT_REPLY_MAX_PAGES; page++) {
      const detail = yield* snapshots.getThreadDetailSnapshot(threadId, window);
      if (Option.isNone(detail)) return undefined;
      const { messages } = detail.value.thread;
      const reply = messages.findLast(
        (message) =>
          message.role === "assistant" &&
          !message.streaming &&
          timestampMs(message.createdAt) >= sinceMs &&
          timestampMs(message.createdAt) <= dueAtMs,
      );
      if (reply !== undefined) return reply.text;
      // Older pages are older still once an assistant message predates the wait. Only those
      // carry the server's clock, as the wait does; a user message carries its client's.
      const beforeCursor = detail.value.page?.beforeCursor;
      const reachedWaitStart = messages.some(
        (message) => message.role === "assistant" && timestampMs(message.createdAt) < sinceMs,
      );
      if (!beforeCursor || reachedWaitStart) return undefined;
      window = { turnLimit: WAIT_REPLY_PAGE_TURNS, beforeCursor };
    }
    return undefined;
  });

  /**
   * A due wait's part of a message: why it ended, and for a thread that finished a turn, the
   * reply that ended it. A wait that fell due before its end time did so because its thread
   * finished a turn or went away; one due at its end time stopped waiting.
   */
  const prepareWait = Effect.fn("CheckInScheduler.prepareWait")(function* (
    checkIn: ThreadCheckIn,
    target: NonNullable<ThreadCheckIn["waitsFor"]>,
  ) {
    const local = target.environmentId === environmentId;
    const shell = local
      ? yield* snapshots.getThreadShellById(target.threadId)
      : Option.none<OrchestrationThreadShell>();
    const since = timestampMs(checkIn.createdAt);
    const dueAt = timestampMs(checkIn.dueSince);
    const finished = dueAt < timestampMs(checkIn.nextAt);
    const reply =
      local && Option.isSome(shell) && finished
        ? yield* waitReply(target.threadId, since, dueAt)
        : undefined;
    const outcome: WaitOutcome =
      local && Option.isNone(shell)
        ? { kind: "gone" }
        : finished
          ? { kind: "finished", reply }
          : {
              kind: "stopped-waiting",
              hours: Math.round((timestampMs(checkIn.nextAt) - since) / 3_600_000),
            };
    return {
      key: `check-in:${checkIn.id}:1`,
      text: waitNoticeText({ title: target.title, target, note: checkIn.note, outcome }),
      label: waitNoticeLabel(outcome),
      payload: { checkInId: checkIn.id, waitsFor: target },
      told: repository.remove(checkIn.id).pipe(Effect.asVoid),
    } satisfies PreparedNotice;
  });

  /** A message from another thread's agent, and the record that it was delivered. */
  const prepareAgentMessage = (row: AgentThreads.AgentMessageRow, nowMs: number) =>
    ({
      key: `agent-message:${row.messageId}`,
      text: agentMessageText(row.envelope),
      label: agentMessageLabel(row.envelope),
      payload: row.envelope,
      record: {
        kind: AGENT_MESSAGE_CONTEXT_KIND,
        contextId: `agent-message-${row.messageId}`.replace(/[^a-z0-9_-]/gi, "-").slice(0, 128),
      },
      told: agentThreads.markDelivered(row.messageId, isoAt(nowMs)),
    }) satisfies PreparedNotice;

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
      label: "Background command",
      payload: { backgroundCommandId: row.id },
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
    shell: OrchestrationThreadShell,
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
            label: "Status update",
            payload: { backgroundCommandId: row.id },
            told,
          }
        : {
            key: `background-command:${row.id}:match:${row.matchNoticesSent + 1}`,
            text: backgroundCommandMatchText(row, stdout, stderr, nowMs, found.matches),
            label: "Background command",
            payload: { backgroundCommandId: row.id },
            told,
          }
    ) satisfies PreparedNotice;
  });

  const sweep = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const rows = yield* repository.listAll;
    const changed = new Set<ThreadId>();
    const waiting = new Map<ThreadId, Array<ThreadCheckIn>>();
    for (const row of rows) {
      // A wait goes in once its thread has finished a turn, or when it stops waiting.
      const waitDue =
        row.waitsFor !== undefined && row.dueSince === null ? yield* waitDueAt(row, nowMs) : null;
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
    // Messages from other threads' agents, waiting for their thread to be idle.
    const messages = new Map<ThreadId, Array<AgentThreads.AgentMessageRow>>();
    for (const row of yield* agentThreads.listQueued(environmentId)) {
      const due = messages.get(row.targetThreadId) ?? [];
      due.push(row);
      messages.set(row.targetThreadId, due);
    }
    for (const threadId of new Set([
      ...waiting.keys(),
      ...commandNotices.keys(),
      ...messages.keys(),
    ])) {
      const shell = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(shell)) {
        // Archived or deleted while the check-in waited; the domain event normally got here first.
        if (waiting.has(threadId)) {
          yield* repository.removeByThread(threadId);
          changed.add(threadId);
        }
        if (messages.has(threadId)) yield* agentThreads.failQueuedTo({ environmentId, threadId });
        continue;
      }
      if (!threadReadyForCheckIn(shell.value, nowMs)) continue;
      // As much as is due and fits goes in one message, so the agent takes it in one turn; the
      // rest goes the next time the thread is idle. Commands' ends first, then check-ins and
      // waits in the order they fell due, then other threads' messages, then running commands'
      // status and matching lines.
      const due = commandNotices.get(threadId) ?? [];
      const notices: Array<PreparedNotice> = [];
      for (const notice of due) {
        if (notice.kind === "end") notices.push(yield* prepareCommandEnd(notice.row));
      }
      const checkIns = (waiting.get(threadId) ?? []).toSorted(
        (a, b) => timestampMs(a.dueSince) - timestampMs(b.dueSince),
      );
      for (const checkIn of checkIns) {
        notices.push(
          checkIn.waitsFor === undefined
            ? prepareCheckIn(checkIn, nowMs)
            : yield* prepareWait(checkIn, checkIn.waitsFor),
        );
      }
      if (checkIns.length > 0) changed.add(threadId);
      for (const row of messages.get(threadId) ?? []) {
        notices.push(prepareAgentMessage(row, nowMs));
      }
      for (const notice of due) {
        if (notice.kind === "end") continue;
        const prepared = yield* prepareCommandUpdate(notice.row, shell.value, nowMs, notice.kind);
        if (prepared) notices.push(prepared);
      }
      // One thread's failed delivery leaves its notices due and must not hold up the others.
      yield* deliverNotices(shell.value, noticesForOneTurn(notices), nowMs).pipe(
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
    repository.removeByThread(threadId).pipe(
      Effect.andThen(agentThreads.failQueuedTo({ environmentId, threadId })),
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
      // Delivered and failed messages only matter to the hourly limits and to a late duplicate.
      yield* agentThreads
        .pruneMessages(isoAt((yield* Clock.currentTimeMillis) - 7 * 24 * 3_600_000))
        .pipe(Effect.ignore);
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
