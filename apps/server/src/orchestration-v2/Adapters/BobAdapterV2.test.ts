// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - fixtures read and search the mock Bob's protocol log.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  BobSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
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
import { BOB_SSO_SIGN_IN_MESSAGE } from "../../provider/acp/BobAcpSupport.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import * as IdAllocator from "../IdAllocator.ts";
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

interface BobTurnResult {
  readonly events: ReadonlyArray<ProviderAdapterV2Event>;
  /** The JSON-RPC methods T3 sent the mock Bob, in order. */
  readonly methods: ReadonlyArray<string>;
  readonly commands: ReadonlyArray<{ readonly names: ReadonlyArray<string>; readonly cwd: string }>;
  readonly modes: ReadonlyArray<{ readonly ids: ReadonlyArray<string>; readonly cwd: string }>;
}

/** Runs one turn through the V2 adapter against the mock Bob, until the turn ends. */
const runBobTurn = (input: {
  readonly text: string;
  readonly interactionMode?: "default" | "plan";
  readonly mockEnv?: Record<string, string>;
  /** Bob's task usage by reading, the first when the session opens. */
  readonly usageReadings?: ReadonlyArray<{ used: number; size: number; bobcoins: number }>;
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
      env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...input.mockEnv },
      source: execScriptSource({ scriptPath: mockPath }),
    });
    const commands: Array<{ names: ReadonlyArray<string>; cwd: string }> = [];
    const spentIn: Array<string> = [];
    let usageReading = 0;
    const modes: Array<{ ids: ReadonlyArray<string>; cwd: string }> = [];
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
    });
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: input.interactionMode ?? "default",
      cwd: workspace,
    });
    const threadId = ThreadId.make("thread-bob-turn");
    const modelSelection = { instanceId, model: "bob-default" } as const;
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-bob-turn"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
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
        interactionMode: input.interactionMode ?? "default",
        branch: null,
        worktreePath: workspace,
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
      runId: RunId.make("run-bob-turn"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("attempt-bob-turn"),
      rootNodeId: NodeId.make("node-bob-turn"),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("message-bob-turn"),
        text: input.text,
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });
    const events = Array.from(yield* Fiber.join(collected));
    const methods = NodeFS.readFileSync(requestLogPath, "utf8")
      .trim()
      .split("\n")
      .flatMap((line) => {
        const message = JSON.parse(line) as { readonly method?: string };
        return message.method ? [message.method] : [];
      });
    return { events, methods, commands, modes, workspace, spentIn } satisfies BobTurnResult & {
      readonly workspace: string;
      readonly spentIn: ReadonlyArray<string>;
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
