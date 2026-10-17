/**
 * The workflow card's model, shared by web and mobile: a workflow run's
 * phases in declared order, each with its agents and counts. It is derived
 * from rows clients already receive, the coordinator's row in the starting
 * thread and the agents' rows in the coordinator thread, so nothing new
 * streams. The derivation lives in `@t3tools/shared/workflowCard`, which the
 * server's `task_status` reads too.
 */
import { type OrchestrationV2Run, type OrchestrationV2Subagent } from "@t3tools/contracts";
import { deriveWorkflowCard, type WorkflowCardCounts } from "@t3tools/shared/workflowCard";
import * as DateTime from "effect/DateTime";

import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
  type RuntimeSubagent,
  type SubagentWorkflowGroup,
} from "./subagentRuntime.ts";

/** The hidden provider instance that drives a workflow's coordinator thread. */
export { WORKFLOW_PROVIDER_INSTANCE_ID } from "@t3tools/contracts";
export {
  deriveWorkflowCard,
  isWorkflowRunLive,
  latestWorkflowLogLine,
  type WorkflowCard,
  type WorkflowCardAgent,
  type WorkflowCardCounts,
  type WorkflowCardPhase,
  type WorkflowCardState,
  type WorkflowPhaseStatus,
} from "@t3tools/shared/workflowCard";

/** "3 working · 5 done · 1 failed", leaving out what is zero. */
export function formatWorkflowCounts(counts: WorkflowCardCounts): string {
  return [
    counts.working > 0 ? `${counts.working} working` : null,
    counts.done > 0 ? `${counts.done} done` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    counts.stopped > 0 ? `${counts.stopped} stopped` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/**
 * A workflow run as upstream's Lineage workflow group, so the starting thread's
 * Lineage unfolds it the way it unfolds a Claude workflow: the card's phases in
 * declared order, each with the latest attempt of its agents, every agent on
 * its own provider and opening its own child thread.
 */
export function deriveWorkflowLineageGroup(input: {
  /** The coordinator's row in the thread that started the workflow. */
  readonly coordinator: OrchestrationV2Subagent;
  readonly coordinatorRuns?: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "ordinal">>;
  /** The coordinator thread's subagent rows. */
  readonly agents: ReadonlyArray<OrchestrationV2Subagent>;
}): SubagentWorkflowGroup | null {
  // Waiting for the user is the card's to show; Lineage has no badge for it.
  const card = deriveWorkflowCard({ ...input, waitingThreadIds: new Set() });
  if (card === null) return null;
  const live = card.state === "running" || card.state === "waiting";
  const workflow: RuntimeSubagent = {
    ...projectedSubagentsToRuntime([input.coordinator])[0]!,
    kind: "workflow",
    workflowName: card.name,
    phases: card.phases.map((phase, index) => ({ index, title: phase.title })),
    // A Retry runs the coordinator thread again after its row settled.
    status: live ? "running" : input.coordinator.status,
    completedAt: card.completedAt === null ? null : DateTime.formatIso(card.completedAt),
  };
  const rows = new Map(input.agents.map((agent) => [agent.id, agent]));
  let agentIndex = 0;
  const members = card.phases.flatMap((phase, phaseIndex) =>
    phase.agents.map((agent): RuntimeSubagent => ({
      ...projectedSubagentsToRuntime([rows.get(agent.id)!])[0]!,
      kind: "workflow_agent",
      title: agent.title,
      role: agent.role,
      attempt: agent.attempt,
      parentAgentId: workflow.id,
      agentIndex: agentIndex++,
      phaseIndex,
      phaseTitle: phase.title,
      providerInstanceId: agent.providerInstanceId,
      driver: agent.driver,
    })),
  );
  return deriveWorkflowGroups([workflow, ...members])[0] ?? null;
}

const FENCED_JSON = /^```json\n([\s\S]*?)\n```/;

function previewValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === "object") return "{…}";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  return String(value);
}

/**
 * A finished run's result as the card's one line. A script that returned an object reads as its
 * top-level fields, `status: done · branch: main · findings: [3]`, rather than raw JSON; any
 * other result is its own text.
 */
export function workflowResultPreview(result: string | null): string | null {
  if (result === null) return null;
  const trimmed = result.trim();
  // Runs that finished before results were fenced lead with one line of JSON.
  const json =
    FENCED_JSON.exec(trimmed)?.[1] ??
    (/^[[{]/.test(trimmed) ? trimmed.split("\n\n")[0] : undefined);
  // A result with a `summary` leads with it as prose, before the rest as a JSON block.
  if (json === undefined) return trimmed.split("\n```json\n")[0]!.trim() || result;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return result;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return previewValue(value);
  }
  const fields = Object.entries(value);
  return fields.length === 0
    ? "{}"
    : fields.map(([key, field]) => `${key}: ${previewValue(field)}`).join(" · ");
}
