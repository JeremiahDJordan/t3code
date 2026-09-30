import {
  AGENT_MESSAGE_MAX_CHARS,
  AGENT_MESSAGES_RECEIVED_PER_HOUR,
  AGENT_MESSAGES_SENT_PER_HOUR,
  AGENT_THREAD_START_DEPTH_MAX,
  AGENT_THREAD_STARTS_PER_HOUR,
  AGENT_THREAD_WAITS_PER_THREAD_MAX,
  AgentThreadsError,
  CHECK_IN_NOTE_MAX_CHARS,
  EnvironmentId,
  IsoDateTime,
  McpCapabilityUnavailableError,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as AgentThreads from "../../../agentThreads/AgentThreads.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, AgentThreads.AgentThreads];

const environmentIdParameter = Schema.optional(
  EnvironmentId.annotate({
    description:
      "The thread's environment, from list_threads. Omit for this T3 Code's own environment.",
  }),
);
const threadIdParameter = ThreadId.annotate({ description: "The thread's id, from list_threads." });

const ThreadState = Schema.Literals([
  "idle",
  "working",
  "needs-approval",
  "needs-input",
  "error",
  "archived",
]);
const ThreadRef = Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId });

const ThreadSummary = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: Schema.String,
  projectId: ProjectId,
  projectName: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  state: ThreadState,
  lastActivityAt: IsoDateTime,
  branch: Schema.NullOr(Schema.String),
  startedBy: Schema.NullOr(ThreadRef).annotate({
    description: "The thread whose agent started this one, if one did.",
  }),
});

export const ListThreadsInput = Schema.Struct({
  query: Schema.optional(
    Schema.String.annotate({ description: "Only threads whose title or project name has this." }),
  ),
  includeArchived: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});

export const ListThreadsResult = Schema.Struct({
  environments: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      local: Schema.Boolean,
      providers: Schema.Array(
        Schema.Struct({
          provider: Schema.String,
          driver: Schema.String,
          name: Schema.String,
          ready: Schema.Boolean,
          defaultModel: Schema.NullOr(Schema.String),
          models: Schema.Array(Schema.String),
        }),
      ),
    }),
  ),
  threads: Schema.Array(ThreadSummary),
  truncated: Schema.Boolean,
});

export const ReadThreadInput = Schema.Struct({
  environmentId: environmentIdParameter,
  threadId: threadIdParameter,
  turns: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
      description: "How many recent turns to read. Default 3.",
    }),
  ),
});

export const ReadThreadResult = Schema.Struct({
  ...ThreadSummary.fields,
  worktreePath: Schema.NullOr(Schema.String),
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      text: Schema.String,
      createdAt: IsoDateTime,
      truncated: Schema.Boolean,
    }),
  ),
  olderMessages: Schema.Boolean,
});

export const StartThreadInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_MESSAGE_MAX_CHARS)).annotate({
    description:
      "The task for the new thread's agent, complete on its own: it sees none of this conversation.",
  }),
  title: Schema.optional(Schema.String),
  projectId: Schema.optional(
    ProjectId.annotate({ description: "The project to start it in. Default: this thread's." }),
  ),
  provider: Schema.optional(
    Schema.String.annotate({
      description:
        "Which provider runs it: a provider from list_threads' environments, such as codex, claudeAgent or bob. Default: the project's default.",
    }),
  ),
  model: Schema.optional(
    Schema.String.annotate({ description: "A model of that provider. Default: its default." }),
  ),
  workspace: Schema.optional(
    Schema.Literals(["local", "worktree"]).annotate({
      description:
        "Where it works: \"local\" in the project's checkout, or \"worktree\" on a new branch in its own worktree, whose agent first runs the project's setup script, under this thread's permission mode. Default: the project's setting.",
    }),
  ),
  baseBranch: Schema.optional(
    Schema.String.annotate({
      description: "For a worktree, the branch to start from. Default: this thread's branch.",
    }),
  ),
  reportBack: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Hear when it next finishes a turn and goes idle (a follow-up already queued there runs first), with the end of its reply (default true). Cancel with cancel_wait.",
    }),
  ),
});

export const StartThreadResult = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  workspace: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  waitId: Schema.NullOr(Schema.String),
  setupScript: Schema.Literals(["none", "in-first-message"]),
});

export const SendToThreadInput = Schema.Struct({
  environmentId: environmentIdParameter,
  threadId: threadIdParameter,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_MESSAGE_MAX_CHARS)),
  inReplyTo: Schema.optional(
    Schema.String.annotate({ description: "The messageId this answers, if it answers one." }),
  ),
});

export const SendToThreadResult = Schema.Struct({
  messageId: Schema.String,
  delivery: Schema.Literals(["soon", "when-idle"]).annotate({
    description:
      '"soon" when the thread is idle; "when-idle" once its agent finishes what it is doing.',
  }),
});

export const WatchThreadInput = Schema.Struct({
  environmentId: environmentIdParameter,
  threadId: threadIdParameter,
  note: Schema.optional(
    Schema.String.check(Schema.isMaxLength(CHECK_IN_NOTE_MAX_CHARS)).annotate({
      description: "What to do when it finishes, written to your future self.",
    }),
  ),
});

export const WatchThreadResult = Schema.Struct({
  waitId: Schema.String,
  stopsWaitingAt: IsoDateTime,
});

export const CancelWaitInput = Schema.Struct({ waitId: TrimmedNonEmptyString });
export const CancelWaitResult = Schema.Struct({
  cancelled: Schema.Boolean.annotate({ description: "False when this thread has no such wait." }),
});

export const AgentThreadsToolError = Schema.Union([
  McpCapabilityUnavailableError,
  AgentThreadsError,
]);

const ListThreadsTool = Tool.make("list_threads", {
  description:
    "List T3 Code threads in every project, newest activity first: each thread's environmentId and threadId (address it with both), title, project, provider and model, and state (idle, working, needs-approval, needs-input, error, archived). Also lists the providers you can start threads on and their models.",
  parameters: ListThreadsInput,
  success: ListThreadsResult,
  failure: AgentThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadThreadTool = Tool.make("read_thread", {
  description:
    "Read a thread's recent messages, the user's and its agent's, in any project, with where the thread is now. Long messages keep their end.",
  parameters: ReadThreadInput,
  success: ReadThreadResult,
  failure: AgentThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const StartThreadTool = Tool.make("start_thread", {
  description: `Start a new top-level T3 Code thread that works on a task in parallel, on any enabled provider, in its own worktree or the project's checkout. Its agent gets only your prompt, so make it complete. By default you hear when it finishes a turn and goes idle. The user sees it as an ordinary thread. Every thread costs usage, so start one only when parallel work or another provider is worth it. A thread may start ${AGENT_THREAD_STARTS_PER_HOUR} an hour, and threads started from agents nest at most ${AGENT_THREAD_START_DEPTH_MAX} deep.`,
  parameters: StartThreadInput,
  success: StartThreadResult,
  failure: AgentThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const SendToThreadTool = Tool.make("send_to_thread", {
  description: `Send a message to another thread's agent. It arrives as a new turn once that agent is idle and never interrupts it; it is labeled as coming from your thread, which the other agent can answer the same way. Each message is a turn and costs usage. A thread may send ${AGENT_MESSAGES_SENT_PER_HOUR} an hour and receive ${AGENT_MESSAGES_RECEIVED_PER_HOUR}.`,
  parameters: SendToThreadInput,
  success: SendToThreadResult,
  failure: AgentThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WatchThreadTool = Tool.make("watch_thread", {
  description: `Hear when another thread's agent next finishes a turn and goes idle (a follow-up already queued there runs first), with the end of its reply, as a new turn in this thread once you are idle. It also tells you if that thread is archived, or has not finished within the check-in repeat limit (24 hours by default). After starting it, end your turn; do not poll. A thread may wait on ${AGENT_THREAD_WAITS_PER_THREAD_MAX} at once.`,
  parameters: WatchThreadInput,
  success: WatchThreadResult,
  failure: AgentThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CancelWaitTool = Tool.make("cancel_wait", {
  description: "Stop waiting for a thread, by the waitId watch_thread or start_thread returned.",
  parameters: CancelWaitInput,
  success: CancelWaitResult,
  failure: AgentThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop waiting for a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AgentThreadsToolkit = Toolkit.make(
  ListThreadsTool,
  ReadThreadTool,
  StartThreadTool,
  SendToThreadTool,
  WatchThreadTool,
  CancelWaitTool,
);
