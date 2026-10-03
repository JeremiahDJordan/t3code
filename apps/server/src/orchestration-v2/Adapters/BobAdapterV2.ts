/**
 * BobAdapterV2 — IBM Bob Shell (`bob acp`) as a flavor of the generic ACP adapter.
 *
 * Bob is a plain ACP agent apart from a few habits the flavor and a thin runtime wrapper absorb:
 * it advertises `session/load` but replays the whole history through it, so sessions are
 * resumed; it HTML-escapes tool titles; it runs subagents as a "Running subagent: …" tool call;
 * it has no plan tool, so a plan turn's plan is its final reply; and its backend can end a turn
 * having said nothing, which fails the turn as retryable rather than looking ignored.
 *
 * @module orchestration-v2/Adapters/BobAdapterV2
 */
import {
  type BobAuthMethod,
  type BobSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type ProviderApprovalOption,
  type ProviderInstanceId,
  ProviderSetupError,
  type RunAttemptId,
  type TurnItemId,
} from "@t3tools/contracts";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import type * as ServerConfig from "../../config.ts";
import {
  acpContentBlockDisplayText,
  type AcpSessionMode,
  type AcpToolCallState,
} from "../../provider/acp/AcpRuntimeModel.ts";
import { ACP_SESSION_MODE_OPTION_ID } from "../../provider/acp/AcpSessionConfig.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import {
  deleteBobSession,
  describeBobAcpSetupError,
  makeBobAcpRuntime,
  moveBobTask,
  rewindBobTask,
} from "../../provider/acp/BobAcpSupport.ts";
import type * as IdAllocator from "../IdAllocator.ts";
import type { TaskTranscript } from "../../provider/taskTranscript.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2SubagentUpdate,
} from "./AcpAdapterV2.ts";

const BOB_PROVIDER = ProviderDriverKind.make("bob");
/** Bob's default mode, which every turn starts from unless the thread picked another. */
const BOB_AGENT_MODE_ID = "agent";
const BOB_PLAN_MODE_ID = "plan";
export const BOB_EMPTY_REPLY_MESSAGE = "Bob ended its turn without replying.";
/** Marks the failure the runtime wrapper raises for a turn Bob ended without output. */
const BOB_EMPTY_REPLY_MARKER = "t3/bob-empty-reply";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const BobProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  planning: {
    ...AcpProviderCapabilitiesV2.planning,
    emitsProposedPlan: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    emitsSubagentLifecycle: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

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

function decodeBobToolTitles(
  notification: EffectAcpSchema.SessionNotification,
): EffectAcpSchema.SessionNotification {
  const update = notification.update;
  if (
    (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") ||
    !update.title
  ) {
    return notification;
  }
  return { ...notification, update: { ...update, title: decodeBobTitle(update.title) } };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The task a tool call runs, when it runs one of Bob's subagents. Bob titles such a call
 * "Running subagent: <description>" in the user's language, with the description as its input,
 * so it is recognized by that shape rather than by the words.
 */
function bobSubagentDescription(toolCall: AcpToolCallState): string | undefined {
  if ((toolCall.kind ?? "other") !== "other") return undefined;
  const description = asRecord(toolCall.data.rawInput)?.description;
  if (typeof description !== "string") return undefined;
  const trimmed = description.trim();
  const title = (typeof toolCall.data.title === "string" ? toolCall.data.title : "").trim();
  return trimmed && title !== trimmed && title.endsWith(trimmed) ? trimmed : undefined;
}

/** A finished subagent's report, without the `<task_result>` tags Bob wraps it in. */
function bobSubagentSummary(toolCall: AcpToolCallState): string | undefined {
  const result = asRecord(toolCall.data.rawOutput)?.result;
  if (typeof result !== "string") return undefined;
  const text = result
    .replace(/^\s*<task_result>/, "")
    .replace(/<\/task_result>\s*$/, "")
    .trim();
  return text || undefined;
}

/** The stand-in session id a subagent's steps are replayed under. */
function bobSubagentSessionId(toolCallId: string): string {
  return `bob-subagent:${toolCallId}`;
}

/** Whether a root-session update starts one of Bob's subagents, by the same shape as above. */
function startsBobSubagent(update: EffectAcpSchema.SessionUpdate): boolean {
  if (update.sessionUpdate !== "tool_call" || (update.kind ?? "other") !== "other") return false;
  const description = asRecord(update.rawInput)?.description;
  if (typeof description !== "string" || !description.trim()) return false;
  const title = decodeBobTitle(update.title ?? "").trim();
  return title !== description.trim() && title.endsWith(description.trim());
}

/**
 * A finished subagent's steps as updates of its stand-in session, which the ACP adapter writes
 * into the subagent's thread: its notes as messages and its tool calls as tools. The prompt is
 * the thread's opening message already, and the report its result.
 */
function bobSubagentStepNotifications(
  toolCallId: string,
  transcript: TaskTranscript,
): ReadonlyArray<EffectAcpSchema.SessionNotification> {
  const sessionId = bobSubagentSessionId(toolCallId);
  const note = (key: string, text: string): EffectAcpSchema.SessionNotification => ({
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: `${toolCallId}:${key}`,
      content: { type: "text", text },
    },
  });
  const omitted = transcript.omittedEntries ?? 0;
  const omittedAt = transcript.entries[0]?._tag === "prompt" ? 1 : 0;
  return transcript.entries.flatMap((entry, index) => {
    const steps: Array<EffectAcpSchema.SessionNotification> =
      omitted > 0 && index === omittedAt
        ? [note("omitted", `${omitted} older ${omitted === 1 ? "step" : "steps"} not shown.`)]
        : [];
    switch (entry._tag) {
      case "prompt":
        break;
      case "message":
        steps.push(note(`step:${index}`, entry.text));
        break;
      case "tool":
        steps.push({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `${toolCallId}:step:${index}`,
            title: entry.title,
            kind: "other",
            status: entry.failed ? "failed" : "completed",
            ...(entry.input === undefined ? {} : { rawInput: entry.input }),
            ...(entry.output === undefined ? {} : { rawOutput: entry.output }),
          },
        });
        break;
    }
    return steps;
  });
}

const extractBobSubagentUpdate = (
  toolCall: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined => {
  const description = bobSubagentDescription(toolCall);
  if (description === undefined) return undefined;
  const status =
    toolCall.status === "completed"
      ? "completed"
      : toolCall.status === "failed"
        ? "failed"
        : toolCall.status === "pending"
          ? "pending"
          : "running";
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt: description,
    title: description,
    model: null,
    status,
    // Bob streams nothing of a subagent's run, so its steps go into the subagent's thread as
    // this stand-in session's updates once it finishes (see `bobSubagentStepNotifications`).
    childSessionId: bobSubagentSessionId(toolCall.toolCallId),
    result:
      status === "completed" || status === "failed" ? (bobSubagentSummary(toolCall) ?? null) : null,
  };
};

/**
 * The answers an approval card offers for Bob's request: only the ones Bob can take, so
 * "Always allow this session" appears only when Bob offers to remember the tool.
 */
function bobApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const offers = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
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

/** Bob reports a failed turn as a generic internal error with the reason in `data.details`. */
function bobErrorDetails(error: EffectAcpErrors.AcpRequestError): string | undefined {
  const details = asRecord(error.data)?.details;
  return typeof details === "string" && details.trim() ? details.trim() : undefined;
}

function isBobEmptyReply(cause: unknown): boolean {
  return isAcpRequestError(cause) && asRecord(cause.data)?.[BOB_EMPTY_REPLY_MARKER] === true;
}

/** A Bob task's context size and Bobcoins, as an ACP usage update would carry them. */
export interface BobTaskUsage {
  readonly used: number;
  /** The context window, or 0 when T3 does not know it. */
  readonly size: number;
  readonly bobcoins: number;
}

export interface BobAdapterV2Hooks {
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
   * Reads a task's usage from Bob's task database. Bob reports no usage over ACP, so after each
   * turn the adapter is given it as a standard usage update.
   */
  readonly readTaskUsage?: (sessionId: string) => Effect.Effect<BobTaskUsage | undefined>;
  /** Called after a turn that spent Bobcoins, with the session's workspace. */
  readonly onBobcoinsSpent?: (cwd: string) => Effect.Effect<void>;
  /** Reads the steps of a subagent run from Bob's task database, once it finished. */
  readonly readSubagentSteps?: (
    parentSessionId: string,
    toolCallId: string,
  ) => Effect.Effect<TaskTranscript>;
}

/** What the wrapper tracks for one `bob acp` process, by the runtime the adapter holds. */
interface BobRuntimeState {
  /** Whether the running prompt showed anything: text, thinking, a tool call or a plan. */
  answered: boolean;
  /** The reply since the last tool call, which a plan turn proposes as its plan. */
  lastReply: string;
  /** Bob's task: the session this process opened or resumed. */
  sessionId?: string;
  /** The task's Bobcoins at the last reading, to tell whether a turn spent any. */
  lastCost?: number;
  /** Subagents running now, by their tool call id. */
  readonly runningSubagents: Set<string>;
  /** The adapter's update handler, which takes the usage Bob does not report itself. */
  handler?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  captureProposedPlan?: (input: { readonly planMarkdown: string }) => Effect.Effect<void>;
}

const bobRuntimeStates = new WeakMap<object, BobRuntimeState>();

function observeBobUpdate(state: BobRuntimeState, update: EffectAcpSchema.SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = acpContentBlockDisplayText(update.content) ?? "";
      if (text.trim()) state.answered = true;
      state.lastReply += text;
      return;
    }
    case "agent_message": {
      const text = (update.content ?? [])
        .map((content) => acpContentBlockDisplayText(content) ?? "")
        .join("");
      if (text.trim()) state.answered = true;
      state.lastReply = text;
      return;
    }
    case "agent_thought_chunk":
      if ((acpContentBlockDisplayText(update.content) ?? "").trim()) state.answered = true;
      return;
    case "agent_thought":
      if ((update.content ?? []).some((content) => acpContentBlockDisplayText(content)?.trim())) {
        state.answered = true;
      }
      return;
    case "tool_call":
      state.answered = true;
      state.lastReply = "";
      return;
    case "tool_call_update":
    case "plan":
    case "plan_update":
      state.answered = true;
      return;
    default:
      return;
  }
}

/**
 * Bob's runtime as the ACP adapter sees it: saved sessions resume instead of replaying their
 * history, the workspace's commands and modes reach the provider snapshot, a plan turn proposes
 * its final reply, and a turn Bob ends without output fails as retryable.
 */
function wrapBobRuntime(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  cwd: string,
  hooks: BobAdapterV2Hooks,
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  const state: BobRuntimeState = { answered: false, lastReply: "", runningSubagents: new Set() };
  /** Replays a finished subagent's steps into its thread, before its result arrives. */
  const replaySubagentSteps = (
    notification: EffectAcpSchema.SessionNotification,
    handler: (
      notification: EffectAcpSchema.SessionNotification,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError>,
  ) =>
    Effect.gen(function* () {
      const update = notification.update;
      if (update.sessionUpdate === "tool_call" && startsBobSubagent(update)) {
        state.runningSubagents.add(update.toolCallId);
        return;
      }
      if (
        update.sessionUpdate !== "tool_call_update" ||
        (update.status !== "completed" && update.status !== "failed") ||
        !state.runningSubagents.delete(update.toolCallId) ||
        !hooks.readSubagentSteps
      ) {
        return;
      }
      const transcript = yield* hooks.readSubagentSteps(notification.sessionId, update.toolCallId);
      for (const step of bobSubagentStepNotifications(update.toolCallId, transcript)) {
        yield* handler(step).pipe(Effect.ignore);
      }
    });
  const reportModes = runtime.getModeState.pipe(
    Effect.flatMap((modeState) =>
      modeState && hooks.onAvailableModes
        ? hooks.onAvailableModes(modeState.availableModes, cwd)
        : Effect.void,
    ),
  );
  /** Remembers the task a session opened, and its Bobcoins so far, to tell what a turn spends. */
  const opened = (started: AcpSessionRuntime.AcpSessionRuntimeStartResult) =>
    Effect.gen(function* () {
      state.sessionId = started.sessionId;
      const usage = hooks.readTaskUsage ? yield* hooks.readTaskUsage(started.sessionId) : undefined;
      state.lastCost = usage?.bobcoins ?? 0;
    }).pipe(Effect.andThen(reportModes));
  /** Gives the adapter Bob's usage after a turn, and says when the turn spent Bobcoins. */
  const reportUsage = Effect.gen(function* () {
    const { sessionId, handler } = state;
    if (!sessionId || !handler || !hooks.readTaskUsage) return;
    const usage = yield* hooks.readTaskUsage(sessionId);
    if (!usage) return;
    yield* handler({
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: usage.used,
        size: usage.size,
        cost: { amount: usage.bobcoins, currency: "Bobcoins" },
      },
    }).pipe(Effect.ignore);
    const spent = state.lastCost !== undefined && usage.bobcoins > state.lastCost;
    state.lastCost = usage.bobcoins;
    if (spent && hooks.onBobcoinsSpent) yield* hooks.onBobcoinsSpent(cwd);
  });
  const wrapped: AcpSessionRuntime.AcpSessionRuntime["Service"] = {
    ...runtime,
    start: () => runtime.start().pipe(Effect.tap(opened)),
    // Bob advertises `session/load` but replays every message through it; resume restores the
    // task without the replay.
    loadSession: (sessionId, options) =>
      runtime.resumeSession(sessionId, options).pipe(Effect.tap(opened)),
    resumeSession: (sessionId, options) =>
      runtime.resumeSession(sessionId, options).pipe(Effect.tap(opened)),
    handleSessionUpdate: (handler) =>
      Effect.sync(() => {
        state.handler = handler;
      }).pipe(
        Effect.andThen(
          runtime.handleSessionUpdate((notification) => {
            observeBobUpdate(state, notification.update);
            const commands =
              notification.update.sessionUpdate === "available_commands_update" &&
              hooks.onAvailableCommands
                ? hooks.onAvailableCommands(notification.update.availableCommands, cwd)
                : Effect.void;
            return commands.pipe(
              Effect.andThen(replaySubagentSteps(notification, handler)),
              Effect.andThen(handler(notification)),
            );
          }),
        ),
      ),
    prompt: (payload, options) =>
      Effect.gen(function* () {
        state.answered = false;
        state.lastReply = "";
        const result = yield* runtime.prompt(payload, options).pipe(Effect.ensuring(reportUsage));
        if (result.stopReason !== "end_turn") return result;
        // Bob's backend can answer a long conversation with an empty reply, and Bob then ends
        // the turn having shown nothing. Without a word the thread looks ignored.
        if (!state.answered) {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32603,
            errorMessage: BOB_EMPTY_REPLY_MESSAGE,
            data: { [BOB_EMPTY_REPLY_MARKER]: true },
          });
        }
        // Bob has no plan tool, so a plan turn's plan is its final reply.
        const planMarkdown = state.lastReply.trim();
        const modeState = yield* runtime.getModeState;
        if (
          planMarkdown &&
          modeState?.currentModeId === BOB_PLAN_MODE_ID &&
          state.captureProposedPlan
        ) {
          yield* state.captureProposedPlan({ planMarkdown });
        }
        return result;
      }),
  };
  bobRuntimeStates.set(wrapped, state);
  return wrapped;
}

export interface BobAdapterV2Options extends BobAdapterV2Hooks {
  readonly instanceId: ProviderInstanceId;
  readonly settings: BobSettings;
  /** The environment `bob` runs with, the instance's variables over the server's. */
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly selfInvocation: SelfInvocation;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
}

export function makeBobAcpAdapterFlavor(options: BobAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: BOB_PROVIDER,
    runtimeHarness: "Bob",
    capabilities: BobProviderCapabilitiesV2,
    makeRuntime: ({ runtimePolicy, ...input }) =>
      makeBobAcpRuntime({
        ...input,
        childProcessSpawner: options.childProcessSpawner,
        bobSettings: options.settings,
        environment: options.environment,
        runtimeMode: runtimePolicy.runtimeMode,
      }).pipe(Effect.map((runtime) => wrapBobRuntime(runtime, input.cwd, options))),
    preferResumeSession: true,
    // Every turn starts in Agent unless the thread picked another mode, so a mode left over in a
    // resumed task never lingers. Plan turns switch to Bob's plan mode after this.
    sessionModeForPolicy: (policy) =>
      policy.interactionMode === "plan" ? undefined : BOB_AGENT_MODE_ID,
    normalizeSessionUpdate: decodeBobToolTitles,
    approvalOptions: bobApprovalOptions,
    extractSubagentUpdate: extractBobSubagentUpdate,
    registerExtensions: ({ runtime, captureProposedPlan }) =>
      Effect.sync(() => {
        const state = bobRuntimeStates.get(runtime);
        if (state) state.captureProposedPlan = captureProposedPlan;
      }),
    promptFailure: (cause) => {
      if (isBobEmptyReply(cause)) {
        return makeProviderFailure({
          cause,
          message: BOB_EMPTY_REPLY_MESSAGE,
          code: "empty_reply",
          class: "provider_error",
          retryable: true,
        });
      }
      if (!isAcpRequestError(cause)) return makeProviderFailure({ cause, class: "provider_error" });
      return makeProviderFailure({
        cause,
        message:
          describeBobAcpSetupError(cause, options.settings.authMethod) ??
          bobErrorDetails(cause) ??
          cause.errorMessage,
        code: String(cause.code),
        class: "provider_error",
      });
    },
  };
}

/** Bob's answer to resuming a task it does not have here: gone, or from another folder. */
function isBobTaskNotHere(cause: unknown): boolean {
  for (let current = cause; current !== null && typeof current === "object";) {
    if (isAcpRequestError(current) && current.code === -32002) return true;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

/**
 * `error` carrying Bob's setup text, such as how to sign in or accept its license, as the safe
 * detail the thread's failure shows. Bob refuses a session that way while it opens, before any
 * prompt, so the flavor's `promptFailure` never sees it.
 */
function withBobSetupDetail(
  error: ProviderAdapter.ProviderAdapterV2Error,
  instanceId: ProviderInstanceId,
  authMethod: BobAuthMethod,
): ProviderAdapter.ProviderAdapterV2Error {
  let detail: string | undefined;
  for (let current: unknown = error.cause; current !== null && typeof current === "object";) {
    detail = describeBobAcpSetupError(current, authMethod);
    if (detail !== undefined) break;
    current = (current as { readonly cause?: unknown }).cause;
  }
  if (detail === undefined) return error;
  const cause = new ProviderSetupError({
    instanceId,
    operation: "session",
    detail,
    cause: error.cause,
  });
  switch (error._tag) {
    case "ProviderAdapterOpenSessionError":
      return new ProviderAdapter.ProviderAdapterOpenSessionError({ ...error, cause });
    case "ProviderAdapterEnsureThreadError":
      return new ProviderAdapter.ProviderAdapterEnsureThreadError({ ...error, cause });
    case "ProviderAdapterResumeThreadError":
      return new ProviderAdapter.ProviderAdapterResumeThreadError({ ...error, cause });
    case "ProviderAdapterTurnStartError":
      return new ProviderAdapter.ProviderAdapterTurnStartError({ ...error, cause });
    default:
      return error;
  }
}

function bobTaskId(providerThread: OrchestrationV2ProviderThread): string | undefined {
  return providerThread.nativeThreadRef?.nativeId ?? undefined;
}

function withBobTaskId(
  providerThread: OrchestrationV2ProviderThread,
  nativeId: string,
): OrchestrationV2ProviderThread {
  return providerThread.nativeThreadRef === null
    ? providerThread
    : { ...providerThread, nativeThreadRef: { ...providerThread.nativeThreadRef, nativeId } };
}

/**
 * Bob's session runtime: a reverted turn rewinds Bob's own conversation instead of starting an
 * empty one, and a thread that moved folders, such as to a worktree, takes its task along.
 */
function wrapBobSession(
  session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  openedIn: string,
  withShortLivedBob: <A>(
    cwd: string,
    use: (bob: AcpSessionRuntime.AcpSessionRuntime["Service"]) => Effect.Effect<A>,
  ) => Effect.Effect<A | undefined>,
  explainSetup: (
    error: ProviderAdapter.ProviderAdapterV2Error,
  ) => ProviderAdapter.ProviderAdapterV2Error,
  modes: {
    /** The mode a turn picked that Bob does not offer in its folder, which runs Agent instead. */
    readonly missing: (input: ProviderAdapter.ProviderAdapterV2TurnInput) => string | undefined;
    readonly noticeItemId: (nativeItemId: string) => TurnItemId;
  },
): ProviderAdapter.ProviderAdapterV2SessionRuntime {
  // Bob's tasks belong to a folder; the session follows the folder of its latest turn.
  let cwd = openedIn;
  const follow = (policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy | undefined) => {
    if (policy?.cwd) cwd = policy.cwd;
  };
  // A turn whose picked mode Bob lacks says so once the turn exists, as the generic adapter
  // runs it in Agent mode without a word. Keyed by run attempt until its provider turn appears.
  const missingModes = new Map<
    RunAttemptId,
    { readonly input: ProviderAdapter.ProviderAdapterV2TurnInput; readonly mode: string }
  >();
  const withMissingModeNotice = (
    event: ProviderAdapter.ProviderAdapterV2Event,
  ): Arr.NonEmptyReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> => {
    if (event.type !== "provider_turn.updated" || event.providerTurn.runAttemptId === null) {
      return [event];
    }
    const pending = missingModes.get(event.providerTurn.runAttemptId);
    if (pending === undefined) return [event];
    missingModes.delete(event.providerTurn.runAttemptId);
    const { providerTurn } = event;
    const nativeItemId = `${providerTurn.id}:bob-missing-mode`;
    const at = providerTurn.startedAt ?? DateTime.nowUnsafe();
    const message = `Bob has no "${pending.mode}" mode in this project, so this turn runs in Agent mode.`;
    return [
      event,
      {
        type: "turn_item.updated",
        driver: BOB_PROVIDER,
        turnItem: {
          id: modes.noticeItemId(nativeItemId),
          threadId: pending.input.threadId,
          runId: pending.input.runId,
          nodeId: providerTurn.nodeId,
          providerThreadId: providerTurn.providerThreadId,
          providerTurnId: providerTurn.id,
          nativeItemRef: { driver: BOB_PROVIDER, nativeId: nativeItemId, strength: "weak" },
          parentItemId: null,
          // The generic adapter numbers a turn's items from `ordinal * 100 + 1`, so this one
          // comes first.
          ordinal: providerTurn.ordinal * 100,
          type: "system_notice",
          status: "completed",
          title: message,
          message,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
        },
      },
    ];
  };
  const deleteTask = (taskCwd: string, sessionId: string) =>
    withShortLivedBob(taskCwd, (bob) => deleteBobSession(bob, sessionId)).pipe(Effect.asVoid);
  return {
    ...session,
    events: session.events.pipe(
      Stream.mapArray((events) => Arr.flatMap(events, withMissingModeNotice)),
    ),
    ensureThread: (input) => {
      follow(input.runtimePolicy);
      return session.ensureThread(input).pipe(Effect.mapError(explainSetup));
    },
    startTurn: (input) => {
      follow(input.runtimePolicy);
      const mode = modes.missing(input);
      if (mode !== undefined) missingModes.set(input.attemptId, { input, mode });
      return session.startTurn(input).pipe(
        Effect.mapError(explainSetup),
        Effect.tapError(() => Effect.sync(() => missingModes.delete(input.attemptId))),
      );
    },
    // Bob resumes a task only in the folder it started in, so a thread that moved copies its
    // task here with `_bob/task/export` and `_bob/task/import`, and the original goes once the
    // copy opens, so Bob's history and Bobcoin totals count the conversation once.
    resumeThread: (input) => {
      follow(input.runtimePolicy);
      return session.resumeThread(input).pipe(
        Effect.catchIf(
          (error) => isBobTaskNotHere(error) && bobTaskId(input.providerThread) !== undefined,
          (error) =>
            Effect.gen(function* () {
              const original = bobTaskId(input.providerThread)!;
              const target = cwd;
              const moved = yield* withShortLivedBob(target, (bob) =>
                moveBobTask(bob, original, target),
              );
              if (moved === undefined) return yield* error;
              const resumed = yield* session
                .resumeThread({
                  ...input,
                  providerThread: withBobTaskId(input.providerThread, moved),
                })
                .pipe(Effect.tapError(() => deleteTask(target, moved)));
              yield* deleteTask(target, original);
              return resumed;
            }),
        ),
        Effect.mapError(explainSetup),
      );
    },
    // ACP has no rewind, so the generic rollback starts an empty conversation. Bob's task is cut
    // instead at the first prompt Bob recorded once the first reverted turn began, as Bob's IDE
    // rolls a task back, and the thread continues in the cut copy.
    rollbackThread: (input) =>
      Effect.gen(function* () {
        const original = bobTaskId(input.providerThread);
        if (original === undefined || input.target.type === "thread_start") {
          const reset = yield* session.rollbackThread(input);
          if (original !== undefined) yield* deleteTask(cwd, original);
          return reset;
        }
        const targetOrdinal = input.target.providerTurn.ordinal;
        const reverted = input.providerThreadTurns.filter((turn) => turn.ordinal > targetOrdinal);
        const startedAtMs = reverted.flatMap((turn) =>
          turn.startedAt === null ? [] : [DateTime.toEpochMillis(turn.startedAt)],
        );
        const kept = input.providerThreadTurns.filter((turn) => turn.ordinal <= targetOrdinal);
        const unchanged: ProviderAdapter.ProviderAdapterV2ThreadSnapshot = {
          providerThread: input.providerThread,
          providerTurns: kept,
          messages: [],
          runtimeRequests: [],
        };
        // Nothing reverted reached Bob, so its conversation already ends before the cut.
        if (reverted.length === 0 || startedAtMs.length === 0) return unchanged;
        const taskCwd = cwd;
        const rewound = yield* withShortLivedBob(taskCwd, (bob) =>
          rewindBobTask(bob, original, taskCwd, { atMs: Math.min(...startedAtMs) }),
        );
        if (rewound === undefined || rewound._tag === "Failed") {
          return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
            driver: BOB_PROVIDER,
            providerThreadId: input.providerThread.id,
            checkpointId: input.target.checkpointId,
            cause: new Error(
              `Bob could not rewind its conversation: ${rewound?.detail ?? "Bob did not start."}`,
            ),
          });
        }
        if (rewound._tag === "Unchanged") return unchanged;
        // The generic rollback resets the adapter for the next turn and opens an empty session,
        // which the rewound task replaces; an emptied task leaves that session as the thread's.
        const reset = yield* session.rollbackThread(input);
        if (rewound._tag === "Emptied") {
          yield* deleteTask(taskCwd, original);
          return reset;
        }
        const replacement = bobTaskId(reset.providerThread);
        if (replacement !== undefined) yield* deleteTask(taskCwd, replacement);
        yield* deleteTask(taskCwd, original);
        return {
          ...reset,
          providerThread: withBobTaskId(reset.providerThread, rewound.sessionId),
        };
      }),
  };
}

export function makeBobAdapterV2(
  options: BobAdapterV2Options,
): ProviderAdapter.ProviderAdapterV2Shape {
  // The modes Bob offered in each folder, custom modes included.
  const offeredModes = new Map<string, ReadonlySet<string>>();
  const adapter = makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeBobAcpAdapterFlavor({
      ...options,
      onAvailableModes: (modes, cwd) => {
        offeredModes.set(cwd, new Set(modes.map((mode) => mode.id)));
        return options.onAvailableModes?.(modes, cwd) ?? Effect.void;
      },
    }),
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
  /** Runs `use` against a short-lived Bob in `cwd` that opens no session. Undefined if Bob fails. */
  const withShortLivedBob = <A>(
    cwd: string,
    use: (bob: AcpSessionRuntime.AcpSessionRuntime["Service"]) => Effect.Effect<A>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const bob = yield* makeBobAcpRuntime({
          bobSettings: options.settings,
          environment: options.environment,
          childProcessSpawner: options.childProcessSpawner,
          cwd,
          clientInfo: { name: "t3-code", version: "0.0.0" },
        });
        yield* bob.initialize();
        return yield* use(bob);
      }),
    ).pipe(
      Effect.provideService(Crypto.Crypto, options.crypto),
      Effect.orElseSucceed(() => undefined),
    );
  const explainSetup = (error: ProviderAdapter.ProviderAdapterV2Error) =>
    withBobSetupDetail(error, options.instanceId, options.settings.authMethod);
  const modes = {
    missing: (input: ProviderAdapter.ProviderAdapterV2TurnInput) => {
      const picked = input.modelSelection.options?.find(
        (option) => option.id === ACP_SESSION_MODE_OPTION_ID,
      )?.value;
      // Plan mode replaces the picked mode anyway.
      if (typeof picked !== "string" || input.runtimePolicy.interactionMode === "plan") {
        return undefined;
      }
      const offered = input.runtimePolicy.cwd
        ? offeredModes.get(input.runtimePolicy.cwd)
        : undefined;
      return offered === undefined || offered.has(picked) ? undefined : picked;
    },
    noticeItemId: (nativeItemId: string) =>
      options.idAllocator.derive.turnItemFromProviderItem({ driver: BOB_PROVIDER, nativeItemId }),
  };
  return {
    ...adapter,
    openSession: (input) =>
      adapter.openSession(input).pipe(
        Effect.mapError(explainSetup),
        Effect.map((session) =>
          wrapBobSession(
            session,
            input.runtimePolicy.cwd ?? process.cwd(),
            withShortLivedBob,
            explainSetup,
            modes,
          ),
        ),
      ),
  };
}
