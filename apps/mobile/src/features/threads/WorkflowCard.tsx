import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { StackActions, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  deriveWorkflowCard,
  formatWorkflowCounts,
  latestWorkflowLogLine,
  WORKFLOW_PROVIDER_INSTANCE_ID,
  type WorkflowCardAgent,
  type WorkflowCardPhase,
  type WorkflowCardState,
  type WorkflowPhaseStatus,
} from "@t3tools/client-runtime/state/workflowCard";
import {
  AuthOrchestrationOperateScope,
  MessageId,
  ProviderInstanceId,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";
import { shareGeneratedAttachment } from "../../lib/attachmentDownload";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentScope } from "../../state/session";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { RequestActionButton } from "./RequestActionButton";
import { subagentCardDetail } from "./subagent-card-presentation";
import { SubagentElapsed, SubagentElapsedClock } from "./SubagentElapsed";
import { SUBAGENT_TONE_TEXT_CLASS, SubagentStatusDot } from "./SubagentStatusDot";
import {
  subagentRowStatusLabel,
  subagentRowTone,
  type SubagentRowTone,
} from "./threadAgentsPresentation";
import { WorkLogBlock } from "./work-log-layout";

const STATE_LABEL: Record<WorkflowCardState, string> = {
  running: "Running",
  waiting: "Waiting for you",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

const STATE_TEXT_CLASS: Record<WorkflowCardState, string> = {
  running: SUBAGENT_TONE_TEXT_CLASS.working,
  waiting: "text-adaptive-amber-700-300",
  done: SUBAGENT_TONE_TEXT_CLASS.completed,
  failed: SUBAGENT_TONE_TEXT_CLASS.failed,
  stopped: SUBAGENT_TONE_TEXT_CLASS.stopped,
};

const PHASE_TONE: Record<WorkflowPhaseStatus, SubagentRowTone> = {
  pending: "stopped",
  running: "working",
  done: "completed",
  failed: "failed",
  stopped: "stopped",
};

const EMPTY_THREAD_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("mobile-workflow-thread:empty"),
);
const EMPTY_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("mobile-workflow-shell:empty"),
);
const EMPTY_COORDINATOR_ATOM = Atom.make<OrchestrationV2Subagent | null>(null).pipe(
  Atom.withLabel("mobile-workflow-coordinator:empty"),
);
const EMPTY_SUBAGENTS: ReadonlyArray<OrchestrationV2Subagent> = [];

const selectAgents = (thread: EnvironmentThread | null) =>
  thread?.projection.subagents ?? EMPTY_SUBAGENTS;
const selectRuns = (thread: EnvironmentThread | null) => thread?.projection.runs;
const selectLatestLog = (thread: EnvironmentThread | null) =>
  thread === null
    ? null
    : latestWorkflowLogLine(thread.projection.visibleTurnItems, thread.projection.runs);

function coordinatorAtom(environmentId: EnvironmentId, parentThreadId: ThreadId, nodeId: string) {
  const ref = scopeThreadRef(environmentId, parentThreadId);
  return Atom.make(
    (get) =>
      get(environmentThreadDetails.threadAtom(ref))?.projection.subagents.find(
        (subagent) => subagent.id === nodeId,
      ) ?? null,
  );
}

/** A workflow's coordinator row, read live from the thread that started the workflow. */
export function useWorkflowCoordinator(
  environmentId: EnvironmentId,
  parentThreadId: ThreadId | null,
  nodeId: string | null,
): OrchestrationV2Subagent | null {
  const atom = useMemo(
    () =>
      parentThreadId === null || nodeId === null
        ? EMPTY_COORDINATOR_ATOM
        : coordinatorAtom(environmentId, parentThreadId, nodeId),
    [environmentId, nodeId, parentThreadId],
  );
  const coordinator = useAtomValue(atom);
  return coordinator?.workflow?.kind === "run" ? coordinator : null;
}

type CoordinatorThread = Pick<EnvironmentThreadShell, "modelSelection" | "lineage" | "forkedFrom">;

/**
 * Where a coordinator thread's workflow row lives: the thread that started
 * the workflow, at the node the coordinator thread forked from. Null for any
 * other thread.
 */
export function workflowCoordinatorSource(
  thread: CoordinatorThread | null,
): { readonly parentThreadId: ThreadId; readonly nodeId: string } | null {
  if (thread?.modelSelection.instanceId !== WORKFLOW_PROVIDER_INSTANCE_ID) return null;
  const parentThreadId = thread.lineage.parentThreadId;
  if (parentThreadId === null || thread.forkedFrom?.type !== "node") return null;
  return { parentThreadId, nodeId: thread.forkedFrom.nodeId };
}

/** The coordinator row of a workflow's coordinator thread, or null for any other thread. */
export function useWorkflowCoordinatorForThread(
  environmentId: EnvironmentId,
  thread: CoordinatorThread | null,
): OrchestrationV2Subagent | null {
  const source = workflowCoordinatorSource(thread);
  return useWorkflowCoordinator(
    environmentId,
    source?.parentThreadId ?? null,
    source?.nodeId ?? null,
  );
}

// Keeps the same set while the waiting children stay the same, so the card
// does not re-derive on unrelated shell updates.
function waitingThreadsAtom(environmentId: EnvironmentId, childThreadIds: ReadonlyArray<ThreadId>) {
  let previous: ReadonlySet<ThreadId> = new Set();
  return Atom.make((get) => {
    const waiting = childThreadIds.filter((threadId) => {
      const shell = get(
        environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId)),
      );
      return shell !== null && (shell.hasPendingApprovals || shell.hasPendingUserInput);
    });
    if (waiting.length !== previous.size || waiting.some((threadId) => !previous.has(threadId))) {
      previous = new Set(waiting);
    }
    return previous;
  });
}

/** Feed rows keep disclosure state in the feed so it survives virtualization and anchors scroll. */
interface PhaseDisclosure {
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly anchorKey: string;
  readonly onToggleRow: (rowId: string, anchorKey: string) => void;
}

/**
 * A workflow run as one card: its declared phases, each with its agents, and
 * the run's controls. It sits in the starting thread's feed and heads the
 * coordinator thread.
 */
export function WorkflowCard(props: {
  readonly environmentId: EnvironmentId;
  /** The coordinator's row in the thread that started the workflow. */
  readonly coordinator: OrchestrationV2Subagent;
  readonly phaseDisclosure?: PhaseDisclosure;
  /** Drawn at the top of the coordinator thread, which needs no link to itself. */
  readonly inCoordinatorThread?: boolean;
}) {
  const { environmentId, coordinator } = props;
  const navigation = useNavigation();
  const config = useEnvironmentServerConfig(environmentId);
  const coordinatorThreadId = coordinator.childThreadId;
  const coordinatorRef =
    coordinatorThreadId === null ? null : scopeThreadRef(environmentId, coordinatorThreadId);
  const coordinatorThreadAtom =
    coordinatorRef === null
      ? EMPTY_THREAD_ATOM
      : environmentThreadDetails.threadAtom(coordinatorRef);
  const agents = useAtomValue(coordinatorThreadAtom, selectAgents);
  const runs = useAtomValue(coordinatorThreadAtom, selectRuns);
  // Retry reads the coordinator's modes from its shell, which is loaded even
  // when the coordinator thread's projection is not.
  const coordinatorShell = useAtomValue(
    coordinatorRef === null
      ? EMPTY_SHELL_ATOM
      : environmentThreadShells.threadShellAtom(coordinatorRef),
  );
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const latestLog = useAtomValue(coordinatorThreadAtom, selectLatestLog);
  const liveChildThreadIds = useMemo(
    () =>
      agents.flatMap((agent) =>
        agent.childThreadId !== null && isActiveSubagentStatus(agent.status)
          ? [agent.childThreadId]
          : [],
      ),
    [agents],
  );
  const waitingThreadIds = useAtomValue(
    useMemo(
      () => waitingThreadsAtom(environmentId, liveChildThreadIds),
      [environmentId, liveChildThreadIds],
    ),
  );
  const card = useMemo(
    () =>
      deriveWorkflowCard({
        coordinator,
        ...(runs === undefined ? {} : { coordinatorRuns: runs }),
        agents,
        waitingThreadIds,
      }),
    [agents, coordinator, runs, waitingThreadIds],
  );

  const [localToggles, setLocalToggles] = useState<Readonly<Record<string, boolean>>>({});
  // Interrupting the run, as the composer's Stop does, also stops every agent it started.
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, "workflow stop");
  const startTurn = useAtomCommand(threadEnvironment.startTurn, "workflow retry");
  const resumeQueue = useAtomCommand(threadEnvironment.resumeThreadQueue, {
    reportFailure: false,
  });
  const readScript = useAtomQueryRunner(orchestrationEnvironment.workflowScript, "workflow script");

  if (card === null) return null;
  const live = card.state === "running" || card.state === "waiting";
  const runningPhase = card.phases.find((phase) => phase.status === "running")?.title ?? null;
  const summary = [
    runningPhase,
    card.counts.started > 0 ? `${card.counts.done}/${card.counts.started} agents done` : null,
    card.waitingForUser > 0 ? `${card.waitingForUser} waiting for you` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const result = live ? null : subagentCardDetail(coordinator.result);

  const openThread = (threadId: ThreadId) => {
    // Push, not navigate: navigate reuses this Thread route, so back would
    // skip the thread the card sits in.
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: String(environmentId),
        threadId: String(threadId),
      }),
    );
  };
  const phaseKey = (phase: WorkflowCardPhase) =>
    `workflow-phase:${coordinator.id}:${phase.title}:${phase.status}`;
  const toggles = props.phaseDisclosure?.expandedRows ?? localToggles;
  const togglePhase = (key: string) => {
    if (props.phaseDisclosure) {
      props.phaseDisclosure.onToggleRow(key, props.phaseDisclosure.anchorKey);
    } else {
      setLocalToggles((current) => ({ ...current, [key]: !(current[key] ?? false) }));
    }
  };

  const withScript = async (use: (script: { scriptPath: string; contents: string }) => unknown) => {
    if (coordinatorThreadId === null) return;
    const script = await readScript({ environmentId, input: { threadId: coordinatorThreadId } });
    if (script._tag === "Success") await use(script.value);
  };
  const shareScript = (script: { scriptPath: string; contents: string }) =>
    shareGeneratedAttachment({
      bytes: new TextEncoder().encode(script.contents),
      attachment: { name: script.scriptPath, mimeType: "text/javascript" },
      signal: new AbortController().signal,
    }).then((shown) => {
      if (!shown) throw new Error("Saving and sharing files is unavailable on this device.");
    });
  // A new turn on the coordinator reruns the script; finished agents are reused.
  const retry = async () => {
    if (coordinatorThreadId === null || coordinatorShell === null) return;
    const started = await startTurn({
      environmentId,
      input: {
        threadId: coordinatorThreadId,
        message: {
          messageId: MessageId.make(uuidv4()),
          role: "user",
          text: "Retry",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make(WORKFLOW_PROVIDER_INSTANCE_ID),
          model: "script",
        },
        runtimeMode: coordinatorShell.runtimeMode,
        interactionMode: coordinatorShell.interactionMode,
      },
    });
    if (started._tag !== "Success") return;
    // A Stop holds the thread's queue; the retry should start, not wait behind it.
    await resumeQueue({ environmentId, input: { threadId: coordinatorThreadId } });
  };
  const actions: MenuAction[] = [
    { id: "copy", title: "Copy script", image: "doc.on.doc" },
    { id: "share", title: "Save or share script", image: "square.and.arrow.up" },
    // Read-only connections can watch a workflow but not steer it.
    ...(!canOperate || coordinatorThreadId === null
      ? []
      : live
        ? [
            {
              id: "stop",
              title: "Stop workflow",
              image: "stop.circle",
              attributes: { destructive: true },
            },
          ]
        : card.state !== "done" && coordinatorShell !== null
          ? [{ id: "retry", title: "Retry workflow", image: "arrow.clockwise" }]
          : []),
  ];
  const onAction = (id: string) => {
    if (id === "copy") {
      void withScript((script) =>
        copyTextWithHaptic(script.contents, { target: "workflow script" }),
      );
    } else if (id === "share") {
      void withScript(shareScript).catch((error: unknown) =>
        Alert.alert(
          "Could not share script",
          error instanceof Error ? error.message : "Try again.",
        ),
      );
    } else if (id === "stop" && coordinatorThreadId !== null) {
      void interruptTurn({ environmentId, input: { threadId: coordinatorThreadId } });
    } else if (id === "retry") {
      void retry();
    }
  };
  const headerLabel = `Workflow ${card.name}, ${STATE_LABEL[card.state]}${summary ? `, ${summary}` : ""}`;
  const headerClassName = "min-w-0 flex-1 flex-row items-center gap-3 rounded-lg py-2 pl-2";
  const header = (
    <>
      <View className="h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-card">
        <SymbolView
          name="point.3.connected.trianglepath.dotted"
          size={14}
          tintColorClassName="accent-icon-subtle"
        />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-1.5">
          <Text numberOfLines={1} className="min-w-0 shrink font-t3-medium text-sm text-foreground">
            {card.name}
          </Text>
          <Text className={cn("shrink-0 text-xs font-t3-medium", STATE_TEXT_CLASS[card.state])}>
            {STATE_LABEL[card.state]}
          </Text>
        </View>
        {summary ? (
          <Text numberOfLines={1} className="text-2xs text-foreground-muted">
            {summary}
          </Text>
        ) : null}
        {live && latestLog ? (
          <Text numberOfLines={1} className="text-2xs text-foreground-muted">
            {latestLog}
          </Text>
        ) : null}
      </View>
      <SubagentElapsed
        agents={[
          {
            status: live ? "running" : "completed",
            startedAt: card.startedAt,
            completedAt: card.completedAt,
          },
        ]}
      />
    </>
  );

  return (
    <WorkLogBlock>
      <SubagentElapsedClock live={live || card.counts.working > 0}>
        <View className="mb-1 rounded-xl border border-border bg-card/30 p-1">
          <View className="flex-row items-center">
            {!props.inCoordinatorThread && coordinatorThreadId !== null ? (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={headerLabel}
                accessibilityHint="Opens the workflow's thread"
                onPress={() => openThread(coordinatorThreadId)}
                className={cn(headerClassName, "active:bg-subtle")}
              >
                {header}
                <SymbolView
                  name="chevron.right"
                  size={12}
                  tintColorClassName="accent-icon-subtle"
                />
              </Pressable>
            ) : (
              <View accessible accessibilityLabel={headerLabel} className={headerClassName}>
                {header}
              </View>
            )}
            <ControlPillMenu
              actions={actions}
              onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Actions for workflow ${card.name}`}
                className="h-11 w-11 items-center justify-center"
              >
                <SymbolView
                  name="ellipsis"
                  size={16}
                  tintColorClassName="accent-icon-subtle"
                  type="monochrome"
                />
              </Pressable>
            </ControlPillMenu>
          </View>
          {card.phases.map((phase) => {
            const key = phaseKey(phase);
            // Running phases start open and finished ones closed; a toggle flips
            // that default until the phase's status changes.
            const open =
              phase.agents.length > 0 && (phase.status === "running") !== (toggles[key] ?? false);
            return (
              <WorkflowPhaseRow
                key={phase.title}
                phase={phase}
                open={open}
                providers={config?.providers}
                onToggle={() => togglePhase(key)}
                onOpenThread={openThread}
              />
            );
          })}
          {result ? (
            <Text numberOfLines={2} className="px-2 pb-1.5 pt-1 text-xs text-foreground-muted">
              {result}
            </Text>
          ) : null}
        </View>
      </SubagentElapsedClock>
    </WorkLogBlock>
  );
}

/** One phase: open while it runs, closed when finished, badged when an agent needs the user. */
function WorkflowPhaseRow(props: {
  readonly phase: WorkflowCardPhase;
  readonly open: boolean;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly onToggle: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { phase } = props;
  const pending = phase.status === "pending";
  const counts = pending ? "Pending" : formatWorkflowCounts(phase.counts);
  const hasAgents = phase.agents.length > 0;
  return (
    <>
      <Pressable
        accessibilityRole={hasAgents ? "button" : undefined}
        accessibilityLabel={`${phase.title}, ${counts}${phase.waitingForUser > 0 ? `, ${phase.waitingForUser} waiting for you` : ""}`}
        accessibilityState={hasAgents ? { expanded: props.open } : undefined}
        disabled={!hasAgents}
        onPress={props.onToggle}
        className="min-h-9 flex-row items-center gap-2 rounded-lg px-2 py-1.5 active:bg-subtle"
      >
        <SubagentStatusDot tone={PHASE_TONE[phase.status]} />
        <Text
          numberOfLines={1}
          className={cn(
            "min-w-0 shrink text-sm",
            pending ? "text-foreground-muted" : "font-t3-medium text-foreground",
          )}
        >
          {phase.title}
        </Text>
        <Text numberOfLines={1} className="min-w-0 flex-1 text-2xs text-foreground-muted">
          {counts}
        </Text>
        {phase.waitingForUser > 0 ? (
          <View className="shrink-0 rounded-full bg-warning px-2 py-0.5">
            <Text className="text-2xs font-t3-medium text-warning-foreground">
              {phase.waitingForUser} waiting for you
            </Text>
          </View>
        ) : null}
        {hasAgents ? (
          <SymbolView
            name={props.open ? "chevron.up" : "chevron.down"}
            size={11}
            tintColorClassName="accent-icon-subtle"
          />
        ) : null}
      </Pressable>
      {props.open ? (
        <View className="mb-1 ml-3 gap-px">
          {phase.agents.map((agent) => (
            <WorkflowAgentRow
              key={agent.id}
              agent={agent}
              provider={props.providers?.find(
                (provider) => provider.instanceId === agent.providerInstanceId,
              )}
              onOpenThread={props.onOpenThread}
            />
          ))}
        </View>
      ) : null}
    </>
  );
}

function WorkflowAgentRow(props: {
  readonly agent: WorkflowCardAgent;
  readonly provider: ServerProvider | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { agent, provider } = props;
  const childThreadId = agent.childThreadId;
  const tone = subagentRowTone(agent.status);
  const binding = [
    agent.role,
    provider ? resolveProviderInstanceDisplayName(provider) : agent.providerInstanceId,
    agent.model ? resolveSubagentMetadata({ model: agent.model, provider }).modelLabel : null,
    agent.attempt > 1 ? `attempt ${agent.attempt}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      accessibilityRole={childThreadId === null ? undefined : "link"}
      accessibilityHint={childThreadId === null ? undefined : "Opens this agent's thread"}
      disabled={childThreadId === null}
      onPress={() => {
        if (childThreadId !== null) props.onOpenThread(childThreadId);
      }}
      className="min-h-11 flex-row items-center gap-2.5 rounded-lg px-2 py-1.5 active:bg-subtle"
    >
      <View className="h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-card">
        <ProviderIcon
          provider={provider?.driver ?? agent.driver}
          iconUrl={provider?.iconUrl}
          size={13}
        />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="text-sm text-foreground">
          {agent.title}
        </Text>
        {binding ? (
          <Text numberOfLines={1} className="text-2xs text-foreground-muted">
            {binding}
          </Text>
        ) : null}
      </View>
      <Text
        className={cn(
          "shrink-0 text-xs font-t3-medium",
          agent.waitingForUser ? STATE_TEXT_CLASS.waiting : SUBAGENT_TONE_TEXT_CLASS[tone],
        )}
      >
        {agent.waitingForUser ? "Waiting for you" : subagentRowStatusLabel(agent.status)}
      </Text>
      <SubagentElapsed agents={[agent]} />
    </Pressable>
  );
}

/** Heads a coordinator thread with its workflow's card, read from the thread that started it. */
/**
 * Replaces the composer on a workflow's coordinator thread. The script runs
 * that thread, so there is nothing to send; Stop and Retry are on its card,
 * and the bar leads back to the thread that started it.
 */
export function WorkflowThreadBar(props: { readonly onOpenParent: (() => void) | null }) {
  return (
    <View className="flex-row items-center gap-3 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
      {/* Only the text is one element, so "Open parent" stays reachable. */}
      <View
        accessible
        accessibilityLabel="Workflow. It runs its script and cannot take messages. Stop and Retry are on its card."
        className="min-w-0 flex-1 gap-0.5"
      >
        <Text numberOfLines={1} className="font-t3-bold text-sm text-foreground">
          Workflow
        </Text>
        <Text numberOfLines={1} className="font-sans text-xs text-foreground-secondary">
          Runs its script · Stop and Retry are on its card
        </Text>
      </View>
      {props.onOpenParent ? (
        <RequestActionButton label="Open parent" tone="secondary" onPress={props.onOpenParent} />
      ) : null}
    </View>
  );
}

export function WorkflowCoordinatorHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly parentThreadId: ThreadId;
  readonly nodeId: string;
}) {
  const coordinator = useWorkflowCoordinator(
    props.environmentId,
    props.parentThreadId,
    props.nodeId,
  );
  if (coordinator === null) return null;
  return (
    <WorkflowCard
      environmentId={props.environmentId}
      coordinator={coordinator}
      inCoordinatorThread
    />
  );
}
