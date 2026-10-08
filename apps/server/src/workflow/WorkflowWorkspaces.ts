/**
 * Git worktrees for a workflow's `workspace()` calls, so agents that edit
 * files can work in parallel. Each workspace is a branch `t3/wf/<run>/<name>`;
 * its worktree is created from the coordinator checkout's HEAD the first time,
 * found again on a rerun, and removed when a run finishes unless it has
 * uncommitted changes. Branches stay: merging is the script's business.
 */
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export class WorkflowWorkspaceError extends Schema.TaggedError<WorkflowWorkspaceError>()(
  "WorkflowWorkspaceError",
  {
    operation: Schema.Literals(["create", "setup", "remove"]),
    branch: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.operation === "setup"
      ? `The setup script failed in the worktree for ${this.branch}.`
      : `Could not ${this.operation} the worktree for ${this.branch}.`;
  }
}

/** A workspace name a script may use: it becomes part of a branch name, so git's ref rules apply. */
export const isWorkflowWorkspaceName = (name: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) &&
  !name.includes("..") &&
  !name.endsWith(".") &&
  !name.endsWith(".lock");

/** The branch a run's workspace lives on; stable across reruns of the same run. */
export function workflowWorkspaceBranch(coordinatorThreadId: ThreadId, name: string): string {
  const run = bytesToHex(sha256(new TextEncoder().encode(coordinatorThreadId))).slice(0, 10);
  return `t3/wf/${run}/${name}`;
}

export class WorkflowWorkspaces extends Context.Service<
  WorkflowWorkspaces,
  {
    /** The worktree for `branch`: an existing one, else one made from `cwd`'s HEAD with setup run. */
    readonly ensure: (input: {
      readonly projectId: ProjectId;
      /** The coordinator thread, whose terminals run the setup script. */
      readonly ownerThreadId: ThreadId;
      readonly cwd: string;
      readonly branch: string;
    }) => Effect.Effect<{ readonly worktreePath: string }, WorkflowWorkspaceError>;
    readonly remove: (input: {
      readonly cwd: string;
      readonly worktreePath: string;
      readonly branch: string;
    }) => Effect.Effect<void, WorkflowWorkspaceError>;
  }
>()("t3/workflow/WorkflowWorkspaces") {}

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;

  const existingWorktree = (cwd: string, branch: string) =>
    git
      .listRefs({ cwd, query: branch, refKind: "local" })
      .pipe(
        Effect.map(
          (result) =>
            result.refs.find((ref) => ref.name === branch && ref.worktreePath !== null)
              ?.worktreePath ?? null,
        ),
      );

  const runSetup = (input: {
    readonly projectId: ProjectId;
    readonly ownerThreadId: ThreadId;
    readonly worktreePath: string;
    readonly branch: string;
  }) =>
    Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
      if (project === undefined) return;
      const setup = yield* setupScripts.runForThread({
        threadId: input.ownerThreadId,
        projectId: input.projectId,
        projectCwd: project.workspaceRoot,
        worktreePath: input.worktreePath,
        preferredTerminalId: `workflow-setup:${input.branch}`,
        observeCompletion: {},
        project: { id: project.id, workspaceRoot: project.workspaceRoot, scripts: project.scripts },
      });
      // A script marked async lets agents start while it runs, as in a launched thread.
      if (setup.status !== "started" || setup.async || setup.completion === undefined) return;
      const completion = yield* setup.completion;
      if (completion.exitCode !== 0) {
        return yield* new WorkflowWorkspaceError({ operation: "setup", branch: input.branch });
      }
    }).pipe(
      Effect.catchTags({
        ProjectSetupScriptOperationError: (cause) =>
          new WorkflowWorkspaceError({ operation: "setup", branch: input.branch, cause }),
        ProjectSetupScriptProjectNotFoundError: (cause) =>
          new WorkflowWorkspaceError({ operation: "setup", branch: input.branch, cause }),
        ProjectOperationError: (cause) =>
          new WorkflowWorkspaceError({ operation: "setup", branch: input.branch, cause }),
      }),
    );

  const ensure: WorkflowWorkspaces["Service"]["ensure"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* existingWorktree(input.cwd, input.branch);
      if (existing !== null) return { worktreePath: existing };
      const branchExists = (yield* git.listLocalBranchNames(input.cwd)).includes(input.branch);
      // Git keeps a record for a worktree directory deleted by hand and
      // refuses to check its branch out again until the record is pruned.
      if (branchExists) yield* git.pruneWorktrees({ cwd: input.cwd });
      const worktreesDirectory = yield* settings.getSettings.pipe(
        Effect.map((current) => current.worktreesDirectory),
        Effect.orElseSucceed(() => ""),
      );
      const created = yield* git.createWorktree(
        branchExists
          ? { cwd: input.cwd, refName: input.branch, path: null }
          : { cwd: input.cwd, refName: "HEAD", newRefName: input.branch, path: null },
        { worktreesDirectory },
      );
      yield* runSetup({ ...input, worktreePath: created.worktree.path });
      return { worktreePath: created.worktree.path };
    }).pipe(
      Effect.catchTags({
        GitCommandError: (cause) =>
          new WorkflowWorkspaceError({ operation: "create", branch: input.branch, cause }),
      }),
      Effect.withSpan("WorkflowWorkspaces.ensure"),
    );

  // Not forced: git refuses a worktree with changes nobody committed, and
  // that work is worth more than a tidy worktrees directory.
  const remove: WorkflowWorkspaces["Service"]["remove"] = (input) =>
    git.removeWorktree({ cwd: input.cwd, path: input.worktreePath }).pipe(
      Effect.catchTags({
        GitCommandError: (cause) =>
          new WorkflowWorkspaceError({ operation: "remove", branch: input.branch, cause }),
      }),
      Effect.withSpan("WorkflowWorkspaces.remove"),
    );

  return WorkflowWorkspaces.of({ ensure, remove });
});

export const layer = Layer.effect(WorkflowWorkspaces, make);
