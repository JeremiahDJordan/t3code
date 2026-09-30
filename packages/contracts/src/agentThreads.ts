import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Agent threads: T3 MCP tools that let an agent list and read threads in any project, start new
 * top-level threads (on any enabled provider), message other threads, and hear when a thread it
 * waits on finishes. Every thread is addressed by `{environmentId, threadId}`, and every message
 * travels in one envelope, so threads in other environments can use the same shapes later.
 */

/**
 * The message-context record kind that marks a message another agent sent, or the first message
 * of a thread an agent started. Like the check-in kind it is not a composer kind: clients carry
 * it as an unknown record and label the message; its payload is the `AgentMessageEnvelope`.
 */
export const AGENT_MESSAGE_CONTEXT_KIND = "agent-message";

/** How deep threads started by agents may nest: a thread at this depth starts no more. */
export const AGENT_THREAD_START_DEPTH_MAX = 3;
/** Per thread, per rolling hour, to stop a runaway agent; normal use stays far below. */
export const AGENT_THREAD_STARTS_PER_HOUR = 10;
export const AGENT_MESSAGES_SENT_PER_HOUR = 30;
/** Per receiving thread, per rolling hour, so one agent cannot flood another. */
export const AGENT_MESSAGES_RECEIVED_PER_HOUR = 30;
/** A message's body; the envelope must fit a context record's payload. */
export const AGENT_MESSAGE_MAX_CHARS = 16_000;
/** Threads an agent may wait on at once, apart from its check-ins. */
export const AGENT_THREAD_WAITS_PER_THREAD_MAX = 20;

/** Who sent an agent message, taken from the sender's MCP credential, never from tool input. */
export const AgentMessageSender = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: Schema.optionalKey(TrimmedNonEmptyString),
  threadId: ThreadId,
  threadTitle: Schema.String,
  projectId: Schema.optionalKey(ProjectId),
  providerInstanceId: Schema.optionalKey(TrimmedNonEmptyString),
  model: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AgentMessageSender = typeof AgentMessageSender.Type;

/**
 * One message between threads, and the payload of its `agent-message` context record. The
 * sender makes `messageId` (a UUID) and keeps it across retries, so a receiver can drop a
 * duplicate. `start-thread` is the first message of a thread an agent started; `watch-notice`
 * is reserved for waits on threads in other environments.
 */
export const AgentMessageEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  messageId: TrimmedNonEmptyString,
  kind: Schema.Literals(["message", "start-thread", "watch-notice"]),
  from: AgentMessageSender,
  to: Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId }),
  sentAt: IsoDateTime,
  /** The message this answers, when the sender said so. */
  inReplyTo: Schema.optionalKey(TrimmedNonEmptyString),
  /** Shared by a message and the replies that follow it. */
  conversationId: TrimmedNonEmptyString,
  /** How many threads were started from agents up to the sender's thread. */
  depth: NonNegativeInt,
  body: Schema.String,
});
export type AgentMessageEnvelope = typeof AgentMessageEnvelope.Type;

/** Why an agent-threads tool refused; stable so agents and later environments can rely on it. */
export const AgentThreadsErrorCode = Schema.Literals([
  "environment-not-connected",
  "environment-unknown",
  "thread-not-found",
  "project-not-found",
  "provider-unavailable",
  "permission-denied",
  "rate-limited",
  "depth-exceeded",
  "message-too-large",
  "invalid-request",
]);
export type AgentThreadsErrorCode = typeof AgentThreadsErrorCode.Type;

/** An agent-threads tool's refusal, with a stable code and a sentence for the agent. */
export class AgentThreadsError extends Schema.TaggedError<AgentThreadsError>()(
  "AgentThreadsError",
  { code: AgentThreadsErrorCode, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
