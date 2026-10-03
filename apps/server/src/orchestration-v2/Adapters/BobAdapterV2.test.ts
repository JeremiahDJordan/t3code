// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - fixtures read and search the mock Bob's protocol log.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  BobSettings,
  CheckpointId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  type OrchestrationV2ProviderThread,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as ServerConfig from "../../config.ts";
import type { TaskTranscript } from "../../provider/taskTranscript.ts";
import { BOB_SSO_SIGN_IN_MESSAGE } from "../../provider/acp/BobAcpSupport.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { type ProviderAdapterV2Event, ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  BOB_EMPTY_REPLY_MESSAGE,
  decodeBobTitle,
  makeBobAcpAdapterFlavor,
  makeBobAdapterV2,
} from "./BobAdapterV2.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

const flavor = makeBobAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("bob-test"),
  settings: decodeBobSettings({ enabled: true }),
  environment: {},
  childProcessSpawner: undefined as never,
  crypto: undefined as never,
  selfInvocation: undefined as never,
  fileSystem: undefined as never,
  idAllocator: undefined as never,
  serverConfig: undefined as never,
});

function permissionRequest(
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): EffectAcpSchema.RequestPermissionRequest {
  return { sessionId: "session-1", options, toolCall: { toolCallId: "tool-1", title: "Edit" } };
}

describe("BobAdapterV2 flavor", () => {
  it("reads Bob's HTML-escaped tool titles as Bob meant them", () => {
    assert.equal(decodeBobTitle("echo a&#x3D;b &amp;&amp; ls &lt;dir&gt;"), "echo a=b && ls <dir>");
    assert.equal(
      decodeBobTitle("keeps &bogus; and &#0; as they are"),
      "keeps &bogus; and &#0; as they are",
    );
  });

  it("recognizes a subagent by its title ending in its description, and strips its report's tags", () => {
    const running = flavor.extractSubagentUpdate?.({
      toolCallId: "call-1",
      kind: "other",
      status: "inProgress",
      data: {
        title: "Running subagent: Count the files",
        rawInput: { description: "Count the files" },
      },
    });
    assert.deepInclude(running, {
      nativeTaskId: "call-1",
      prompt: "Count the files",
      status: "running",
    });
    assert.isNull(running?.result);
    const finished = flavor.extractSubagentUpdate?.({
      toolCallId: "call-1",
      kind: "other",
      status: "completed",
      data: {
        title: "Running subagent: Count the files",
        rawInput: { description: "Count the files" },
        rawOutput: { result: "<task_result>\nThere are 2 files.\n</task_result>" },
      },
    });
    assert.equal(finished?.result, "There are 2 files.");
    // A tool whose title is just its description, or another kind, is not a subagent.
    assert.isUndefined(
      flavor.extractSubagentUpdate?.({
        toolCallId: "call-2",
        kind: "other",
        data: { title: "Count the files", rawInput: { description: "Count the files" } },
      }),
    );
    assert.isUndefined(
      flavor.extractSubagentUpdate?.({
        toolCallId: "call-3",
        kind: "execute",
        data: { title: "Running subagent: ls", rawInput: { description: "ls" } },
      }),
    );
  });

  it("offers only the approval answers Bob can take", () => {
    assert.deepEqual(
      flavor
        .approvalOptions?.(
          permissionRequest([
            { optionId: "once", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Deny", kind: "reject_once" },
          ]),
        )
        .map((option) => option.decision),
      ["cancel", "decline", "accept"],
    );
    assert.deepEqual(
      flavor
        .approvalOptions?.(
          permissionRequest([
            { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "once", name: "Allow", kind: "allow_once" },
          ]),
        )
        .map((option) => option.decision),
      ["cancel", "acceptForSession", "accept"],
    );
  });

  it("starts every turn in Agent but leaves Plan turns to the plan mode switch", () => {
    const mode = (interactionMode: "default" | "plan") =>
      flavor.sessionModeForPolicy?.(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode,
          cwd: "/workspace",
        }),
      );
    assert.equal(mode("default"), "agent");
    assert.isUndefined(mode("plan"));
  });

  it("explains Bob's setup refusals and the reason in a failed turn", () => {
    const signIn = flavor.promptFailure?.(
      new EffectAcpErrors.AcpRequestError({
        code: -32000,
        errorMessage: "Authentication required",
      }),
    );
    assert.equal(signIn?.message, BOB_SSO_SIGN_IN_MESSAGE);
    const details = flavor.promptFailure?.(
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        data: { details: "The model is overloaded." },
      }),
    );
    assert.equal(details?.message, "The model is overloaded.");
  });
});

const sessionLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-bob-v2-adapter-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

interface BobRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * Opens the V2 adapter against the mock Bob, which records every request and keeps its tasks in a
 * file every mock Bob shares, as real Bobs share their task database.
 */
const openBob = (input: {
  readonly mockEnv?: Record<string, string>;
  /** Bob's task usage by reading, the first when a session opens. */
  readonly usageReadings?: ReadonlyArray<{ used: number; size: number; bobcoins: number }>;
  /** The steps Bob's task database holds for every subagent run. */
  readonly subagentSteps?: TaskTranscript;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bob-v2-turn-" });
    const workspace = path.join(tempDir, "workspace");
    yield* fileSystem.makeDirectory(workspace);
    const requestLogPath = path.join(tempDir, "requests.ndjson");
    const mockPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-bob.ts", import.meta.url),
    );
    const binaryPath = writeFakeCli({
      directory: path.join(tempDir, "bin"),
      name: "bob",
      env: {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_BOB_STATE_PATH: path.join(tempDir, "bob-state.json"),
        ...input.mockEnv,
      },
      source: execScriptSource({ scriptPath: mockPath }),
    });
    const commands: Array<{ names: ReadonlyArray<string>; cwd: string }> = [];
    const modes: Array<{ ids: ReadonlyArray<string>; cwd: string }> = [];
    const spentIn: Array<string> = [];
    let usageReading = 0;
    const instanceId = ProviderInstanceId.make("bob-turn-test");
    const adapter = makeBobAdapterV2({
      instanceId,
      settings: decodeBobSettings({ enabled: true, binaryPath }),
      environment: process.env,
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      crypto: yield* Crypto.Crypto,
      selfInvocation: yield* resolveSelfInvocation(),
      fileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
      onAvailableCommands: (available, cwd) =>
        Effect.sync(() => {
          commands.push({ names: available.map((command) => command.name), cwd });
        }),
      onAvailableModes: (available, cwd) =>
        Effect.sync(() => {
          modes.push({ ids: available.map((mode) => mode.id), cwd });
        }),
      ...(input.usageReadings
        ? {
            readTaskUsage: () => Effect.sync(() => input.usageReadings?.[usageReading++]),
            onBobcoinsSpent: (cwd: string) =>
              Effect.sync(() => {
                spentIn.push(cwd);
              }),
          }
        : {}),
      ...(input.subagentSteps
        ? { readSubagentSteps: () => Effect.succeed(input.subagentSteps!) }
        : {}),
    });
    const threadId = ThreadId.make("thread-bob-turn");
    const modelSelection = { instanceId, model: "bob-default" } as const;
    const policyFor = (cwd: string, interactionMode: "default" | "plan" = "default") =>
      ProviderAdapterV2RuntimePolicy.make({ runtimeMode: "full-access", interactionMode, cwd });
    let sessions = 0;
    let turns = 0;
    /** Opens a session in `cwd`, as a turn after a server start or a folder change does. */
    const openSession = (cwd: string) =>
      adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`provider-session-bob-${++sessions}`),
        modelSelection,
        runtimePolicy: policyFor(cwd),
      });
    /** Runs one turn on `session` until it ends, and returns its events. */
    const runTurn = (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      providerThread: OrchestrationV2ProviderThread,
      text: string,
      options: { readonly cwd?: string; readonly interactionMode?: "default" | "plan" } = {},
    ) =>
      Effect.gen(function* () {
        const turn = ++turns;
        const cwd = options.cwd ?? workspace;
        const runtimePolicy = policyFor(cwd, options.interactionMode);
        const now = yield* DateTime.now;
        const collected = yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* session.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-bob-turn"),
            title: "Bob turn",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: options.interactionMode ?? "default",
            branch: null,
            worktreePath: cwd,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make(`run-bob-${turn}`),
          runOrdinal: turn,
          providerTurnOrdinal: turn,
          attemptId: RunAttemptId.make(`attempt-bob-${turn}`),
          rootNodeId: NodeId.make(`node-bob-${turn}`),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make(`message-bob-${turn}`),
            text,
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        return Array.from(yield* Fiber.join(collected));
      });
    /** When the mock Bobs stamped each prompt they received, in order. */
    const promptTimestamps = (): ReadonlyArray<number> => {
      const state = JSON.parse(
        NodeFS.readFileSync(path.join(tempDir, "bob-state.json"), "utf8"),
      ) as {
        readonly tasks: Record<
          string,
          {
            readonly messages: ReadonlyArray<{
              readonly role: string;
              readonly data: { readonly _meta?: { readonly timestamp?: number } };
            }>;
          }
        >;
      };
      return Object.values(state.tasks)
        .flatMap((task) => task.messages)
        .flatMap((message) =>
          message.role === "user" && message.data._meta?.timestamp !== undefined
            ? [message.data._meta.timestamp]
            : [],
        )
        .toSorted((a, b) => a - b);
    };
    /** The requests T3 sent every mock Bob, in order. */
    const requests = (): ReadonlyArray<BobRequest> =>
      NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .flatMap((line) => {
          const message = JSON.parse(line) as {
            readonly method?: string;
            readonly params?: Record<string, unknown>;
          };
          return message.method ? [{ method: message.method, params: message.params ?? {} }] : [];
        });
    return {
      threadId,
      modelSelection,
      workspace,
      tempDir,
      commands,
      modes,
      spentIn,
      policyFor,
      openSession,
      runTurn,
      requests,
      promptTimestamps,
    };
  });

/** Runs one turn through the V2 adapter against the mock Bob, until the turn ends. */
const runBobTurn = (input: {
  readonly text: string;
  readonly interactionMode?: "default" | "plan";
  readonly mockEnv?: Record<string, string>;
  readonly usageReadings?: ReadonlyArray<{ used: number; size: number; bobcoins: number }>;
  readonly subagentSteps?: TaskTranscript;
}) =>
  Effect.gen(function* () {
    const bob = yield* openBob(input);
    const session = yield* bob.openSession(bob.workspace);
    const providerThread = yield* session.ensureThread({
      threadId: bob.threadId,
      modelSelection: bob.modelSelection,
      runtimePolicy: bob.policyFor(bob.workspace, input.interactionMode),
    });
    const events = yield* bob.runTurn(session, providerThread, input.text, {
      ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    });
    return {
      events,
      methods: bob.requests().map((request) => request.method),
      commands: bob.commands,
      modes: bob.modes,
      workspace: bob.workspace,
      spentIn: bob.spentIn,
    };
  });

const terminalOf = (events: ReadonlyArray<ProviderAdapterV2Event>) =>
  events.find((event) => event.type === "turn.terminal");

describe("BobAdapterV2 turns", () => {
  it.effect(
    "runs a turn without ever asking Bob to authenticate, and learns its commands and modes",
    () =>
      Effect.gen(function* () {
        const result = yield* runBobTurn({ text: "hello" });
        assert.equal(terminalOf(result.events)?.status, "completed");
        assert.notInclude(result.methods, "authenticate");
        assert.include(result.methods, "session/new");
        assert.include(result.methods, "session/prompt");
        assert.isTrue(
          result.events.some(
            (event) =>
              event.type === "message.updated" &&
              JSON.stringify(event.message).includes("Hello from Bob."),
          ),
        );
        assert.deepEqual(result.modes[0], {
          ids: ["agent", "ask", "plan", "reviewer"],
          cwd: result.workspace,
        });
        assert.deepEqual(result.commands.at(-1), {
          names: ["init", "review"],
          cwd: result.workspace,
        });
      }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("says how to sign in, or accept Bob's license, when Bob refuses the session", () =>
    Effect.gen(function* () {
      const signedOut = yield* Effect.flip(
        runBobTurn({ text: "hello", mockEnv: { T3_ACP_BOB_SIGNED_OUT: "1" } }),
      );
      assert.equal(makeProviderFailure({ cause: signedOut }).message, BOB_SSO_SIGN_IN_MESSAGE);
      const unlicensed = yield* Effect.flip(
        runBobTurn({ text: "hello", mockEnv: { T3_ACP_BOB_LICENSE_REQUIRED: "1" } }),
      );
      assert.equal(
        makeProviderFailure({ cause: unlicensed }).message,
        "Run bob with --accept-license to accept the license. Run `bob` once in a terminal to accept it.",
      );
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("fails a turn Bob ends without replying as retryable", () =>
    Effect.gen(function* () {
      const terminal = terminalOf((yield* runBobTurn({ text: "say nothing" })).events);
      assert.equal(terminal?.status, "failed");
      if (terminal?.status !== "failed") return;
      assert.deepInclude(terminal.failure, {
        message: BOB_EMPTY_REPLY_MESSAGE,
        code: "empty_reply",
        retryable: true,
      });
      assert.equal(terminal.threadDisposition, "reusable");
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("proposes a plan turn's final reply as the plan", () =>
    Effect.gen(function* () {
      const result = yield* runBobTurn({ text: "plan the change", interactionMode: "plan" });
      assert.equal(terminalOf(result.events)?.status, "completed");
      assert.include(result.methods, "session/set_mode");
      assert.isTrue(
        result.events.some(
          (event) =>
            event.type === "plan.updated" &&
            JSON.stringify(event.plan).includes("1. Read the code."),
        ),
      );
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("reports Bob's context and Bobcoins from its task database after a turn", () =>
    Effect.gen(function* () {
      const result = yield* runBobTurn({
        text: "hello",
        usageReadings: [
          { used: 0, size: 0, bobcoins: 1 },
          { used: 1_200, size: 200_000, bobcoins: 1.42 },
        ],
      });
      const usage = result.events.findLast(
        (event) => event.type === "provider_thread.updated" && event.providerThread.contextUsage,
      );
      assert.deepEqual(
        usage?.type === "provider_thread.updated" ? usage.providerThread.contextUsage : undefined,
        { usedTokens: 1_200, maxTokens: 200_000, cost: { amount: 1.42, currency: "Bobcoins" } },
      );
      assert.deepEqual(result.spentIn, [result.workspace]);
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("rewinds Bob's conversation to before a reverted turn", () =>
    Effect.gen(function* () {
      const bob = yield* openBob({});
      const session = yield* bob.openSession(bob.workspace);
      const providerThread = yield* session.ensureThread({
        threadId: bob.threadId,
        modelSelection: bob.modelSelection,
        runtimePolicy: bob.policyFor(bob.workspace),
      });
      const providerTurnsOf = (events: ReadonlyArray<ProviderAdapterV2Event>) =>
        events.flatMap((event) =>
          event.type === "provider_turn.updated" ? [event.providerTurn] : [],
        );
      const first = providerTurnsOf(yield* bob.runTurn(session, providerThread, "first")).at(-1)!;
      const secondEvents = yield* bob.runTurn(session, providerThread, "second");
      // The reverted turn began when Bob stamped its prompt; the test clock cannot say when.
      const second = {
        ...providerTurnsOf(secondEvents).at(-1)!,
        startedAt: DateTime.makeUnsafe(bob.promptTimestamps()[1]!),
      };
      // The thread as orchestration keeps it, bound to Bob's task once a turn ran.
      const boundThread = secondEvents.findLast(
        (event) => event.type === "provider_thread.updated",
      );
      assert.isDefined(boundThread);
      if (boundThread?.type !== "provider_thread.updated") return;
      const original = boundThread.providerThread.nativeThreadRef?.nativeId;
      assert.isDefined(original);
      const rolledBack = yield* session.rollbackThread({
        providerThread: boundThread.providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-first"),
          appRunOrdinal: 1,
          providerTurn: first,
        },
        providerThreadTurns: [first, second],
      });
      const rewound = rolledBack.providerThread.nativeThreadRef?.nativeId;
      assert.match(rewound ?? "", /^mock-imported-/);
      const exported = bob.requests().find((request) => request.method === "_bob/task/import");
      // Only the first turn's prompt and reply go into the rewound task.
      const kept = JSON.stringify(exported?.params.snapshot);
      assert.include(kept, "first");
      assert.notInclude(kept, "second");
      const deleted = bob
        .requests()
        .filter((request) => request.method === "session/delete")
        .map((request) => request.params.sessionId);
      assert.include(deleted, original);
      // The next turn continues the rewound task.
      yield* bob.runTurn(session, rolledBack.providerThread, "third");
      const resumed = bob
        .requests()
        .filter((request) => request.method === "session/resume")
        .map((request) => request.params.sessionId);
      assert.include(resumed, rewound);
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("takes a thread's task along when it moves to another folder", () =>
    Effect.gen(function* () {
      const bob = yield* openBob({});
      const first = yield* bob.openSession(bob.workspace);
      const providerThread = yield* first.ensureThread({
        threadId: bob.threadId,
        modelSelection: bob.modelSelection,
        runtimePolicy: bob.policyFor(bob.workspace),
      });
      const firstEvents = yield* bob.runTurn(first, providerThread, "first");
      const boundThread = firstEvents.findLast((event) => event.type === "provider_thread.updated");
      if (boundThread?.type !== "provider_thread.updated") return assert.fail("no bound thread");
      const original = boundThread.providerThread.nativeThreadRef?.nativeId;
      assert.isDefined(original);
      const fileSystem = yield* FileSystem.FileSystem;
      const worktree = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bob-v2-worktree-" });
      const moved = yield* bob.openSession(worktree);
      const resumed = yield* moved.resumeThread({
        providerThread: boundThread.providerThread,
        threadId: bob.threadId,
        modelSelection: bob.modelSelection,
        runtimePolicy: bob.policyFor(worktree),
      });
      const copy = resumed.nativeThreadRef?.nativeId;
      assert.match(copy ?? "", /^mock-imported-/);
      const imported = bob.requests().find((request) => request.method === "_bob/task/import");
      assert.equal(imported?.params.cwd, worktree);
      assert.include(
        bob
          .requests()
          .filter((request) => request.method === "session/delete")
          .map((request) => request.params.sessionId),
        original,
      );
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("writes a finished subagent's steps from Bob's database into its thread", () =>
    Effect.gen(function* () {
      const result = yield* runBobTurn({
        text: "use a subagent",
        subagentSteps: {
          entries: [
            { _tag: "prompt", text: "Count the files" },
            { _tag: "message", text: "Listing the folder." },
            {
              _tag: "tool",
              title: "List Files in .",
              input: "ls",
              output: "a.ts\nb.ts",
              failed: false,
            },
          ],
        },
      });
      const subagent = result.events.findLast((event) => event.type === "subagent.updated");
      if (subagent?.type !== "subagent.updated") return assert.fail("no subagent");
      const childThreadId = subagent.subagent.childThreadId;
      const childTool = result.events.find(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.threadId === childThreadId &&
          event.turnItem.type === "dynamic_tool",
      );
      assert.include(JSON.stringify(childTool), "List Files in .");
      assert.include(JSON.stringify(childTool), "a.ts");
      assert.isTrue(
        result.events.some(
          (event) =>
            event.type === "message.updated" &&
            event.message.threadId === childThreadId &&
            JSON.stringify(event.message).includes("Listing the folder."),
        ),
      );
      assert.include(JSON.stringify(subagent), "There are 2 files.");
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("shows a subagent Bob runs with its report", () =>
    Effect.gen(function* () {
      const result = yield* runBobTurn({ text: "use a subagent" });
      assert.equal(terminalOf(result.events)?.status, "completed");
      const subagent = result.events.findLast((event) => event.type === "subagent.updated");
      assert.isDefined(subagent);
      assert.include(JSON.stringify(subagent), "There are 2 files.");
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );
});
