import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createCheckInEnvironmentAtoms } from "@t3tools/client-runtime/state/checkIns";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";

export const checkInEnvironment = createCheckInEnvironmentAtoms(connectionAtomRuntime);

/**
 * Whether the agent left a background command running in a thread, which thread lists show as
 * Waiting, as they do a provider's own background work. Every row shares one subscription per
 * environment.
 */
export function useRunsBackgroundCommand(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.threadBackgroundCommands ===
    true;
  const query = useEnvironmentQuery(
    supported ? checkInEnvironment.backgroundCommandThreads({ environmentId, input: {} }) : null,
  );
  return query.data?.includes(threadId) === true;
}
