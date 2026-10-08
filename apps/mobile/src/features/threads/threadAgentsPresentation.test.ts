import {
  NodeId,
  type OrchestrationV2Subagent,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  groupWorkflowAgentsByPhase,
  resolveSubagentRowPresentation,
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
    workflow: { kind: "agent", phase, role: null, attempt: 1 },
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
      workflow: {
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
    const plain = { ...workflowAgent("plain", null, 1), workflow: undefined };

    expect(groupWorkflowAgentsByPhase([plain], null)).toBeNull();
  });
});
