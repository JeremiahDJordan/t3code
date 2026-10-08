import { useIsFocused } from "@react-navigation/native";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AppState } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { subagentCardElapsed } from "./subagent-card-presentation";

type AgentTiming = Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">;

const SharedNowContext = createContext<number | null>(null);

/** The current time, ticking each second only while live, focused and in the foreground. */
function useTickingNow(live: boolean): number {
  const focused = useIsFocused();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!live || !focused || !appActive) return;
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [appActive, focused, live]);
  return nowMs;
}

/**
 * One clock for every `SubagentElapsed` inside it, so a card with many live
 * agents runs one timer. A tick re-renders only those labels: `children` keep
 * their identity, so React skips everything else.
 */
export function SubagentElapsedClock(props: {
  readonly live: boolean;
  readonly children: ReactNode;
}) {
  const nowMs = useTickingNow(props.live);
  return <SharedNowContext.Provider value={nowMs}>{props.children}</SharedNowContext.Provider>;
}

/**
 * Wall time for one agent or a group. Inside a `SubagentElapsedClock` it reads
 * that clock; on its own it ticks only while live, focused and in the foreground.
 */
export function SubagentElapsed({ agents }: { readonly agents: ReadonlyArray<AgentTiming> }) {
  const sharedNowMs = useContext(SharedNowContext);
  return sharedNowMs === null ? (
    <SelfTimedElapsed agents={agents} />
  ) : (
    <ElapsedText agents={agents} nowMs={sharedNowMs} />
  );
}

function SelfTimedElapsed({ agents }: { readonly agents: ReadonlyArray<AgentTiming> }) {
  const nowMs = useTickingNow(agents.some((agent) => isActiveSubagentStatus(agent.status)));
  return <ElapsedText agents={agents} nowMs={nowMs} />;
}

function ElapsedText(props: {
  readonly agents: ReadonlyArray<AgentTiming>;
  readonly nowMs: number;
}) {
  const elapsed = subagentCardElapsed(props.agents, props.nowMs);
  return elapsed ? (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{elapsed}</Text>
  ) : null;
}
