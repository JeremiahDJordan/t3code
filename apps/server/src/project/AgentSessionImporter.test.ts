import { expect, it } from "@effect/vitest";
import {
  BOB_DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      }),
  });
  const layerTest = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
        SqlitePersistenceMemory,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(layerTest));
});

it.effect("imports a Bob task and leaves out tasks that back other T3 threads", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const boundTaskIds: Array<ReadonlySet<string> | undefined> = [];
  const bobInstanceId = ProviderInstanceId.make("bob");
  const taskId = "0123456789abcdef0123456789abcdef";
  const bobThreadId = ThreadId.make(`import:${bobInstanceId}:${taskId}`);
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: (_workspaceRoot, _completedSources, boundBobTaskIds) => {
      boundTaskIds.push(boundBobTaskIds);
      return Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "bob",
          providerInstanceId: bobInstanceId,
          providerSessionId: taskId,
          filePath: `/home/.bob/db/bob.db#${taskId}`,
          size: 2,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "bob",
          providerInstanceId: bobInstanceId,
          providerSessionId: taskId,
          title: "Imported Bob task",
          model: null,
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      });
    },
  });
  /** A runtime row as the V1 fork left it in the migrated database. */
  const legacyRuntime = (threadId: string, providerName: string, resumeCursor: unknown) =>
    ({
      threadId: ThreadId.make(threadId),
      providerName,
      providerInstanceId: ProviderInstanceId.make(providerName),
      adapterKey: providerName,
      runtimeMode: "full-access",
      status: "stopped",
      lastSeenAt: "2026-08-01T00:00:00.000Z",
      resumeCursor,
      runtimePayload: null,
    }) as const;
  const testLayer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId: bobThreadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) => Effect.sync(() => (writes.push(input.events), [])),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () =>
            Effect.succeed([
              // A thread T3 started in Bob before orchestration V2.
              legacyRuntime("thread-started-in-v1", "bob", {
                schemaVersion: 1,
                sessionId: "task-started-in-v1",
                turnStartedAt: [1],
              }),
              // An imported Bob thread that Bob could not resume, so T3 moved it to a new task.
              legacyRuntime("import:bob:task-imported-earlier", "bob", {
                schemaVersion: 1,
                sessionId: "task-continued-in-v1",
              }),
              legacyRuntime("import:bob:task-still-imported", "bob", {
                schemaVersion: 1,
                sessionId: "task-still-imported",
              }),
              legacyRuntime("thread-claude", "claudeAgent", { threadId: "thread-claude" }),
            ]),
          upsert: () => Effect.void,
          recordImportedTranscript: () => Effect.void,
        }),
        IdAllocator.layer,
      ),
    ),
    // Shared with the test, which writes the V2 provider threads.
    Layer.provideMerge(SqlitePersistenceMemory),
  );

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    /** A V2 provider thread on native thread `nativeId`, as the projection stores it. */
    const insertProviderThread = (input: {
      readonly threadId: string;
      readonly driver: string;
      readonly instanceId: string;
      readonly nativeId: string;
    }) =>
      sql`
        INSERT INTO orchestration_v2_projection_provider_threads (
          provider_thread_id, thread_id, owner_node_id, provider, driver, provider_instance_id,
          provider_session_id, status, first_run_ordinal, last_run_ordinal, updated_at,
          payload_json
        ) VALUES (
          ${`provider-thread:${input.threadId}`}, ${input.threadId}, NULL, ${input.instanceId},
          ${input.driver}, ${input.instanceId}, NULL, 'idle', 1, 1, '2026-09-01T00:00:00.000Z',
          ${`{"nativeThreadRef":{"driver":"${input.driver}","nativeId":"${input.nativeId}","strength":"strong"}}`}
        )
      `;
    // A thread T3 started in Bob since orchestration V2.
    yield* insertProviderThread({
      threadId: "thread-started-in-v2",
      driver: "bob",
      instanceId: "bob",
      nativeId: "task-started-in-v2",
    });
    // A Bob task imported from one instance and continued on another.
    yield* insertProviderThread({
      threadId: "import:bob_api:task-imported-in-v2",
      driver: "bob",
      instanceId: "bob",
      nativeId: "task-imported-in-v2",
    });
    yield* insertProviderThread({
      threadId: "thread-codex",
      driver: "codex",
      instanceId: "codex",
      nativeId: "codex-thread",
    });

    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(boundTaskIds).toEqual([
      new Set(["task-started-in-v1", "task-continued-in-v1", "task-started-in-v2"]),
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: bobThreadId,
      modelSelection: { instanceId: bobInstanceId, model: BOB_DEFAULT_MODEL },
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: bobThreadId,
      nativeThreadRef: { driver: "bob", nativeId: taskId, strength: "strong" },
    });
  }).pipe(Effect.provide(testLayer));
});
