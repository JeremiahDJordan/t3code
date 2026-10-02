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
  type BobSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type ProviderApprovalOption,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import type * as ServerConfig from "../../config.ts";
import {
  acpContentBlockDisplayText,
  type AcpSessionMode,
  type AcpToolCallState,
} from "../../provider/acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import { describeBobAcpSetupError, makeBobAcpRuntime } from "../../provider/acp/BobAcpSupport.ts";
import type * as IdAllocator from "../IdAllocator.ts";
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
    childSessionId: null,
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
  const state: BobRuntimeState = { answered: false, lastReply: "" };
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
            return commands.pipe(Effect.andThen(handler(notification)));
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

export function makeBobAdapterV2(options: BobAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeBobAcpAdapterFlavor(options),
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
}
