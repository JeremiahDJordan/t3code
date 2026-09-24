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
  type BobSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type SessionExitedPayload,
  type ThreadId,
  TurnId,
  type TurnCompletedPayload,
} from "@t3tools/contracts";
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
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
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
  type AcpSessionModeState,
  canonicalItemTypeFromAcpToolKind,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  describeBobAcpSetupError,
  makeBobAcpRuntime,
  setBobSessionMode,
} from "../acp/BobAcpSupport.ts";
import { type BobAdapterShape } from "../Services/BobAdapter.ts";
import {
  type BobTaskCosts,
  bobThreadTokenUsage,
  bobTurnTokenUsage,
  readBobTaskCosts,
  resolveBobTaskDatabasePath,
  sameBobTaskCosts,
} from "./bobTaskUsage.ts";
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
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface BobSessionContext {
  readonly threadId: ThreadId;
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
      }
    | undefined;
  /** Number of sendTurn prompts currently in flight or waiting to be sent.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  /** Runs one prompt at a time, as Bob requires, so a steer waits for the running prompt. */
  readonly promptLock: Semaphore.Semaphore;
  /** Counts Stop requests. A prompt waiting to be sent when Stop is pressed is dropped. */
  interrupts: number;
  /** The latest reading of the task's running totals, and the one when the turn began. */
  taskCosts: BobTaskCosts | undefined;
  turnStartTaskCosts: BobTaskCosts | undefined;
  stopped: boolean;
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

function parseBobResume(raw: unknown): { sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== BOB_RESUME_VERSION) return undefined;
  if (typeof record.sessionId !== "string" || !record.sessionId.trim()) return undefined;
  return { sessionId: record.sessionId.trim() };
}

/**
 * Plan turns run in Bob's `plan` mode and every other turn in `agent`. Bob's `ask` mode is
 * read-only Q&A, not "ask before editing", so T3 never selects it.
 */
function resolveBobModeId(
  modeState: AcpSessionModeState | undefined,
  interactionMode: ProviderInteractionMode | undefined,
): string | undefined {
  const modeId = interactionMode === "plan" ? "plan" : "agent";
  return modeState?.availableModes.some((mode) => mode.id === modeId) ? modeId : undefined;
}

/**
 * Whether a resume failed only because Bob cannot reopen that task. Bob answers every such
 * `session/resume` (task deleted, other cwd) with -32002; an agent without resume support, or
 * one that never answers, fails the same step.
 */
function isBobResumeUnavailable(error: EffectAcpErrors.AcpError): boolean {
  return (
    (error._tag === "AcpRequestError" && error.code === -32002) ||
    (error._tag === "AcpTransportError" && error.method === "session/resume")
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

/**
 * Bob names and classifies a tool only in its `tool_call`; later updates carry just status and
 * output, and a command arrives as the title with no `rawInput`. Carrying both forward keeps
 * every update showing the command instead of a generic tool.
 */
function makeBobToolCallNormalizer() {
  const tools = new Map<string, { title?: string; kind?: EffectAcpSchema.ToolKind }>();
  return (
    notification: EffectAcpSchema.SessionNotification,
  ): EffectAcpSchema.SessionNotification => {
    const update = notification.update;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return notification;
    }
    const known = tools.get(update.toolCallId);
    const title = update.title ?? known?.title;
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

    const sessions = new Map<ThreadId, BobSessionContext>();
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

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
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
    ): Effect.Effect<BobSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    /** Emits the open turn's `turn.completed` once, whichever of its prompt or Bob's exit ends it. */
    const settleTurn = (ctx: BobSessionContext, payload: TurnCompletedPayload) =>
      Effect.gen(function* () {
        const turn = ctx.openTurn;
        if (!turn) return;
        ctx.openTurn = undefined;
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: turn.id,
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
     */
    const stopSessionInternal = (ctx: BobSessionContext, exitError?: EffectAcpErrors.AcpError) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (sessions.get(ctx.threadId) === ctx) sessions.delete(ctx.threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        let payload: SessionExitedPayload = { exitKind: "graceful" };
        if (exitError) {
          const reason = `Bob stopped: ${(exitError._tag === "AcpTransportError" && exitError.detail) || exitError.message}`;
          payload = { exitKind: "error", reason };
          yield* settleTurn(ctx, failedTurnPayload(ctx, reason));
          // Bob's exit reaches the event consumer, which the session scope owns.
          yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.forkIn(adapterScope));
        } else {
          // The session exit ends a turn that is still running.
          ctx.openTurn = undefined;
          if (ctx.notificationFiber) {
            yield* Fiber.interrupt(ctx.notificationFiber);
          }
          yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        }
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload,
        });
      });

    /** Opens Bob for a thread, resuming its stored task when there is one. */
    const startSession: BobAdapterShape["startSession"] = (input) =>
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
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          let ctx!: BobSessionContext;
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          /** Answers what the runtime mode allows without asking, and asks the user the rest. */
          const handlePermission = (params: EffectAcpSchema.RequestPermissionRequest) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "session/request_permission", params);
              const autoApproval = bobAutoApproval(input.runtimeMode, params.toolCall.kind);
              if (autoApproval !== undefined) {
                const optionId = selectPermissionOptionId(params, autoApproval);
                if (optionId !== undefined) {
                  return { outcome: { outcome: "selected" as const, optionId } };
                }
              }
              const permissionRequest = parsePermissionRequest(params);
              const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              pendingApprovals.set(requestId, { decision });
              yield* offerRuntimeEvent(
                makeAcpRequestOpenedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  detail:
                    permissionRequest.detail ??
                    encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                    "[unserializable params]",
                  args: params,
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

          // Each attempt owns its Bob process, which stops unless the session takes it.
          let transferredScope: Scope.Closeable | undefined;
          const openBob = (resumeSessionId: string | undefined) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make("sequential");
              yield* Effect.addFinalizer(() =>
                scope === transferredScope ? Effect.void : Scope.close(scope, Exit.void),
              );
              const acp = yield* makeBobAcpRuntime({
                bobSettings,
                ...(options?.environment || mcpSession?.agentDeviceEnvironment
                  ? {
                      environment: McpProviderSession.withAgentDeviceEnvironment(
                        options?.environment ?? process.env,
                        mcpSession,
                      ),
                    }
                  : {}),
                childProcessSpawner,
                cwd,
                runtimeMode: input.runtimeMode,
                ...(resumeSessionId ? { resumeSessionId } : {}),
                clientInfo: { name: "t3-code", version: "0.0.0" },
                transformSessionUpdate: makeBobToolCallNormalizer(),
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
              return { scope, acp, started };
            });

          // Bob cannot resume a task it deleted or that belongs to another folder. The thread
          // then continues in a new Bob conversation rather than failing; sign-in, license and
          // trust errors still fail, since a new conversation would hit them too.
          const resumeSessionId = parseBobResume(input.resumeCursor)?.sessionId;
          let lostResume: EffectAcpErrors.AcpError | undefined;
          const { scope, acp, started } = yield* openBob(resumeSessionId).pipe(
            Effect.catchIf(
              (error): error is EffectAcpErrors.AcpError =>
                resumeSessionId !== undefined && isAcpError(error) && isBobResumeUnavailable(error),
              (error) =>
                Effect.suspend(() => {
                  lostResume = error;
                  return openBob(undefined);
                }),
            ),
            Effect.mapError((error) =>
              isAcpError(error) ? mapBobAcpError(input.threadId, "session/start", error) : error,
            ),
          );

          // The baseline for the first turn's usage, which matters on resume.
          const taskCosts = yield* readBobTaskCosts(taskDatabasePath, started.sessionId);
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: BOB_DEFAULT_MODEL,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: BOB_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope,
            acp,
            sessionId: started.sessionId,
            currentModeId: (yield* acp.getModeState)?.currentModeId,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            activeTurnId: undefined,
            openTurn: undefined,
            promptsInFlight: 0,
            promptLock: yield* Semaphore.make(1),
            interrupts: 0,
            taskCosts,
            turnStartTaskCosts: taskCosts,
            stopped: false,
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
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
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
                    return;
                  case "ThoughtDelta":
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

    /** Sends a prompt to Bob as a new turn, or as a steer of the turn that is running. */
    const sendTurn: BobAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A sendTurn while a prompt is in flight is a steer: it continues the active turn and
        // waits for the running prompt, since Bob rejects a second concurrent prompt.
        const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
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
            const modeId = resolveBobModeId(yield* ctx.acp.getModeState, input.interactionMode);
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
            };
            ctx.turnStartTaskCosts = ctx.taskCosts;
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
          // ACP commands parse the complete text. Extra context can turn an exact
          // command into an ordinary model prompt or change its arguments.
          const result: EffectAcpSchema.PromptResponse = dropped
            ? { stopReason: "cancelled" }
            : yield* ctx.acp
                .prompt({
                  prompt: /^\/[^\s/]+(?:\s|$)/.test(rawPrompt)
                    ? promptParts
                    : [
                        ...promptParts,
                        { type: "text", text: buildRuntimeInstructions({ harness: "Bob" }) },
                      ],
                })
                .pipe(
                  Effect.mapError((error) =>
                    mapBobAcpError(input.threadId, "session/prompt", error),
                  ),
                );

          yield* ctx.acp.drainEvents;

          if (!dropped) {
            const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
            if (turnRecord) {
              turnRecord.items.push({ prompt: promptParts, result });
            } else {
              ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
            }
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };

          // Bob records spend before it answers the prompt, so the row is current here.
          const previousTaskCosts = ctx.taskCosts;
          const taskCosts = yield* readBobTaskCosts(taskDatabasePath, ctx.sessionId);
          if (taskCosts) {
            ctx.taskCosts = taskCosts;
            if (!sameBobTaskCosts(previousTaskCosts, taskCosts)) {
              yield* offerRuntimeEvent({
                type: "thread.token-usage.updated",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { usage: bobThreadTokenUsage(taskCosts, previousTaskCosts) },
              });
            }
          }

          // Only the last remaining prompt settles the turn; a steer waiting behind this
          // one continues it.
          yield* uncount;
          if (ctx.promptsInFlight === 0) {
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
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              yield* uncount;
              if (ctx.promptsInFlight === 0) {
                yield* settleTurn(ctx, failedTurnPayload(ctx, error.message));
              }
            }),
          ),
          Effect.ensuring(uncount),
        );

        return yield* ctx.promptLock.withPermit(run).pipe(Effect.ensuring(uncount));
      });

    const interruptTurn: BobAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // A steer waiting behind the running prompt was sent before Stop, so it is dropped too.
        ctx.interrupts += 1;
        if (ctx.openTurn) ctx.openTurn.interrupted = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* Effect.ignore(ctx.acp.cancel);
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

    const rollbackThread: BobAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Bob ACP sessions do not support provider-side rollback.",
        });
      });

    const stopSession: BobAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: BobAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: BobAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: BobAdapterShape["stopAll"] = () =>
      Effect.forEach([...sessions.values()], (ctx) => stopSessionInternal(ctx), { discard: true });

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

    return {
      provider: PROVIDER,
      // No `compaction`: Bob's ACP server has no `/compact`, it would reach the model as text.
      capabilities: { sessionModelSwitch: "unsupported", supportsConversationRollback: false },
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
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies BobAdapterShape;
  });
}
