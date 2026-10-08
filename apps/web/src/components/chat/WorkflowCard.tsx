import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import {
  deriveWorkflowCard,
  formatWorkflowCounts,
  latestWorkflowLogLine,
  WORKFLOW_PROVIDER_INSTANCE_ID,
  type WorkflowCardAgent,
  type WorkflowCardPhase,
  type WorkflowCardState,
} from "@t3tools/client-runtime/state/workflowCard";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import {
  ArrowUpLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  RotateCcwIcon,
  SquareIcon,
  WorkflowIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

import { cn, newMessageId } from "~/lib/utils";
import { useThreadProjection, useThreadShell, useThreadShells } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SubagentAvatar, SubagentElapsed } from "./V2LifecycleRow";
import { WorkLogBlock } from "./WorkLog";

const STATE_LABEL: Record<WorkflowCardState, string> = {
  running: "Running",
  waiting: "Waiting for you",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

const AGENT_STATUS_LABEL: Record<OrchestrationV2Subagent["status"], string> = {
  pending: "Queued",
  running: "Working",
  waiting: "Working",
  idle: "Idle",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

const iso = (value: DateTime.Utc | null) => (value === null ? null : DateTime.formatIso(value));

function downloadTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/javascript;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * A workflow run as one card: its declared phases, each with its agents, and
 * the run's controls. It sits in the starting thread's timeline and heads the
 * coordinator thread.
 */
const WorkflowCard = memo(function WorkflowCard(props: {
  readonly environmentId: EnvironmentId;
  /** The coordinator's row in the thread that started the workflow. */
  readonly coordinator: OrchestrationV2Subagent;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Drawn at the top of the coordinator thread, which needs no link to itself. */
  readonly inCoordinatorThread?: boolean;
}) {
  const coordinatorThreadId = props.coordinator.childThreadId;
  const coordinatorRef =
    coordinatorThreadId === null ? null : scopeThreadRef(props.environmentId, coordinatorThreadId);
  const coordinatorThread = useThreadProjection(coordinatorRef)?.projection;
  // Retry reads the coordinator's modes from its shell, which is loaded even
  // when the coordinator thread's projection is not.
  const coordinatorShell = useThreadShell(coordinatorRef);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const shells = useThreadShells();
  const agents = coordinatorThread?.subagents;
  // Shells change whenever any thread does; key the set by its contents so the
  // card only re-derives when an agent starts or stops waiting on the user.
  const waitingKey = useMemo(() => {
    const children = new Set(agents?.flatMap((agent) => agent.childThreadId ?? []));
    return shells
      .filter(
        (shell) =>
          shell.environmentId === props.environmentId &&
          children.has(shell.id) &&
          (shell.hasPendingApprovals || shell.hasPendingUserInput),
      )
      .map((shell) => shell.id)
      .sort()
      .join("\n");
  }, [agents, props.environmentId, shells]);
  const waitingThreadIds = useMemo(
    () => new Set(waitingKey === "" ? [] : (waitingKey.split("\n") as ThreadId[])),
    [waitingKey],
  );
  const card = useMemo(
    () =>
      deriveWorkflowCard({
        coordinator: props.coordinator,
        ...(coordinatorThread === undefined ? {} : { coordinatorRuns: coordinatorThread.runs }),
        agents: agents ?? [],
        waitingThreadIds,
      }),
    [agents, coordinatorThread, props.coordinator, waitingThreadIds],
  );
  const latestLog = useMemo(
    () =>
      card?.state === "running" || card?.state === "waiting"
        ? latestWorkflowLogLine(
            coordinatorThread?.visibleTurnItems ?? [],
            coordinatorThread?.runs ?? [],
          )
        : null,
    [card?.state, coordinatorThread?.visibleTurnItems, coordinatorThread?.runs],
  );

  // Interrupting the run, as the composer's Stop does, also stops every agent it started.
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, "workflow stop");
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, "workflow retry");
  const resumeQueue = useOrchestrationCommand(threadEnvironment.resumeThreadQueue, {
    reportFailure: false,
  });
  const readScript = useAtomQueryRunner(orchestrationEnvironment.workflowScript, "workflow script");
  const [copied, setCopied] = useState(false);

  if (card === null) return null;
  const live = card.state === "running" || card.state === "waiting";
  const runningPhase = card.phases.find((phase) => phase.status === "running")?.title ?? null;

  const withScript = async (use: (script: { scriptPath: string; contents: string }) => void) => {
    if (coordinatorThreadId === null) return;
    const result = await readScript({
      environmentId: props.environmentId,
      input: { threadId: coordinatorThreadId },
    });
    if (AsyncResult.isSuccess(result)) use(result.value);
  };
  const stop = () => {
    if (coordinatorThreadId === null) return;
    void interruptTurn({
      environmentId: props.environmentId,
      input: { threadId: coordinatorThreadId },
    });
  };
  // A new turn on the coordinator reruns the script; finished agents are reused.
  const retry = async () => {
    if (coordinatorThreadId === null || coordinatorShell === null) return;
    await startTurn({
      environmentId: props.environmentId,
      input: {
        threadId: coordinatorThreadId,
        message: { messageId: newMessageId(), role: "user", text: "Retry", attachments: [] },
        modelSelection: {
          instanceId: ProviderInstanceId.make(WORKFLOW_PROVIDER_INSTANCE_ID),
          model: "script",
        },
        runtimeMode: coordinatorShell.runtimeMode,
        interactionMode: coordinatorShell.interactionMode,
      },
    });
    // A Stop holds the thread's queue; the retry should start, not wait behind it.
    await resumeQueue({
      environmentId: props.environmentId,
      input: { threadId: coordinatorThreadId },
    });
  };

  const summary = [
    runningPhase,
    card.counts.started > 0 ? `${card.counts.done}/${card.counts.started} agents done` : null,
    card.waitingForUser > 0 ? `${card.waitingForUser} waiting for you` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <WorkLogBlock>
      <div
        data-workflow-card
        className="my-1 rounded-lg border border-border/60 bg-card/30 p-2"
        aria-label={`Workflow ${card.name}`}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
            <WorkflowIcon className="size-3.5 text-muted-foreground" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="truncate text-xs font-semibold">{card.name}</span>
              <span
                className={cn(
                  "shrink-0 text-3xs",
                  card.state === "failed"
                    ? "text-destructive"
                    : card.state === "waiting"
                      ? "text-warning"
                      : live
                        ? "text-info"
                        : "text-muted-foreground",
                )}
              >
                {STATE_LABEL[card.state]}
              </span>
            </span>
            {summary ? (
              <span className="block truncate text-3xs text-muted-foreground">{summary}</span>
            ) : null}
            {latestLog ? (
              <span className="block truncate text-2xs text-muted-foreground">{latestLog}</span>
            ) : null}
          </span>
          <span className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
            <SubagentElapsed
              agent={{
                status: live ? "running" : "completed",
                startedAt: iso(card.startedAt),
                completedAt: iso(card.completedAt),
              }}
            />
          </span>
          <span className="flex shrink-0 items-center">
            <CardAction
              label={copied ? "Copied" : "Copy script"}
              onClick={() =>
                void withScript((script) => {
                  void navigator.clipboard.writeText(script.contents).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  });
                })
              }
            >
              <CopyIcon />
            </CardAction>
            <CardAction
              label="Download script"
              onClick={() =>
                void withScript((script) => downloadTextFile(script.scriptPath, script.contents))
              }
            >
              <DownloadIcon />
            </CardAction>
            {/* Read-only connections can watch a workflow but not steer it. */}
            {!canOperate || coordinatorThreadId === null ? null : live ? (
              <CardAction label="Stop workflow" onClick={stop}>
                <SquareIcon />
              </CardAction>
            ) : card.state !== "done" && coordinatorShell !== null ? (
              <CardAction label="Retry workflow" onClick={() => void retry()}>
                <RotateCcwIcon />
              </CardAction>
            ) : null}
            {!props.inCoordinatorThread && coordinatorThreadId !== null ? (
              <CardAction
                label="Open workflow thread"
                onClick={() => props.onOpenThread(coordinatorThreadId)}
              >
                <ChevronRightIcon />
              </CardAction>
            ) : null}
          </span>
        </div>
        {card.phases.length > 0 ? (
          <div className="mt-1.5 flex flex-col">
            {card.phases.map((phase) => (
              <WorkflowPhaseRow
                key={phase.title}
                phase={phase}
                providerStatuses={props.providerStatuses}
                onOpenThread={props.onOpenThread}
              />
            ))}
          </div>
        ) : null}
        {!live && props.coordinator.result ? (
          <p className="mt-1.5 line-clamp-2 px-1 text-2xs text-muted-foreground">
            {props.coordinator.result}
          </p>
        ) : null}
      </div>
    </WorkLogBlock>
  );
});

function CardAction(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={props.label}
            onClick={props.onClick}
          >
            {props.children}
          </Button>
        }
      />
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** One phase: collapsed when finished, open while it runs, and badged when an agent needs the user. */
const WorkflowPhaseRow = memo(function WorkflowPhaseRow(props: {
  readonly phase: WorkflowCardPhase;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { phase } = props;
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? phase.status === "running";
  const counts = formatWorkflowCounts(phase.counts);
  return (
    <Collapsible open={open} onOpenChange={setOverride} data-workflow-phase={phase.status}>
      <CollapsibleTrigger
        disabled={phase.agents.length === 0}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/20 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            phase.status === "running"
              ? "bg-info"
              : phase.status === "done"
                ? "bg-success"
                : phase.status === "failed"
                  ? "bg-destructive"
                  : "bg-muted-foreground/40",
          )}
        />
        <span
          className={cn(
            "min-w-0 truncate text-xs",
            phase.status === "pending" ? "text-muted-foreground" : "font-medium text-foreground",
          )}
        >
          {phase.title}
        </span>
        <span className="min-w-0 flex-1 truncate text-3xs text-muted-foreground">
          {phase.status === "pending" ? "Pending" : counts}
        </span>
        {phase.waitingForUser > 0 ? (
          <span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-3xs text-warning">
            {phase.waitingForUser} waiting for you
          </span>
        ) : null}
        {phase.agents.length > 0 ? (
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        ) : null}
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        {open ? (
          <div className="mb-1 ml-3 flex flex-col">
            {phase.agents.map((agent) => (
              <WorkflowAgentRow
                key={agent.id}
                agent={agent}
                provider={props.providerStatuses.find(
                  (provider) => provider.instanceId === agent.providerInstanceId,
                )}
                onOpenThread={props.onOpenThread}
              />
            ))}
          </div>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
});

function WorkflowAgentRow(props: {
  readonly agent: WorkflowCardAgent;
  readonly provider: ServerProvider | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { agent } = props;
  const childThreadId = agent.childThreadId;
  const binding = [
    agent.role,
    props.provider?.displayName ?? agent.providerInstanceId,
    agent.model
      ? resolveSubagentMetadata({ model: agent.model, provider: props.provider }).modelLabel
      : null,
    agent.attempt > 1 ? `attempt ${agent.attempt}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      disabled={childThreadId === null}
      aria-label={`Open ${agent.title}`}
      onClick={() => childThreadId !== null && props.onOpenThread(childThreadId)}
      className="group/agent flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/20"
    >
      <SubagentAvatar driver={agent.driver} provider={props.provider} status={agent.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-foreground">{agent.title}</span>
        <span className="block truncate text-3xs text-muted-foreground">{binding}</span>
      </span>
      <span
        className={cn(
          "shrink-0 text-3xs",
          agent.waitingForUser
            ? "text-warning"
            : agent.status === "failed"
              ? "text-destructive"
              : "text-muted-foreground",
        )}
      >
        {agent.waitingForUser ? "Waiting for you" : AGENT_STATUS_LABEL[agent.status]}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        <SubagentElapsed
          agent={{
            status: agent.status,
            startedAt: iso(agent.startedAt),
            completedAt: iso(agent.completedAt),
          }}
        />
      </span>
    </button>
  );
}

/**
 * A coordinator's subagent item in the starting thread's timeline, drawn as
 * the workflow card once its live row says it is a workflow run.
 */
/**
 * Stands in for the composer on a workflow's coordinator thread. The script
 * runs that thread, so there is nothing to send; Stop and Retry are on its
 * card, and the bar leads back to the thread that started it.
 */
export function WorkflowThreadBar(props: { readonly onOpenParent: (() => void) | null }) {
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-3xl py-2 ps-5 pe-2 text-sm">
      <span className="shrink-0 font-medium text-foreground">Workflow</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        Runs its script. Stop and Retry are on its card.
      </span>
      {props.onOpenParent ? (
        <Button size="sm" variant="ghost" onClick={props.onOpenParent}>
          <ArrowUpLeftIcon />
          Open parent
        </Button>
      ) : null}
    </div>
  );
}

export function WorkflowRunRow(props: {
  readonly environmentId: EnvironmentId;
  readonly parentThreadId: ThreadId;
  readonly subagentId: OrchestrationV2Subagent["id"];
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly fallback: React.ReactNode;
}) {
  const coordinator = useThreadProjection(
    scopeThreadRef(props.environmentId, props.parentThreadId),
  )?.projection.subagents.find((subagent) => subagent.id === props.subagentId);
  if (coordinator === undefined || coordinator.workflow?.kind !== "run") return props.fallback;
  return (
    <WorkflowCard
      environmentId={props.environmentId}
      coordinator={coordinator}
      providerStatuses={props.providerStatuses}
      onOpenThread={props.onOpenThread}
    />
  );
}

/** Heads a coordinator thread with its workflow's card, read from the thread that started it. */
export function WorkflowCoordinatorHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: {
    readonly lineage: { readonly parentThreadId: ThreadId | null };
    readonly forkedFrom: { readonly type: string; readonly nodeId?: string } | null;
  };
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const parentThreadId = props.thread.lineage.parentThreadId;
  const nodeId =
    props.thread.forkedFrom?.type === "node" ? props.thread.forkedFrom.nodeId : undefined;
  const coordinator = useThreadProjection(
    parentThreadId === null ? null : scopeThreadRef(props.environmentId, parentThreadId),
  )?.projection.subagents.find((subagent) => subagent.id === nodeId);
  if (coordinator === undefined || coordinator.workflow?.kind !== "run") return null;
  return (
    <WorkflowCard
      environmentId={props.environmentId}
      coordinator={coordinator}
      providerStatuses={props.providerStatuses}
      onOpenThread={props.onOpenThread}
      inCoordinatorThread
    />
  );
}
