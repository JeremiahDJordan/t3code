import {
  formatSubagentDisplayTitle,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { SubagentPillSegment } from "@t3tools/client-runtime/state/thread-subagents";
import { deriveWorkflowCard, isWorkflowRunLive } from "@t3tools/client-runtime/state/workflowCard";
import type { OrchestrationV2Run, OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";
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

const startOrder = (subagent: OrchestrationV2Subagent) =>
  DateTime.toEpochMillis(subagent.startedAt ?? subagent.updatedAt);

/**
 * The agents the sheet lists as rows: the turn's, plus any still working from an earlier turn.
 * The Waiting control opens this sheet for whatever a settled thread still waits on, which can be
 * an older turn's agent. Workflow runs read as cards instead.
 */
export function sheetAgentRows(
  threadSubagents: ReadonlyArray<OrchestrationV2Subagent>,
  turnSubagents: ReadonlyArray<OrchestrationV2Subagent>,
): ReadonlyArray<OrchestrationV2Subagent> {
  const inTurn = new Set(turnSubagents.map((subagent) => subagent.id));
  const earlierLive = threadSubagents.filter(
    (subagent) => !inTurn.has(subagent.id) && isActiveSubagentStatus(subagent.status),
  );
  // `filter` returned a new array; Hermes has no `toSorted`.
  return [...earlierLive, ...turnSubagents]
    .filter((subagent) => subagent.t3Workflow?.kind !== "run")
    .sort((left, right) => startOrder(left) - startOrder(right) || left.id.localeCompare(right.id));
}

/** Each workflow coordinator thread's latest run status, read from its shell. */
export type CoordinatorRunStatuses = ReadonlyMap<ThreadId, OrchestrationV2Run["status"]>;

/** A workflow run is live while its row is, or while a Retry runs its coordinator thread. */
function workflowRunIsLive(
  subagent: OrchestrationV2Subagent,
  coordinatorRunStatuses: CoordinatorRunStatuses,
): boolean {
  if (subagent.t3Workflow?.kind !== "run") return false;
  const status =
    subagent.childThreadId === null
      ? undefined
      : coordinatorRunStatuses.get(subagent.childThreadId);
  return isWorkflowRunLive({
    coordinator: subagent,
    ...(status === undefined ? {} : { coordinatorRuns: [{ ordinal: 0, status }] }),
  });
}

/**
 * Every workflow run a thread started, as its agents sheet shows them: live ones first, then
 * newest. A finished run stays, since its card holds the script and Retry; the sheet shows it as
 * a row until opened, so a thread's history does not load every coordinator thread.
 */
export function sheetWorkflowRuns(
  threadSubagents: ReadonlyArray<OrchestrationV2Subagent>,
  coordinatorRunStatuses: CoordinatorRunStatuses,
): ReadonlyArray<{ readonly run: OrchestrationV2Subagent; readonly live: boolean }> {
  return threadSubagents
    .filter((subagent) => subagent.t3Workflow?.kind === "run")
    .map((run) => ({ run, live: workflowRunIsLive(run, coordinatorRunStatuses) }))
    .sort(
      (left, right) =>
        Number(right.live) - Number(left.live) ||
        DateTime.toEpochMillis(right.run.updatedAt) - DateTime.toEpochMillis(left.run.updatedAt),
    );
}

/**
 * The pill's agents segment when the turn's own has none. A thread that started workflows keeps
 * it, running or finished, so their cards stay one tap away after the thread settles.
 */
export function workflowPillSegment(
  threadSubagents: ReadonlyArray<OrchestrationV2Subagent>,
  coordinatorRunStatuses: CoordinatorRunStatuses,
): SubagentPillSegment | null {
  const runs = threadSubagents.filter((subagent) => subagent.t3Workflow?.kind === "run");
  if (runs.length === 0) return null;
  const noun = (count: number) => (count === 1 ? "workflow" : "workflows");
  const running = runs.filter((run) => workflowRunIsLive(run, coordinatorRunStatuses)).length;
  if (running > 0) {
    return {
      label: `${running} ${noun(running)}`,
      accessibilityLabel: `${running} ${noun(running)} running`,
    };
  }
  return {
    label: `${runs.length} ${noun(runs.length)} done`,
    accessibilityLabel: `${runs.length} ${noun(runs.length)} done`,
  };
}
