import {
  BACKGROUND_COMMAND_MATCH_NOTICE_MINUTES,
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
import * as FileSystem from "effect/FileSystem";
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
const MATCHES_READ_BYTES = 64 * 1024;
const MATCHES_SHOWN = 20;

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
  const commands = yield* ThreadBackgroundCommands.ThreadBackgroundCommandRepository;
  const commandChanges = yield* ThreadBackgroundCommands.BackgroundCommandChanges;
  const fs = yield* FileSystem.FileSystem;
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

  /**
   * Sends one message from T3 into a thread as a new turn. The command id is fixed per notice, so
   * a retry after a crash between the dispatch and the caller's write is deduplicated by the
   * engine instead of arriving twice.
   */
  const dispatchNotice = (
    shell: OrchestrationThreadShell,
    notice: {
      readonly key: string;
      readonly text: string;
      readonly label: string;
      readonly payload: Record<string, unknown>;
    },
    nowMs: number,
  ) =>
    engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:${notice.key}`),
        threadId: shell.id,
        message: {
          messageId: MessageId.make(notice.key),
          role: "user",
          text: notice.text,
          attachments: [],
          context: decodeMessageContext({
            version: 1,
            records: [
              {
                version: 1,
                contextId: notice.key.replace(/[^a-z0-9_-]/gi, "-"),
                label: notice.label,
                kind: CHECK_IN_CONTEXT_KIND,
                payload: notice.payload,
              },
            ],
          }),
        },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdAt: isoAt(nowMs),
      })
      .pipe(
        Effect.asVoid,
        // The thread refused the turn; retrying the same message would be refused again.
        Effect.catchTag("OrchestrationCommandInvariantError", (error) =>
          Effect.logWarning("check-in delivery refused", {
            key: notice.key,
            detail: error.message,
          }),
        ),
      );

  /** Sends one due check-in into its thread and records the delivery. */
  const deliver = Effect.fn("CheckInScheduler.deliver")(function* (
    shell: OrchestrationThreadShell,
    checkIn: ThreadCheckIn,
    nowMs: number,
  ) {
    const delivery = checkIn.deliveredCount + 1;
    yield* dispatchNotice(
      shell,
      {
        key: `check-in:${checkIn.id}:${delivery}`,
        text: checkInMessageText(checkIn, nowMs),
        label: "Check-in",
        payload: { checkInId: checkIn.id },
      },
      nowMs,
    );
    yield* isLastDelivery(checkIn)
      ? repository.remove(checkIn.id).pipe(Effect.asVoid)
      : repository.update({ ...checkIn, dueSince: null, deliveredCount: delivery });
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

  /** Tells the agent how a background command ended, then records that it was told. */
  const deliverCommandEnd = Effect.fn("CheckInScheduler.deliverCommandEnd")(function* (
    shell: OrchestrationThreadShell,
    row: ThreadBackgroundCommands.BackgroundCommandRow,
    nowMs: number,
  ) {
    const stdout = yield* noticedOutput(row.stdoutPath, row.stdoutBytesNoticed, row.tailLines);
    const stderr = yield* noticedOutput(row.stderrPath, row.stderrBytesNoticed, row.tailLines);
    const found = yield* readNewMatches(row);
    yield* dispatchNotice(
      shell,
      {
        key: `background-command:${row.id}:end`,
        text: backgroundCommandEndText(row, stdout, stderr, found?.matches),
        label: "Background command",
        payload: { backgroundCommandId: row.id },
      },
      nowMs,
    );
    if (found) yield* commands.recordEndMatches(row.id, found.bytes);
    yield* commands.markEndNoticeSent(row.id);
    yield* PubSub.publish(commandChanges, row.threadId);
  });

  /**
   * A message about a running command: a status update, or new lines matching its pattern.
   * A status update also quotes new matches. Nothing is sent for a command that has in fact
   * just ended, whose end message says it all.
   */
  const deliverCommandUpdate = Effect.fn("CheckInScheduler.deliverCommandUpdate")(function* (
    shell: OrchestrationThreadShell,
    row: ThreadBackgroundCommands.BackgroundCommandRow,
    nowMs: number,
    kind: "status" | "match",
  ) {
    const ended = yield* fs
      .exists(`${row.jobDir}/exit-status`)
      .pipe(Effect.orElseSucceed(() => false));
    if (ended) return false;
    const found = yield* readNewMatches(row);
    if (kind === "match" && found === undefined) return false;
    const stdout = yield* noticedOutput(row.stdoutPath, row.stdoutBytesNoticed, row.tailLines);
    const stderr = yield* noticedOutput(row.stderrPath, row.stderrBytesNoticed, row.tailLines);
    const status = kind === "status" || found === undefined;
    yield* dispatchNotice(
      shell,
      status
        ? {
            key: `background-command:${row.id}:status:${row.statusNoticesSent + 1}`,
            text: backgroundCommandStatusText(row, stdout, stderr, nowMs, found?.matches),
            label: "Status update",
            payload: { backgroundCommandId: row.id },
          }
        : {
            key: `background-command:${row.id}:match:${row.matchNoticesSent + 1}`,
            text: backgroundCommandMatchText(row, stdout, stderr, nowMs, found.matches),
            label: "Background command",
            payload: { backgroundCommandId: row.id },
          },
      nowMs,
    );
    yield* commands.recordNotice(row.id, {
      kind: status ? "status" : "match",
      nextStatusAt:
        status && row.statusEveryMinutes !== null && row.nextStatusAt !== null
          ? nextRepeatAt(row.nextStatusAt, row.statusEveryMinutes, nowMs)
          : row.nextStatusAt,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      matchBytes: found?.bytes ?? row.matchBytesNoticed,
      matchesAt: found ? isoAt(nowMs) : null,
    });
    yield* PubSub.publish(commandChanges, row.threadId);
    return true;
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
      const shell = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(shell)) {
        // Archived or deleted while the check-in waited; the domain event normally got here first.
        if (waiting.has(threadId)) {
          yield* repository.removeByThread(threadId);
          changed.add(threadId);
        }
        continue;
      }
      if (!threadReadyForCheckIn(shell.value, nowMs)) continue;
      // One per sweep: the delivery starts a turn, and the next waits until that one ends. A
      // command's end comes first, then check-ins in the order they fell due, then a command's
      // status or its matching lines.
      const notices = commandNotices.get(threadId) ?? [];
      const end = notices.find((notice) => notice.kind === "end");
      if (end) {
        yield* deliverCommandEnd(shell.value, end.row, nowMs);
        continue;
      }
      const [first] = (waiting.get(threadId) ?? []).toSorted(
        (a, b) => timestampMs(a.dueSince) - timestampMs(b.dueSince),
      );
      if (first !== undefined) {
        yield* deliver(shell.value, first, nowMs);
        changed.add(threadId);
        continue;
      }
      for (const notice of notices) {
        if (notice.kind === "end") continue;
        if (yield* deliverCommandUpdate(shell.value, notice.row, nowMs, notice.kind)) break;
      }
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
    wake: worker.enqueue(undefined).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(CheckInScheduler, make);
