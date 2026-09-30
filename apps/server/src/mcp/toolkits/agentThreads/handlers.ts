import * as Effect from "effect/Effect";

import * as AgentThreads from "../../../agentThreads/AgentThreads.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentThreadsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const agentThreads = yield* AgentThreads.AgentThreads;
  // Every tool acts as the thread whose credential called it.
  const caller = McpInvocationContext.requireMcpCapability("agent-threads").pipe(
    Effect.map(({ environmentId, threadId }) => ({ environmentId, threadId })),
  );

  return AgentThreadsToolkit.of({
    list_threads: (input) =>
      caller.pipe(
        Effect.andThen(
          agentThreads.list({
            query: input.query,
            includeArchived: input.includeArchived,
            limit: input.limit,
          }),
        ),
      ),
    read_thread: (input) =>
      caller.pipe(Effect.flatMap((thread) => agentThreads.read(thread, input))),
    start_thread: (input) =>
      caller.pipe(Effect.flatMap((thread) => agentThreads.start(thread, input))),
    send_to_thread: (input) =>
      caller.pipe(Effect.flatMap((thread) => agentThreads.send(thread, input))),
    watch_thread: (input) =>
      caller.pipe(
        Effect.flatMap((thread) => agentThreads.watch(thread, input)),
        Effect.map((wait) => ({ waitId: wait.id, stopsWaitingAt: wait.nextAt })),
      ),
    cancel_wait: (input) =>
      caller.pipe(
        Effect.flatMap((thread) => agentThreads.cancelWait(thread, input.waitId)),
        Effect.map((cancelled) => ({ cancelled })),
      ),
  });
});

export const AgentThreadsToolkitHandlersLive = AgentThreadsToolkit.toLayer(make);
