import {
  CheckInId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ThreadCheckIn,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as AgentThreads from "../../../agentThreads/AgentThreads.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentThreadsToolkitHandlersLive } from "./handlers.ts";
import { AgentThreadsToolkit } from "./tools.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");
const TARGET_ID = ThreadId.make("thread-2");

const wait: ThreadCheckIn = {
  id: CheckInId.make("ci-1"),
  threadId: THREAD_ID,
  note: 'Wait for "Review the docs" to finish its turn.',
  repeatEveryMinutes: null,
  nextAt: "2026-09-29T12:00:00.000Z",
  endsAt: null,
  dueSince: null,
  deliveredCount: 0,
  createdAt: "2026-09-28T12:00:00.000Z",
  waitsFor: { environmentId: ENVIRONMENT_ID, threadId: TARGET_ID, title: "Review the docs" },
};

const makeHarness = Effect.fn("makeAgentThreadsToolkitHarness")(function* () {
  const callers = yield* Ref.make<ReadonlyArray<AgentThreads.AgentThreadCaller>>([]);
  const record = (caller: AgentThreads.AgentThreadCaller) =>
    Ref.update(callers, (all) => [...all, caller]);
  const dependencies = Layer.mock(AgentThreads.AgentThreads)({
    send: (caller) =>
      record(caller).pipe(Effect.as({ messageId: "message-1", delivery: "soon" as const })),
    watch: (caller) => record(caller).pipe(Effect.as(wait)),
    cancelWait: (caller) => record(caller).pipe(Effect.as(true)),
  });
  const toolkit = yield* AgentThreadsToolkit.pipe(
    Effect.provide(AgentThreadsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof AgentThreadsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["agent-threads"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof AgentThreadsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(capabilities),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  return { call, callers };
});

describe("agent-threads toolkit handlers", () => {
  it.effect("refuses a credential without the agent-threads capability", () =>
    Effect.gen(function* () {
      const { call, callers } = yield* makeHarness();
      const error = yield* call("send_to_thread", { threadId: TARGET_ID, message: "Hi." }, [
        "check-ins",
      ]).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "agent-threads",
      });
      expect(yield* Ref.get(callers)).toEqual([]);
    }),
  );

  it.effect("acts as the credential's thread", () =>
    Effect.gen(function* () {
      const { call, callers } = yield* makeHarness();
      expect(yield* call("send_to_thread", { threadId: TARGET_ID, message: "Hi." })).toEqual({
        messageId: "message-1",
        delivery: "soon",
      });
      expect(yield* call("watch_thread", { threadId: TARGET_ID })).toEqual({
        waitId: wait.id,
        stopsWaitingAt: wait.nextAt,
      });
      expect(yield* call("cancel_wait", { waitId: wait.id })).toEqual({ cancelled: true });
      const caller = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
      expect(yield* Ref.get(callers)).toEqual([caller, caller, caller]);
    }),
  );
});
