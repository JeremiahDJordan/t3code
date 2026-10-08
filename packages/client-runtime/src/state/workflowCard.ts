/**
 * The workflow card's model, shared by web and mobile: a workflow run's
 * phases in declared order, each with its agents and counts. It is derived
 * from rows clients already receive, the coordinator's row in the starting
 * thread and the agents' rows in the coordinator thread, so nothing new
 * streams.
 */
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2WorkflowPhase,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** The hidden provider instance that drives a workflow's coordinator thread. */
export { WORKFLOW_PROVIDER_INSTANCE_ID } from "@t3tools/contracts";

export type WorkflowCardState = "running" | "waiting" | "done" | "failed" | "stopped";
export type WorkflowPhaseStatus = "pending" | "running" | "done" | "failed" | "stopped";

export interface WorkflowCardAgent {
  readonly id: OrchestrationV2Subagent["id"];
  readonly title: string;
  readonly role: string | null;
  readonly attempt: number;
  readonly providerInstanceId: OrchestrationV2Subagent["providerInstanceId"];
  readonly driver: OrchestrationV2Subagent["driver"];
  readonly model: string | null;
  readonly status: OrchestrationV2Subagent["status"];
  readonly childThreadId: ThreadId | null;
  readonly waitingForUser: boolean;
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
}

export interface WorkflowCardCounts {
  readonly working: number;
  readonly done: number;
  readonly failed: number;
  readonly stopped: number;
}

export interface WorkflowCardPhase {
  readonly title: string;
  readonly detail: string | null;
  readonly status: WorkflowPhaseStatus;
  readonly agents: ReadonlyArray<WorkflowCardAgent>;
  readonly counts: WorkflowCardCounts;
  readonly waitingForUser: number;
}

export interface WorkflowCard {
  readonly name: string;
  readonly state: WorkflowCardState;
  readonly phases: ReadonlyArray<WorkflowCardPhase>;
  /** Agents across every phase, done and started. */
  readonly counts: WorkflowCardCounts & { readonly started: number };
  readonly waitingForUser: number;
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
}

const UNPHASED = "Agents";

const isWorkflowRun = (
  workflow: OrchestrationV2Subagent["workflow"],
): workflow is Extract<NonNullable<OrchestrationV2Subagent["workflow"]>, { kind: "run" }> =>
  workflow?.kind === "run";

function emptyCounts(): { working: number; done: number; failed: number; stopped: number } {
  return { working: 0, done: 0, failed: 0, stopped: 0 };
}

function count(counts: ReturnType<typeof emptyCounts>, status: OrchestrationV2Subagent["status"]) {
  if (isOrchestrationV2WorkActive(status)) counts.working += 1;
  else if (status === "completed") counts.done += 1;
  else if (status === "failed") counts.failed += 1;
  else if (status === "cancelled" || status === "interrupted") counts.stopped += 1;
}

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

export function deriveWorkflowCard(input: {
  /** The coordinator's row in the thread that started the workflow. */
  readonly coordinator: Pick<
    OrchestrationV2Subagent,
    "workflow" | "status" | "startedAt" | "completedAt"
  >;
  /** The coordinator thread's runs, when known: a Retry runs again after a terminal row. */
  readonly coordinatorRuns?: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "ordinal">>;
  /** The coordinator thread's subagent rows. */
  readonly agents: ReadonlyArray<OrchestrationV2Subagent>;
  /** Child threads with an approval or question waiting on the user. */
  readonly waitingThreadIds: ReadonlySet<ThreadId>;
}): WorkflowCard | null {
  const workflow = input.coordinator.workflow;
  if (!isWorkflowRun(workflow)) return null;

  // A retried call keeps only its latest attempt.
  const latest = new Map<string, OrchestrationV2Subagent>();
  for (const agent of input.agents) {
    if (agent.workflow?.kind !== "agent") continue;
    const key = agent.workflow.call ?? agent.id;
    const current = latest.get(key);
    if (
      current === undefined ||
      (current.workflow?.kind === "agent" && current.workflow.attempt < agent.workflow.attempt)
    ) {
      latest.set(key, agent);
    }
  }
  const agents = [...latest.values()].sort(
    (left, right) =>
      (left.startedAt === null ? 0 : DateTime.toEpochMillis(left.startedAt)) -
      (right.startedAt === null ? 0 : DateTime.toEpochMillis(right.startedAt)),
  );

  const declared: ReadonlyArray<OrchestrationV2WorkflowPhase> = workflow.phases;
  const order = declared.map((phase) => phase.title);
  const byPhase = new Map<string, Array<WorkflowCardAgent>>();
  for (const agent of agents) {
    const facts = agent.workflow?.kind === "agent" ? agent.workflow : undefined;
    const phase = facts?.phase ?? UNPHASED;
    if (!order.includes(phase)) order.push(phase);
    const list = byPhase.get(phase) ?? [];
    list.push({
      id: agent.id,
      title: agent.title ?? agent.prompt.split("\n")[0] ?? "Agent",
      role: facts?.role ?? null,
      attempt: facts?.attempt ?? 1,
      providerInstanceId: agent.providerInstanceId,
      driver: agent.driver,
      model: agent.model,
      status: agent.status,
      childThreadId: agent.childThreadId,
      waitingForUser:
        agent.childThreadId !== null &&
        isOrchestrationV2WorkActive(agent.status) &&
        input.waitingThreadIds.has(agent.childThreadId),
      startedAt: agent.startedAt,
      completedAt: agent.completedAt,
    });
    byPhase.set(phase, list);
  }

  const totals = emptyCounts();
  let waitingForUser = 0;
  const phases = order.map((title): WorkflowCardPhase => {
    const phaseAgents = byPhase.get(title) ?? [];
    const counts = emptyCounts();
    for (const agent of phaseAgents) {
      count(counts, agent.status);
      count(totals, agent.status);
    }
    const waiting = phaseAgents.filter((agent) => agent.waitingForUser).length;
    waitingForUser += waiting;
    // A phase with a stopped agent did not finish its work, so it is not done.
    const status: WorkflowPhaseStatus =
      phaseAgents.length === 0
        ? "pending"
        : counts.working > 0
          ? "running"
          : counts.failed > 0
            ? "failed"
            : counts.stopped > 0
              ? "stopped"
              : "done";
    return {
      title,
      detail: declared.find((phase) => phase.title === title)?.detail ?? null,
      status,
      agents: phaseAgents,
      counts,
      waitingForUser: waiting,
    };
  });

  const latestRun =
    input.coordinatorRuns === undefined
      ? undefined
      : [...input.coordinatorRuns].sort((left, right) => right.ordinal - left.ordinal)[0];
  const runLive =
    latestRun !== undefined &&
    (latestRun.status === "queued" ||
      latestRun.status === "preparing" ||
      latestRun.status === "starting" ||
      latestRun.status === "running" ||
      latestRun.status === "waiting");
  const coordinatorStatus = input.coordinator.status;
  const state: WorkflowCardState =
    runLive || isOrchestrationV2WorkActive(coordinatorStatus) || coordinatorStatus === "idle"
      ? waitingForUser > 0
        ? "waiting"
        : "running"
      : coordinatorStatus === "completed"
        ? "done"
        : coordinatorStatus === "failed"
          ? "failed"
          : "stopped";

  return {
    name: workflow.name,
    state,
    phases,
    counts: { ...totals, started: agents.length },
    waitingForUser,
    startedAt: input.coordinator.startedAt,
    completedAt: state === "running" || state === "waiting" ? null : input.coordinator.completedAt,
  };
}

/**
 * The latest `log()` line in a coordinator thread's turn items: its newest
 * assistant message that is not a phase heading.
 */
export function latestWorkflowLogLine(
  items: ReadonlyArray<{
    readonly item: { readonly type: string; readonly text?: string; readonly runId: string | null };
  }>,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal">>,
): string | null {
  // A Retry's line comes from its own run, not the "stopped" line before it.
  const latestRunId = [...runs].sort((left, right) => right.ordinal - left.ordinal)[0]?.id;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!.item;
    if (item.type !== "assistant_message" || item.text === undefined) continue;
    if (latestRunId !== undefined && item.runId !== latestRunId) continue;
    const text = item.text.trim();
    if (text === "" || /^\*\*.+\*\*$/.test(text)) continue;
    return text.split("\n")[0]!;
  }
  return null;
}
