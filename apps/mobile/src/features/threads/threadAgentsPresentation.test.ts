import { presentPendingBackgroundWork } from "@t3tools/client-runtime/state/thread-execution";
import {
  deriveThreadTurnSubagents,
  resolveSubagentPillSegment,
} from "@t3tools/client-runtime/state/thread-subagents";
import { deriveWorkflowCard } from "@t3tools/client-runtime/state/workflowCard";
import {
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  groupWorkflowAgentsByPhase,
  resolveSubagentRowPresentation,
  sheetAgentRows,
  sheetWorkflowRuns,
  workflowPillSegment,
  type CoordinatorRunStatuses,
} from "./threadAgentsPresentation";

const base = {
  title: null,
  prompt: "Audit the timestamps",
  status: "running" as const,
  result: null,
  childThreadId: "thread-child" as never,
};

describe("resolveSubagentRowPresentation", () => {
  it("leads with progress while the agent is working", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      progress: "Reading files",
      result: "stale result",
    });

    expect(row.detail).toBe("Reading files");
    expect(row.tone).toBe("working");
    expect(row.live).toBe(true);
  });

  it("leads with the result once the agent has settled", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      status: "completed",
      progress: "Reading files",
      result: "Found two\n  problems",
    });

    expect(row.detail).toBe("Found two problems");
    expect(row.tone).toBe("completed");
    expect(row.statusLabel).toBe("Completed");
  });

  it("shows a failure's text, since that is where the error lands", () => {
    const row = resolveSubagentRowPresentation({ ...base, status: "failed", result: "Timed out" });

    expect(row.detail).toBe("Timed out");
    expect(row.tone).toBe("failed");
  });

  it("falls back to a trimmed prompt when the agent has no title", () => {
    const long = resolveSubagentRowPresentation({ ...base, prompt: "x".repeat(200) });
    const titled = resolveSubagentRowPresentation({ ...base, title: "Subagent: /root/my_worker" });

    expect(long.title).toHaveLength(80);
    expect(long.title.endsWith("...")).toBe(true);
    expect(titled.title).toBe("My Worker");
  });

  it("only offers a thread to open when the agent has one", () => {
    expect(resolveSubagentRowPresentation(base).canOpenThread).toBe(true);
    expect(resolveSubagentRowPresentation({ ...base, childThreadId: null }).canOpenThread).toBe(
      false,
    );
  });

  it("uses the status label when there is nothing to report yet", () => {
    const row = resolveSubagentRowPresentation({ ...base, status: "pending" });

    expect(row.detail).toBeNull();
    expect(row.statusLabel).toBe("Working");
  });

  it("bounds long result previews without dropping the agent's status", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      status: "failed",
      result: "x".repeat(400),
    });
    expect(row.detail).toBe(`${"x".repeat(280)}…`);
    expect(row.statusLabel).toBe("Failed");
  });
});

function workflowAgent(id: string, phase: string | null, started: number): OrchestrationV2Subagent {
  const startedAt = DateTime.makeUnsafe(`2026-10-07T10:00:${String(started).padStart(2, "0")}Z`);
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("thread:coordinator"),
    runId: null,
    parentNodeId: NodeId.make("node:root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: ThreadId.make(`thread:${id}`),
    nativeTaskRef: null,
    prompt: `do ${id}`,
    title: id,
    model: null,
    status: "running",
    result: null,
    t3Workflow: { kind: "agent", phase, role: null, attempt: 1 },
    startedAt,
    completedAt: null,
    updatedAt: startedAt,
  };
}

describe("groupWorkflowAgentsByPhase", () => {
  const agents = [
    workflowAgent("judge", "Judge", 1),
    workflowAgent("review", "Review", 2),
    workflowAgent("loose", null, 3),
  ];

  it("follows the declared phases and leaves out ones with no agents", () => {
    const groups = groupWorkflowAgentsByPhase(agents, {
      t3Workflow: {
        kind: "run",
        name: "judged-review",
        phases: [{ title: "Review" }, { title: "Challenge" }, { title: "Judge" }],
      },
      status: "running",
      startedAt: null,
      completedAt: null,
    });

    expect(groups?.map((group) => [group.title, group.subagents.map((s) => s.id)])).toEqual([
      ["Review", ["review"]],
      ["Judge", ["judge"]],
      ["Agents", ["loose"]],
    ]);
  });

  it("orders phases by first agent without the coordinator's row", () => {
    const groups = groupWorkflowAgentsByPhase(agents, null);

    expect(groups?.map((group) => group.title)).toEqual(["Judge", "Review", "Agents"]);
  });

  it("does not group agents that are not a workflow's", () => {
    const plain = { ...workflowAgent("plain", null, 1), t3Workflow: undefined };

    expect(groupWorkflowAgentsByPhase([plain], null)).toBeNull();
  });
});

function workflowRun(
  id: string,
  status: OrchestrationV2Subagent["status"],
  updated: number,
): OrchestrationV2Subagent {
  const updatedAt = DateTime.makeUnsafe(`2026-10-07T11:00:${String(updated).padStart(2, "0")}Z`);
  return {
    ...workflowAgent(id, null, 1),
    providerInstanceId: ProviderInstanceId.make("t3-workflow"),
    status,
    t3Workflow: { kind: "run", name: id, phases: [] },
    updatedAt,
  };
}

const NO_RETRIES: CoordinatorRunStatuses = new Map();

describe("the agents sheet's workflow cards", () => {
  const live = workflowRun("live", "running", 1);
  const earlierDone = workflowRun("earlier-done", "completed", 2);
  const thisTurnDone = workflowRun("this-turn-done", "completed", 3);
  const plain = workflowAgent("plain", null, 4);
  const thread = [earlierDone, plain, thisTurnDone, live];

  it("shows every run the thread started, live first, then newest", () => {
    expect(
      sheetWorkflowRuns(thread, NO_RETRIES).map((entry) => [entry.run.id, entry.live]),
    ).toEqual([
      ["live", true],
      ["this-turn-done", false],
      ["earlier-done", false],
    ]);
  });

  it("counts running workflows in the pill", () => {
    expect(workflowPillSegment(thread, NO_RETRIES)).toEqual({
      label: "1 workflow",
      accessibilityLabel: "1 workflow running",
    });
    expect(workflowPillSegment([plain], NO_RETRIES)).toBeNull();
  });

  // The feed has no workflow rows, so once the parent settles the pill is the card's only entry:
  // `task_status` can acknowledge completion before the wake, and a batched completion has no
  // single child link.
  it.each(["completed", "failed"] as const)(
    "keeps the pill and card after a workflow has %s and the parent settled",
    (status) => {
      const ended = workflowRun("ended", status, 9);
      // No active run: the parent has settled.
      const turn = deriveThreadTurnSubagents({ runs: [], subagents: [ended] });

      expect(resolveSubagentPillSegment(turn)).toBeNull();
      expect(workflowPillSegment([ended], NO_RETRIES)).toEqual({
        label: "1 workflow done",
        accessibilityLabel: "1 workflow done",
      });
      expect(sheetWorkflowRuns([ended], NO_RETRIES).map((entry) => entry.run.id)).toEqual([
        "ended",
      ]);
    },
  );

  it("reads a Retry as running the way the card does, outside the selected turn", () => {
    const retried = workflowRun("retried", "failed", 9);
    const newerDone = workflowRun("newer-done", "completed", 10);
    const coordinatorThreadId = ThreadId.make("thread:retried");
    const retrying: CoordinatorRunStatuses = new Map([[coordinatorThreadId, "running"]]);

    expect(
      deriveWorkflowCard({
        coordinator: retried,
        coordinatorRuns: [{ ordinal: 2, status: "running" }],
        agents: [],
        waitingThreadIds: new Set(),
      })?.state,
    ).toBe("running");
    expect(workflowPillSegment([retried, newerDone], retrying)?.accessibilityLabel).toBe(
      "1 workflow running",
    );
    expect(
      sheetWorkflowRuns([newerDone, retried], retrying).map((entry) => [entry.run.id, entry.live]),
    ).toEqual([
      ["retried", true],
      ["newer-done", false],
    ]);
    // Once the coordinator thread settles again, the run reads as it ended.
    const settled: CoordinatorRunStatuses = new Map([[coordinatorThreadId, "failed"]]);
    expect(workflowPillSegment([retried], settled)?.label).toBe("1 workflow done");
  });
});

function run(id: string, ordinal: number, status: OrchestrationV2Run["status"]) {
  return { id: RunId.make(id), ordinal, status };
}

describe("the agents sheet's rows", () => {
  function ordinary(
    id: string,
    runId: string,
    status: OrchestrationV2Subagent["status"],
    started: number,
  ): OrchestrationV2Subagent {
    const at = DateTime.makeUnsafe(`2026-10-07T12:00:${String(started).padStart(2, "0")}Z`);
    return {
      ...workflowAgent(id, null, started),
      runId: RunId.make(runId),
      status,
      t3Workflow: undefined,
      startedAt: at,
      completedAt: status === "running" ? null : at,
      updatedAt: status === "running" ? at : DateTime.add(at, { seconds: 30 }),
    };
  }

  it("lists the older child the Waiting control names when a newer one finished last", () => {
    const older = ordinary("older", "run-1", "running", 1);
    const newer = ordinary("newer", "run-2", "completed", 2);
    const runs = [run("run-1", 1, "completed"), run("run-2", 2, "completed")];
    // No active run: the parent has settled, so the turn is the last one updated.
    const turn = deriveThreadTurnSubagents({ runs: [], subagents: [older, newer] });
    const waiting = presentPendingBackgroundWork(
      derivePendingBackgroundWork({
        latestRun: runs[1],
        runs,
        providerThreads: [],
        turnItems: [older, newer].map((subagent) => ({
          id: subagent.id,
          type: "subagent" as const,
          status: subagent.status,
          title: subagent.title,
          runId: subagent.runId,
          childThreadId: subagent.childThreadId,
        })),
      }),
    );

    expect(waiting?.title).toBe("Waiting on subagent older");
    // The selected turn is the newer child's alone.
    expect(turn?.subagents.map((subagent) => subagent.id)).toEqual(["newer"]);
    const rows = sheetAgentRows([older, newer], turn?.subagents ?? []);
    expect(rows.map((subagent) => subagent.id)).toEqual(["older", "newer"]);
    expect(rows.map((subagent) => subagent.childThreadId)).toEqual(
      expect.arrayContaining(waiting?.items.map((item) => item.childThreadId) ?? []),
    );
  });

  it("leaves out an earlier turn's settled agents and every workflow run", () => {
    const earlierDone = ordinary("earlier-done", "run-1", "completed", 1);
    const current = ordinary("current", "run-2", "running", 2);
    const workflow = { ...workflowRun("workflow", "running", 3), runId: RunId.make("run-2") };

    expect(
      sheetAgentRows([earlierDone, current, workflow], [current, workflow]).map(
        (subagent) => subagent.id,
      ),
    ).toEqual(["current"]);
  });
});
