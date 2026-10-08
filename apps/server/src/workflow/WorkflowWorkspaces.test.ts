import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkflowWorkspaces from "./WorkflowWorkspaces.ts";

const projectId = ProjectId.make("project:workflow-workspaces");
const coordinatorThreadId = ThreadId.make("thread:workflow-coordinator");

describe("WorkflowWorkspaces", () => {
  it.live("creates a worktree from HEAD, finds it again, and removes only a clean one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repo = yield* checkpointWorkspace("workflow-workspaces");
        const setups = yield* Ref.make<ReadonlyArray<string>>([]);
        const layerGit = GitVcsDriver.layer.pipe(
          Layer.provide(ServerConfig.layerTest(repo, { prefix: "t3-workflow-ws-" })),
          Layer.provide(VcsProcess.layer),
        );
        const layer = WorkflowWorkspaces.layer.pipe(
          Layer.provideMerge(layerGit),
          Layer.provide(
            Layer.mergeAll(
              ServerSettings.layerTest({}).pipe(Layer.orDie),
              Layer.mock(ProjectService.ProjectService)({
                getById: (id) =>
                  Effect.succeed(Option.some({ id, workspaceRoot: repo, scripts: [] } as never)),
              }),
              Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
                runForThread: (input) =>
                  Ref.update(setups, (all) => [...all, input.worktreePath]).pipe(
                    Effect.as({ status: "no-script" as const }),
                  ),
              }),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const workspaces = yield* WorkflowWorkspaces.WorkflowWorkspaces;
          const git = yield* GitVcsDriver.GitVcsDriver;
          const fs = yield* FileSystem.FileSystem;
          const branch = WorkflowWorkspaces.workflowWorkspaceBranch(coordinatorThreadId, "noise");
          const input = { projectId, ownerThreadId: coordinatorThreadId, cwd: repo, branch };

          const created = yield* workspaces.ensure(input);
          expect(yield* fs.exists(`${created.worktreePath}/README.md`)).toBe(true);
          expect(yield* git.listLocalBranchNames(repo)).toContain(branch);
          expect(yield* Ref.get(setups)).toEqual([created.worktreePath]);

          // A rerun finds the same worktree and runs no setup again.
          const found = yield* workspaces.ensure(input);
          expect(yield* fs.realPath(found.worktreePath)).toBe(
            yield* fs.realPath(created.worktreePath),
          );
          expect(yield* Ref.get(setups)).toHaveLength(1);

          yield* workspaces.remove({ cwd: repo, worktreePath: created.worktreePath, branch });
          expect(yield* fs.exists(created.worktreePath)).toBe(false);
          expect(yield* git.listLocalBranchNames(repo)).toContain(branch);

          // After removal the branch is checked out again rather than recreated.
          const again = yield* workspaces.ensure(input);
          expect(yield* fs.exists(`${again.worktreePath}/README.md`)).toBe(true);

          // Work nobody committed keeps its worktree.
          yield* fs.writeFileString(`${again.worktreePath}/draft.txt`, "unsaved\n");
          const kept = yield* workspaces
            .remove({ cwd: repo, worktreePath: again.worktreePath, branch })
            .pipe(Effect.flip);
          expect(kept.operation).toBe("remove");
          expect(yield* fs.readFileString(`${again.worktreePath}/draft.txt`)).toBe("unsaved\n");
          yield* git.removeWorktree({ cwd: repo, path: again.worktreePath, force: true });

          // A worktree directory deleted by hand does not block the next run.
          const deleted = yield* workspaces.ensure(input);
          yield* fs.remove(deleted.worktreePath, { recursive: true });
          const recreated = yield* workspaces.ensure(input);
          expect(yield* fs.exists(`${recreated.worktreePath}/README.md`)).toBe(true);
          yield* workspaces.remove({ cwd: repo, worktreePath: recreated.worktreePath, branch });
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  it("keeps workspace names to what a branch can hold", () => {
    expect(WorkflowWorkspaces.isWorkflowWorkspaceName("task-1.a_b")).toBe(true);
    expect(WorkflowWorkspaces.isWorkflowWorkspaceName("../escape")).toBe(false);
    expect(WorkflowWorkspaces.isWorkflowWorkspaceName("has space")).toBe(false);
    // Names git would refuse as a branch.
    for (const name of ["a..b", "a.lock", "a."]) {
      expect(WorkflowWorkspaces.isWorkflowWorkspaceName(name)).toBe(false);
    }
    expect(WorkflowWorkspaces.workflowWorkspaceBranch(coordinatorThreadId, "noise")).toMatch(
      /^t3\/wf\/[0-9a-f]{10}\/noise$/,
    );
  });
});
