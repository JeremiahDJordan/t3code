import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { ThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import {
  isOrchestrationV2WorkActive,
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "@t3tools/shared/orchestrationTiming";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useThreadShell } from "../../state/entities";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { SubagentRow } from "./SubagentRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import {
  groupWorkflowAgentsByPhase,
  sheetAgentRows,
  sheetWorkflowRuns,
  type CoordinatorRunStatuses,
} from "./threadAgentsPresentation";
import { FinishedWorkflowRow, WorkflowCard, useWorkflowCoordinatorForThread } from "./WorkflowCard";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type AgentsTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

const EMPTY_TURN_SUBAGENTS_ATOM = Atom.make<ThreadTurnSubagents | null>(null).pipe(
  Atom.withLabel("mobile-thread-turn-subagents:empty"),
);
const EMPTY_THREAD_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("mobile-thread-agents-thread:empty"),
);
const EMPTY_RUN_STATUSES_ATOM = Atom.make<CoordinatorRunStatuses>(new Map()).pipe(
  Atom.withLabel("mobile-thread-agents-coordinator-runs:empty"),
);

/** A thread's subagent rows, every turn's, as the sheet and the agents pill read them. */
export const selectThreadSubagents = (
  thread: {
    readonly projection: { readonly subagents: ReadonlyArray<OrchestrationV2Subagent> };
  } | null,
): ReadonlyArray<OrchestrationV2Subagent> | undefined => thread?.projection.subagents;

export function useThreadTurnSubagents(target: AgentsTarget | null): ThreadTurnSubagents | null {
  return useAtomValue(
    target === null
      ? EMPTY_TURN_SUBAGENTS_ATOM
      : environmentThreadDetails.turnSubagentsAtom(target),
  );
}

// Keeps the same map while the statuses stay the same, so readers do not re-derive on
// unrelated shell updates.
function coordinatorRunStatusesAtom(
  environmentId: EnvironmentId,
  coordinatorThreadIds: ReadonlyArray<ThreadId>,
) {
  let previous: CoordinatorRunStatuses = new Map();
  return Atom.make((get) => {
    const next = new Map<ThreadId, OrchestrationV2Run["status"]>();
    for (const threadId of coordinatorThreadIds) {
      const status = get(
        environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId)),
      )?.latestRun?.status;
      if (status !== undefined) next.set(threadId, status);
    }
    if (
      next.size !== previous.size ||
      [...next].some(([threadId, status]) => previous.get(threadId) !== status)
    ) {
      previous = next;
    }
    return previous;
  });
}

/**
 * The latest run status of each workflow coordinator thread these rows started, from the shells
 * clients already hold, so a Retry reads as running before its coordinator thread loads.
 */
export function useCoordinatorRunStatuses(
  environmentId: EnvironmentId,
  threadSubagents: ReadonlyArray<OrchestrationV2Subagent> | undefined,
): CoordinatorRunStatuses {
  const idsKey = (threadSubagents ?? [])
    .flatMap((subagent) =>
      subagent.t3Workflow?.kind === "run" && subagent.childThreadId !== null
        ? [subagent.childThreadId]
        : [],
    )
    .join("\n");
  return useAtomValue(
    useMemo(
      () =>
        idsKey === ""
          ? EMPTY_RUN_STATUSES_ATOM
          : coordinatorRunStatusesAtom(
              environmentId,
              idsKey.split("\n").map((id) => ThreadId.make(id)),
            ),
      [environmentId, idsKey],
    ),
  );
}

/** Every turn's subagent rows; none until a queued thread reaches the server. */
export function useThreadSubagents(
  target: AgentsTarget | null,
): ReadonlyArray<OrchestrationV2Subagent> | undefined {
  return useAtomValue(
    target === null
      ? EMPTY_THREAD_ATOM
      : environmentThreadDetails.threadAtom(scopeThreadRef(target.environmentId, target.threadId)),
    selectThreadSubagents,
  );
}

export function ThreadAgentsSheet({ route }: StaticScreenProps<AgentsTarget>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const turn = useThreadTurnSubagents(target);
  const threadSubagents = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(target.environmentId, target.threadId)),
    selectThreadSubagents,
  );
  const coordinatorRunStatuses = useCoordinatorRunStatuses(target.environmentId, threadSubagents);
  const workflowRuns = useMemo(
    () => sheetWorkflowRuns(threadSubagents ?? [], coordinatorRunStatuses),
    [coordinatorRunStatuses, threadSubagents],
  );
  // Finished runs show as rows until opened; one seen running stays a card when it finishes.
  const [openedWorkflowIds, setOpenedWorkflowIds] = useState<ReadonlySet<string>>(new Set());
  const newlyLive = workflowRuns.filter(({ run, live }) => live && !openedWorkflowIds.has(run.id));
  if (newlyLive.length > 0) {
    setOpenedWorkflowIds(new Set([...openedWorkflowIds, ...newlyLive.map(({ run }) => run.id)]));
  }
  const setWorkflowOpen = (id: string, open: boolean) =>
    setOpenedWorkflowIds((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  // A workflow run reads as its card above the other agents, not as a row among them.
  const subagents = useMemo(
    () => sheetAgentRows(threadSubagents ?? [], turn?.subagents ?? []),
    [threadSubagents, turn?.subagents],
  );
  const hasLiveAgent = subagents.some((subagent) => isActiveSubagentStatus(subagent.status));
  const shell = useThreadShell(scopeThreadRef(target.environmentId, target.threadId));
  const coordinator = useWorkflowCoordinatorForThread(target.environmentId, shell);
  // A workflow coordinator thread's agents read under their phases, as on its card.
  const phases = useMemo(
    () => groupWorkflowAgentsByPhase(subagents, coordinator),
    [coordinator, subagents],
  );

  const openChildThread = (childThreadId: ThreadId) => {
    void Haptics.selectionAsync();
    // Replace rather than push: the sheet is a leaf, and the child thread
    // belongs in the workspace stack where Home's back button expects it.
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: target.environmentId,
        threadId: childThreadId,
      }),
    );
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      // The iOS header is translucent and floats over this view; UIKit has to
      // inset the content or the first row sits underneath the title.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {workflowRuns.length > 0 ? (
        <View className="gap-2 pt-4">
          {workflowRuns.map(({ run, live }) =>
            openedWorkflowIds.has(run.id) || live ? (
              <WorkflowCard
                key={run.id}
                environmentId={target.environmentId}
                coordinator={run}
                onOpenThread={openChildThread}
                {...(live ? {} : { onCollapse: () => setWorkflowOpen(run.id, false) })}
              />
            ) : (
              <FinishedWorkflowRow
                key={run.id}
                coordinator={run}
                onExpand={() => setWorkflowOpen(run.id, true)}
              />
            ),
          )}
        </View>
      ) : null}
      {subagents.length === 0 ? (
        workflowRuns.length === 0 ? (
          <Text className="pt-6 text-center text-sm text-foreground-muted">
            No agents in this turn.
          </Text>
        ) : null
      ) : phases !== null ? (
        phases.map((phase) => (
          <View key={phase.title}>
            <Text
              accessibilityRole="header"
              className="pt-5 pb-1 text-sm font-t3-medium text-foreground-muted"
            >
              {phase.title}
            </Text>
            {phase.subagents.map((subagent) => (
              <AgentRow
                key={subagent.id}
                subagent={subagent}
                environmentId={target.environmentId}
                tickSeconds={hasLiveAgent}
                onOpen={openChildThread}
              />
            ))}
          </View>
        ))
      ) : (
        subagents.map((subagent) => (
          <AgentRow
            key={subagent.id}
            subagent={subagent}
            environmentId={target.environmentId}
            tickSeconds={hasLiveAgent}
            onOpen={openChildThread}
          />
        ))
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // A plain formSheet screen never renders a stack header, so it comes from
    // a nested native stack inside the sheet (same shape as the git sheet).
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-agents-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title="Agents"
              titleColor={theme["--color-foreground"]}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title="Agents" onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}

function AgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
  readonly onOpen: (childThreadId: ThreadId) => void;
}) {
  const { subagent } = props;
  const childThreadId = subagent.childThreadId;

  const row = (
    <View className="border-b border-border py-3.5">
      <SubagentRow
        environmentId={props.environmentId}
        subagent={subagent}
        elapsed={<AgentElapsed subagent={subagent} tickSeconds={props.tickSeconds} />}
      />
    </View>
  );

  if (childThreadId === null) {
    return (
      <View
        accessible
        accessibilityHint="Provider-managed agent. Its work appears in the transcript."
      >
        {row}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityHint="Opens this agent's thread"
      onPress={() => props.onOpen(childThreadId)}
      className="active:opacity-70"
    >
      {row}
    </Pressable>
  );
}

function AgentElapsed(props: {
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
}) {
  const elapsed = useSubagentElapsed(props.subagent, props.tickSeconds);
  return elapsed === null ? null : (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{elapsed}</Text>
  );
}

function useSubagentElapsed(
  subagent: Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">,
  tickSeconds: boolean,
): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const running = isOrchestrationV2WorkActive(subagent.status);
  useEffect(() => {
    if (!tickSeconds || !running) return;
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [running, tickSeconds]);
  const elapsedMs = deriveSubagentElapsedMs(
    {
      status: subagent.status,
      startedAt: subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt),
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
    },
    nowMs,
  );
  return elapsedMs === null || elapsedMs === 0 ? null : formatDuration(elapsedMs);
}
