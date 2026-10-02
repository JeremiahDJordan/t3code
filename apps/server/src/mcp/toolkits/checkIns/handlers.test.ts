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
const OTHER_THREAD_ID = ThreadId.make("thread-2");

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

const wait: ThreadCheckIn = {
  ...checkIn,
  id: CheckInId.make("ci-wait"),
  note: 'Wait for "Review the docs" to finish its turn.',
  repeatEveryMinutes: null,
  nextAt: "2026-09-29T12:00:00.000Z",
  endsAt: null,
  waitsFor: { threadId: OTHER_THREAD_ID, title: "Review the docs" },
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
  const waits = yield* Ref.make<ReadonlyArray<CheckInScheduler.ScheduleWaitInput>>([]);
  const starts = yield* Ref.make<ReadonlyArray<BackgroundCommands.StartBackgroundCommandInput>>([]);
  const dependencies = Layer.mergeAll(
    Layer.mock(CheckInScheduler.CheckInScheduler)({
      schedule: () => Effect.succeed(checkIn),
      scheduleWait: (input) => Ref.update(waits, (all) => [...all, input]).pipe(Effect.as(wait)),
      list: () => Effect.succeed([checkIn, wait]),
      cancel: (checkInId, threadId) =>
        Ref.update(cancels, (all) => [...all, [checkInId, threadId] as const]).pipe(
          Effect.as(true),
        ),
    }),
    Layer.mock(BackgroundCommands.BackgroundCommands)({
      list: () => Effect.succeed([command]),
      start: (input) => Ref.update(starts, (all) => [...all, input]).pipe(Effect.as(command)),
    }),
  );
  const toolkit = yield* CheckInsToolkit.pipe(
    Effect.provide(CheckInsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof CheckInsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration"],
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
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(capabilities),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  return { call, cancels, waits, starts };
});

describe("check-in toolkit handlers", () => {
  it.effect("refuses a credential without the orchestration capability", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness();
      const error = yield* call("list_scheduled", {}, ["pull-requests"]).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "orchestration",
      });
    }),
  );

  it.effect("lists check-ins and waits, saying which thread a wait is on", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness();
      const listed = yield* call("list_scheduled", {});
      expect(listed.checkIns.map((entry) => entry.waitsForThreadId)).toEqual([
        null,
        OTHER_THREAD_ID,
      ]);
      expect(listed.commands).toMatchObject([{ backgroundCommandId: command.id, muted: false }]);
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
          notifyOn: null,
        },
      ]);
    }),
  );

  it.effect("waits for another thread from the calling one, and says when it stops", () =>
    Effect.gen(function* () {
      const { call, waits } = yield* makeHarness();
      const watched = yield* call("watch_thread", { threadId: OTHER_THREAD_ID });
      expect(watched).toEqual({ waitId: wait.id, stopsWaitingAt: wait.nextAt });
      expect(yield* Ref.get(waits)).toEqual([
        { threadId: THREAD_ID, targetThreadId: OTHER_THREAD_ID, note: "" },
      ]);
    }),
  );

  it.effect("cancels only the calling thread's waits with cancel_wait", () =>
    Effect.gen(function* () {
      const { call, cancels } = yield* makeHarness();
      // A check-in is not a wait, so cancel_wait leaves it alone.
      expect(yield* call("cancel_wait", { waitId: checkIn.id })).toEqual({ cancelled: false });
      expect(yield* call("cancel_wait", { waitId: wait.id })).toEqual({ cancelled: true });
      expect(yield* Ref.get(cancels)).toEqual([[wait.id, THREAD_ID]]);
    }),
  );
});
