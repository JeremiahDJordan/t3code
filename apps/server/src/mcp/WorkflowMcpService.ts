/**
 * The agent's side of workflows: `t3_workflow_run` starts a script as a
 * delegated task of the calling thread, driven by the hidden workflow
 * provider.
 */
import {
  CommandId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpWorkflowLimits,
  type OrchestratorMcpWorkflowRunInput,
  type OrchestratorMcpWorkflowRunResult,
  WORKFLOW_PROVIDER_INSTANCE_ID,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's FileSystem has no lstat to check an opened handle against.
import * as NodeFSP from "node:fs/promises";

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { WORKFLOW_MODEL } from "../orchestration-v2/Adapters/WorkflowAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { validateStructuredResult } from "../orchestration-v2/StructuredResult.ts";
import { readWorkflowScript } from "../orchestration-v2/workflowScriptQuery.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  workflowInvocationMessage,
  type WorkflowInvocation,
} from "../workflow/WorkflowInvocation.ts";
import { bindWorkflowRoles } from "../workflow/WorkflowRoles.ts";
import * as WorkflowSandbox from "../workflow/WorkflowSandbox.ts";
import {
  decodeWorkflowMeta,
  scanClaudeScript,
  WORKFLOW_SOURCE_MAX_BYTES,
  workflowSourceHash,
} from "../workflow/WorkflowScript.ts";
import * as WorkflowSourceStore from "../workflow/WorkflowSourceStore.ts";
import { type McpInvocationScope, requireThreadScope } from "./McpInvocationContext.ts";
import { providerConstraints } from "./OrchestratorMcpService.ts";

/** What a script gets when its meta sets no limits. */
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_AGENTS = 30;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class WorkflowMcpService extends Context.Service<
  WorkflowMcpService,
  {
    readonly runWorkflow: (
      scope: McpInvocationScope,
      input: OrchestratorMcpWorkflowRunInput,
    ) => Effect.Effect<OrchestratorMcpWorkflowRunResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/WorkflowMcpService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const sandbox = yield* WorkflowSandbox.WorkflowSandbox;
  const sources = yield* WorkflowSourceStore.WorkflowSourceStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const orchestrationError = (what: string) => (error: unknown) =>
    failure("orchestration_error", `${what}: ${errorMessage(error)}`);

  const loadCaller = (scope: McpInvocationScope, operation: string) =>
    Effect.gen(function* () {
      if (!scope.capabilities.has("orchestration")) {
        return yield* failure(
          "capability_denied",
          "This MCP credential does not grant orchestration capabilities.",
        );
      }
      const threadScope = yield* requireThreadScope(scope, operation);
      const caller = yield* threads
        .getThreadRecords(threadScope.thread.threadId, ["runs", "messages", "subagents"], {
          messageRoles: ["user"],
        })
        .pipe(Effect.mapError(orchestrationError("Unable to read this thread")));
      return { scope: threadScope, caller } as const;
    });

  /** Reads a file in the thread's checkout or one of its message attachments. */
  const readWorkflowFile = (
    caller: Pick<OrchestrationV2ThreadProjection, "thread" | "messages">,
    file: string,
  ) =>
    Effect.gen(function* () {
      const attachment = caller.messages
        .flatMap((message) => message.attachments)
        .find((candidate) => {
          const stored = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: candidate,
          });
          return (
            candidate.id === file || candidate.name === file || (stored !== null && stored === file)
          );
        });
      let target: string | null = null;
      if (attachment !== undefined) {
        target = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      } else {
        const workspaceRoot =
          caller.thread.worktreePath ??
          Option.getOrUndefined(
            yield* projects
              .getById(caller.thread.projectId)
              .pipe(Effect.mapError(orchestrationError("Unable to read this thread's project"))),
          )?.workspaceRoot;
        if (workspaceRoot !== undefined) {
          const root = yield* fileSystem.realPath(workspaceRoot).pipe(Effect.option);
          const resolved = yield* fileSystem
            .realPath(path.resolve(workspaceRoot, file))
            .pipe(Effect.option);
          if (
            Option.isSome(root) &&
            Option.isSome(resolved) &&
            (resolved.value === root.value || resolved.value.startsWith(`${root.value}${path.sep}`))
          ) {
            target = resolved.value;
          }
        }
      }
      if (target === null) {
        // A Claude run's own script, under the same containment Copy script uses.
        const claudeScript = yield* readWorkflowScript({ scriptPath: file }).pipe(Effect.option);
        if (Option.isSome(claudeScript) && !claudeScript.value.truncated) {
          return claudeScript.value.contents;
        }
        return yield* failure(
          "invalid_request",
          `${file} is not in this thread's workspace, among its message attachments, or a Claude workflow script.`,
        );
      }
      const opened = target;
      // Read through one handle and check it is still the file that was
      // resolved, so a path swapped after the containment check is refused.
      const read = yield* Effect.tryPromise({
        try: async () => {
          const handle = await NodeFSP.open(opened, "r");
          try {
            const info = await handle.stat();
            if (!info.isFile()) return { problem: `${file} is not a file.` };
            const atPath = await NodeFSP.lstat(opened);
            if (info.ino !== atPath.ino || info.dev !== atPath.dev) {
              return { problem: `${file} changed while it was being read.` };
            }
            if (info.size > WORKFLOW_SOURCE_MAX_BYTES) {
              return {
                problem: `${file} is larger than ${WORKFLOW_SOURCE_MAX_BYTES / 1024} KB, the most a workflow can be.`,
              };
            }
            return { contents: await handle.readFile("utf8") };
          } finally {
            await handle.close();
          }
        },
        catch: () => failure("invalid_request", `Cannot read ${file}.`),
      });
      if ("problem" in read) return yield* failure("invalid_request", read.problem);
      return read.contents;
    });

  const runWorkflow: WorkflowMcpService["Service"]["runWorkflow"] = (callerScope, input) =>
    Effect.gen(function* () {
      const { scope, caller } = yield* loadCaller(callerScope, "t3_workflow_run");
      const parentRun = ThreadManagementService.latestActiveRun(caller);
      if (
        parentRun === undefined ||
        parentRun.rootNodeId === null ||
        parentRun.providerInstanceId !== scope.thread.providerInstanceId
      ) {
        return yield* failure(
          "parent_not_active",
          "Starting a workflow requires an active run owned by this MCP provider session.",
        );
      }
      if ((input.source === undefined) === (input.file === undefined)) {
        return yield* failure(
          "invalid_request",
          "Pass the workflow as source or as file, not both.",
        );
      }
      const source =
        input.source !== undefined ? input.source : yield* readWorkflowFile(caller, input.file!);

      const scriptFailure = (error: WorkflowSandbox.WorkflowScriptError) =>
        failure("invalid_request", `The workflow script is invalid. ${error.message}`);
      const rawMeta = yield* sandbox.readMeta(source).pipe(Effect.mapError(scriptFailure));
      const meta = decodeWorkflowMeta(rawMeta);
      if (Result.isFailure(meta)) {
        return yield* failure(
          "invalid_request",
          `The workflow script is invalid. ${meta.failure.message}`,
        );
      }
      const claude =
        meta.success.dialect === "claude" ? scanClaudeScript(source) : { problems: [], models: [] };
      if (claude.problems.length > 0) {
        return yield* failure(
          "invalid_request",
          `This Claude workflow uses features T3 cannot run:\n${claude.problems
            .map((problem) => `Line ${problem.line}: ${problem.message}`)
            .join("\n")}`,
        );
      }
      let args: unknown = input.args ?? null;
      if (meta.success.argsSchema !== null) {
        const validated = validateStructuredResult(meta.success.argsSchema, input.args ?? {});
        if (Result.isFailure(validated)) {
          return yield* failure(
            "invalid_request",
            `args do not match meta.args: ${validated.failure}`,
          );
        }
        args = validated.success;
      }

      const capable = new Set(yield* providerAdapters.list());
      const providers = (yield* providerRegistry.getProviders).filter(
        (provider) =>
          capable.has(provider.instanceId) && providerConstraints(provider, true).length === 0,
      );
      const bound = bindWorkflowRoles({
        meta: meta.success,
        claudeModels: claude.models,
        providers,
        parent: {
          modelSelection: caller.thread.modelSelection,
          runtimeMode: caller.thread.runtimeMode,
          interactionMode: caller.thread.interactionMode,
        },
        explicit: input.roles ?? {},
        unboundRoles: input.unboundRoles ?? "fail",
      });
      const modeProblem = bound.modeProblems[0];
      if (modeProblem !== undefined) {
        return yield* failure(
          modeProblem.mode === "runtime"
            ? "runtime_mode_escalation_denied"
            : "interaction_mode_escalation_denied",
          bound.modeProblems.map((problem) => problem.message).join(" "),
        );
      }

      const current = yield* settings.getSettings.pipe(
        Effect.mapError(orchestrationError("Unable to read this environment's settings")),
      );
      const requested = {
        concurrency: meta.success.limits.concurrency ?? DEFAULT_CONCURRENCY,
        agents: meta.success.limits.agents ?? DEFAULT_AGENTS,
      };
      const limits: OrchestratorMcpWorkflowLimits = {
        concurrency: Math.min(requested.concurrency, current.workflowMaxConcurrency),
        agents: Math.min(requested.agents, current.workflowMaxAgents),
        notes: [
          ...(requested.concurrency > current.workflowMaxConcurrency
            ? [
                `The script asks for ${requested.concurrency} concurrent agents; this environment allows ${current.workflowMaxConcurrency}.`,
              ]
            : []),
          ...(requested.agents > current.workflowMaxAgents
            ? [
                `The script asks for ${requested.agents} agents; this environment allows ${current.workflowMaxAgents}.`,
              ]
            : []),
        ],
      };
      const sourceHash = workflowSourceHash(source);
      if (input.dryRun === true) {
        return {
          status: "dry_run",
          name: meta.success.name,
          description: meta.success.description,
          dialect: meta.success.dialect,
          phases: meta.success.phases.map((phase) => ({
            title: phase.title,
            ...(phase.detail === undefined ? {} : { detail: phase.detail }),
          })),
          sourceHash,
          roles: bound.report,
          limits,
        } satisfies OrchestratorMcpWorkflowRunResult;
      }
      const unbound = bound.report.filter((role) => role.bound === null);
      if (unbound.length > 0) {
        return {
          status: "unbound_roles",
          name: meta.success.name,
          message: `Nothing started: ${unbound.map((role) => role.role).join(", ")} cannot bind here. Ask the user, pass roles with a providerInstanceId and model from the candidates, or pass unboundRoles: "inherit" to run them on this thread's model.`,
          roles: bound.report,
        } satisfies OrchestratorMcpWorkflowRunResult;
      }

      yield* sources
        .put(source)
        .pipe(Effect.mapError(orchestrationError("Unable to store the workflow")));
      const phases = meta.success.phases.map((phase) => ({
        title: phase.title,
        ...(phase.detail === undefined ? {} : { detail: phase.detail }),
      }));
      const invocation: WorkflowInvocation = {
        t3Workflow: 1,
        name: meta.success.name,
        dialect: meta.success.dialect,
        sourceHash,
        args: args as Schema.Json,
        phases,
        roles: bound.bindings,
        defaultRole: bound.defaultRole,
        limits: { concurrency: limits.concurrency, agents: limits.agents },
        unboundRolesInherit: input.unboundRoles === "inherit",
      };
      const key = input.clientRequestId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const commandId = CommandId.make(
        [
          "command",
          "mcp",
          encodeURIComponent(scope.requestNamespace),
          "workflow-run",
          encodeURIComponent(key),
        ].join(":"),
      );
      const dispatched = yield* threads
        .dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId,
          parentThreadId: scope.thread.threadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId,
          task: workflowInvocationMessage(invocation),
          title: `Workflow: ${meta.success.name}`.slice(0, 200),
          modelSelection: { instanceId: WORKFLOW_PROVIDER_INSTANCE_ID, model: WORKFLOW_MODEL },
          runtimeMode: caller.thread.runtimeMode,
          interactionMode: caller.thread.interactionMode,
          completionWake: "always",
          workflow: { kind: "run", name: meta.success.name, phases },
        })
        .pipe(Effect.mapError(orchestrationError("Unable to start the workflow")));
      const task = dispatched.storedEvents.find(
        (stored) =>
          stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
      );
      if (task?.event.type !== "subagent.updated" || task.event.payload.childThreadId === null) {
        return yield* failure("orchestration_error", "Starting the workflow produced no task.");
      }
      return {
        status: "started",
        taskId: task.event.payload.id,
        childThreadId: task.event.payload.childThreadId,
        name: meta.success.name,
        sourceHash,
        roles: bound.report,
        limits,
      } satisfies OrchestratorMcpWorkflowRunResult;
    }).pipe(Effect.withSpan("WorkflowMcpService.runWorkflow"));

  return WorkflowMcpService.of({ runWorkflow });
});

export const layer = Layer.effect(WorkflowMcpService, make);
