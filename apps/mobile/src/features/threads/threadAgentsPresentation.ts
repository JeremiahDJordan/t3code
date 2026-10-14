import {
  formatSubagentDisplayTitle,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { SubagentPillSegment } from "@t3tools/client-runtime/state/thread-subagents";
import { deriveWorkflowCard } from "@t3tools/client-runtime/state/workflowCard";
import { isOrchestrationV2WorkActive, type OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const PROMPT_TITLE_LIMIT = 80;

type WorkflowCoordinator = Pick<
  OrchestrationV2Subagent,
  "t3Workflow" | "status" | "startedAt" | "completedAt"
>;

// Stands in for a coordinator row that has not loaded: no declared phases, so
// phases follow the order agents started in.
const UNDECLARED_WORKFLOW_RUN: WorkflowCoordinator = {
  t3Workflow: { kind: "run", name: "Workflow", phases: [] },
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
  if (!subagents.some((subagent) => subagent.t3Workflow?.kind === "agent")) return null;
  const card = deriveWorkflowCard({
    coordinator: coordinator?.t3Workflow?.kind === "run" ? coordinator : UNDECLARED_WORKFLOW_RUN,
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
  readonly detail: string | null;
  readonly statusLabel: string;
  readonly tone: SubagentRowTone;
  readonly live: boolean;
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

const workflowRunIsLive = (subagent: OrchestrationV2Subagent) =>
  subagent.t3Workflow?.kind === "run" && isOrchestrationV2WorkActive(subagent.status);

/**
 * The workflow runs a thread started that its agents sheet shows as cards: every one still
 * running, whichever turn started it, and any in the turn the sheet lists. Live ones first,
 * then newest.
 */
export function sheetWorkflowRuns(
  threadSubagents: ReadonlyArray<OrchestrationV2Subagent>,
  turnSubagents: ReadonlyArray<OrchestrationV2Subagent>,
): ReadonlyArray<OrchestrationV2Subagent> {
  const inTurn = new Set(turnSubagents.map((subagent) => subagent.id));
  return threadSubagents
    .filter(
      (subagent) =>
        subagent.t3Workflow?.kind === "run" &&
        (workflowRunIsLive(subagent) || inTurn.has(subagent.id)),
    )
    .sort(
      (left, right) =>
        Number(workflowRunIsLive(right)) - Number(workflowRunIsLive(left)) ||
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
}

/**
 * The pill's agents segment when the turn's own has none: a workflow still running from an
 * earlier turn keeps the sheet one tap away while the thread does other work.
 */
export function workflowPillSegment(
  threadSubagents: ReadonlyArray<OrchestrationV2Subagent>,
  turnSubagents: ReadonlyArray<OrchestrationV2Subagent>,
): SubagentPillSegment | null {
  const inTurn = new Set(turnSubagents.map((subagent) => subagent.id));
  const running = threadSubagents.filter(
    (subagent) => workflowRunIsLive(subagent) && !inTurn.has(subagent.id),
  ).length;
  if (running === 0) return null;
  const noun = running === 1 ? "workflow" : "workflows";
  return { label: `${running} ${noun}`, accessibilityLabel: `${running} ${noun} running` };
}
