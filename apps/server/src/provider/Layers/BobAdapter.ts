/**
 * BobAdapterLive — IBM Bob Shell (`bob acp`) via ACP.
 *
 * Bob picks its own model, so sessions always report {@link BOB_DEFAULT_MODEL}.
 * ACP carries no usage, so token and Bobcoin totals come from Bob's task database.
 *
 * @module BobAdapterLive
 */

import {
  ApprovalRequestId,
  BOB_DEFAULT_MODEL,
  EnvironmentId,
  type BobSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  RuntimeTaskId,
  type SessionExitedPayload,
  type ThreadId,
  TurnId,
  type TurnCompletedPayload,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerActivation } from "../../serverActivation.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  type AcpToolCallState,
  canonicalItemTypeFromAcpToolKind,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  BOB_TMUX_MISSING_MESSAGE,
  type BobRelayHost,
  type BobRelayLink,
  type BobRelayMeta,
  type BobRelayTool,
  readBobRelayMeta,
  toBobRelayTool,
} from "../acp/BobRelay.ts";
import {
  type BobRewindCut,
  closeBobSession,
  deleteBobSession,
  describeBobAcpSetupError,
  makeBobAcpRuntime,
  moveBobTask,
  rewindBobTask,
  setBobSessionMode,
} from "../acp/BobAcpSupport.ts";
import { type BobAdapterShape } from "../Services/BobAdapter.ts";
import {
  type BobTaskCosts,
  bobContextWindow,
  bobThreadTokenUsage,
  bobTurnTokenUsage,
  readBobTaskCosts,
  resolveBobTaskDatabasePath,
  sameBobTaskCosts,
} from "./bobTaskUsage.ts";
import { readBobSubagentTranscript } from "./bobSubagentTranscript.ts";
import { readBobConfiguredModel } from "./bobUsageLimits.ts";
import { BOB_AGENT_MODE_ID, BOB_MODE_OPTION_ID, BOB_PLAN_MODE_ID } from "./BobProvider.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const isAcpError = Schema.is(EffectAcpErrors.AcpError);

const PROVIDER = ProviderDriverKind.make("bob");
const BOB_RESUME_VERSION = 1 as const;
const PERMISSION_OPTION_KINDS = {
  accept: "allow_once",
  acceptForSession: "allow_always",
  acceptAlways: "allow_always",
  decline: "reject_once",
} as const;
/**
 * How long stopping a session waits for Bob to cancel its running turn. It outlasts the
 * runtime's own cancel timeout, which stops a Bob that never finishes cancelling.
 */
const BOB_STOP_CANCEL_TIMEOUT = "20 seconds";

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface BobAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Stamped on sessions. Defaults to the built-in instance id (`bob`). */
  readonly instanceId?: ProviderInstanceId;
  /** Bob's task database. Defaults to the one `bob` opens for `environment`. */
  readonly taskDatabasePath?: string;
  /** Receives the slash commands a session reports, with the session's workspace. */
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) => Effect.Effect<void>;
  /** Receives the modes a session offers, custom modes included, with the session's workspace. */
  readonly onAvailableModes?: (
    modes: ReadonlyArray<AcpSessionMode>,
    cwd: string,
  ) => Effect.Effect<void>;
  /**
   * Re-reads Bob's budgets for a workspace, when a session starts there and after a turn that
   * spent Bobcoins (`spent`). Runs in the background, so a turn never waits for the gateway.
   */
  readonly refreshUsageLimits?: (cwd: string, spent: boolean) => Effect.Effect<void>;
  /**
   * Runs each Bob under a relay in T3's tmux server, so Bob outlives T3 and a turn running when
   * T3 stops finishes after it starts again. Without it Bob is T3's child process.
   */
  readonly relay?: BobRelayHost;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface BobSessionContext {
  readonly threadId: ThreadId;
  /** What started the session, so a rollback can start it again on the rewound task. */
  readonly startInput: Parameters<BobAdapterShape["startSession"]>[0];
  /** The folder Bob runs in. */
  readonly cwd: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  /** Bob's task id for this session. */
  readonly sessionId: string;
  /** Bob's active mode, from the session, T3's `session/set_mode` calls and Bob's own updates. */
  currentModeId: string | undefined;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  /**
   * When each of the thread's turns began, in epoch milliseconds, oldest first, as far back as
   * T3 recorded them; null for a turn Bob's current task holds nothing from. A rollback cuts
   * Bob's task at the first prompt Bob stamped at or after the first dropped turn's start.
   */
  turnStartedAt: Array<number | null>;
  activeTurnId: TurnId | undefined;
  /**
   * The started turn still owed a `turn.completed`, and whether Stop was pressed during it. A
   * plan turn also keeps Bob's latest reply segment, which becomes its proposed plan.
   */
  openTurn:
    | {
        readonly id: TurnId;
        interrupted: boolean;
        readonly plan: boolean;
        reply?: { readonly itemId: string | undefined; text: string };
        /** Whether Bob showed anything this turn: text, thinking, a tool call or a plan. */
        answered: boolean;
        /** The turn's tool calls Bob has not finished, by tool call id. */
        readonly openTools: Map<string, AcpToolCallState>;
        /** The turn's subagent runs, by tool call id, and whether T3 announced them started. */
        readonly subagents: Map<string, { readonly description: string; started: boolean }>;
        /** Completes once the turn's `turn.completed` is out. */
        readonly settled: Deferred.Deferred<void>;
      }
    | undefined;
  /** Number of sendTurn prompts currently in flight or waiting to be sent.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  /**
   * Runs one prompt at a time, as Bob requires. A follow-up waits for the running prompt: in
   * `queue` mode until Bob finishes it, in `steer` mode after interrupting it once no tool call
   * is running. Either way it then goes to Bob as the next prompt of the same turn.
   */
  readonly promptLock: Semaphore.Semaphore;
  /**
   * A steer waits for the running prompt: `waiting` until Bob finishes its running tool calls,
   * `cancelled` once the prompt was cancelled for it. Cleared when that prompt returns.
   */
  steer: "waiting" | "cancelled" | undefined;
  /**
   * Follow-ups waiting for the running prompt, counted for a session in tmux. They live only in
   * this T3, so the relay keeps the count, and a T3 that takes the turn over after a restart says
   * they were lost.
   */
  waitingPrompts: number;
  /** Counts Stop requests. A prompt waiting to be sent when Stop is pressed is dropped. */
  interrupts: number;
  /**
   * `interrupts` when the prompt now with Bob was sent. A Stop since then refuses that prompt's
   * permission requests; a steer sent after the Stop carries the new count and is asked.
   */
  promptEpoch: number | undefined;
  /** The latest reading of the task's running totals, and the one when the turn began. */
  taskCosts: BobTaskCosts | undefined;
  turnStartTaskCosts: BobTaskCosts | undefined;
  /** Whether this Bob closes sessions with `session/close` (Bob 2.0.5). */
  readonly canCloseSessions: boolean;
  stopped: boolean;
  /** The relay Bob runs under, for an instance that runs Bob in tmux. */
  readonly relay: BobRelayLink | undefined;
  /**
   * A session taken over after a restart whose MCP credential this T3 could not take back ends
   * once its turn does, so the next turn starts a fresh Bob on the same task with T3's tools.
   */
  recycleWhenIdle: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function parseBobResume(
  raw: unknown,
): { sessionId: string; turnStartedAt: Array<number | null> } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== BOB_RESUME_VERSION) return undefined;
  if (typeof record.sessionId !== "string" || !record.sessionId.trim()) return undefined;
  const turnStartedAt = Array.isArray(record.turnStartedAt)
    ? record.turnStartedAt.map((value) =>
        typeof value === "number" && Number.isFinite(value) ? value : null,
      )
    : [];
  return { sessionId: record.sessionId.trim(), turnStartedAt };
}

/** The resume cursor for Bob task `sessionId`, with the thread's turn start times. */
function bobResumeCursor(sessionId: string, turnStartedAt: ReadonlyArray<number | null>) {
  return {
    schemaVersion: BOB_RESUME_VERSION,
    sessionId,
    ...(turnStartedAt.length > 0 ? { turnStartedAt: [...turnStartedAt] } : {}),
  };
}

/**
 * Where to cut Bob's task to drop the last `numTurns` turns: at the first dropped turn T3
 * recorded a start for, or null when none of them reached Bob's task. Turns with no record at
 * all, such as those of a thread from before T3 recorded turn start times, fall back to counting
 * Bob's prompts from the end. That keeps part of a dropped turn that had follow-ups, since each
 * follow-up is a prompt of its own.
 */
export function bobRollbackCut(
  turnStartedAt: ReadonlyArray<number | null>,
  numTurns: number,
): BobRewindCut | null {
  if (numTurns > turnStartedAt.length) return { lastTurns: numTurns };
  const atMs = turnStartedAt
    .slice(turnStartedAt.length - numTurns)
    .find((value): value is number => value !== null);
  return atMs === undefined ? null : { atMs };
}

/**
 * Plan turns run in Bob's `plan` mode. Every other turn runs in the mode picked with the Mode
 * option (Bob's `ask` or a custom mode), `agent` by default. A picked mode this session does not
 * offer, such as another project's custom mode, runs in `agent` and is returned as `missing`.
 */
function resolveBobModeId(
  modeState: AcpSessionModeState | undefined,
  interactionMode: ProviderInteractionMode | undefined,
  pickedModeId: string | undefined,
): { readonly modeId: string | undefined; readonly missing?: string } {
  const offers = (modeId: string) =>
    modeState?.availableModes.some((mode) => mode.id === modeId) === true;
  if (interactionMode === "plan") {
    return { modeId: offers(BOB_PLAN_MODE_ID) ? BOB_PLAN_MODE_ID : undefined };
  }
  if (pickedModeId && pickedModeId !== BOB_AGENT_MODE_ID) {
    if (offers(pickedModeId)) return { modeId: pickedModeId };
    return {
      modeId: offers(BOB_AGENT_MODE_ID) ? BOB_AGENT_MODE_ID : undefined,
      missing: pickedModeId,
    };
  }
  return { modeId: offers(BOB_AGENT_MODE_ID) ? BOB_AGENT_MODE_ID : undefined };
}

/**
 * Whether a resume failed only because Bob cannot reopen that task. Bob answers every such
 * `session/resume` (task deleted, other cwd) with -32002, and the runtime refuses to resume
 * with an agent that does not advertise it, the only `session/resume` error it raises without
 * an `operation`. A resume that times out or breaks off may still have a task behind it, so it
 * fails the start rather than replacing the task.
 *
 * The transport-error check relies on those two error sites: the refusal in
 * `AcpSessionRuntime.ts` (`sessionCapabilities?.resume` missing, no `operation`) and the
 * timeout from effect-acp's call, which carries `operation: "call-rpc"`. Recheck both when
 * either changes upstream.
 */
function isBobResumeUnavailable(error: EffectAcpErrors.AcpError): boolean {
  return (
    (error._tag === "AcpRequestError" && error.code === -32002) ||
    (error._tag === "AcpTransportError" &&
      error.method === "session/resume" &&
      error.operation === undefined)
  );
}

/** Bob reports a failed turn as a generic internal error with the reason in `data.details`. */
function bobErrorDetails(error: EffectAcpErrors.AcpError): string | undefined {
  if (error._tag !== "AcpRequestError" || typeof error.data !== "object" || !error.data) {
    return undefined;
  }
  const details = "details" in error.data ? error.data.details : undefined;
  return typeof details === "string" && details.trim() ? details.trim() : undefined;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * A tool title as Bob meant it. Bob HTML-escapes its tool titles (`=` arrives as `&#x3D;`) but
 * not their input, so an escaped title neither reads right nor matches the input it names.
 */
export function decodeBobTitle(title: string): string {
  return title.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi,
    (entity, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
      if (name !== undefined) return HTML_ENTITIES[name.toLowerCase()] ?? entity;
      const codePoint = Number.parseInt(hex ?? decimal ?? "", hex !== undefined ? 16 : 10);
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    },
  );
}

/**
 * Bob names and classifies a tool only in its `tool_call`; later updates carry just status and
 * output, and a command arrives as the title with no `rawInput`. Carrying both forward keeps
 * every update showing the command instead of a generic tool.
 */
function makeBobToolCallNormalizer(open: ReadonlyArray<BobRelayTool> = []) {
  const tools = new Map<string, { title?: string; kind?: EffectAcpSchema.ToolKind }>(
    open.map((tool) => [
      tool.toolCallId,
      { ...(tool.title ? { title: tool.title } : {}), ...(tool.kind ? { kind: tool.kind } : {}) },
    ]),
  );
  return (
    notification: EffectAcpSchema.SessionNotification,
  ): EffectAcpSchema.SessionNotification => {
    const update = notification.update;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return notification;
    }
    const known = tools.get(update.toolCallId);
    const title = update.title ? decodeBobTitle(update.title) : known?.title;
    const kind = update.kind ?? known?.kind;
    if (update.status === "completed" || update.status === "failed") {
      tools.delete(update.toolCallId);
    } else {
      tools.set(update.toolCallId, { ...(title ? { title } : {}), ...(kind ? { kind } : {}) });
    }
    return {
      ...notification,
      update: {
        ...update,
        ...(title ? { title } : {}),
        ...(kind ? { kind } : {}),
        ...(kind === "execute" && title && update.rawInput === undefined
          ? { rawInput: { command: title } }
          : {}),
      },
    };
  };
}

/**
 * The task a tool call from Bob's `tool_call` update runs, when it runs one of Bob's subagents.
 * Bob titles such a call "Running subagent: <description>" in the user's language, with the
 * description as its input, so it is recognized by that shape rather than by the words.
 */
export function bobSubagentDescription(
  update: EffectAcpSchema.SessionNotification["update"],
): string | undefined {
  if (update.sessionUpdate !== "tool_call" || (update.kind ?? "other") !== "other") {
    return undefined;
  }
  const rawInput = update.rawInput;
  const description =
    typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>).description
      : undefined;
  if (typeof description !== "string") return undefined;
  const trimmed = description.trim();
  const title = update.title.trim();
  return trimmed && title !== trimmed && title.endsWith(trimmed) ? trimmed : undefined;
}

/**
 * A finished subagent's report, without the `<task_result>` tags Bob wraps it in. Ingestion
 * shortens it for clients, and marks it when it does.
 */
export function bobSubagentSummary(toolCall: AcpToolCallState): string | undefined {
  const rawOutput = toolCall.data.rawOutput;
  const result =
    typeof rawOutput === "object" && rawOutput !== null && !Array.isArray(rawOutput)
      ? (rawOutput as Record<string, unknown>).result
      : undefined;
  if (typeof result !== "string") return undefined;
  const text = result
    .replace(/^\s*<task_result>/, "")
    .replace(/<\/task_result>\s*$/, "")
    .trim();
  return text || undefined;
}

/**
 * The answer T3 gives Bob without asking the user: anything in full access, and in
 * auto-accept-edits the edits, deletes and moves T3 shows as file changes, each allowed once so
 * Bob keeps asking about the next. Every other request goes to the user.
 */
function bobAutoApproval(
  runtimeMode: RuntimeMode,
  toolKind: EffectAcpSchema.ToolKind | null | undefined,
): ProviderApprovalDecision | undefined {
  if (runtimeMode === "full-access") return "acceptForSession";
  return runtimeMode === "auto-accept-edits" &&
    canonicalItemTypeFromAcpToolKind(toolKind ?? undefined) === "file_change"
    ? "accept"
    : undefined;
}

/**
 * The line an approval card shows for Bob's request. T3 labels every file change "Changed
 * files", so for those it shows Bob's own title, which names the file and what Bob will do to it.
 */
function bobPermissionDetail(
  request: EffectAcpSchema.RequestPermissionRequest,
  fallback: string | undefined,
): string | undefined {
  const title = request.toolCall.title?.trim();
  return title &&
    canonicalItemTypeFromAcpToolKind(request.toolCall.kind ?? undefined) === "file_change"
    ? title
    : fallback;
}

/** Bob's option ids are its own, so replies are picked by ACP option kind. */
function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  if (decision === "cancel") return undefined;
  const optionIdOfKind = (kind: EffectAcpSchema.PermissionOptionKind) =>
    request.options.find((option) => option.kind === kind && option.optionId.trim())?.optionId;
  const kind = PERMISSION_OPTION_KINDS[decision];
  return (
    optionIdOfKind(kind) ?? (kind === "allow_always" ? optionIdOfKind("allow_once") : undefined)
  );
}

/**
 * The answers an approval card offers for Bob's request: only the ones Bob can take, so
 * "Always allow this session" appears only when Bob offers to remember the tool. Labels and
 * order are the card's defaults.
 */
export function bobApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const offers = (kind: EffectAcpSchema.PermissionOptionKind) =>
    request.options.some((option) => option.kind === kind && option.optionId.trim());
  return [
    { decision: "cancel", label: "Cancel" },
    ...(offers("reject_once") ? [{ decision: "decline" as const, label: "Decline" }] : []),
    ...(offers("allow_always")
      ? [{ decision: "acceptForSession" as const, label: "Always allow this session" }]
      : []),
    ...(offers("allow_once") ? [{ decision: "accept" as const, label: "Approve" }] : []),
  ];
}

/**
 * Builds the adapter for one Bob instance. Each thread gets its own `bob acp` process, whose
 * ACP events become T3's runtime events.
 */
export function makeBobAdapter(bobSettings: BobSettings, options?: BobAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("bob");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const taskDatabasePath =
      options?.taskDatabasePath ??
      resolveBobTaskDatabasePath(options?.environment ?? process.env, path);
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger = options?.nativeEventLogger;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();
    const adapterScope = yield* Effect.scope;
    /** Starts `options.refreshUsageLimits` without waiting for the gateway. */
    const refreshUsageLimitsInBackground = (cwd: string, spent: boolean) =>
      options?.refreshUsageLimits
        ? options.refreshUsageLimits(cwd, spent).pipe(Effect.forkIn(adapterScope), Effect.asVoid)
        : Effect.void;

    const sessions = new Map<ThreadId, BobSessionContext>();
    const relayHost = options?.relay;
    /**
     * Threads whose Bob a relay kept running across a restart, until T3 has attached to it.
     * They count as live sessions, so startup does not mark their turns as lost, and calls for
     * them wait for the attach.
     */
    const attaching = new Map<
      ThreadId,
      { readonly session: ProviderSession; readonly attached: Deferred.Deferred<void> }
    >();
    const awaitAttach = (threadId: ThreadId) =>
      Effect.suspend(() => {
        const pending = attaching.get(threadId);
        return pending ? Deferred.await(pending.attached) : Effect.void;
      });
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const mapBobAcpError = (
      threadId: ThreadId,
      method: string,
      cause: EffectAcpErrors.AcpError,
    ) => {
      const detail =
        describeBobAcpSetupError(cause, bobSettings.authMethod) ?? bobErrorDetails(cause);
      return detail
        ? new ProviderAdapterRequestError({ provider: PROVIDER, method, detail, cause })
        : mapAcpToAdapterError(PROVIDER, threadId, method, cause);
    };

    // Strictly increasing, so events that arrive together, such as what Bob said while T3 was
    // restarting, keep their order in the thread: the timeline orders by time.
    let lastStampMs = 0;
    const nowIso = Effect.map(DateTime.now, (now) => {
      lastStampMs = Math.max(DateTime.toEpochMillis(now), lastStampMs + 1);
      return DateTime.formatIso(DateTime.makeUnsafe(lastStampMs));
    });
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Bob runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<BobSessionContext, ProviderAdapterSessionNotFoundError> =>
      awaitAttach(threadId).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const ctx = sessions.get(threadId);
            if (!ctx || ctx.stopped) {
              return Effect.fail(
                new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
              );
            }
            return Effect.succeed(ctx);
          }),
        ),
      );

    /** Reports a run of one of Bob's subagents as a T3 task, linked to the tool call running it. */
    const offerSubagentEvent = (
      ctx: BobSessionContext,
      turnId: TurnId,
      toolCallId: string,
      description: string,
      status: "started" | "completed" | "failed" | "stopped",
      summary?: string,
    ) =>
      Effect.gen(function* () {
        const task = {
          taskId: RuntimeTaskId.make(toolCallId),
          title: description,
          toolUseId: toolCallId,
        };
        const stamp = { ...(yield* makeEventStamp()), provider: PROVIDER, threadId: ctx.threadId };
        yield* offerRuntimeEvent(
          status === "started"
            ? { type: "task.started", ...stamp, turnId, payload: { ...task, description } }
            : {
                type: "task.completed",
                ...stamp,
                turnId,
                payload: {
                  ...task,
                  status,
                  ...(summary ? { summary } : {}),
                  // Bob stores the run on the parent's tool message (see bobSubagentTranscript).
                  ...(status === "stopped" ? {} : { hasTranscript: true }),
                },
              },
        );
      });

    /**
     * Follows Bob's subagent runs as tasks. Bob starts a subagent once its tool call is allowed,
     * so the task starts when the call runs, and ends with the subagent's report when it does.
     * Bob does not stream the subagent's own tool calls, so the task has no inner activity; its
     * steps are read from Bob's database afterwards (`readTaskTranscript`).
     */
    const trackSubagent = (
      ctx: BobSessionContext,
      toolCall: AcpToolCallState,
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        const turn = ctx.openTurn;
        if (!turn) return;
        let subagent = turn.subagents.get(toolCall.toolCallId);
        if (!subagent) {
          const update = (rawPayload as Partial<EffectAcpSchema.SessionNotification> | undefined)
            ?.update;
          const description = update ? bobSubagentDescription(update) : undefined;
          if (!description) return;
          subagent = { description, started: false };
          turn.subagents.set(toolCall.toolCallId, subagent);
        }
        const ran = toolCall.status === "inProgress" || toolCall.status === "completed";
        if (!subagent.started && ran) {
          subagent.started = true;
          yield* offerSubagentEvent(
            ctx,
            turn.id,
            toolCall.toolCallId,
            subagent.description,
            "started",
          );
        }
        if (toolCall.status !== "completed" && toolCall.status !== "failed") return;
        turn.subagents.delete(toolCall.toolCallId);
        if (!subagent.started) return;
        yield* offerSubagentEvent(
          ctx,
          turn.id,
          toolCall.toolCallId,
          subagent.description,
          toolCall.status,
          bobSubagentSummary(toolCall),
        );
      });

    /**
     * Interrupts the running prompt for a waiting steer once Bob runs no tool call, so a tool
     * call Bob started finishes rather than being cancelled. Bob records its tool results before
     * it asks the model again, so the steer continues from them; what Bob loses is the model reply
     * in progress, which the steer replaces. The cancel runs apart from Bob's updates, which it
     * waits on.
     */
    const interruptForSteer = (ctx: BobSessionContext) =>
      Effect.gen(function* () {
        if (
          ctx.steer !== "waiting" ||
          ctx.promptEpoch === undefined ||
          (ctx.openTurn?.openTools.size ?? 0) > 0
        ) {
          return;
        }
        ctx.steer = "cancelled";
        yield* Effect.ignore(ctx.acp.cancel).pipe(Effect.forkIn(adapterScope), Effect.asVoid);
      });

    /**
     * In steer mode, a follow-up still waiting when a prompt reaches Bob, such as one sent while
     * an earlier follow-up waited, interrupts that prompt as it did the one before.
     */
    const steerWaitingFollowUp = (ctx: BobSessionContext) =>
      Effect.suspend(() => {
        if (
          bobSettings.followUpBehavior !== "steer" ||
          ctx.promptsInFlight <= 1 ||
          ctx.steer !== undefined
        ) {
          return Effect.void;
        }
        ctx.steer = "waiting";
        return interruptForSteer(ctx);
      });

    /**
     * Emits the open turn's `turn.completed` once, whichever of its prompt or Bob's exit ends it,
     * and returns the session to ready unless a new turn has already claimed it. Bob leaves the
     * tool it was running unfinished when Stop cancels it, so any tool still open ends failed.
     */
    const settleTurn = (ctx: BobSessionContext, payload: TurnCompletedPayload) =>
      Effect.gen(function* () {
        const turn = ctx.openTurn;
        if (!turn) return;
        // T3 let go of this Bob to stop; the next T3 finishes the turn.
        if (ctx.relay && (yield* ctx.relay.detached)) return;
        ctx.openTurn = undefined;
        for (const [toolCallId, subagent] of turn.subagents) {
          if (subagent.started) {
            yield* offerSubagentEvent(ctx, turn.id, toolCallId, subagent.description, "stopped");
          }
        }
        for (const toolCall of turn.openTools.values()) {
          yield* offerRuntimeEvent(
            makeAcpToolCallEvent({
              stamp: yield* makeEventStamp(),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: turn.id,
              toolCall: { ...toolCall, status: "failed" },
              rawPayload: undefined,
            }),
          );
        }
        if (ctx.activeTurnId === turn.id) ctx.activeTurnId = undefined;
        if (ctx.session.activeTurnId === turn.id) {
          const { activeTurnId: _settledTurnId, ...session } = ctx.session;
          ctx.session = { ...session, status: "ready", updatedAt: yield* nowIso };
        }
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: turn.id,
          payload,
        });
        yield* Deferred.succeed(turn.settled, undefined);
        if (ctx.relay) yield* ctx.relay.turnSettled;
        if (ctx.recycleWhenIdle && !ctx.stopped) yield* recycleWhenIdle(ctx);
      });

    /**
     * Ends a session taken over after a restart once nothing is running, without telling the
     * thread: the thread stays ready and its next turn starts Bob again on the same task.
     */
    const recycleWhenIdle = (ctx: BobSessionContext): Effect.Effect<void> =>
      withThreadLock(
        ctx.threadId,
        Effect.suspend(() =>
          ctx.stopped || ctx.promptsInFlight > 0
            ? Effect.void
            : stopSessionInternal(ctx, undefined, { emitExitEvent: false }),
        ),
      ).pipe(Effect.forkIn(adapterScope), Effect.asVoid);

    /**
     * Stop for the running turn: Bob is asked to cancel, open approvals are answered as
     * cancelled, and a prompt still waiting to be sent is dropped.
     */
    const cancelRunningTurn = (ctx: BobSessionContext) =>
      Effect.gen(function* () {
        ctx.interrupts += 1;
        if (ctx.openTurn) ctx.openTurn.interrupted = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* Effect.ignore(ctx.acp.cancel);
      });

    /** Publishes the session's single `session.exited`. */
    const publishSessionExited = (ctx: BobSessionContext, payload: SessionExitedPayload) =>
      Effect.gen(function* () {
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload,
        });
      });

    /**
     * Bob has no plan tool, so a plan turn's plan is its final reply. When a plan turn ends
     * normally with text, that reply becomes T3's proposed plan, which the user can implement.
     */
    const proposePlan = (ctx: BobSessionContext, stopReason: EffectAcpSchema.StopReason) =>
      Effect.gen(function* () {
        const turn = ctx.openTurn;
        const planMarkdown =
          turn?.plan && !turn.interrupted && stopReason === "end_turn"
            ? turn.reply?.text.trim()
            : undefined;
        if (!turn || !planMarkdown) return;
        yield* offerRuntimeEvent({
          type: "turn.proposed.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: turn.id,
          payload: { planMarkdown },
        });
      });

    /** A turn that ended in an error was cancelled if Stop was pressed during it. */
    const failedTurnPayload = (
      ctx: BobSessionContext,
      errorMessage: string,
    ): TurnCompletedPayload =>
      ctx.openTurn?.interrupted
        ? { state: "cancelled", stopReason: "cancelled" }
        : { state: "failed", errorMessage: errorMessage.trim() || "Bob turn failed." };

    /**
     * Ends a session. `exitError` means Bob's process or connection died on its own, including
     * the runtime stopping a Bob that did not finish a cancel, so the next turn starts a new one.
     * Otherwise a running turn is cancelled and settles before Bob is closed, so Bob can finish
     * writing its task.
     */
    const stopSessionInternal = (
      ctx: BobSessionContext,
      exitError?: EffectAcpErrors.AcpError,
      options?: { readonly emitExitEvent?: boolean },
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (sessions.get(ctx.threadId) === ctx) sessions.delete(ctx.threadId);
        // T3 is stopping and left this Bob running its turn: nothing is cancelled, closed or
        // reported, so the next T3 finds the turn where it was.
        if (ctx.relay && (yield* ctx.relay.detached)) {
          yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.forkIn(adapterScope), Effect.asVoid);
          return;
        }
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (exitError) {
          const reason = `Bob stopped: ${(exitError._tag === "AcpTransportError" && exitError.detail) || exitError.message}`;
          yield* Effect.gen(function* () {
            yield* settleTurn(ctx, failedTurnPayload(ctx, reason));
            yield* publishSessionExited(ctx, { exitKind: "error", reason });
          }).pipe(
            // Bob's exit reaches the event consumer, which the session scope owns and its close
            // interrupts, so the close runs last and outside the consumer.
            Effect.ensuring(
              Scope.close(ctx.scope, Exit.void).pipe(Effect.forkIn(adapterScope), Effect.asVoid),
            ),
          );
          return;
        }
        const turn = ctx.openTurn;
        if (turn && ctx.promptsInFlight > 0) {
          yield* cancelRunningTurn(ctx).pipe(
            Effect.andThen(Deferred.await(turn.settled)),
            Effect.timeoutOption(BOB_STOP_CANCEL_TIMEOUT),
          );
        }
        // The session exit ends a turn that is still running.
        ctx.openTurn = undefined;
        if (ctx.canCloseSessions) yield* closeBobSession(ctx.acp, ctx.sessionId);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        if (options?.emitExitEvent !== false) {
          yield* publishSessionExited(ctx, { exitKind: "graceful" });
        }
      }).pipe(Effect.uninterruptible);

    // Every Bob process for a thread, including a short-lived one for its tasks, starts with the
    // same environment. The device environment adds only a PATH shim, so Bob's home, which T3
    // reads usage, settings and limits from, is the instance's either way.
    const bobEnvironmentFor = (threadId: ThreadId) => {
      const mcpSession = McpProviderSession.readMcpProviderSession(threadId);
      return options?.environment || mcpSession?.agentDeviceEnvironment
        ? {
            environment: McpProviderSession.withAgentDeviceEnvironment(
              options?.environment ?? process.env,
              mcpSession,
            ),
          }
        : {};
    };

    /**
     * Runs `use` against a short-lived Bob in `cwd`, for requests on a thread's tasks that no
     * session holds, such as moving one here or deleting a copy that did not open.
     */
    const withShortLivedBob = <A, E>(
      threadId: ThreadId,
      cwd: string,
      use: (bob: AcpSessionRuntime.AcpSessionRuntime["Service"]) => Effect.Effect<A, E>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const bob = yield* makeBobAcpRuntime({
            bobSettings,
            ...bobEnvironmentFor(threadId),
            childProcessSpawner,
            cwd,
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...makeAcpNativeLoggers({ nativeEventLogger, provider: PROVIDER, threadId }),
          });
          yield* bob.initialize();
          return yield* use(bob);
        }),
      ).pipe(Effect.provideService(Crypto.Crypto, crypto));

    /** Deletes Bob task `sessionId` with a short-lived Bob in `cwd`. Best effort. */
    const deleteTaskBestEffort = (threadId: ThreadId, cwd: string, sessionId: string) =>
      withShortLivedBob(threadId, cwd, (bob) => deleteBobSession(bob, sessionId)).pipe(
        Effect.ignore,
      );

    /**
     * Opens Bob for a thread, resuming its stored task when there is one. With `attach`, takes
     * over the Bob a relay kept running across a restart, and the turn it was running.
     */
    const startSessionInternal = (
      input: Parameters<BobAdapterShape["startSession"]>[0],
      attach?: {
        readonly link: BobRelayLink;
        readonly meta: BobRelayMeta & { readonly sessionId: string };
        readonly turn: NonNullable<BobRelayMeta["turn"]>;
      },
    ) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          // Said plainly here: a relay that cannot start reports only a failed spawn.
          if (relayHost && !attach && !(yield* relayHost.available)) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: BOB_TMUX_MISSING_MESSAGE,
            });
          }
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          let ctx!: BobSessionContext;
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          /**
           * Answers what the runtime mode allows without asking, and asks the user the rest. A
           * stopped session asks no one: Bob is being cancelled or closed, so it is refused.
           */
          /**
           * Bob can reach its next tool's prompt before it acts on a cancel. After Stop nothing
           * may run, and an open question would hold Bob's cancel until the runtime kills it.
           */
          const refusesPermission = () =>
            ctx?.stopped === true ||
            ctx?.steer === "cancelled" ||
            (ctx?.promptEpoch !== undefined && ctx.promptEpoch !== ctx.interrupts);
          const handlePermission = (params: EffectAcpSchema.RequestPermissionRequest) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "session/request_permission", params);
              const autoApproval = bobAutoApproval(input.runtimeMode, params.toolCall.kind);
              if (autoApproval !== undefined && !refusesPermission()) {
                const optionId = selectPermissionOptionId(params, autoApproval);
                if (optionId !== undefined) {
                  return { outcome: { outcome: "selected" as const, optionId } };
                }
              }
              // The card shows Bob's title as Bob meant it.
              const request = params.toolCall.title
                ? {
                    ...params,
                    toolCall: { ...params.toolCall, title: decodeBobTitle(params.toolCall.title) },
                  }
                : params;
              const permissionRequest = parsePermissionRequest(request);
              const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              // Nothing yields between this check and the set, so a stop that cancels the
              // pending approvals either sees this one or has already refused it here.
              if (refusesPermission()) return { outcome: { outcome: "cancelled" as const } };
              pendingApprovals.set(requestId, { decision });
              yield* offerRuntimeEvent(
                makeAcpRequestOpenedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  approvalOptions: bobApprovalOptions(params),
                  detail:
                    bobPermissionDetail(request, permissionRequest.detail) ??
                    encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                    "[unserializable params]",
                  args: request,
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: params,
                }),
              );
              const resolved = yield* Deferred.await(decision);
              pendingApprovals.delete(requestId);
              yield* offerRuntimeEvent(
                makeAcpRequestResolvedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  decision: resolved,
                }),
              );
              const optionId = selectPermissionOptionId(params, resolved);
              return {
                outcome:
                  optionId === undefined
                    ? ({ outcome: "cancelled" } as const)
                    : { outcome: "selected" as const, optionId },
              };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new EffectAcpErrors.AcpTransportError({
                    detail: "Failed to process Bob permission request.",
                    cause,
                  }),
              ),
            );

          const bobEnvironment = bobEnvironmentFor(input.threadId);
          // Each attempt owns its Bob process, which stops unless the session takes it.
          let transferredScope: Scope.Closeable | undefined;
          const openBob = (resumeSessionId: string | undefined, link?: BobRelayLink) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make("sequential");
              yield* Effect.addFinalizer(() =>
                scope === transferredScope ? Effect.void : Scope.close(scope, Exit.void),
              );
              const relay =
                link ??
                relayHost?.link({
                  threadId: input.threadId,
                  instanceId: boundInstanceId,
                  cwd,
                  runtimeMode: input.runtimeMode,
                });
              const acp = yield* makeBobAcpRuntime({
                bobSettings,
                ...bobEnvironment,
                childProcessSpawner: relay?.spawner ?? childProcessSpawner,
                cwd,
                runtimeMode: input.runtimeMode,
                ...(resumeSessionId ? { resumeSessionId } : {}),
                clientInfo: { name: "t3-code", version: "0.0.0" },
                // A Bob taken over after a restart may finish a call the last T3 saw start.
                transformSessionUpdate: makeBobToolCallNormalizer(attach?.meta.tools),
                ...(mcpSession
                  ? {
                      mcpServers: [
                        {
                          type: "http" as const,
                          name: "t3-code",
                          url: mcpSession.endpoint,
                          headers: [
                            { name: "Authorization", value: mcpSession.authorizationHeader },
                          ],
                        },
                      ],
                    }
                  : {}),
                ...makeAcpNativeLoggers({
                  nativeEventLogger,
                  provider: PROVIDER,
                  threadId: input.threadId,
                }),
              }).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(Scope.Scope, scope),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail:
                        describeBobAcpSetupError(cause, bobSettings.authMethod) ?? cause.message,
                      cause,
                    }),
                ),
              );
              yield* acp.handleRequestPermission(handlePermission);
              const started = yield* acp
                .start()
                .pipe(Effect.tapError(() => Scope.close(scope, Exit.void)));
              return { scope, acp, started, relay };
            });

          /**
           * Copies the thread's Bob task into this folder with a short-lived Bob here, and returns
           * the copy's id, or undefined when it cannot move.
           */
          const moveTaskHere = (sessionId: string) =>
            withShortLivedBob(input.threadId, cwd, (mover) =>
              moveBobTask(mover, sessionId, cwd),
            ).pipe(Effect.orElseSucceed(() => undefined));
          const isResumeUnavailable = (error: unknown): error is EffectAcpErrors.AcpError =>
            isAcpError(error) && isBobResumeUnavailable(error);
          const openNewConversation = (error: EffectAcpErrors.AcpError) =>
            Effect.suspend(() => {
              lostResume = error;
              return openBob(undefined);
            });

          // Bob resumes a task only in the folder it started in, and not one it deleted. A thread
          // that moved to another folder, such as a worktree, takes its task along; otherwise it
          // continues in a new Bob conversation rather than failing. Sign-in, license and trust
          // errors still fail, since a new conversation would hit them too, and so does a resume
          // that times out, since its task may still be there. Bob checks the folder before the
          // sign-in, so a moved task's copy can still fail to open: the copy is then deleted and
          // the thread keeps its original, which the next start moves again. The original is
          // deleted once the copy is open, so Bob's history and Bobcoin totals count it once.
          const resumed = parseBobResume(input.resumeCursor);
          const resumeSessionId = resumed?.sessionId;
          let lostResume: EffectAcpErrors.AcpError | undefined;
          const { scope, acp, started, relay } = yield* (
            attach
              ? // The relay answers the handshake itself; Bob is already in the task.
                openBob(attach.meta.sessionId, attach.link)
              : openBob(resumeSessionId)
          ).pipe(
            Effect.catchIf(
              (error): error is EffectAcpErrors.AcpError =>
                attach === undefined && resumeSessionId !== undefined && isResumeUnavailable(error),
              (error) =>
                Effect.gen(function* () {
                  if (resumeSessionId === undefined) return yield* openNewConversation(error);
                  const movedSessionId = yield* moveTaskHere(resumeSessionId);
                  if (movedSessionId === undefined) return yield* openNewConversation(error);
                  return yield* openBob(movedSessionId).pipe(
                    Effect.tap(({ acp }) => deleteBobSession(acp, resumeSessionId)),
                    Effect.tapError(() =>
                      deleteTaskBestEffort(input.threadId, cwd, movedSessionId),
                    ),
                  );
                }),
            ),
            Effect.mapError((error) =>
              isAcpError(error) ? mapBobAcpError(input.threadId, "session/start", error) : error,
            ),
          );

          // The baseline for the first turn's usage, which matters on resume.
          const taskCosts = yield* readBobTaskCosts(taskDatabasePath, started.sessionId);
          // A moved task keeps its messages' timestamps, so the turn start times still apply; a
          // new conversation holds none of the earlier turns.
          const turnStartedAt = attach
            ? [...(attach.meta.turnStartedAt ?? [])]
            : lostResume
              ? (resumed?.turnStartedAt ?? []).map(() => null)
              : [...(resumed?.turnStartedAt ?? [])];
          if (relay && !attach) {
            yield* relay.setMeta({
              sessionId: started.sessionId,
              turnStartedAt,
              ...(mcpSession
                ? { mcp: { ...mcpSession, capabilities: [...mcpSession.capabilities] } }
                : {}),
            });
          }
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: BOB_DEFAULT_MODEL,
            threadId: input.threadId,
            resumeCursor: bobResumeCursor(started.sessionId, turnStartedAt),
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            startInput: input,
            cwd,
            session,
            scope,
            acp,
            sessionId: started.sessionId,
            currentModeId: attach?.meta.modeId ?? (yield* acp.getModeState)?.currentModeId,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            turnStartedAt,
            activeTurnId: undefined,
            openTurn: undefined,
            promptsInFlight: 0,
            promptLock: yield* Semaphore.make(1),
            waitingPrompts: 0,
            interrupts: 0,
            promptEpoch: undefined,
            steer: undefined,
            taskCosts,
            turnStartTaskCosts: taskCosts,
            canCloseSessions:
              started.initializeResult.agentCapabilities?.sessionCapabilities?.close != null,
            stopped: false,
            relay,
            recycleWhenIdle: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ConnectionTerminated":
                    yield* stopSessionInternal(ctx, event.error);
                    return;
                  case "ModeChanged":
                    ctx.currentModeId = event.modeId;
                    return;
                  case "AvailableCommandsUpdated":
                    yield* (
                      options?.onAvailableCommands?.(event.availableCommands, cwd) ?? Effect.void
                    );
                    return;
                  case "AssistantItemStarted":
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle:
                          event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    if (ctx.openTurn) ctx.openTurn.answered = true;
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpPlanUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ToolCallUpdated": {
                    if (ctx.openTurn) ctx.openTurn.answered = true;
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* trackSubagent(ctx, event.toolCall, event.rawPayload);
                    const openTools = ctx.openTurn?.openTools;
                    const wasOpen = openTools?.has(event.toolCall.toolCallId) ?? false;
                    if (
                      event.toolCall.status === "completed" ||
                      event.toolCall.status === "failed"
                    ) {
                      openTools?.delete(event.toolCall.toolCallId);
                    } else {
                      openTools?.set(event.toolCall.toolCallId, event.toolCall);
                    }
                    // The relay keeps the open calls for a T3 that takes over after a restart.
                    if (
                      ctx.relay &&
                      openTools &&
                      wasOpen !== openTools.has(event.toolCall.toolCallId)
                    ) {
                      yield* ctx.relay.setMeta({
                        tools: [...openTools.values()].map(toBobRelayTool),
                      });
                    }
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    yield* interruptForSteer(ctx);
                    return;
                  }
                  case "ThoughtDelta":
                    if (ctx.openTurn && event.text.trim()) ctx.openTurn.answered = true;
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        streamKind: "reasoning_text",
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    if (ctx.openTurn && event.text.trim()) ctx.openTurn.answered = true;
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    if (ctx.openTurn?.plan) {
                      const turn = ctx.openTurn;
                      if (!turn.reply || turn.reply.itemId !== event.itemId) {
                        turn.reply = { itemId: event.itemId, text: "" };
                      }
                      turn.reply.text += event.text;
                    }
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Bob runtime notification.", { cause }),
            ),
            // The consumer must outlive `startSession`, so it lives in the session scope.
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          transferredScope = scope;
          const modeState = yield* acp.getModeState;
          if (modeState) {
            yield* options?.onAvailableModes?.(modeState.availableModes, cwd) ?? Effect.void;
          }
          yield* refreshUsageLimitsInBackground(cwd, false);

          if (attach) {
            // Bob still holds the MCP credential the last T3 gave it. Taken back, its T3 tools keep
            // working and it can stay; otherwise it ends once its turn does.
            const kept = attach.meta.mcp
              ? yield* restoreMcpSession(attach.meta.mcp, input.threadId)
              : false;
            yield* adoptTurn(
              ctx,
              attach.link,
              attach.turn,
              attach.meta.tools ?? [],
              !kept,
              attach.meta.waitingPrompts ?? 0,
            );
            return ctx.session;
          }

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Bob ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          if (lostResume) {
            yield* offerRuntimeEvent({
              type: "runtime.warning",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: {
                message:
                  "Bob could not restore its previous conversation, so this thread continues in a new Bob session.",
                detail: lostResume.message,
              },
            });
          }

          return session;
        }).pipe(Effect.scoped),
      );

    const startSession: BobAdapterShape["startSession"] = (input) =>
      awaitAttach(input.threadId).pipe(Effect.andThen(startSessionInternal(input)));

    /**
     * After a prompt of the turn ends, answered or failed: lets what Bob said for it through, so
     * it lands in this turn and not the next, and reports the task's usage. Returns the task's
     * running totals.
     */
    const settlePromptEffects = (ctx: BobSessionContext, turnId: TurnId) =>
      Effect.gen(function* () {
        yield* ctx.acp.drainEvents;
        // Bob records spend before it answers the prompt, so the row is current here.
        const previousTaskCosts = ctx.taskCosts;
        const taskCosts = yield* readBobTaskCosts(taskDatabasePath, ctx.sessionId);
        if (!taskCosts) return undefined;
        ctx.taskCosts = taskCosts;
        if (!sameBobTaskCosts(previousTaskCosts, taskCosts)) {
          yield* offerRuntimeEvent({
            type: "thread.token-usage.updated",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              usage: bobThreadTokenUsage(
                taskCosts,
                previousTaskCosts,
                // Bob reads its model setting on every turn, so the window follows it.
                bobContextWindow(
                  yield* readBobConfiguredModel(options?.environment ?? process.env).pipe(
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.provideService(Path.Path, path),
                  ),
                ),
              ),
            },
          });
          yield* refreshUsageLimitsInBackground(ctx.cwd, true);
        }
        return taskCosts;
      });

    /**
     * After Bob answers a turn's prompt: records it, reports the task's usage and, when no
     * other prompt of the turn waits behind it, settles the turn.
     */
    const finishPrompt = (
      ctx: BobSessionContext,
      input: {
        readonly turnId: TurnId;
        readonly result: EffectAcpSchema.PromptResponse;
        /** What went to Bob, or none for a prompt that never reached it. */
        readonly prompt?: ReadonlyArray<EffectAcpSchema.ContentBlock>;
        readonly uncount: Effect.Effect<void>;
      },
    ) =>
      Effect.gen(function* () {
        const { turnId, result } = input;
        const taskCosts = yield* settlePromptEffects(ctx, turnId);

        if (input.prompt) {
          const item = { prompt: input.prompt, result };
          const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
          if (turnRecord) {
            turnRecord.items.push(item);
          } else {
            ctx.turns.push({ id: turnId, items: [item] });
          }
        }

        // Only the last remaining prompt settles the turn; a steer waiting behind this
        // one continues it.
        yield* input.uncount;
        if (ctx.promptsInFlight === 0) {
          // Bob can end a turn having shown nothing, such as when its backend answers a long
          // conversation with an empty reply. Without a word the thread looks ignored.
          const turn = ctx.openTurn;
          if (
            turn?.id === turnId &&
            !turn.answered &&
            !turn.interrupted &&
            result.stopReason !== "cancelled"
          ) {
            yield* offerRuntimeEvent({
              type: "runtime.warning",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              payload: { message: "Bob ended its turn without replying.", retryable: true },
            });
          }
          yield* proposePlan(ctx, result.stopReason);
          yield* settleTurn(ctx, {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason ?? null,
            ...(taskCosts
              ? {
                  tokenUsage: bobTurnTokenUsage(
                    taskCosts,
                    ctx.turnStartTaskCosts,
                    result.stopReason !== "cancelled",
                  ),
                }
              : {}),
          });
        }

        return {
          threadId: ctx.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    /**
     * Takes back the MCP credential a Bob kept running across a restart still holds, when this
     * server can honour it (same environment, same endpoint), and records it as the thread's MCP
     * session for any Bob this adapter starts for the thread later. Whether it was taken back.
     */
    const restoreMcpSession = (mcp: NonNullable<BobRelayMeta["mcp"]>, threadId: ThreadId) =>
      Effect.gen(function* () {
        if (mcp.threadId !== threadId || mcp.providerInstanceId !== boundInstanceId) return false;
        const config: McpProviderSession.McpProviderSessionConfig = {
          ...mcp,
          environmentId: EnvironmentId.make(mcp.environmentId),
          threadId,
          providerInstanceId: boundInstanceId,
          capabilities: new Set(mcp.capabilities),
        };
        const restored = yield* McpSessionRegistry.restoreActiveMcpCredential(config);
        if (restored) McpProviderSession.setMcpProviderSession(config);
        return restored;
      });

    /**
     * Finishes, on a Bob its relay kept running across a restart, the turn it was running when
     * the last T3 let go. What Bob said meanwhile arrives as it would have live, and the answer
     * to the prompt that was running ends the turn here.
     */
    const adoptTurn = (
      ctx: BobSessionContext,
      link: BobRelayLink,
      turn: NonNullable<BobRelayMeta["turn"]>,
      tools: ReadonlyArray<BobRelayTool>,
      recycle: boolean,
      /** Messages the last T3 held for Bob during the turn, which went with it. */
      lostPrompts: number,
    ) =>
      Effect.gen(function* () {
        const turnId = TurnId.make(turn.id);
        ctx.recycleWhenIdle = recycle;
        ctx.activeTurnId = turnId;
        ctx.openTurn = {
          id: turnId,
          interrupted: false,
          plan: turn.plan,
          // What Bob showed before the restart is unknown, so its silence since is no warning.
          answered: true,
          // The calls still running, so a steer waits for them instead of cancelling them.
          openTools: new Map(
            tools.map((tool): [string, AcpToolCallState] => [
              tool.toolCallId,
              { ...tool, status: "inProgress", data: {} },
            ]),
          ),
          subagents: new Map(),
          settled: yield* Deferred.make<void>(),
        };
        // From the turn's start, so what Bob spent while no T3 ran is reported. None means the
        // task had no row yet, which is no spend.
        ctx.turnStartTaskCosts = turn.costsAtStart;
        ctx.taskCosts = turn.costsAtStart;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };
        // Running, not ready: a ready session would end the thread's turn.
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { state: "running", reason: "Bob kept working while T3 Code restarted" },
        });
        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: { model: BOB_DEFAULT_MODEL },
        });
        if (lostPrompts > 0) {
          const one = lostPrompts === 1;
          yield* offerRuntimeEvent({
            type: "runtime.warning",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              message: `${lostPrompts} ${one ? "message" : "messages"} sent while Bob was working did not reach Bob before T3 Code restarted. Send ${one ? "it" : "them"} again.`,
            },
          });
          yield* link.setMeta({ waitingPrompts: 0 });
        }
        ctx.promptsInFlight += 1;
        let counted = true;
        const uncount = Effect.sync(() => {
          if (!counted) return;
          counted = false;
          ctx.promptsInFlight -= 1;
        });
        // Taken before the session is visible, so a message sent meanwhile waits behind it.
        yield* ctx.promptLock.take(1);
        yield* Effect.gen(function* () {
          yield* link.replay;
          // This prompt reaches no Bob: it takes the answer to the one that was running.
          yield* link.adoptNextPrompt;
          ctx.promptEpoch = ctx.interrupts;
          const result = yield* ctx.acp
            .prompt({ prompt: [{ type: "text", text: "Continue." }] })
            .pipe(
              Effect.mapError((error) => mapBobAcpError(ctx.threadId, "session/prompt", error)),
              Effect.ensuring(
                Effect.sync(() => {
                  ctx.promptEpoch = undefined;
                  ctx.steer = undefined;
                }),
              ),
            );
          yield* finishPrompt(ctx, { turnId, result, uncount });
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              yield* settlePromptEffects(ctx, turnId);
              yield* uncount;
              if (ctx.promptsInFlight === 0) {
                yield* settleTurn(ctx, failedTurnPayload(ctx, error.message));
              }
            }),
          ),
          Effect.ensuring(uncount),
          Effect.ensuring(ctx.promptLock.release(1)),
          Effect.catch((cause) =>
            Effect.logWarning("Bob could not finish the turn it ran across a restart.", { cause }),
          ),
          Effect.forkIn(adapterScope),
        );
      });

    /** Sends a prompt to Bob as a new turn, or as a steer of the turn that is running. */
    const sendTurn: BobAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A sendTurn while a prompt is in flight continues the active turn. Bob rejects a second
        // concurrent prompt, so it waits for the running one: queued follow-ups until Bob finishes
        // it, steers after interrupting it once Bob's running tool calls finish.
        const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
        // Only a prompt that is with Bob is interrupted; between prompts the steer just waits.
        if (
          bobSettings.followUpBehavior === "steer" &&
          steeringTurnId !== undefined &&
          ctx.steer === undefined &&
          ctx.promptEpoch !== undefined
        ) {
          ctx.steer = "waiting";
          yield* interruptForSteer(ctx);
        }
        const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
        const interrupts = ctx.interrupts;
        ctx.activeTurnId = turnId;
        // Counted while it waits, so the running prompt leaves the turn open for it. The count
        // drops inside the lock, before the next prompt checks whether it is the last.
        ctx.promptsInFlight += 1;
        let counted = true;
        const uncount = Effect.sync(() => {
          if (!counted) return;
          counted = false;
          ctx.promptsInFlight -= 1;
        });
        // A follow-up waits until its prompt goes to Bob, or it is given up.
        let waiting = steeringTurnId !== undefined && ctx.relay !== undefined;
        const countWaiting = (change: 1 | -1) =>
          Effect.suspend(() => {
            ctx.waitingPrompts += change;
            return ctx.relay?.setMeta({ waitingPrompts: ctx.waitingPrompts }) ?? Effect.void;
          });
        if (waiting) yield* countWaiting(1);
        const stopWaiting = Effect.suspend(() => {
          if (!waiting) return Effect.void;
          waiting = false;
          return countWaiting(-1);
        });

        const run = Effect.gen(function* () {
          // A prompt still waiting when the session ended has no Bob to go to.
          if (ctx.stopped) {
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          if (ctx.openTurn?.id !== turnId) {
            // Switching modes under a running prompt is unsafe, so only a new turn picks its mode.
            const { modeId, missing } = resolveBobModeId(
              yield* ctx.acp.getModeState,
              input.interactionMode,
              getModelSelectionStringOptionValue(input.modelSelection, BOB_MODE_OPTION_ID),
            );
            if (missing !== undefined) {
              yield* offerRuntimeEvent({
                type: "runtime.warning",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                payload: {
                  message: `Bob has no "${missing}" mode in this project, so this turn runs in Agent mode.`,
                },
              });
            }
            if (modeId !== undefined && modeId !== ctx.currentModeId) {
              yield* setBobSessionMode(ctx.acp, ctx.sessionId, modeId).pipe(
                Effect.mapError((cause) =>
                  mapBobAcpError(input.threadId, "session/set_mode", cause),
                ),
              );
              ctx.currentModeId = modeId;
            }
            ctx.openTurn = {
              id: turnId,
              interrupted: false,
              plan: input.interactionMode === "plan",
              answered: false,
              openTools: new Map(),
              subagents: new Map(),
              settled: yield* Deferred.make<void>(),
            };
            // Before the prompt goes out, so Bob stamps it at or after this time.
            ctx.turnStartedAt.push(DateTime.toEpochMillis(yield* DateTime.now));
            ctx.session = {
              ...ctx.session,
              resumeCursor: bobResumeCursor(ctx.sessionId, ctx.turnStartedAt),
            };
            ctx.turnStartTaskCosts = ctx.taskCosts;
            if (ctx.relay) {
              // What a T3 started after this one needs to finish the turn.
              yield* ctx.relay.setMeta({
                turnStartedAt: ctx.turnStartedAt,
                ...(ctx.currentModeId ? { modeId: ctx.currentModeId } : {}),
              });
              yield* ctx.relay.turnStarted({
                id: turnId,
                plan: ctx.openTurn.plan,
                ...(ctx.turnStartTaskCosts ? { costsAtStart: ctx.turnStartTaskCosts } : {}),
              });
            }
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { model: BOB_DEFAULT_MODEL },
            });
          }
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };

          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          const rawPrompt = input.input?.trim() ?? "";
          if (rawPrompt) {
            promptParts.push({ type: "text", text: rawPrompt });
          }
          for (const attachment of input.attachments ?? []) {
            // Generic files reach the agent through the path line ProviderService
            // puts in the prompt; only images go inline.
            if (attachment.type !== "image") {
              continue;
            }
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            promptParts.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }

          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          // Stop drops a prompt that was still waiting, instead of sending it after the cancel.
          const dropped = ctx.interrupts !== interrupts;
          if (!dropped) ctx.promptEpoch = interrupts;
          const dispatched = yield* Deferred.make<void>();
          // ACP commands parse the complete text. Extra context can turn an exact
          // command into an ordinary model prompt or change its arguments.
          const result: EffectAcpSchema.PromptResponse = dropped
            ? { stopReason: "cancelled" }
            : yield* Effect.raceFirst(
                ctx.acp.prompt(
                  {
                    prompt: /^\/[^\s/]+(?:\s|$)/.test(rawPrompt)
                      ? promptParts
                      : [
                          ...promptParts,
                          { type: "text", text: buildRuntimeInstructions({ harness: "Bob" }) },
                        ],
                  },
                  { dispatched },
                ),
                // Only once the prompt is sent, so a steer's cancel stops it rather than going first.
                Deferred.await(dispatched).pipe(
                  Effect.andThen(stopWaiting),
                  Effect.andThen(steerWaitingFollowUp(ctx)),
                  Effect.andThen(Effect.never),
                ),
              ).pipe(
                Effect.mapError((error) => mapBobAcpError(input.threadId, "session/prompt", error)),
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.promptEpoch = undefined;
                    // The steer this prompt held goes next; one waiting behind it interrupts it.
                    ctx.steer = undefined;
                  }),
                ),
              );

          return yield* finishPrompt(ctx, {
            turnId,
            result,
            ...(dropped ? {} : { prompt: promptParts }),
            uncount,
          });
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              yield* settlePromptEffects(ctx, turnId);
              yield* uncount;
              if (ctx.promptsInFlight === 0) {
                yield* settleTurn(ctx, failedTurnPayload(ctx, error.message));
              }
            }),
          ),
          Effect.ensuring(uncount),
        );

        return yield* ctx.promptLock
          .withPermit(run)
          .pipe(Effect.ensuring(uncount), Effect.ensuring(stopWaiting));
      });

    /**
     * Stops the running turn, and a steer waiting behind it, which was sent before Stop. A Stop
     * for a turn that is no longer running arrived late and does nothing.
     */
    const interruptTurn: BobAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (turnId !== undefined && turnId !== ctx.activeTurnId) return;
        yield* cancelRunningTurn(ctx);
      });

    const respondToRequest: BobAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    // Bob only asks for permissions; it never opens structured user-input requests.
    const respondToUserInput: BobAdapterShape["respondToUserInput"] = (threadId, requestId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "user-input/respond",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      });

    const readThread: BobAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    /**
     * Drops the thread's last `numTurns` turns from Bob's conversation, as Bob's IDE rolls a task
     * back to before a message. T3 has already restored the files. Bob keeps the conversation
     * before the first dropped turn as a new task, which the session reopens; the original is then
     * deleted, so Bob's history and Bobcoin totals count the kept part once. A new task that does
     * not open is deleted instead, and the original stays. Rolling back every turn starts a new
     * conversation.
     */
    const rollbackThread: BobAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        if (ctx.promptsInFlight > 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/rollback",
            detail: "Bob is still working on this thread. Stop it before reverting.",
          });
        }
        const keptTurns = ctx.turns.slice(0, Math.max(0, ctx.turns.length - numTurns));
        const keptStarts = ctx.turnStartedAt.slice(
          0,
          Math.max(0, ctx.turnStartedAt.length - numTurns),
        );
        const cut = bobRollbackCut(ctx.turnStartedAt, numTurns);
        const rewound =
          cut === null
            ? ({ _tag: "Unchanged" } as const)
            : yield* rewindBobTask(ctx.acp, ctx.sessionId, ctx.cwd, cut);
        switch (rewound._tag) {
          case "Failed":
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "thread/rollback",
              detail: `Bob could not rewind its conversation: ${rewound.detail}`,
            });
          case "Unchanged":
            // None of the dropped turns reached Bob's task, so its conversation already ends
            // before them.
            ctx.turnStartedAt = keptStarts;
            ctx.turns.splice(keptTurns.length);
            ctx.session = {
              ...ctx.session,
              resumeCursor: bobResumeCursor(ctx.sessionId, ctx.turnStartedAt),
            };
            return { threadId, turns: keptTurns };
        }
        const previousSessionId = ctx.sessionId;
        yield* stopSessionInternal(ctx, undefined, { emitExitEvent: false });
        yield* startSession({
          ...ctx.startInput,
          runtimeMode: ctx.session.runtimeMode,
          resumeCursor:
            rewound._tag === "Rewound" ? bobResumeCursor(rewound.sessionId, keptStarts) : undefined,
        }).pipe(
          Effect.tapError(() =>
            rewound._tag === "Rewound"
              ? deleteTaskBestEffort(threadId, ctx.cwd, rewound.sessionId)
              : Effect.void,
          ),
        );
        const next = yield* requireSession(threadId);
        yield* deleteBobSession(next.acp, previousSessionId);
        return { threadId, turns: keptTurns };
      });

    /**
     * At startup: the relays this instance left running. One that was running a turn becomes a
     * live session at once, so startup does not mark the turn lost, and T3 attaches to it once
     * the server is up, when the thread's events have somewhere to go. The rest stop.
     */
    const takeOverRelays = (host: BobRelayHost) =>
      Effect.gen(function* () {
        const activation = yield* ServerActivation;
        const now = yield* nowIso;
        const toAttach: Array<{
          readonly relayId: string;
          readonly meta: BobRelayMeta & { readonly sessionId: string };
          readonly turn: NonNullable<BobRelayMeta["turn"]>;
          readonly attached: Deferred.Deferred<void>;
        }> = [];
        for (const { relayId, state } of yield* host.scan) {
          const meta = readBobRelayMeta(state);
          // Another instance's relay is that instance's to take.
          if (meta && meta.instanceId !== boundInstanceId) continue;
          // A disabled instance runs no Bob, so its relays stop.
          if (!bobSettings.enabled) {
            yield* host.kill(relayId);
            continue;
          }
          const threadId = meta ? (meta.threadId as ThreadId) : undefined;
          const sessionId = meta?.sessionId;
          const turn = meta?.turn;
          if (
            !meta ||
            !threadId ||
            !sessionId ||
            !turn ||
            (!state.promptInFlight && !state.promptEnded) ||
            attaching.has(threadId)
          ) {
            yield* host.kill(relayId);
            continue;
          }
          const attached = yield* Deferred.make<void>();
          attaching.set(threadId, {
            attached,
            session: {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              status: "running",
              runtimeMode: meta.runtimeMode,
              cwd: meta.cwd,
              model: BOB_DEFAULT_MODEL,
              threadId,
              activeTurnId: TurnId.make(turn.id),
              resumeCursor: bobResumeCursor(sessionId, meta.turnStartedAt ?? []),
              createdAt: now,
              updatedAt: now,
            },
          });
          toAttach.push({ relayId, meta: { ...meta, sessionId }, turn, attached });
        }
        if (toAttach.length === 0) return;
        yield* Effect.forEach(
          toAttach,
          ({ relayId, meta, turn, attached }) => {
            const threadId = meta.threadId as ThreadId;
            return startSessionInternal(
              {
                threadId,
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                cwd: meta.cwd,
                runtimeMode: meta.runtimeMode,
                resumeCursor: bobResumeCursor(meta.sessionId, meta.turnStartedAt ?? []),
              },
              { link: host.attach(relayId), meta, turn },
            ).pipe(
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning("Could not take over Bob after a restart.", { cause });
                  yield* host.kill(relayId);
                  // Nothing will finish the turn, so it ends here.
                  yield* offerRuntimeEvent({
                    type: "turn.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId,
                    turnId: TurnId.make(turn.id),
                    payload: {
                      state: "failed",
                      errorMessage: "Bob stopped while T3 Code was restarting.",
                    },
                  });
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => attaching.delete(threadId)).pipe(
                  Effect.andThen(Deferred.succeed(attached, undefined)),
                ),
              ),
            );
          },
          { discard: true },
        ).pipe(
          // Once the server is up, so the events of the turn reach the thread.
          (attachAll) => (activation ? Effect.andThen(activation, attachAll) : attachAll),
          Effect.forkIn(adapterScope),
        );
      });

    // Waits for an attach outside the lock, since the attach takes the lock to finish.
    const stopSession: BobAdapterShape["stopSession"] = (threadId) =>
      awaitAttach(threadId).pipe(
        Effect.andThen(
          withThreadLock(
            threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(threadId);
              yield* stopSessionInternal(ctx);
            }),
          ),
        ),
      );

    const listSessions: BobAdapterShape["listSessions"] = () =>
      Effect.sync(() => [
        ...Array.from(sessions.values(), (c) => ({ ...c.session })),
        ...Array.from(attaching, ([threadId, pending]) =>
          sessions.has(threadId) ? undefined : { ...pending.session },
        ).filter((session) => session !== undefined),
      ]);

    const hasSession: BobAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        if (attaching.has(threadId)) return true;
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: BobAdapterShape["stopAll"] = () =>
      Effect.forEach([...sessions.values()], (ctx) => stopSessionInternal(ctx), { discard: true });

    if (relayHost) yield* takeOverRelays(relayHost);

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...sessions.values()], (ctx) => stopSessionInternal(ctx), {
        discard: true,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Bob session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    const readTaskTranscript: NonNullable<BobAdapterShape["readTaskTranscript"]> = (input) => {
      const parentTaskId =
        parseBobResume(input.resumeCursor)?.sessionId ?? sessions.get(input.threadId)?.sessionId;
      return parentTaskId === undefined
        ? Effect.succeed({ entries: [] })
        : readBobSubagentTranscript(taskDatabasePath, parentTaskId, input.taskId);
    };

    return {
      provider: PROVIDER,
      // No `compaction`: Bob's ACP server has no `/compact`, it would reach the model as text.
      capabilities: { sessionModelSwitch: "unsupported", supportsConversationRollback: true },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      readTaskTranscript,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies BobAdapterShape;
  });
}
