import {
  NodeId,
  type OrchestrationV2Subagent,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveWorkflowCard,
  deriveWorkflowLineageGroup,
  formatWorkflowCounts,
  latestWorkflowLogLine,
  workflowResultPreview,
} from "./workflowCard.ts";

const at = (seconds: number) =>
  DateTime.makeUnsafe(`2026-10-07T10:00:${String(seconds).padStart(2, "0")}Z`);

function agent(input: {
  readonly id: string;
  readonly phase: string | null;
  readonly status: OrchestrationV2Subagent["status"];
  readonly started: number;
  readonly call?: string;
  readonly attempt?: number;
  readonly provider?: string;
}): OrchestrationV2Subagent {
  return {
    id: NodeId.make(input.id),
    threadId: ThreadId.make("thread:coordinator"),
    runId: null,
    parentNodeId: NodeId.make("node:root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make(input.provider ?? "codex"),
    providerInstanceId: ProviderInstanceId.make(input.provider ?? "codex"),
    providerThreadId: null,
    childThreadId: ThreadId.make(`thread:${input.id}`),
    nativeTaskRef: null,
    prompt: `do ${input.id}`,
    title: input.id,
    model: "gpt-6",
    status: input.status,
    result: null,
    t3Workflow: {
      kind: "agent",
      phase: input.phase,
      role: "reviewer",
      ...(input.call === undefined ? {} : { call: input.call }),
      attempt: input.attempt ?? 1,
    },
    startedAt: at(input.started),
    completedAt: null,
    updatedAt: at(input.started),
  };
}

const coordinator = {
  t3Workflow: {
    kind: "run" as const,
    name: "judged-review",
    phases: [{ title: "Review" }, { title: "Challenge" }, { title: "Judge" }],
  },
  status: "running" as const,
  startedAt: at(0),
  completedAt: null,
};

describe("deriveWorkflowCard", () => {
  it("lists declared phases from the start and fills them as agents start", () => {
    const card = deriveWorkflowCard({
      coordinator,
      agents: [
        agent({ id: "review-api", phase: "Review", status: "completed", started: 1 }),
        agent({ id: "review-ui", phase: "Review", status: "failed", started: 2 }),
        agent({ id: "challenge-1", phase: "Challenge", status: "running", started: 3 }),
        agent({ id: "challenge-2", phase: "Challenge", status: "running", started: 4 }),
        agent({ id: "extra", phase: "Cleanup", status: "completed", started: 5 }),
      ],
      waitingThreadIds: new Set([ThreadId.make("thread:challenge-2")]),
    })!;
    expect(
      card.phases.map((phase) => [phase.title, phase.status, formatWorkflowCounts(phase.counts)]),
    ).toEqual([
      ["Review", "failed", "1 done · 1 failed"],
      ["Challenge", "running", "2 working"],
      ["Judge", "pending", ""],
      ["Cleanup", "done", "1 done"],
    ]);
    expect(card.state).toBe("waiting");
    expect(card.waitingForUser).toBe(1);
    expect(card.phases[1]?.waitingForUser).toBe(1);
    expect(card.counts).toMatchObject({ started: 5, done: 2, working: 2, failed: 1 });
  });

  it("reads a phase with stopped agents as stopped, not done", () => {
    const card = deriveWorkflowCard({
      coordinator: { ...coordinator, status: "interrupted", completedAt: at(9) },
      agents: [
        agent({ id: "review-api", phase: "Review", status: "cancelled", started: 1 }),
        agent({ id: "review-ui", phase: "Review", status: "interrupted", started: 2 }),
        agent({ id: "challenge-1", phase: "Challenge", status: "completed", started: 3 }),
        agent({ id: "challenge-2", phase: "Challenge", status: "interrupted", started: 4 }),
        agent({ id: "judge", phase: "Judge", status: "failed", started: 5 }),
        agent({ id: "judge-2", phase: "Judge", status: "cancelled", started: 6 }),
      ],
      waitingThreadIds: new Set(),
    })!;
    expect(
      card.phases.map((phase) => [phase.title, phase.status, formatWorkflowCounts(phase.counts)]),
    ).toEqual([
      ["Review", "stopped", "2 stopped"],
      ["Challenge", "stopped", "1 done · 1 stopped"],
      ["Judge", "failed", "1 failed · 1 stopped"],
    ]);
    expect(card.state).toBe("stopped");
  });

  it("shows only the latest attempt of a retried call", () => {
    const card = deriveWorkflowCard({
      coordinator: { ...coordinator, status: "completed", completedAt: at(9) },
      coordinatorRuns: [{ status: "completed", ordinal: 2 }],
      agents: [
        agent({
          id: "flaky-1",
          phase: "Review",
          status: "failed",
          started: 1,
          call: "abc:1",
          attempt: 1,
        }),
        agent({
          id: "flaky-2",
          phase: "Review",
          status: "completed",
          started: 2,
          call: "abc:1",
          attempt: 2,
        }),
      ],
      waitingThreadIds: new Set(),
    })!;
    expect(card.state).toBe("done");
    expect(card.phases[0]?.agents.map((entry) => [entry.id, entry.attempt])).toEqual([
      ["flaky-2", 2],
    ]);
  });

  it("is running again while a retried coordinator runs after a terminal row", () => {
    const card = deriveWorkflowCard({
      coordinator: { ...coordinator, status: "interrupted" },
      coordinatorRuns: [
        { status: "interrupted", ordinal: 1 },
        { status: "running", ordinal: 2 },
      ],
      agents: [],
      waitingThreadIds: new Set(),
    })!;
    expect(card.state).toBe("running");
    expect(
      deriveWorkflowCard({
        coordinator: { ...coordinator, t3Workflow: undefined },
        agents: [],
        waitingThreadIds: new Set(),
      }),
    ).toBeNull();
  });

  it("reads the latest run's log line, skipping phase headings", () => {
    const runs = [
      { id: RunId.make("run-1"), ordinal: 1 },
      { id: RunId.make("run-2"), ordinal: 2 },
    ];
    expect(
      latestWorkflowLogLine(
        [
          { item: { type: "assistant_message", text: "found 3\nmore", runId: "run-2" } },
          { item: { type: "subagent", runId: "run-2" } },
          { item: { type: "assistant_message", text: "**Challenge**", runId: "run-2" } },
        ],
        runs,
      ),
    ).toBe("found 3");
    // A Retry that has not logged yet does not show the stopped run's last line.
    expect(
      latestWorkflowLogLine(
        [
          {
            item: { type: "assistant_message", text: "The workflow was stopped.", runId: "run-1" },
          },
        ],
        runs,
      ),
    ).toBeNull();
  });
});

describe("deriveWorkflowLineageGroup", () => {
  // The run's row in the starting thread: a delegated task on the hidden instance.
  const run: OrchestrationV2Subagent = {
    ...agent({ id: "run", phase: null, status: "running", started: 0, provider: "t3-workflow" }),
    threadId: ThreadId.make("thread:start"),
    childThreadId: ThreadId.make("thread:coordinator"),
    title: "Workflow: judged-review",
    t3Workflow: {
      kind: "run",
      name: "judged-review",
      phases: [
        { title: "Review" },
        { title: "Challenge" },
        { title: "Judge" },
        { title: "Report" },
      ],
    },
  };

  it("unfolds the run into its declared phases, each agent on its own provider", () => {
    const group = deriveWorkflowLineageGroup({
      coordinator: run,
      agents: [
        agent({
          id: "challenge-1",
          phase: "Challenge",
          status: "running",
          started: 3,
          provider: "claudeAgent",
        }),
        agent({
          id: "review-api",
          phase: "Review",
          status: "completed",
          started: 1,
          provider: "bob",
        }),
        agent({ id: "review-ui", phase: "Review", status: "failed", started: 2 }),
        agent({
          id: "challenge-2",
          phase: "Challenge",
          status: "pending",
          started: 4,
          provider: "bob",
        }),
        agent({ id: "judge", phase: "Judge", status: "cancelled", started: 5 }),
        agent({ id: "extra", phase: "Cleanup", status: "completed", started: 6 }),
      ],
    })!;

    expect(group.workflow).toMatchObject({
      id: "run",
      kind: "workflow",
      workflowName: "judged-review",
      status: "running",
      childThreadId: "thread:coordinator",
    });
    expect(
      group.phases.map((phase) => [
        phase.title,
        phase.state,
        `${phase.settledCount}/${phase.members.length}`,
      ]),
    ).toEqual([
      ["Review", "done", "2/2"],
      ["Challenge", "running", "0/2"],
      ["Judge", "done", "1/1"],
      ["Report", "pending", "0/0"],
      ["Cleanup", "done", "1/1"],
    ]);
    expect(
      group.phases.flatMap((phase) =>
        phase.members.map((member) => [
          phase.title,
          member.title,
          member.status,
          member.driver,
          member.providerInstanceId,
          member.childThreadId,
        ]),
      ),
    ).toEqual([
      ["Review", "review-api", "completed", "bob", "bob", "thread:review-api"],
      ["Review", "review-ui", "failed", "codex", "codex", "thread:review-ui"],
      ["Challenge", "challenge-1", "running", "claudeAgent", "claudeAgent", "thread:challenge-1"],
      ["Challenge", "challenge-2", "pending", "bob", "bob", "thread:challenge-2"],
      ["Judge", "judge", "cancelled", "codex", "codex", "thread:judge"],
      ["Cleanup", "extra", "completed", "codex", "codex", "thread:extra"],
    ]);
    expect(
      group.phases.every((phase) =>
        phase.members.every(
          (member) => member.kind === "workflow_agent" && member.parentAgentId === "run",
        ),
      ),
    ).toBe(true);
    expect(group.unphasedMembers).toEqual([]);
  });

  it("lists the declared phases before any agent starts", () => {
    const group = deriveWorkflowLineageGroup({ coordinator: run, agents: [] })!;
    expect(group.phases.map((phase) => [phase.title, phase.state, phase.members.length])).toEqual([
      ["Review", "pending", 0],
      ["Challenge", "pending", 0],
      ["Judge", "pending", 0],
      ["Report", "pending", 0],
    ]);
    expect(group.unphasedMembers).toEqual([]);
  });

  it("follows the run's state, including a Retry after it stopped", () => {
    const stopped = { ...run, status: "interrupted" as const, completedAt: at(9) };
    expect(
      deriveWorkflowLineageGroup({ coordinator: stopped, agents: [] })?.workflow,
    ).toMatchObject({ status: "interrupted", completedAt: "2026-10-07T10:00:09.000Z" });
    expect(
      deriveWorkflowLineageGroup({
        coordinator: stopped,
        coordinatorRuns: [
          { status: "interrupted", ordinal: 1 },
          { status: "running", ordinal: 2 },
        ],
        agents: [],
      })?.workflow,
    ).toMatchObject({ status: "running", completedAt: null });
    expect(
      deriveWorkflowLineageGroup({ coordinator: { ...run, t3Workflow: undefined }, agents: [] }),
    ).toBeNull();
  });
});

describe("workflowResultPreview", () => {
  it("reads a returned object as its top-level fields", () => {
    const result = [
      "```json",
      JSON.stringify(
        {
          status: "unresolved-findings",
          branch: "t3/wf/x",
          implementation: { summary: "Built" },
          notes: [1, 2],
        },
        null,
        2,
      ),
      "```",
      "",
      "Spent 4 Bobcoins.",
    ].join("\n");
    expect(workflowResultPreview(result)).toBe(
      "status: unresolved-findings · branch: t3/wf/x · implementation: {…} · notes: [2]",
    );
  });

  it("keeps a text result, and a fence it cannot read, as written", () => {
    expect(workflowResultPreview("All 3 reviews passed.")).toBe("All 3 reviews passed.");
    expect(workflowResultPreview("```json\n{oops\n```")).toBe("```json\n{oops\n```");
    expect(workflowResultPreview("```json\n[1, 2, 3]\n```")).toBe("[3]");
    expect(workflowResultPreview(null)).toBeNull();
    // A run that finished before results were fenced.
    expect(workflowResultPreview('{"status":"done","n":2}\n\nNote: 1 agent failed.')).toBe(
      "status: done · n: 2",
    );
    expect(workflowResultPreview("{not json")).toBe("{not json");
    // A run whose value had a summary leads with it, the other fields below as JSON.
    expect(
      workflowResultPreview('All six agents finished.\n\n```json\n{\n  "branch": "b"\n}\n```'),
    ).toBe("All six agents finished.");
  });
});
