import {
  BackgroundCommandId,
  type ThreadBackgroundCommand,
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

import * as BackgroundCommands from "../../../checkIns/BackgroundCommands.ts";
import * as CheckInScheduler from "../../../checkIns/CheckInScheduler.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CheckInsToolkitHandlersLive } from "./handlers.ts";
import { CheckInsToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-1");

const checkIn: ThreadCheckIn = {
  id: CheckInId.make("ci-1"),
  threadId: THREAD_ID,
  note: "Check the build.",
  repeatEveryMinutes: 20,
  nextAt: "2026-09-28T12:20:00.000Z",
  endsAt: "2026-09-29T12:00:00.000Z",
  dueSince: null,
  deliveredCount: 0,
  createdAt: "2026-09-28T12:00:00.000Z",
};

const command: ThreadBackgroundCommand = {
  id: BackgroundCommandId.make("bg-1"),
  threadId: THREAD_ID,
  command: "vp run build",
  cwd: "/repo",
  stdoutPath: "/repo/.t3/jobs/bg-1/stdout.log",
  stderrPath: "/repo/.t3/jobs/bg-1/stderr.log",
  status: "running",
  exitStatus: null,
  startedAt: "2026-09-28T12:00:00.000Z",
  endedAt: null,
  statusEveryMinutes: 20,
  nextStatusAt: "2026-09-28T12:20:00.000Z",
  note: "",
  tailLines: 0,
  stopRequestedBy: null,
};

const makeHarness = Effect.fn("makeCheckInToolkitHarness")(function* () {
  const cancels = yield* Ref.make<ReadonlyArray<readonly [CheckInId, ThreadId | undefined]>>([]);
  const starts = yield* Ref.make<ReadonlyArray<BackgroundCommands.StartBackgroundCommandInput>>([]);
  const stops = yield* Ref.make<
    ReadonlyArray<readonly [BackgroundCommandId, string, ThreadId | undefined]>
  >([]);
  const dependencies = Layer.mergeAll(
    Layer.mock(CheckInScheduler.CheckInScheduler)({
      schedule: () => Effect.succeed(checkIn),
      list: () => Effect.succeed([checkIn]),
      cancel: (checkInId, threadId) =>
        Ref.update(cancels, (all) => [...all, [checkInId, threadId] as const]).pipe(
          Effect.as(true),
        ),
    }),
    Layer.mock(BackgroundCommands.BackgroundCommands)({
      list: () => Effect.succeed([command]),
      start: (input) => Ref.update(starts, (all) => [...all, input]).pipe(Effect.as(command)),
      stop: (id, by, threadId) =>
        Ref.update(stops, (all) => [...all, [id, by, threadId] as const]).pipe(Effect.as(true)),
    }),
  );
  const toolkit = yield* CheckInsToolkit.pipe(
    Effect.provide(CheckInsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof CheckInsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["check-ins"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof CheckInsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: THREAD_ID,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("bob"),
        capabilities: new Set(capabilities),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  return { call, cancels, starts, stops };
});

describe("check-in toolkit handlers", () => {
  it.effect("refuses a credential without the check-ins capability", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness();
      const error = yield* call("list_scheduled", {}, ["pull-requests"]).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "check-ins",
      });
    }),
  );

  it.effect("reports a check-in's schedule and whether it waits for the thread", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness();
      const scheduled = yield* call("schedule_check_in", {
        inMinutes: 20,
        note: "Check the build.",
        repeatEveryMinutes: 20,
      });
      expect(scheduled).toEqual({
        checkInId: checkIn.id,
        note: "Check the build.",
        nextAt: checkIn.nextAt,
        repeatEveryMinutes: 20,
        endsAt: checkIn.endsAt,
        waitingForIdle: false,
      });
    }),
  );

  it.effect("starts a background command with its defaults and reports its files", () =>
    Effect.gen(function* () {
      const { call, starts } = yield* makeHarness();
      const started = yield* call("start_background_command", { command: "vp run build" });
      expect(started).toEqual({
        backgroundCommandId: command.id,
        stdoutPath: command.stdoutPath,
        stderrPath: command.stderrPath,
        startedAt: command.startedAt,
      });
      expect(yield* Ref.get(starts)).toEqual([
        {
          threadId: THREAD_ID,
          command: "vp run build",
          statusEveryMinutes: null,
          note: "",
          tailLines: 0,
        },
      ]);
    }),
  );

  it.effect("stops only the calling thread's commands, as the agent", () =>
    Effect.gen(function* () {
      const { call, stops } = yield* makeHarness();
      yield* call("stop_background_command", { backgroundCommandId: command.id });
      expect(yield* Ref.get(stops)).toEqual([[command.id, "agent", THREAD_ID]]);
    }),
  );

  it.effect("cancels only within the calling thread", () =>
    Effect.gen(function* () {
      const { call, cancels } = yield* makeHarness();
      yield* call("cancel_check_in", { checkInId: checkIn.id });
      expect(yield* Ref.get(cancels)).toEqual([[checkIn.id, THREAD_ID]]);
    }),
  );
});
