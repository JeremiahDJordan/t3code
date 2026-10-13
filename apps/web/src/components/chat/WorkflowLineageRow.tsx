import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveWorkflowLineageGroup } from "@t3tools/client-runtime/state/workflowCard";
import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";
import { useMemo, type ComponentProps } from "react";

import { useThreadProjection } from "../../state/entities";
import { ThreadLineageWorkflowRow } from "./ThreadLineageWorkflowRow";

/**
 * A T3 workflow run in the starting thread's Lineage, drawn as upstream's
 * workflow row. Its agents live in the coordinator thread, read through the
 * same subscription the run's workflow card uses.
 */
export function WorkflowLineageRow(
  props: Omit<ComponentProps<typeof ThreadLineageWorkflowRow>, "group"> & {
    readonly environmentId: EnvironmentId;
    /** The run's row in the thread that started it. */
    readonly coordinator: OrchestrationV2Subagent;
  },
) {
  const { environmentId, coordinator, ...rowProps } = props;
  const coordinatorThread = useThreadProjection(
    coordinator.childThreadId === null
      ? null
      : scopeThreadRef(environmentId, coordinator.childThreadId),
  )?.projection;
  // Only the runs and agents matter; the log streaming into the thread does not.
  const runs = coordinatorThread?.runs;
  const agents = coordinatorThread?.subagents;
  const group = useMemo(
    () =>
      deriveWorkflowLineageGroup({
        coordinator,
        ...(runs === undefined ? {} : { coordinatorRuns: runs }),
        agents: agents ?? [],
      }),
    [agents, coordinator, runs],
  );
  if (group === null) return null;
  return <ThreadLineageWorkflowRow {...rowProps} group={group} />;
}
