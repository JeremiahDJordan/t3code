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
import * as NodeOS from "node:os";

import {
  type BobAuthMethod,
  type BobRule,
  type BobRuleScope,
  type BobSettings,
  type ProjectId,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type ProviderApprovalOption,
  type ProviderInstanceId,
  ProviderSetupError,
  type RunAttemptId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  acpContentBlockDisplayText,
  type AcpSessionMode,
  type AcpToolCallState,
} from "@t3tools/provider-acp/server/runtimeModel";
import {
  acpPermissionDisposition,
  type AcpPermissionDisposition,
} from "@t3tools/provider-acp/server/clientPolicy";
import { ACP_SESSION_MODE_OPTION_ID } from "@t3tools/provider-acp/server/sessionConfig";
import {
  type BobRelayLink,
  type BobRelays,
  nativeBobToolCallId,
} from "../../provider/acp/BobRelay.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  bobApprovesItsOwnTools,
  deleteBobSession,
  describeBobAcpSetupError,
  makeBobAcpRuntime,
  moveBobTask,
  rewindBobTask,
} from "../../provider/acp/BobAcpSupport.ts";
import {
  BOB_NETWORK_ASK,
  BOB_NETWORK_OPTION_ID,
  type BobAutoJudge,
  type BobUserQuote,
} from "../../provider/acp/bobAutoJudge.ts";
import {
  type BobPermissionMode,
  type BobRuleSuggestion,
  type BobUserRules,
  asksByUserRule,
  describeBobToolCall,
  reviewBobPermission,
  suggestBobCommandRule,
} from "../../provider/acp/bobAutoReview.ts";
import {
  type BobSandbox,
  bobSandboxFolderSuggestion,
  makeBobSandbox,
} from "../../provider/acp/bobSandbox.ts";
import { bobBudgetResetsAt } from "../../provider/bobUsageLimits.ts";
import { isUserWritten, type BobStartingThread } from "../../provider/bobUserMessages.ts";
import { aliasActiveMcpCredential } from "../../mcp/McpSessionRegistry.ts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { TaskTranscript } from "../../provider/taskTranscript.ts";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";

const BOB_PROVIDER = ProviderDriverKind.make("bob");
/** Bob's default mode, which every turn starts from unless the thread picked another. */
const BOB_AGENT_MODE_ID = "agent";
const BOB_PLAN_MODE_ID = "plan";
export const BOB_EMPTY_REPLY_MESSAGE = "Bob ended its turn without replying.";
/** Marks the failure the runtime wrapper raises for a turn Bob ended without output. */
const BOB_EMPTY_REPLY_MARKER = "t3/bob-empty-reply";
/** How many of the latest messages to Bob Auto's reviewer judges a call against. */
const BOB_AUTO_REVIEW_REQUESTS = 6;
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
  // Bob takes one prompt at a time, so a steer lets the running tool calls finish, cancels the
  // prompt and continues the turn with the message as Bob's next prompt.
  turns: {
    ...AcpProviderCapabilitiesV2.turns,
    supportsActiveSteering: true,
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
 * "Always allow this session" appears only when Bob offers to remember the tool, and T3's own
 * options to add a rule, which clients show as one split button.
 */
function bobApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const bobs = request.options.filter((option) => !option.optionId.startsWith(BOB_RULE_OPTION));
  const offers = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    bobs.some((option) => option.kind === kind && option.optionId.trim());
  const rules = request.options.flatMap((option): Array<ProviderApprovalOption> => {
    if (bobRuleScopeOf(option.optionId) === undefined) return [];
    const warning = option._meta?.["warning"];
    return [
      {
        decision: "acceptAlways",
        optionId: option.optionId,
        label: option.name,
        ...(typeof warning === "string" && warning.trim() ? { warning } : {}),
      },
    ];
  });
  return [
    { decision: "cancel", label: "Cancel" },
    ...(offers("reject_once") ? [{ decision: "decline" as const, label: "Decline" }] : []),
    ...(offers("allow_always")
      ? [{ decision: "acceptForSession" as const, label: "Always allow this session" }]
      : []),
    ...rules,
    ...(offers("allow_once")
      ? [
          {
            decision: "accept" as const,
            label: "Approve",
            ...(request._meta?.[BOB_RUNS_OUTSIDE] === true
              ? { warning: "Runs the command outside the sandbox, as you." }
              : {}),
          },
        ]
      : []),
  ];
}

/**
 * Bob's permission request as T3 shows and answers it. Bob derives a tool's kind from its
 * permission group, and for web, MCP and other tools from its name: one named for a search
 * becomes a "search", which T3 takes for a file read and lets through in every mode, and one
 * named for a fetch shows as a file read. Every kind but an edit becomes "other", so it asks and
 * shows as the tool it is.
 */
export function normalizeBobPermissionRequest(
  request: EffectAcpSchema.RequestPermissionRequest,
): EffectAcpSchema.RequestPermissionRequest {
  const kind = request.toolCall.kind;
  // Options named like T3's own rule options are T3's to add, never Bob's.
  const options = request.options.filter((option) => bobRuleScopeOf(option.optionId) === undefined);
  return kind === "edit" || kind === "delete" || kind === "move"
    ? { ...request, options }
    : { ...request, options, toolCall: { ...request.toolCall, kind: "other" } };
}

/**
 * How the adapter answers Bob's permission requests: Accept edits lets Bob's edits through and
 * asks about the rest. In Auto, Bob's runtime wrapper already let through what the review allows,
 * so whatever reaches the adapter asks; upstream's Auto would approve everything when no sandbox
 * is set. In Full access Bob approves its own tools.
 */
export function bobPermissionDisposition(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  return policy.runtimeMode === "full-access"
    ? acpPermissionDisposition(policy, normalizeBobPermissionRequest(request))
    : "ask";
}

/** Bob reports a failed turn as a generic internal error with the reason in `data.details`. */
function bobErrorDetails(error: EffectAcpErrors.AcpRequestError): string | undefined {
  const details = asRecord(error.data)?.details;
  return typeof details === "string" && details.trim() ? details.trim() : undefined;
}

// Bob's own errors read `<name>: <data as JSON>`, and the data holds the text Bob shows.
const BOB_NAMED_ERROR = /^([A-Za-z]+Error): (\{[\s\S]*\})$/;
const decodeBobErrorData = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ description: Schema.optional(Schema.String) })),
);

/** The error Bob named for a failed turn, with the description Bob shows for it. */
function bobNamedError(error: EffectAcpErrors.AcpRequestError) {
  const match = bobErrorDetails(error)?.match(BOB_NAMED_ERROR);
  if (!match?.[1] || !match[2]) return undefined;
  const description = Option.getOrUndefined(decodeBobErrorData(match[2]))?.description?.trim();
  return { name: match[1], description: description || undefined };
}

/**
 * Whether a Bob error says Bobcoins ran out: a monthly budget, which resets with the month, or
 * a trial's, which waits for a plan change. Bob 2.0.5 raises the same `BudgetExceededError` for a
 * suspended plan and for a profile it could not read, so only its wording of a spent allowance
 * counts; Bob translates it, and another language reads as an ordinary failure.
 */
function bobBobcoinsSpent(
  named: NonNullable<ReturnType<typeof bobNamedError>>,
): "monthly" | "trial" | undefined {
  if (named.name === "TrialExpiredError") return "trial";
  if (named.name !== "BudgetExceededError") return undefined;
  return /budget allowance|team budget has been exceeded/i.test(named.description ?? "")
    ? "monthly"
    : undefined;
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
  /** In Auto, judges the tool calls the rules leave to what the user asked for. */
  readonly autoJudge?: BobAutoJudge | undefined;
  /** Keeps the reviewer open while a Bob runtime, which outlives a settings change, runs. */
  readonly holdAutoJudge?: Effect.Effect<void, never, Scope.Scope> | undefined;
  /**
   * The thread delegated work started in, from the agent's parent, and what the user wrote there,
   * or undefined when they cannot be read: the restrictions and permissions the agent works under.
   */
  readonly readStartingThread?: (
    parentThreadId: ThreadId,
  ) => Effect.Effect<BobStartingThread | undefined>;
}

/**
 * The user's own words in a prompt T3 sent Bob, without the instructions T3 wraps a turn's
 * message in; a steer is the words alone.
 */
function bobUserRequest(text: string): string {
  const start = text.indexOf(USER_REQUEST_OPEN);
  const end = text.lastIndexOf(USER_REQUEST_CLOSE);
  return (
    start >= 0 && end > start ? text.slice(start + USER_REQUEST_OPEN.length, end) : text
  ).trim();
}
const USER_REQUEST_OPEN = "<user_request>";
const USER_REQUEST_CLOSE = "</user_request>";

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
  /** Tool calls Bob is running in the current prompt, which a steer lets finish. */
  readonly openTools: Set<string>;
  /** Whether a prompt is with Bob, which a steer can interrupt. */
  prompting: boolean;
  /** Messages to steer the running prompt with, sent together as Bob's next prompt. */
  readonly steers: Array<string>;
  /** Whether the running prompt was cancelled for the waiting steers. */
  steerCancelled: boolean;
  /** The user stopped the running prompt, which sends Bob nothing more in this turn. */
  stopped: boolean;
  /** The thread picked to be asked about every call left to Auto's reviewer, as of its turn. */
  asksAboutNetwork: boolean;
  /**
   * What the user asked Bob lately, in turns' messages and steers, for Auto; the thread's, so a
   * runtime started for the thread keeps it. Its revision counts them, so a judgement made while
   * one came is not used.
   */
  readonly requests: BobUserRequests;
  /** The adapter's update handler, which takes the usage Bob does not report itself. */
  handler?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  captureProposedPlan?: (input: { readonly planMarkdown: string }) => Effect.Effect<void>;
}

const bobRuntimeStates = new WeakMap<object, BobRuntimeState>();

/** What a Bob session's next prompt does with a prompt Bob kept going while T3 restarted. */
interface BobTurnContext {
  /** The thread and project the turn belongs to, whose rules Bob's calls are answered by. */
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** The turn's message as Bob gets it, when the user wrote it, attachments included. */
  readonly userRequest: string | undefined;
  /** What the user typed, without attachments, which Auto's reviewer reads and quotes. */
  readonly userText: string | undefined;
  /**
   * The task another agent delegated to the thread, when this turn starts it: Auto's reviewer
   * judges by it but never quotes it, so nothing in it forbids or allows anything.
   */
  readonly delegatedTask: string | undefined;
  /** The thread that delegated the task, from which the thread the work started in is found. */
  readonly delegatedFrom: ThreadId | undefined;
  /** The thread picked to be asked about every call left to Auto's reviewer. */
  readonly asksAboutNetwork: boolean;
  /** A run T3 started to finish the prompt Bob kept going while T3 restarted: never prompts Bob. */
  readonly adoptOnly: boolean;
  /** Its message only asks Bob to go on, which a prompt Bob kept going already does. */
  readonly skipTextAfterAdoption: boolean;
}

/**
 * Each thread's next turn and its project, by thread id, which whichever runtime serves the
 * thread reads: the generic adapter may replace a runtime as the turn starts.
 */
interface BobThreadTurns {
  readonly next: Map<string, BobTurnContext>;
  readonly projects: Map<string, ProjectId>;
  /** What the user asked lately, which a runtime started for the thread keeps reading. */
  readonly requests: Map<string, BobUserRequests>;
  /** What the user wrote in threads delegated work started in, by thread id, quoted once. */
  readonly started: Map<string, BobStartedRequests>;
}

/**
 * What the user typed to Bob in one message: its text, dropped once the reviewer needs only its
 * quotes; what it forbade or allowed, once quoted; and the attempt at quoting it, while one runs.
 */
interface BobUserMessage {
  text: string;
  quotes: ReadonlyArray<BobUserQuote> | undefined;
  quoting: Deferred.Deferred<void> | undefined;
}

/**
 * What the user told Bob in a thread, for Auto's reviewer, oldest first: the latest messages, and
 * older ones whose restrictions are kept or not quoted yet; and a count of changes, so a
 * judgement made while one came is not used.
 */
interface BobUserRequests {
  readonly messages: Array<BobUserMessage>;
  revision: number;
  /**
   * Set when the thread works on a task another agent delegated: its messages are that task, and
   * the user's words come from the thread the work started in.
   */
  delegated?: {
    readonly from: ThreadId | undefined;
    startedIn: ThreadId | undefined;
    unreadable: boolean;
  };
}

/** What the user wrote in a thread delegated work started in, and the messages read so far, by id. */
interface BobStartedRequests extends BobUserRequests {
  readonly read: Set<string>;
}

/**
 * How many restrictions a thread keeps, and how much text of older messages waits to be quoted,
 * such as those sent outside Auto; past either the oldest go, as the reviewer's prompt drops its
 * oldest restrictions.
 */
const BOB_STANDING_RESTRICTIONS = 200;
const BOB_UNQUOTED_CHARACTERS = 50_000;
/** How many threads' requests the adapter keeps; the least recently served go first. */
const BOB_REQUEST_THREADS = 100;

/** The text of a message's quotes of one kind. */
const quoted = (quotes: ReadonlyArray<BobUserQuote>, kind: BobUserQuote["kind"]) =>
  quotes.filter((quote) => quote.kind === kind).map((quote) => quote.text);

/**
 * Forgets what the reviewer no longer needs, keeping the latest messages whole. The messages of a
 * thread delegated work started in skip the cap on unquoted text: they arrive together, at most
 * a read's worth, and the reviewer sees them only as quotes, so one dropped before it is quoted
 * would lose its restriction for good.
 */
function trimBobUserRequests(requests: BobUserRequests, keepUnquoted = false): void {
  const latest = requests.messages.length - BOB_AUTO_REVIEW_REQUESTS;
  let quotes = 0;
  let unquoted = 0;
  const kept: Array<BobUserMessage> = [];
  for (let at = requests.messages.length - 1; at >= 0; at -= 1) {
    const message = requests.messages[at]!;
    if (at < latest) {
      if (message.quotes === undefined) {
        unquoted += message.text.length;
        if (unquoted > BOB_UNQUOTED_CHARACTERS && !keepUnquoted) continue;
      } else {
        if (message.quotes.length === 0 || quotes >= BOB_STANDING_RESTRICTIONS) continue;
        message.text = "";
      }
    }
    quotes += message.quotes?.length ?? 0;
    kept.push(message);
  }
  requests.messages.splice(0, requests.messages.length, ...kept.toReversed());
}
/**
 * How long a review waits for a message's restrictions to be quoted, about twenty parts of a long
 * message on Apple's model, before it judges without them.
 */
const BOB_QUOTE_WAIT = "30 seconds";

const makeBobUserRequests = (): BobUserRequests => ({ messages: [], revision: 0 });

/** A thread's requests, or a runtime's own when it serves no thread. */
function requestsOf(turns: BobThreadTurns, threadId: string | undefined): BobUserRequests {
  if (threadId === undefined) return makeBobUserRequests();
  const requests = turns.requests.get(threadId) ?? makeBobUserRequests();
  turns.requests.delete(threadId);
  turns.requests.set(threadId, requests);
  for (const oldest of turns.requests.keys()) {
    if (turns.requests.size <= BOB_REQUEST_THREADS) break;
    turns.requests.delete(oldest);
  }
  return requests;
}

const makeBobThreadTurns = (): BobThreadTurns => ({
  next: new Map(),
  projects: new Map(),
  requests: new Map(),
  started: new Map(),
});

/** What the user wrote in the thread `threadId`, kept for the least recently served threads. */
function startedRequestsOf(turns: BobThreadTurns, threadId: ThreadId): BobStartedRequests {
  const started = turns.started.get(threadId) ?? {
    messages: [],
    revision: 0,
    read: new Set<string>(),
  };
  turns.started.delete(threadId);
  turns.started.set(threadId, started);
  for (const oldest of turns.started.keys()) {
    if (turns.started.size <= BOB_REQUEST_THREADS) break;
    turns.started.delete(oldest);
  }
  return started;
}

/** How Bob's session wrapper reaches the runtime of a Bob session, by Bob's task id. */
interface BobSessionControl {
  /**
   * Steers the running prompt with a message, which Auto's reviewer reads when the user wrote it;
   * false when no prompt is with Bob.
   */
  /** Steers the running prompt with `text`; `userText` is what the user typed, if they wrote it. */
  readonly steer: (text: string, userText: string | undefined) => Effect.Effect<boolean>;
  /** Tells a relay whose thread its Bob works for, so a T3 that restarts mid-turn finds it. */
  readonly describe: (owner: {
    readonly threadId: string;
    readonly providerThreadId: string;
  }) => Effect.Effect<void>;
}

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
      if (update.status !== "completed" && update.status !== "failed") {
        state.openTools.add(update.toolCallId);
      }
      return;
    case "tool_call_update":
      state.answered = true;
      if (update.status === "completed" || update.status === "failed") {
        state.openTools.delete(update.toolCallId);
      }
      return;
    case "plan":
    case "plan_update":
      state.answered = true;
      return;
    default:
      return;
  }
}

/** The command line of a command Bob asks to run. */
function commandOf(request: EffectAcpSchema.RequestPermissionRequest): string | undefined {
  const command = asRecord(request.toolCall.rawInput)?.command;
  return request.toolCall.kind === "execute" && typeof command === "string" ? command : undefined;
}

/**
 * Whether a command that failed in the sandbox was stopped by it rather than failing on its own:
 * a denied file operation or no network, as a test needing a server or a cache outside the
 * project hits.
 */
function bobSandboxDenied(update: EffectAcpSchema.ToolCallUpdate): boolean {
  // The end of the output, where a run the sandbox stopped says so, however long it ran.
  const output = [
    ...(update.content ?? []).map((content) =>
      content.type === "content"
        ? content.content.type === "text"
          ? content.content.text.slice(-16_384)
          : (acpContentBlockDisplayText(content.content) ?? "")
        : "",
    ),
    typeof update.rawOutput === "string"
      ? update.rawOutput
      : JSON.stringify(update.rawOutput ?? ""),
  ].join("\n");
  return /sandbox-exec:|operation not permitted|EPERM|EACCES|could not resolve host|ENOTFOUND|EAI_AGAIN|getaddrinfo|nodename nor servname|network is unreachable|couldn't connect to server|ECONNREFUSED/i.test(
    output,
  );
}

/**
 * The first absolute path a command the sandbox stopped names beside the denial, such as
 * `open '/Users/me/.vercel/auth.json'` after `EPERM`, which a card offers to open.
 */
function bobSandboxDeniedPath(update: EffectAcpSchema.ToolCallUpdate): string | undefined {
  const output = (update.content ?? [])
    .map((content) =>
      content.type === "content" && content.content.type === "text"
        ? content.content.text.slice(-16_384)
        : "",
    )
    .join("\n");
  for (const line of output.split("\n")) {
    if (!/operation not permitted|EPERM|EACCES/i.test(line)) continue;
    const path = /(?:^|[\s'"`(:=])(\/[^\s'"`():,;]+)/.exec(line)?.[1];
    if (path !== undefined) return path.replace(/[.]+$/, "");
  }
  return undefined;
}

/** The user's permission rules for Bob as settings keep them, shared by every Bob instance. */
export interface BobSavedRules {
  readonly rules: ReadonlyArray<BobRule>;
  /** The scope a card offers first: the one the user picked last. */
  readonly scope: BobRuleScope;
}

/** Where the adapter reads and saves the user's rules. */
export interface BobRulesSource {
  readonly get: Effect.Effect<BobSavedRules>;
  /** Subscribes to changes, before a read, so none falls between the two. */
  readonly subscribe: Effect.Effect<Stream.Stream<BobSavedRules>, never, Scope.Scope>;
  /** Saves a rule a card added and remembers the scope picked; whether it was saved. */
  readonly add: (rule: BobRule, scope: BobRuleScope) => Effect.Effect<boolean>;
}

/** The rules a Bob runtime answers by, and the thread and project they apply in. */
interface BobRuntimeRules {
  saved: BobSavedRules;
  /** Counts changes, so a decision taken while the rules changed is taken again. */
  revision: number;
  /** The workspace, which rules' `./` paths start from. */
  readonly workspace: string;
  threadId: ThreadId | undefined;
  projectId: ProjectId | undefined;
  readonly home: string;
  /** T3's home, whose folders a card never offers to open. */
  readonly t3Home: string;
  readonly source: BobRulesSource | undefined;
  /** Applies the rules to the runtime's sandbox, once the runtime has one. */
  refresh: () => void;
}

/**
 * The rules that apply in a runtime's thread and project, with paths made absolute: `~/` from the
 * home folder, and any other relative path, `./` or not, from the workspace, so none is dropped.
 */
function bobUserRules(rules: BobRuntimeRules): BobUserRules {
  const applying = rules.saved.rules.filter(
    (rule) =>
      (rule.projectId === undefined || rule.projectId === rules.projectId) &&
      (rule.threadId === undefined || rule.threadId === rules.threadId),
  );
  const values = (kind: BobRule["kind"]) =>
    applying.filter((rule) => rule.kind === kind).map((rule) => rule.value);
  const paths = (kind: BobRule["kind"]) =>
    values(kind).flatMap((value) => {
      if (value === "~" || value.startsWith("~/")) return [`${rules.home}${value.slice(1)}`];
      // `~user` names another account's home, which no rule here reaches.
      if (value.startsWith("~")) return [];
      if (value.startsWith("/")) return [value];
      if (value === ".") return [rules.workspace];
      return [`${rules.workspace}/${value.startsWith("./") ? value.slice(2) : value}`];
    });
  return {
    allowCommands: values("allow-command"),
    askCommands: values("ask-command"),
    read: paths("read"),
    write: paths("write"),
    private: paths("private"),
  };
}

/**
 * A path as a rule keeps it: from `./` in the workspace, so a project's rule follows it into each
 * thread's worktree, and from `~/` in the home folder.
 */
function bobRulePath(path: string, home: string, workspace: string): string {
  const under = (root: string) => (root.endsWith("/") ? root : `${root}/`);
  if (path.startsWith(under(workspace))) return `./${path.slice(under(workspace).length)}`;
  return path.startsWith(under(home)) ? `~/${path.slice(under(home).length)}` : path;
}

/** Marks a request whose approval runs the command outside the sandbox. */
const BOB_RUNS_OUTSIDE = "t3RunsOutsideSandbox";

/** Card options that add a rule are T3's own, beside Bob's, one per scope. */
const BOB_RULE_OPTION = "t3-rule:";
const BOB_RULE_SCOPES: ReadonlyArray<BobRuleScope> = ["thread", "project", "global"];
const BOB_RULE_SCOPE_WORDS: Record<BobRuleScope, string> = {
  thread: "in this thread",
  project: "in this project",
  global: "in every project",
};

function bobRuleScopeOf(optionId: string): BobRuleScope | undefined {
  const scope = optionId.startsWith(BOB_RULE_OPTION)
    ? optionId.slice(BOB_RULE_OPTION.length)
    : undefined;
  return BOB_RULE_SCOPES.find((candidate) => candidate === scope);
}

function bobRuleLabel(suggestion: BobRuleSuggestion, scope: BobRuleScope): string {
  const where = BOB_RULE_SCOPE_WORDS[scope];
  switch (suggestion.kind) {
    case "allow-command":
      return `Always allow \`${suggestion.value}\` ${where}`;
    case "read":
      return `Always allow reading ${suggestion.value} ${where}`;
    case "write":
      return `Always allow writing in ${suggestion.value} ${where}`;
  }
}

/**
 * Bob's request with T3's options to add a rule, one per scope, the one the user picked last
 * first. A rule for the project needs the project known.
 */
function withRuleOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
  suggestion: BobRuleSuggestion,
  rules: BobRuntimeRules,
): EffectAcpSchema.RequestPermissionRequest {
  const scopes = [
    rules.saved.scope,
    ...BOB_RULE_SCOPES.filter((scope) => scope !== rules.saved.scope),
  ].filter(
    (scope) =>
      rules.source !== undefined &&
      (scope !== "thread" || rules.threadId !== undefined) &&
      (scope !== "project" || rules.projectId !== undefined),
  );
  return {
    ...request,
    options: [
      ...request.options,
      ...scopes.map((scope) => ({
        optionId: `${BOB_RULE_OPTION}${scope}`,
        name: bobRuleLabel(suggestion, scope),
        kind: "allow_once" as const,
        ...(suggestion.warning === undefined ? {} : { _meta: { warning: suggestion.warning } }),
      })),
    ],
  };
}

/** What a Bob runtime's wrapper works with beyond the runtime itself. */
interface BobRuntimeExtras {
  /** For an instance that runs Bob in tmux, the relay this Bob runs under. */
  readonly link?: BobRelayLink | undefined;
  /** Done once the runtime has recorded that its Bob exited. */
  readonly terminated?: Deferred.Deferred<void> | undefined;
  /** The `Authorization` header of the MCP credential this T3 issued the session. */
  readonly mcpAuthorization?: string | undefined;
  /**
   * Outside Full access: the mode Bob's tool calls are answered in, the workspace they are
   * reviewed against, and the sandbox Bob's commands run in, where this host has one.
   */
  readonly review?:
    | {
        readonly mode: BobPermissionMode;
        readonly workspace: string | null;
        readonly sandbox: BobSandbox | undefined;
      }
    | undefined;
  /** The user's rules, outside Full access. */
  readonly rules?: BobRuntimeRules | undefined;
  /** The thread the runtime serves, whose next turn it takes from `turns`. */
  readonly threadId?: string | undefined;
  readonly turns?: BobThreadTurns | undefined;
  /** The runtime's scope, which owns its work apart from the turn. */
  readonly scope?: Scope.Scope | undefined;
}

/**
 * Bob's runtime as the ACP adapter sees it: saved sessions resume instead of replaying their
 * history, the workspace's commands and modes reach the provider snapshot, a plan turn proposes
 * its final reply, a turn Bob ends without output fails as retryable, and in Auto a tool call the
 * review lets through runs without the adapter asking.
 */
function wrapBobRuntime(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  cwd: string,
  hooks: BobAdapterV2Hooks,
  sessions: Map<string, BobSessionControl>,
  {
    link,
    terminated,
    mcpAuthorization,
    review: answering,
    rules,
    threadId,
    turns = makeBobThreadTurns(),
    scope,
  }: BobRuntimeExtras = {},
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  const state: BobRuntimeState = {
    answered: false,
    lastReply: "",
    runningSubagents: new Set(),
    openTools: new Set(),
    prompting: false,
    steers: [],
    steerCancelled: false,
    stopped: false,
    asksAboutNetwork: false,
    requests: requestsOf(turns, threadId),
  };
  /** Keeps a message the user sent Bob for Auto's reviewer, which reads the latest few. */
  const remember = (request: string) =>
    Effect.suspend(() => {
      if (!request) return Effect.void;
      const requests = state.requests;
      requests.revision += 1;
      requests.messages.push({ text: request, quotes: undefined, quoting: undefined });
      trimBobUserRequests(requests);
      // The reviewer quotes its restrictions now, so they hold once it leaves the latest messages.
      return quoteRestrictions;
    });
  /**
   * Keeps the task another agent delegated to this thread, which the reviewer judges calls by
   * but never quotes, and reads what the user wrote in the thread the work started in.
   */
  const rememberTask = (task: string, from: ThreadId | undefined) =>
    Effect.suspend(() => {
      const requests = state.requests;
      // Unreadable until read: with no way to read the user's words, the task's calls ask.
      requests.delegated = { from, startedIn: undefined, unreadable: from !== undefined };
      if (task) {
        requests.revision += 1;
        requests.messages.push({ text: task, quotes: [], quoting: undefined });
        trimBobUserRequests(requests);
      }
      return readStarted;
    });
  /**
   * Adds what the user wrote since the last read in the thread the delegated work started in,
   * then quotes it: its restrictions and permissions are the ones the task works under.
   */
  const readStarted = Effect.suspend(() => {
    const delegated = state.requests.delegated;
    const read = hooks.readStartingThread;
    if (delegated?.from === undefined || read === undefined) return Effect.void;
    return read(delegated.from).pipe(
      Effect.flatMap((starting) =>
        Effect.suspend(() => {
          // A starting thread where the user wrote nothing, such as an agent's fork or a thread
          // an agent created, gives no restrictions to keep: the task's calls ask, as a thread
          // the user never wrote in does.
          delegated.unreadable = starting === undefined || starting.messages.length === 0;
          if (starting === undefined || starting.messages.length === 0) {
            state.requests.revision += 1;
            return Effect.void;
          }
          delegated.startedIn = starting.threadId;
          const started = startedRequestsOf(turns, starting.threadId);
          let added = false;
          for (const message of starting.messages) {
            if (started.read.has(message.id)) continue;
            started.read.add(message.id);
            const text = message.text.trim();
            if (!text) continue;
            started.messages.push({ text, quotes: undefined, quoting: undefined });
            added = true;
          }
          if (added) {
            started.revision += 1;
            trimBobUserRequests(started, true);
          }
          return quoteRestrictions;
        }),
      ),
    );
  });
  /**
   * In Auto, while the thread lets the reviewer decide, quotes what the messages not quoted yet
   * forbid or allow, newest first, apart from the turn and within the runtime's life; nothing else
   * sends the user's messages to the reviewer. At the first that fails the rest wait for the next
   * message or review, so a reviewer that is down gets one request each time. A new quote changes
   * what the reviewer judges by.
   */
  const quoteRestrictions = Effect.suspend(() => {
    const startedIn = state.requests.delegated?.startedIn;
    const sets = [
      ...(startedIn === undefined
        ? []
        : [{ requests: startedRequestsOf(turns, startedIn), from: startedIn, started: true }]),
      { requests: state.requests, from: threadId, started: false },
    ];
    const extract = hooks.autoJudge?.extract;
    if (
      extract === undefined ||
      answering?.mode !== "auto" ||
      state.asksAboutNetwork ||
      scope === undefined
    ) {
      return Effect.void;
    }
    const idle = sets.flatMap(({ requests, from, started }) =>
      requests.messages
        .filter((message) => message.quotes === undefined && message.quoting === undefined)
        .map((message) => ({ message, requests, from, started }))
        .toReversed(),
    );
    if (idle.length === 0) return Effect.void;
    return Effect.gen(function* () {
      const quoting = yield* Deferred.make<void>();
      for (const { message } of idle) message.quoting = quoting;
      yield* Effect.gen(function* () {
        for (const { message, requests, from, started } of idle) {
          const quotes = yield* extract(message.text);
          // What the reviewer took from each message, in the trace file for the Auto audit.
          yield* Effect.logInfo(
            quotes === undefined
              ? "Auto's reviewer could not quote the user's message"
              : "Auto's reviewer quoted the user's message",
          ).pipe(
            Effect.withSpan("bob.auto.quote", {
              attributes: {
                "bob.thread": from ?? "",
                "bob.reviewer": hooks.autoJudge?.name ?? "",
                "bob.characters": message.text.length,
                "bob.quoted": quotes !== undefined,
                ...(quotes === undefined
                  ? {}
                  : {
                      "bob.forbids": quoted(quotes, "forbids"),
                      "bob.allows": quoted(quotes, "allows"),
                    }),
              },
            }),
          );
          if (quotes === undefined) return;
          message.quotes = quotes;
          message.quoting = undefined;
          if (quotes.length > 0) requests.revision += 1;
          trimBobUserRequests(requests, started);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const { message } of idle) {
              if (message.quoting === quoting) message.quoting = undefined;
            }
          }).pipe(Effect.andThen(Deferred.succeed(quoting, undefined))),
        ),
        Effect.forkIn(scope),
      );
    });
  });
  /**
   * Cancels the running prompt for waiting steers once Bob runs no tool call, so a tool call Bob
   * started finishes rather than being cancelled. Bob records tool results before it asks the
   * model again, so the steer continues from them; what it loses is the reply in progress. The
   * cancel runs apart from Bob's updates, since it waits for the prompt to end.
   */
  const interruptForSteer = Effect.suspend(() => {
    if (
      state.steers.length === 0 ||
      !state.prompting ||
      state.steerCancelled ||
      state.openTools.size > 0
    ) {
      return Effect.void;
    }
    state.steerCancelled = true;
    // A tool call Bob started meanwhile holds the steer again, and its end tries once more.
    return Effect.suspend(() => {
      if (state.openTools.size === 0) return runtime.cancel.pipe(Effect.ignore);
      state.steerCancelled = false;
      return Effect.void;
    }).pipe(Effect.forkDetach, Effect.asVoid);
  });
  /** Keeps the waiting steers in the relay, so a T3 that takes Bob's prompt over sends them. */
  const saveSteers = link
    ? Effect.suspend(() => link.setMeta({ steers: [...state.steers] }))
    : Effect.void;
  /** Sends the waiting steers as Bob's next prompt until none wait; the relay drops them then. */
  const promptSteers = (payload: Parameters<typeof runtime.prompt>[0], steers: Array<string>) =>
    Effect.suspend(() => {
      state.openTools.clear();
      state.steerCancelled = false;
      return runtime.prompt({ ...payload, prompt: [{ type: "text", text: steers.join("\n\n") }] });
    });
  const sendSteers = (
    payload: Parameters<typeof runtime.prompt>[0],
    last: EffectAcpSchema.PromptResponse,
  ) =>
    Effect.gen(function* () {
      let result = last;
      for (let steers = state.steers.splice(0); steers.length > 0;) {
        result = yield* promptSteers(payload, steers);
        steers = state.steers.splice(0);
      }
      return result;
    });
  const control: BobSessionControl = {
    steer: (text, userText) =>
      Effect.suspend(() => {
        if (!state.prompting) return Effect.succeed(false);
        state.steers.push(text);
        return (userText === undefined ? Effect.void : remember(userText)).pipe(
          Effect.andThen(saveSteers),
          Effect.andThen(interruptForSteer),
          Effect.as(true),
        );
      }),
    describe: (owner) => (link ? link.setMeta(owner) : Effect.void),
  };
  /**
   * After a prompt that took over one Bob kept going while T3 restarted: stops that Bob, which
   * holds the MCP credential of the T3 before. It ends before the turn does, so the adapter knows
   * to start a Bob with this T3's for the next turn.
   */
  const retireIfAdopted = link
    ? link.adopted.pipe(
        Effect.flatMap((adopted) =>
          adopted
            ? link.retire.pipe(
                Effect.andThen(
                  terminated
                    ? Deferred.await(terminated).pipe(Effect.timeout("5 seconds"), Effect.ignore)
                    : Effect.void,
                ),
              )
            : Effect.void,
        ),
      )
    : Effect.void;
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
      // Bob's task database knows the subagent by the id Bob gave it, before any renaming.
      const transcript = yield* hooks.readSubagentSteps(
        notification.sessionId,
        nativeBobToolCallId(update.toolCallId),
      );
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
      sessions.set(started.sessionId, control);
      if (link) {
        yield* link.setMeta({ sessionId: started.sessionId });
        // A Bob kept running while T3 restarted calls T3's tools with the token the T3 before
        // gave it, which this T3 accepts as its own credential for the session.
        const keptHash = (yield* link.kept)?.mcpTokenHash;
        if (keptHash !== undefined && mcpAuthorization !== undefined) {
          yield* aliasActiveMcpCredential(mcpAuthorization, keptHash);
        }
      }
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
  /**
   * Outside Full access, Bob's answer for a tool call the mode lets through while a prompt runs:
   * allow once, so Bob does not remember the tool for later calls. In Auto, a call the rules leave
   * to review goes to the reviewer model, judged against what the user asked; a command it lets
   * through, which needs the network, runs outside the sandbox. None for a call the user decides,
   * including one the user stopped the prompt during. Each answer in Auto, and why, goes to the
   * trace file as a `bob.auto.decision` span, which `scripts/bob-auto-audit.ts` reads.
   */
  const autoAnswer = (request: EffectAcpSchema.RequestPermissionRequest) =>
    decideAuto(request).pipe(
      Effect.tap((outcome) => {
        if (outcome === undefined || answering?.mode !== "auto") return Effect.void;
        return Effect.logInfo(
          outcome.answer === undefined
            ? "Auto asked about a Bob tool call"
            : "Auto allowed a Bob tool call",
        ).pipe(
          Effect.withSpan("bob.auto.decision", {
            attributes: {
              "bob.thread": threadId ?? "",
              "bob.tool_call": request.toolCall.toolCallId,
              "bob.tool": request.toolCall.title ?? "",
              "bob.kind": request.toolCall.kind ?? "other",
              "bob.call": describeBobToolCall(request.toolCall, answering),
              "bob.decision": outcome.answer === undefined ? "ask" : "allow",
              "bob.by": outcome.by,
              "bob.reason": outcome.reason,
            },
          }),
        );
      }),
      Effect.map((outcome) => outcome?.answer),
    );
  /** Who answered a tool call in `decideAuto`, and why; no answer leaves it to the user. */
  const asks = (by: string, reason: string) => ({ answer: undefined, by, reason });
  const allows = (optionId: string, by: string, reason: string) => ({
    answer: { outcome: { outcome: "selected" as const, optionId } },
    by,
    reason,
  });
  const decideAuto = (request: EffectAcpSchema.RequestPermissionRequest) =>
    Effect.gen(function* () {
      const reviewing = () => answering !== undefined && state.prompting && !state.stopped;
      const option = request.options.find((candidate) => candidate.kind === "allow_once");
      if (answering === undefined || !reviewing() || option === undefined) return undefined;
      // A sandbox whose shell went missing no longer bounds what Bob runs.
      const sandboxed = answering.sandbox?.ready() === true;
      const command = commandOf(request);
      const context =
        rules === undefined ? answering : { ...answering, rules: bobUserRules(rules) };
      const decision = reviewBobPermission(request.toolCall, {
        mode: answering.mode,
        sandboxed,
        context,
      });
      if (decision.outside === true) {
        letOutOfSandbox(request);
        return allows(option.optionId, "user rule", decision.reason);
      }
      // The sandbox stopped this command before; the user decides whether it runs outside.
      if (command !== undefined && sandboxCalls.deniedCommands.has(command)) {
        return asks("sandbox", "the sandbox stopped this command before");
      }
      if (decision.verdict === "review") {
        // Only the user's own request can call for such a call, unless the thread asks about all.
        if (hooks.autoJudge === undefined) return asks("rules", "no reviewer");
        if (state.asksAboutNetwork)
          return asks("rules", "the thread asks about every network call");
        if (state.requests.messages.length === 0) return asks("rules", "no message from the user");
        // Restrictions being quoted are waited for, so a long message does not make its turn's
        // calls ask. A message still not quoted is judged by only while it is shown whole; one
        // that left the latest messages unquoted asks, and is quoted again meanwhile. A delegated
        // task works under what the user wrote where the work started, which the reviewer sees
        // only as quotes, so all of it must be quoted.
        const requests = state.requests;
        // What the user wrote where the work started since the turn began binds this call too.
        if (requests.delegated !== undefined) yield* readStarted;
        const startedIn = requests.delegated?.startedIn;
        const started = startedIn === undefined ? undefined : startedRequestsOf(turns, startedIn);
        if (requests.delegated?.unreadable) {
          return asks("rules", "the user's messages where the work started could not be read");
        }
        yield* quoteRestrictions;
        yield* Effect.forEach(
          [...(started?.messages ?? []), ...requests.messages],
          (message) => (message.quoting ? Deferred.await(message.quoting) : Effect.void),
          { discard: true },
        ).pipe(Effect.timeout(BOB_QUOTE_WAIT), Effect.ignore);
        const unquoted = [
          ...(started?.messages ?? []),
          ...requests.messages.slice(0, -BOB_AUTO_REVIEW_REQUESTS),
        ].some((message) => message.quotes === undefined);
        if (
          started !== undefined &&
          hooks.autoJudge.extract === undefined &&
          started.messages.length > 0
        ) {
          return asks(
            "rules",
            "the reviewer cannot quote the user's messages where the work started",
          );
        }
        if (hooks.autoJudge.extract !== undefined && unquoted) {
          return asks("rules", "an older message is not quoted yet");
        }
        const revision = () => requests.revision + (started?.revision ?? 0);
        const asked = { requests: revision(), rules: rules?.revision };
        const judgement = yield* hooks.autoJudge.judge({
          userMessages: requests.messages
            .slice(-BOB_AUTO_REVIEW_REQUESTS)
            .map((message) => ({ text: message.text, extracted: message.quotes !== undefined })),
          standing: [...(started?.messages ?? []), ...requests.messages].flatMap((message) =>
            message.quotes !== undefined && message.quotes.length > 0 ? [message.quotes] : [],
          ),
          ...(requests.delegated === undefined ? {} : { delegated: true }),
          call: describeBobToolCall(request.toolCall, context),
        });
        const reviewer = `reviewer (${hooks.autoJudge.name})`;
        if (judgement.decision !== "allow") return asks(reviewer, judgement.reason);
        // A message or a rule that came while the model judged may say otherwise.
        const unchanged = revision() === asked.requests && rules?.revision === asked.rules;
        if (!reviewing() || !unchanged) {
          return asks(reviewer, `allowed, then the request or rules changed: ${judgement.reason}`);
        }
        letOutOfSandbox(request);
        return allows(option.optionId, reviewer, judgement.reason);
      }
      if (decision.verdict !== "allow") return asks("rules", decision.reason);
      if (command !== undefined && sandboxed) {
        sandboxCalls.running.set(request.toolCall.toolCallId, command);
      }
      return allows(option.optionId, "rules", decision.reason);
    });
  /**
   * The sandbox's bookkeeping for this Bob: commands running in it, by tool call, to notice one
   * the sandbox stops; commands it stopped, which ask next time; and tool calls let out, whose
   * end drops any approval left.
   */
  const sandboxCalls = {
    running: new Map<string, string>(),
    /** Each with the path the sandbox stopped it at, where its output names one. */
    deniedCommands: new Map<string, string | undefined>(),
    /** Each approved call's approval file, which its end lets go of. */
    approvedCalls: new Map<string, string>(),
  };
  /** Lets a command run outside the sandbox once, as approved, in the folder it asked to. */
  const letOutOfSandbox = (request: EffectAcpSchema.RequestPermissionRequest) => {
    const command = commandOf(request);
    if (command === undefined || answering?.sandbox === undefined) return;
    const base = answering.workspace ?? cwd;
    const folder = asRecord(request.toolCall.rawInput)?.cwd;
    const where =
      typeof folder !== "string" ? base : folder.startsWith("/") ? folder : `${base}/${folder}`;
    const approval = answering.sandbox.approveOutside(command, where);
    sandboxCalls.approvedCalls.set(request.toolCall.toolCallId, approval);
    sandboxCalls.deniedCommands.delete(command);
  };
  /** Follows Bob's tool calls through the sandbox as they end. */
  const followSandboxedCall = (update: EffectAcpSchema.SessionUpdate) => {
    if (update.sessionUpdate !== "tool_call_update") return;
    if (update.status !== "completed" && update.status !== "failed") return;
    const id = update.toolCallId;
    // Approvals still waiting for other approved calls stay; any other was left by a command.
    if (sandboxCalls.approvedCalls.delete(id)) {
      answering?.sandbox?.dropApprovals(new Set(sandboxCalls.approvedCalls.values()));
    }
    const command = sandboxCalls.running.get(id);
    if (command === undefined) return;
    sandboxCalls.running.delete(id);
    if (update.status === "failed" && bobSandboxDenied(update))
      sandboxCalls.deniedCommands.set(command, bobSandboxDeniedPath(update));
  };
  /**
   * The rule a card offers for a call it asks about: after the sandbox stopped a command at a
   * folder it keeps closed, to open that folder; otherwise to run commands starting like it
   * without asking.
   */
  const ruleFor = (
    request: EffectAcpSchema.RequestPermissionRequest,
  ): BobRuleSuggestion | undefined => {
    const command = commandOf(request);
    if (answering === undefined || rules === undefined || command === undefined) return undefined;
    // A command the user's own rule asks about gets no rule that could not apply to it.
    if (asksByUserRule(command, bobUserRules(rules))) return undefined;
    const path = sandboxCalls.deniedCommands.get(command);
    const folder =
      path === undefined
        ? undefined
        : bobSandboxFolderSuggestion(path, {
            home: rules.home,
            workspace: answering.workspace ?? cwd,
            t3Home: rules.t3Home,
            rules: bobUserRules(rules),
          });
    return folder === undefined
      ? suggestBobCommandRule(command)
      : { kind: folder.kind, value: bobRulePath(folder.folder, rules.home, rules.workspace) };
  };
  /**
   * A card option that adds a rule: T3 keeps the rule, for the thread or in settings, and answers
   * Bob's request once. A command rule runs the command outside the sandbox; a folder rule runs it
   * in the sandbox, which now opens the folder.
   */
  const addRule = (
    request: EffectAcpSchema.RequestPermissionRequest,
    suggestion: BobRuleSuggestion,
    scope: BobRuleScope,
  ) =>
    Effect.gen(function* () {
      const option = request.options.find((candidate) => candidate.kind === "allow_once");
      if (rules === undefined || option === undefined) {
        return { outcome: { outcome: "cancelled" as const } };
      }
      const rule: BobRule = {
        kind: suggestion.kind,
        value: suggestion.value,
        ...(scope !== "global" && rules.projectId !== undefined
          ? { projectId: rules.projectId }
          : {}),
        ...(scope === "thread" && rules.threadId !== undefined ? { threadId: rules.threadId } : {}),
      };
      // The rule applies once settings keep it; the user approved this run either way.
      const saved = (yield* rules.source?.add(rule, scope) ?? Effect.succeed(false)) === true;
      if (saved) {
        rules.saved = { rules: [...rules.saved.rules, rule], scope };
        rules.revision += 1;
        rules.refresh();
      }
      const command = commandOf(request);
      // A folder rule that could not be saved leaves the command in the sandbox, to ask again.
      if (suggestion.kind === "allow-command") {
        letOutOfSandbox(request);
      } else if (saved && command !== undefined && answering?.sandbox?.ready() === true) {
        sandboxCalls.deniedCommands.delete(command);
        sandboxCalls.running.set(request.toolCall.toolCallId, command);
      }
      return { outcome: { outcome: "selected" as const, optionId: option.optionId } };
    });
  /** The user's answer on a card in Auto, beside Auto's decision to ask, for the audit. */
  const recordUserAnswer = (
    request: EffectAcpSchema.RequestPermissionRequest,
    response: EffectAcpSchema.RequestPermissionResponse,
  ) => {
    if (answering?.mode !== "auto") return Effect.void;
    const chosen = response.outcome.outcome === "selected" ? response.outcome.optionId : undefined;
    const scope = typeof chosen === "string" ? bobRuleScopeOf(chosen) : undefined;
    const kind = request.options.find((option) => option.optionId === chosen)?.kind;
    const answer =
      chosen === undefined
        ? "cancelled"
        : scope !== undefined
          ? `rule (${scope})`
          : kind?.startsWith("allow")
            ? "allow"
            : "reject";
    return Effect.logInfo("The user answered a Bob tool call Auto asked about").pipe(
      Effect.withSpan("bob.auto.answer", {
        attributes: {
          "bob.thread": threadId ?? "",
          "bob.tool_call": request.toolCall.toolCallId,
          "bob.answer": answer,
        },
      }),
    );
  };
  /** A command the user approved on a card runs outside the sandbox, as Codex's do. */
  const userApproved = (
    request: EffectAcpSchema.RequestPermissionRequest,
    response: EffectAcpSchema.RequestPermissionResponse,
  ) =>
    Effect.sync(() => {
      if (response.outcome.outcome !== "selected") return;
      const optionId = response.outcome.optionId;
      const kind = request.options.find((option) => option.optionId === optionId)?.kind;
      if (kind === "allow_once" || kind === "allow_always") letOutOfSandbox(request);
    });
  const wrapped: AcpSessionRuntime.AcpSessionRuntime["Service"] = {
    ...runtime,
    // Stop cancels at once, and the steers waiting on the prompt go with it.
    cancel: Effect.sync(() => {
      state.steers.length = 0;
      state.stopped = true;
    }).pipe(Effect.andThen(saveSteers), Effect.andThen(runtime.cancel)),
    start: () => runtime.start().pipe(Effect.tap(opened)),
    // The adapter shows and answers each request by its kind, which Bob's tool names skew.
    handleRequestPermission: (handler) =>
      runtime.handleRequestPermission((request, context) =>
        autoAnswer(request).pipe(
          Effect.flatMap((answer) => {
            if (answer !== undefined) return Effect.succeed(answer);
            const suggestion = ruleFor(request);
            const normalized = normalizeBobPermissionRequest(request);
            const kind = request.toolCall.kind;
            // Bob would remember "always" for the tool itself, past T3's rules, so commands and
            // edits get T3's rules instead. An approved command runs outside the sandbox.
            const remembered =
              kind === "execute" || kind === "edit" || kind === "delete" || kind === "move";
            const outside = answering?.sandbox !== undefined && commandOf(request) !== undefined;
            const shown = {
              ...normalized,
              options: remembered
                ? normalized.options.filter((option) => option.kind !== "allow_always")
                : normalized.options,
              ...(outside ? { _meta: { ...normalized._meta, [BOB_RUNS_OUTSIDE]: true } } : {}),
            };
            return handler(
              suggestion === undefined || rules === undefined
                ? shown
                : withRuleOptions(shown, suggestion, rules),
              context,
            ).pipe(
              Effect.tap((response) => recordUserAnswer(request, response)),
              Effect.flatMap((response) => {
                const chosen =
                  response.outcome.outcome === "selected" ? response.outcome.optionId : undefined;
                const scope = typeof chosen === "string" ? bobRuleScopeOf(chosen) : undefined;
                return scope === undefined || suggestion === undefined
                  ? userApproved(request, response).pipe(Effect.as(response))
                  : addRule(request, suggestion, scope);
              }),
            );
          }),
        ),
      ),
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
            followSandboxedCall(notification.update);
            const commands =
              notification.update.sessionUpdate === "available_commands_update" &&
              hooks.onAvailableCommands
                ? hooks.onAvailableCommands(notification.update.availableCommands, cwd)
                : Effect.void;
            return commands.pipe(
              Effect.andThen(replaySubagentSteps(notification, handler)),
              Effect.andThen(handler(notification)),
              // The last running tool call finishing lets a waiting steer interrupt the prompt.
              Effect.andThen(interruptForSteer),
            );
          }),
        ),
      ),
    prompt: (payload, options) =>
      Effect.gen(function* () {
        state.answered = false;
        state.lastReply = "";
        state.prompting = true;
        state.stopped = false;
        const turn = threadId === undefined ? undefined : turns.next.get(threadId);
        if (threadId !== undefined) turns.next.delete(threadId);
        if (turn !== undefined && rules !== undefined) {
          rules.projectId = turn.projectId;
          rules.refresh();
        }
        if (turn !== undefined) state.asksAboutNetwork = turn.asksAboutNetwork;
        // The turn's message leads the prompt; it counts for Auto only when the user wrote it,
        // not a check-in, a notice or a wake.
        const first = payload.prompt.find((block) => block.type === "text");
        const request = first?.type === "text" ? bobUserRequest(first.text) : "";
        if (turn?.userRequest !== undefined && turn.userRequest === request) {
          yield* remember(turn.userText ?? "");
        }
        if (turn?.delegatedTask !== undefined) {
          yield* rememberTask(turn.delegatedTask, turn.delegatedFrom);
        } else if (state.requests.delegated !== undefined) {
          // A later turn of the task: the user may have written more where the work started.
          yield* readStarted;
        }
        if (link) yield* link.turnStarted;
        let result: EffectAcpSchema.PromptResponse;
        if (link && (yield* link.adopt)) {
          // Bob kept a prompt going while T3 restarted. This prompt takes it over: the relay
          // shows the rest of it in this run, then hands over its reply. Steers that were
          // waiting on Bob's tool calls wait again, for the calls Bob still runs however the
          // relay replays them. In the order they were sent, they go first, then the turn's own
          // message unless it only asks Bob to go on, then steers sent since; after a Stop,
          // none of them.
          for (const id of yield* link.openTools) state.openTools.add(id);
          const restored = [...((yield* link.kept)?.steers ?? [])];
          state.steers.push(...restored);
          result = yield* runtime.prompt(payload, options);
          const earlier = state.steers.splice(0, restored.length);
          if (earlier.length > 0) result = yield* promptSteers(payload, earlier);
          if (turn?.skipTextAfterAdoption !== true && !state.stopped) {
            result = yield* runtime.prompt(payload);
          }
        } else if (turn?.adoptOnly === true) {
          // The prompt this run was to finish ended with the Bob that ran it; nothing to say.
          state.answered = true;
          result = { stopReason: "end_turn" };
        } else {
          result = yield* runtime.prompt(payload, options);
        }
        // Steers continue the turn as Bob's next prompt, whether or not Bob ended the one before.
        result = yield* sendSteers(payload, result);
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
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            state.prompting = false;
            state.steerCancelled = false;
            state.openTools.clear();
            // No approval outlives the turn it was given in.
            sandboxCalls.approvedCalls.clear();
            sandboxCalls.running.clear();
            answering?.sandbox?.dropApprovals(new Set());
          }),
        ),
        Effect.ensuring(link ? link.turnSettled : Effect.void),
        Effect.ensuring(reportUsage),
        Effect.ensuring(retireIfAdopted),
      ),
  };
  bobRuntimeStates.set(wrapped, state);
  return wrapped;
}

/**
 * The sandbox for a Bob runtime's commands, or none where the host has none or it cannot be set
 * up, in which case the modes answer as without one.
 */
function openBobSandbox(
  options: BobAdapterV2Options,
  mode: BobPermissionMode,
  cwd: string,
  rules: BobRuntimeRules,
): Effect.Effect<BobSandbox | undefined> {
  return Effect.try(() =>
    makeBobSandbox({
      mode: mode === "approval-required" ? "read-only" : "workspace-write",
      workspace: cwd,
      home: options.environment.HOME ?? NodeOS.homedir(),
      platform: options.platform ?? "linux",
      shell: options.environment.SHELL,
      cacheDir: options.host.paths.providerStatusCacheDir,
      stateDir: options.host.paths.stateDir,
      key: `${options.instanceId}\0${rules.threadId ?? ""}\0${cwd}`,
      temporaryFolders: [NodeOS.tmpdir(), "/private/tmp", "/private/var/tmp"],
      searchPath: options.environment.PATH,
      rules: bobUserRules(rules),
    }),
  ).pipe(
    Effect.tapError((cause) => Effect.logWarning("Bob's sandbox could not be set up", cause)),
    Effect.orElseSucceed(() => undefined),
  );
}

export interface BobAdapterV2Options extends BobAdapterV2Hooks {
  /** The host's platform, which decides whether Bob's commands can run in a sandbox. */
  readonly platform?: NodeJS.Platform;
  /** The user's permission rules; without them only a thread's own rules apply. */
  readonly rules?: BobRulesSource;
  /** For an instance that runs Bob in tmux: the relays its Bob sessions run under. */
  readonly relays?: BobRelays;
  readonly instanceId: ProviderInstanceId;
  readonly settings: BobSettings;
  /** The environment `bob` runs with, the instance's variables over the server's. */
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly selfInvocation: SelfInvocation;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly host: ProviderHost.ProviderHostShape;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
}

export function makeBobAcpAdapterFlavor(
  options: BobAdapterV2Options,
  sessions: Map<string, BobSessionControl> = new Map(),
  turns: BobThreadTurns = makeBobThreadTurns(),
): AcpAdapterV2Flavor {
  return {
    driver: BOB_PROVIDER,
    runtimeHarness: "Bob",
    capabilities: BobProviderCapabilitiesV2,
    makeRuntime: ({ runtimePolicy, ...input }) =>
      Effect.gen(function* () {
        // In tmux, Bob runs under a relay that keeps it going while T3 restarts. A new relay
        // keeps the digest of the MCP token its Bob gets, for a T3 that takes Bob over.
        const mcpAuthorization = input.processEnvironment?.["T3_ACP_MCP_AUTHORIZATION"];
        const mcpTokenHash =
          options.relays && mcpAuthorization
            ? yield* options.crypto
                .digest(
                  "SHA-256",
                  new TextEncoder().encode(mcpAuthorization.replace(/^Bearer\s+/, "")),
                )
                .pipe(Effect.map(Hex.encode), Effect.orDie)
            : undefined;
        const link = options.relays?.linkFor({
          cwd: input.cwd,
          resumeSessionId: input.resumeSessionId,
          mcpTokenHash,
          autoApprove: bobApprovesItsOwnTools(runtimePolicy.runtimeMode),
          mode: runtimePolicy.runtimeMode,
        });
        const terminated = yield* Deferred.make<void>();
        // Auto's reviewer model gets ready while Bob starts, so its first call does not wait.
        if (options.holdAutoJudge !== undefined) yield* options.holdAutoJudge;
        if (runtimePolicy.runtimeMode === "auto" && options.autoJudge !== undefined) {
          yield* options.autoJudge.warm.pipe(Effect.forkDetach);
        }
        const mode = runtimePolicy.runtimeMode;
        // Subscribed before the rules are read, so no change falls between the two.
        const changes =
          mode === "full-access" ? undefined : yield* options.rules?.subscribe ?? Effect.void;
        const rules: BobRuntimeRules | undefined =
          mode === "full-access"
            ? undefined
            : {
                saved: options.rules ? yield* options.rules.get : { rules: [], scope: "thread" },
                revision: 0,
                workspace: runtimePolicy.cwd ?? input.cwd,
                threadId: input.threadId ?? undefined,
                projectId: input.threadId ? turns.projects.get(input.threadId) : undefined,
                home: options.environment.HOME ?? NodeOS.homedir(),
                t3Home: options.host.paths.baseDir,
                source: options.rules,
                refresh: () => undefined,
              };
        // Outside Full access Bob's commands run in a sandbox, read-only in Supervised, which
        // follows the user's rules as they change.
        const sandbox =
          rules === undefined || mode === "full-access"
            ? undefined
            : yield* openBobSandbox(options, mode, input.cwd, rules);
        if (rules !== undefined) {
          rules.refresh = () => sandbox?.update(bobUserRules(rules));
          if (changes) {
            yield* changes.pipe(
              Stream.runForEach((saved) =>
                Effect.sync(() => {
                  rules.saved = saved;
                  rules.revision += 1;
                  rules.refresh();
                }),
              ),
              Effect.forkScoped,
            );
          }
        }
        const runtime = yield* makeBobAcpRuntime({
          ...input,
          onTermination: (error) =>
            input
              .onTermination(error)
              .pipe(Effect.ensuring(Deferred.succeed(terminated, undefined))),
          childProcessSpawner: link?.spawner ?? options.childProcessSpawner,
          bobSettings: options.settings,
          environment: { ...options.environment, ...sandbox?.environment },
          runtimeMode: mode,
        });
        return wrapBobRuntime(runtime, input.cwd, options, sessions, {
          link,
          terminated,
          mcpAuthorization,
          review:
            mode === "full-access" ? undefined : { mode, workspace: runtimePolicy.cwd, sandbox },
          rules,
          threadId: input.threadId ?? undefined,
          turns,
          scope: yield* Effect.scope,
        });
      }),
    preferResumeSession: true,
    // Every turn starts in Agent unless the thread picked another mode, so a mode left over in a
    // resumed task never lingers. Plan turns switch to Bob's plan mode after this.
    sessionModeForPolicy: (policy) =>
      policy.interactionMode === "plan" ? undefined : BOB_AGENT_MODE_ID,
    normalizeSessionUpdate: decodeBobToolTitles,
    permissionDisposition: bobPermissionDisposition,
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
      const named = bobNamedError(cause);
      const spent = named === undefined ? undefined : bobBobcoinsSpent(named);
      // Bob's gateway refuses a budget's Bobcoins until the month resets, and a trial's until
      // the plan changes.
      if (named !== undefined && spent !== undefined) {
        return makeProviderFailure({
          cause,
          message: named.description ?? "Bob is out of Bobcoins.",
          code: named.name,
          class: "usage_limit",
          resetAt:
            spent === "monthly"
              ? bobBudgetResetsAt(DateTime.formatIso(DateTime.nowUnsafe()))
              : null,
        });
      }
      return makeProviderFailure({
        cause,
        message:
          describeBobAcpSetupError(cause, options.settings.authMethod) ??
          named?.description ??
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
  sessions: ReadonlyMap<string, BobSessionControl>,
  resolveAttachmentPath: ProviderHost.ProviderHostShape["resolveAttachmentPath"],
  turns: BobThreadTurns,
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
      Stream.tap((event) => {
        // Once Bob's task exists, its relay learns whose it is.
        const nativeId =
          event.type === "provider_thread.updated"
            ? event.providerThread.nativeThreadRef?.nativeId
            : undefined;
        if (
          event.type !== "provider_thread.updated" ||
          nativeId == null ||
          event.providerThread.appThreadId === null
        ) {
          return Effect.void;
        }
        return (
          sessions.get(nativeId)?.describe({
            threadId: event.providerThread.appThreadId,
            providerThreadId: event.providerThread.id,
          }) ?? Effect.void
        );
      }),
    ),
    ensureThread: (input) => {
      follow(input.runtimePolicy);
      return session.ensureThread(input).pipe(Effect.mapError(explainSetup));
    },
    steerTurn: (input) =>
      Effect.gen(function* () {
        const taskId = bobTaskId(input.providerThread);
        const steer = taskId === undefined ? undefined : sessions.get(taskId)?.steer;
        const text = providerMessageTextWithAttachmentPaths({
          text: input.message.text,
          attachments: input.message.attachments,
          resolveAttachmentPath,
        });
        // Too late once Bob's prompt ended; the message then follows the turn instead.
        const userText = isUserWritten(input.message) ? input.message.text.trim() : undefined;
        if (steer === undefined || !(yield* steer(text, userText))) {
          return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
            driver: BOB_PROVIDER,
            providerThreadId: input.providerThread.id,
            providerTurnId: input.providerTurnId,
            cause: new Error("Bob is not running a prompt to steer."),
          });
        }
      }),
    startTurn: (input) => {
      follow(input.runtimePolicy);
      // Auto's reviewer judges calls against what the user asked, never a check-in, a notice or
      // another agent's message, so the turn tells its runtime its text only when the user wrote it.
      const userRequest = isUserWritten(input.message)
        ? providerMessageTextWithAttachmentPaths({
            text: input.message.text,
            attachments: input.message.attachments,
            resolveAttachmentPath,
          }).trim()
        : undefined;
      // Only what the user typed is quoted, never an attachment's path or text.
      const userText = userRequest === undefined ? undefined : input.message.text.trim();
      // A subagent thread's first message is the task another agent delegated: what the reviewer
      // judges calls by, while the user's words where the work started say what it may do.
      const { lineage } = input.appThread;
      const delegatedTask =
        lineage.relationshipToParent === "subagent" &&
        input.runOrdinal === 1 &&
        userRequest === undefined
          ? input.message.text.trim()
          : undefined;
      const mode = modes.missing(input);
      if (mode !== undefined) missingModes.set(input.attemptId, { input, mode });
      // A wake T3 starts for a prompt Bob kept going while T3 restarted carries no request of its
      // own, and upstream's restart continuation only asks Bob to go on.
      const isWake =
        input.message.createdBy === "agent" && input.message.creationSource === "provider";
      // Whichever runtime serves the thread takes the turn, one started for it included.
      turns.next.set(input.threadId, {
        threadId: input.threadId,
        projectId: input.appThread.projectId,
        userRequest,
        userText,
        delegatedTask,
        delegatedFrom:
          delegatedTask === undefined ? undefined : (lineage.parentThreadId ?? undefined),
        asksAboutNetwork:
          input.modelSelection.options?.find((option) => option.id === BOB_NETWORK_OPTION_ID)
            ?.value === BOB_NETWORK_ASK,
        adoptOnly: isWake,
        skipTextAfterAdoption: isWake || input.restartContinuationOfRunId !== undefined,
      });
      turns.projects.set(input.threadId, input.appThread.projectId);
      return session.startTurn(input).pipe(
        Effect.mapError(explainSetup),
        Effect.tapError(() =>
          Effect.sync(() => {
            missingModes.delete(input.attemptId);
            turns.next.delete(input.threadId);
          }),
        ),
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
  // Each Bob session's runtime, by Bob's task id.
  const sessions = new Map<string, BobSessionControl>();
  const turns = makeBobThreadTurns();
  const adapter = makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeBobAcpAdapterFlavor(
      {
        ...options,
        onAvailableModes: (modes, cwd) => {
          offeredModes.set(cwd, new Set(modes.map((mode) => mode.id)));
          return options.onAvailableModes?.(modes, cwd) ?? Effect.void;
        },
      },
      sessions,
      turns,
    ),
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    host: options.host,
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
            sessions,
            options.host.resolveAttachmentPath,
            turns,
          ),
        ),
      ),
  };
}
