import {
  ComposerContextId,
  TurnItemId,
  NodeId,
  MessageId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { usageLimitBlockedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  presentPendingBackgroundWork,
  deriveLatestThreadRun,
  deriveProviderSubagentStatus,
  formatModelSelectionEffort,
  formatProviderSubagentStatus,
  deriveRetryableThreadRun,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  threadRuntimeHasInterruptibleRun,
} from "./threadExecution.ts";
import { threadRuntimeCanArchive, type ThreadRuntimeSummary } from "./models.ts";

const now = DateTime.makeUnsafe("2026-07-28T10:00:00.000Z");

function run(id: string, ordinal: number, status: OrchestrationV2RunStatus) {
  return {
    id: RunId.make(id),
    threadId: v2Projection.thread.id,
    ordinal,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

describe("thread execution presentation", () => {
  it("derives the current root failure without inheriting errors from children or previous runs", () => {
    const failed = { ...run("limited", 1, "failed"), rootNodeId: NodeId.make("root") };
    const item = {
      id: TurnItemId.make("limit-error"),
      threadId: v2Projection.thread.id,
      runId: failed.id,
      nodeId: failed.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: "usageLimitExceeded",
        retryable: null,
      },
    };
    const projection = { ...v2Projection, runs: [failed], turnItems: [item] };
    expect(deriveThreadRuntime(projection)).toMatchObject({
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    expect(
      deriveThreadRuntime({
        ...projection,
        turnItems: [{ ...item, nodeId: NodeId.make("child") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({
        ...projection,
        runs: [{ ...failed, rootNodeId: NodeId.make("new-root") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, run("new", 2, "running")] }),
    ).toMatchObject({ status: "running", lastError: null, lastErrorClass: null });
  });

  it("keeps a subscription limit visible while later messages stay queued", () => {
    const failed = {
      ...run("limited", 1, "failed"),
      rootNodeId: NodeId.make("root"),
      completedAt: now,
    };
    const queued = run("queued", 2, "queued");
    const item = {
      id: TurnItemId.make("limit-error"),
      threadId: v2Projection.thread.id,
      runId: failed.id,
      nodeId: failed.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: "usageLimitExceeded",
        retryable: null,
      },
    };
    const projection = { ...v2Projection, runs: [failed, queued], turnItems: [item] };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "failed",
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    const cancelledQueued = {
      ...run("cancelled-queued", 3, "cancelled"),
      startedAt: null,
      completedAt: now,
    };
    expect(
      usageLimitBlockedRun([failed, queued, cancelledQueued], projection.turnItems, null)?.id,
    ).toBe(failed.id);
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, queued, cancelledQueued] }),
    ).toMatchObject({ status: "failed", lastErrorClass: "usage_limit" });
    expect(
      deriveThreadRuntime({
        ...projection,
        turnItems: [{ ...item, failure: { ...item.failure, class: "provider_error" as const } }],
      }),
    ).toMatchObject({ status: "queued", lastErrorClass: null });
  });

  it("keeps live activity attached to an executing run when a newer run is queued", () => {
    const runningRun = run("run-running", 1, "running");
    const queuedRun = run("run-queued", 2, "queued");
    const projection = { ...v2Projection, runs: [queuedRun, runningRun], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(queuedRun.id);
    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: runningRun.id,
      status: "running",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "running",
      activeRunId: runningRun.id,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });

  it("presents a held queue as the stopped run instead of queued work", () => {
    const interrupted = { ...run("run-interrupted", 1, "interrupted"), completedAt: now };
    const held = { ...run("run-held", 2, "queued"), queueHeld: true };
    const projection = { ...v2Projection, runs: [interrupted, held], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "interrupted",
      activeRunId: null,
    });

    // Resuming clears the hold, and the run reads as queued until it starts.
    const resumed = { ...projection, runs: [interrupted, { ...held, queueHeld: false }] };
    expect(deriveThreadRuntime(resumed)).toMatchObject({ status: "queued" });

    // Recovery can hold a first message before any run executed; it is not work.
    const onlyHeld = {
      ...projection,
      runs: [held],
      thread: { ...projection.thread, activeProviderThreadId: null },
    };
    expect(deriveLatestThreadRun(onlyHeld)).toBeNull();
    expect(deriveThreadRuntime(onlyHeld)).toBeNull();
  });

  it("does not expose a queued-only run as interruptible", () => {
    const queuedRun = run("run-queued", 1, "queued");
    const projection = { ...v2Projection, runs: [queuedRun], updatedAt: now };

    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: queuedRun.id,
      status: "queued",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "queued",
      activeRunId: null,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it("keeps checkpoint-wait activity visible without exposing a non-functional interrupt", () => {
    const waitingRun = run("run-waiting", 1, "waiting");
    const projection = { ...v2Projection, runs: [waitingRun], updatedAt: now };

    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: waitingRun.id,
      status: "waiting",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "waiting",
      activeRunId: null,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it("does not expose a stale active run after the runtime parks at idle", () => {
    const runtime = {
      status: "idle" as const,
      activeRunId: RunId.make("run-stale"),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: DateTime.formatIso(now),
    };

    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it.each(["preparing", "starting"] as const)("keeps an active %s run interruptible", (status) => {
    const runtime = {
      status,
      activeRunId: RunId.make(`run-${status}`),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: DateTime.formatIso(now),
    };

    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });
});

describe("deriveRetryableThreadRun", () => {
  const failed = {
    ...run("empty", 1, "failed"),
    rootNodeId: NodeId.make("root"),
    completedAt: now,
  };
  const failureItem = {
    id: TurnItemId.make("empty-reply"),
    threadId: v2Projection.thread.id,
    runId: failed.id,
    nodeId: failed.rootNodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 3,
    type: "error" as const,
    status: "failed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    failure: {
      class: "provider_error" as const,
      message: "Bob ended its turn without replying.",
      code: "empty_reply",
      retryable: true,
    },
  };
  const context = {
    version: 1 as const,
    records: [
      {
        version: 1 as const,
        contextId: ComposerContextId.make("terminal_1"),
        kind: "terminal" as const,
        label: "Terminal lines 1-2",
        terminalId: "default",
        terminalLabel: "Terminal",
        lineStart: 1,
        lineEnd: 2,
        text: "npm test",
      },
    ],
  };
  const prompt = {
    id: failed.userMessageId,
    threadId: v2Projection.thread.id,
    runId: failed.id,
    nodeId: null,
    role: "user" as const,
    text: "Summarize the diff",
    context,
    attachments: [
      { type: "image" as const, id: "image-1", name: "a.png", mimeType: "image/png", sizeBytes: 1 },
    ],
    streaming: false,
    createdBy: "user" as const,
    creationSource: "web" as const,
    createdAt: now,
    updatedAt: now,
  };
  const projection = {
    ...v2Projection,
    runs: [failed],
    turnItems: [failureItem],
    messages: [prompt],
  };

  it("sends the failed run's own message again, by id, without its attachments", () => {
    expect(deriveRetryableThreadRun(projection)).toEqual({
      runId: failed.id,
      failureItemId: failureItem.id,
      message: { text: "Summarize the diff", context },
    });
    // A later message in the same run (a steer) is not the one that started it.
    const steer = { ...prompt, id: MessageId.make("steer"), text: "Also the tests" };
    expect(
      deriveRetryableThreadRun({ ...projection, messages: [prompt, steer] })?.message.text,
    ).toBe("Summarize the diff");
  });

  it("offers nothing for failures a resend would not fix", () => {
    const withFailure = (failure: Partial<OrchestrationV2ProviderFailure>) =>
      deriveRetryableThreadRun({
        ...projection,
        turnItems: [{ ...failureItem, failure: { ...failureItem.failure, ...failure } }],
      });
    expect(withFailure({ retryable: null })).toBeNull();
    expect(withFailure({ retryable: false })).toBeNull();
    // A usage limit resumes at its reset instead.
    expect(withFailure({ class: "usage_limit" })).toBeNull();
    // A subagent's failure is not the run's.
    expect(
      deriveRetryableThreadRun({
        ...projection,
        turnItems: [{ ...failureItem, nodeId: NodeId.make("child") }],
      }),
    ).toBeNull();
  });

  it("offers it only while the failed run is the latest and nothing else is under way", () => {
    expect(
      deriveRetryableThreadRun({ ...projection, runs: [failed, run("next", 2, "running")] }),
    ).toBeNull();
    // The queue starts on its own after an ordinary failure, but waits when held.
    expect(
      deriveRetryableThreadRun({ ...projection, runs: [failed, run("queued", 2, "queued")] }),
    ).toBeNull();
    expect(
      deriveRetryableThreadRun({
        ...projection,
        runs: [failed, { ...run("held", 2, "queued"), queueHeld: true }],
      })?.runId,
    ).toBe(failed.id);
    expect(
      deriveRetryableThreadRun({
        ...projection,
        runtimeRequests: [
          {
            id: RuntimeRequestId.make("approval"),
            nodeId: NodeId.make("root"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        ],
      }),
    ).toBeNull();
  });

  it("offers nothing when the run's message is unknown or was not the user's", () => {
    expect(deriveRetryableThreadRun({ ...projection, messages: [] })).toBeNull();
    expect(
      deriveRetryableThreadRun({
        ...projection,
        messages: [
          {
            ...prompt,
            notification: {
              source: { kind: "command" },
              outcome: "completed",
              summary: "Command finished",
            },
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("deriveRunlessWorkStartedAt", () => {
  const later = DateTime.makeUnsafe("2026-07-28T10:05:00.000Z");
  const rootTurn = (
    status: OrchestrationV2ExecutionNode["status"],
    startedAt = now,
  ): OrchestrationV2ExecutionNode => ({
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn",
    status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt,
    completedAt: null,
  });

  const nativeChild = {
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource: "provider" as const,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
  };

  it("times a provider-native subagent from its runless root turn while it works", () => {
    const projection = { ...nativeChild, nodes: [rootTurn("running", later)] };
    expect(deriveRunlessWorkStartedAt(projection)).toBe("2026-07-28T10:05:00.000Z");
    // The subagent has no run, so it stays unstoppable and unqueueable.
    expect(deriveThreadRuntime(projection)).toBeNull();
  });

  it.each(["completed", "cancelled", "failed", "interrupted", "idle"] as const)(
    "is idle once the subagent is %s",
    (status) => {
      expect(deriveRunlessWorkStartedAt({ ...nativeChild, nodes: [rootTurn(status)] })).toBe(null);
    },
  );

  it("ignores root turns that belong to a run, and threads the provider does not run", () => {
    const owned = { ...rootTurn("running"), runId: RunId.make("run-1") };
    expect(deriveRunlessWorkStartedAt({ ...nativeChild, nodes: [owned] })).toBeNull();
    expect(
      deriveRunlessWorkStartedAt({ ...v2Projection, nodes: [rootTurn("running")] }),
    ).toBeNull();
  });
});

describe("deriveProviderSubagentStatus", () => {
  const root = {
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn" as const,
    status: "completed" as const,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: now,
  };
  const child = (creationSource: "provider" | "mcp") => ({
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
    nodes: [root],
  });

  it("reports the provider's own subagent from its runless root turn", () => {
    expect(deriveProviderSubagentStatus(child("provider"))).toEqual({
      status: "completed",
      startedAt: "2026-07-28T10:00:00.000Z",
      completedAt: "2026-07-28T10:00:00.000Z",
    });
  });

  it("says how long the subagent has worked, or took", () => {
    const startedAt = "2026-07-28T10:00:00.000Z";
    const at = (iso: string) => Date.parse(iso);
    expect(
      formatProviderSubagentStatus(
        { status: "running", startedAt, completedAt: null },
        at("2026-07-28T10:01:05.400Z"),
      ),
    ).toBe("Working 1m 5s");
    expect(
      formatProviderSubagentStatus(
        { status: "completed", startedAt, completedAt: "2026-07-28T10:00:34.000Z" },
        at("2026-07-28T11:00:00.000Z"),
      ),
    ).toBe("Completed in 34s");
    expect(
      formatProviderSubagentStatus(
        { status: "cancelled", startedAt, completedAt: "2026-07-28T10:00:34.000Z" },
        0,
      ),
    ).toBe("Cancelled");
    expect(formatProviderSubagentStatus(null, 0)).toBe("Starting");
  });

  it("leaves T3 delegated tasks and ordinary threads alone", () => {
    expect(deriveProviderSubagentStatus(child("mcp"))).toBeNull();
    expect(deriveProviderSubagentStatus({ ...v2Projection, nodes: [root] })).toBeNull();
  });
});

describe("formatModelSelectionEffort", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const selection = (options?: ReadonlyArray<{ id: string; value: string }>) => ({
    instanceId,
    model: "claude-sonnet-5",
    ...(options === undefined ? {} : { options }),
  });
  const catalog = (descriptor: { currentValue?: string }) => [
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
            ],
            ...descriptor,
          },
        ],
      },
    },
  ];

  it("shows the model's default effort when the user never picked one", () => {
    expect(formatModelSelectionEffort(selection(), catalog({}))).toBe("High");
  });

  it("names a stored effort the way the catalog does", () => {
    expect(
      formatModelSelectionEffort(selection([{ id: "effort", value: "xhigh" }]), catalog({})),
    ).toBe("Extra High");
  });

  it("uses the descriptor's current value over the default", () => {
    expect(formatModelSelectionEffort(selection(), catalog({ currentValue: "medium" }))).toBe(
      "Medium",
    );
  });

  it("shows nothing for a model the catalog does not describe", () => {
    expect(formatModelSelectionEffort(selection([{ id: "effort", value: "high" }]))).toBeNull();
    expect(
      formatModelSelectionEffort(
        { ...selection(), model: "claude-haiku-4-5" },
        catalog({ currentValue: "medium" }),
      ),
    ).toBeNull();
  });
});

describe("threadRuntimeCanArchive", () => {
  const runtime = (
    status: ThreadRuntimeSummary["status"],
    activeRunId: ThreadRuntimeSummary["activeRunId"],
  ): ThreadRuntimeSummary => ({
    status,
    activeRunId,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    providerName: null,
    lastError: null,
    updatedAt: DateTime.formatIso(now),
  });

  it.each(["preparing", "starting", "running"] as const)(
    "blocks archive while a provider is %s",
    (status) => {
      expect(threadRuntimeCanArchive(runtime(status, RunId.make(`run-${status}`)))).toBe(false);
    },
  );

  it("only blocks a queued runtime when a provider run remains attached", () => {
    expect(threadRuntimeCanArchive(runtime("queued", RunId.make("run-queued")))).toBe(false);
    expect(threadRuntimeCanArchive(runtime("queued", null))).toBe(true);
  });

  it("allows waiting and idle threads", () => {
    expect(threadRuntimeCanArchive(runtime("waiting", RunId.make("run-finished")))).toBe(true);
    expect(threadRuntimeCanArchive(runtime("idle", null))).toBe(true);
  });
});

describe("presentPendingBackgroundWork", () => {
  it("names a single piece of work by kind", () => {
    expect(
      presentPendingBackgroundWork([
        { taskId: "a", kind: "subagent", description: "Review src/math.ts" },
      ])?.title,
    ).toBe("Waiting on subagent Review src/math.ts");
    expect(presentPendingBackgroundWork([{ taskId: "a", kind: "command" }])?.title).toBe(
      "Waiting on a command",
    );
    expect(presentPendingBackgroundWork([])).toBeNull();
  });

  it("groups work by kind, subagents first, and keeps each name", () => {
    const presentation = presentPendingBackgroundWork([
      { taskId: "cmd", kind: "command", description: "npm test" },
      {
        taskId: "b",
        kind: "subagent",
        description: "Write tests",
        childThreadId: ThreadId.make("thread:b"),
      },
      { taskId: "a", kind: "subagent", description: "Review src/math.ts" },
    ]);
    expect(presentation?.title).toBe("Waiting on 2 subagents and 1 command");
    expect(presentation?.items.map((item) => [item.kind, item.label, item.childThreadId])).toEqual([
      ["subagent", "Write tests", "thread:b"],
      ["subagent", "Review src/math.ts", undefined],
      ["command", "npm test", undefined],
    ]);
  });

  it("names generic work, including rosters from servers that predate kinds", () => {
    expect(
      presentPendingBackgroundWork([
        { taskId: "bash", kind: "command", description: "Background sleep" },
        { taskId: "watch", kind: "monitor" },
        { taskId: "other", kind: "background_task" },
      ])?.title,
    ).toBe("Waiting on 1 command, 1 monitor and 1 background task");
    expect(presentPendingBackgroundWork([{ taskId: "old", kind: "background_task" }])?.title).toBe(
      "Waiting on a background task",
    );
  });
});
