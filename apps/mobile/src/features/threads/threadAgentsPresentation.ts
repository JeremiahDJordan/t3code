import {
  formatSubagentDisplayTitle,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import { deriveWorkflowCard } from "@t3tools/client-runtime/state/workflowCard";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";

const PROMPT_TITLE_LIMIT = 80;

type WorkflowCoordinator = Pick<
  OrchestrationV2Subagent,
  "workflow" | "status" | "startedAt" | "completedAt"
>;

// Stands in for a coordinator row that has not loaded: no declared phases, so
// phases follow the order agents started in.
const UNDECLARED_WORKFLOW_RUN: WorkflowCoordinator = {
  workflow: { kind: "run", name: "Workflow", phases: [] },
  status: "running",
  startedAt: null,
  completedAt: null,
};

export interface WorkflowAgentPhaseGroup {
  readonly title: string;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
}

/**
 * A workflow coordinator thread's agents under their phases, in the order the
 * workflow card shows them. Null when the agents are not a workflow's.
 */
export function groupWorkflowAgentsByPhase(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  coordinator: WorkflowCoordinator | null,
): ReadonlyArray<WorkflowAgentPhaseGroup> | null {
  if (!subagents.some((subagent) => subagent.workflow?.kind === "agent")) return null;
  const card = deriveWorkflowCard({
    coordinator: coordinator?.workflow?.kind === "run" ? coordinator : UNDECLARED_WORKFLOW_RUN,
    agents: subagents,
    waitingThreadIds: new Set(),
  });
  const byId = new Map(subagents.map((subagent) => [subagent.id, subagent]));
  return (card?.phases ?? []).flatMap((phase) => {
    const rows = phase.agents.flatMap((agent) => byId.get(agent.id) ?? []);
    return rows.length === 0 ? [] : [{ title: phase.title, subagents: rows }];
  });
}

export type SubagentRowTone = "working" | "completed" | "failed" | "stopped";

export interface SubagentRowPresentation {
  readonly title: string;
  /** Live agents lead with progress; settled ones lead with what came out. */
  readonly detail: string | null;
  readonly statusLabel: string;
  readonly tone: SubagentRowTone;
  readonly live: boolean;
  /** Provider-native tasks have no thread of their own to open. */
  readonly canOpenThread: boolean;
}

function rowTitle(subagent: Pick<OrchestrationV2Subagent, "title" | "prompt">): string {
  const title = subagent.title?.trim();
  if (title) return formatSubagentDisplayTitle(title);
  const prompt = subagent.prompt.trim();
  if (prompt.length === 0) return "Subagent";
  return prompt.length > PROMPT_TITLE_LIMIT
    ? `${prompt.slice(0, PROMPT_TITLE_LIMIT - 3)}...`
    : prompt;
}

export function subagentRowTone(status: OrchestrationV2Subagent["status"]): SubagentRowTone {
  if (isActiveSubagentStatus(status)) return "working";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

export function subagentRowStatusLabel(status: OrchestrationV2Subagent["status"]): string {
  switch (status) {
    case "pending":
    case "running":
      return "Working";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
  }
}

export function resolveSubagentRowPresentation(
  subagent: Pick<
    OrchestrationV2Subagent,
    "title" | "prompt" | "status" | "progress" | "result" | "childThreadId"
  >,
): SubagentRowPresentation {
  const live = isActiveSubagentStatus(subagent.status);
  return {
    title: rowTitle(subagent),
    detail: subagentDetailPreview(subagent),
    statusLabel: subagentRowStatusLabel(subagent.status),
    tone: subagentRowTone(subagent.status),
    live,
    canOpenThread: subagent.childThreadId !== null,
  };
}
