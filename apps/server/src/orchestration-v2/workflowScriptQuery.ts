// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only access to persisted workflow scripts for the Agents surface's
 * "{} script" affordance.
 *
 * Containment rules (lifted from the reviewed #3650 inspection service):
 * - the resolved realpath must live under ~/.claude/projects (where the
 *   Claude harness persists workflow scripts) — realpath re-containment
 *   defeats symlink escapes, including a symlinked leaf file;
 * - only .js leaf files are served;
 * - reads are size-capped rather than failed, with a truncation marker.
 *
 * The client-supplied path is a hint from the workflow's runHandles; it is
 * never trusted beyond these checks.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { OrchestrationGetWorkflowScriptError, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { parseWorkflowInvocation } from "../workflow/WorkflowInvocation.ts";
import * as WorkflowSourceStore from "../workflow/WorkflowSourceStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const SCRIPT_BYTE_CAP = 256 * 1024;

function scriptsRoot(): string {
  return NodePath.join(NodeOS.homedir(), ".claude", "projects");
}

export const readWorkflowScript = Effect.fn("orchestration.readWorkflowScript")(function* (input: {
  readonly scriptPath: string;
}) {
  const requested = input.scriptPath;

  if (!NodePath.isAbsolute(requested) || NodePath.extname(requested) !== ".js") {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: "invalid-path",
      scriptPath: requested,
    });
  }

  const root = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(scriptsRoot()),
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({
        reason: "root-unavailable",
        scriptPath: requested,
        cause,
      }),
  });

  // Realpath the FILE itself (not just its directory): a symlink named
  // like a script inside a contained directory must not escape.
  const resolved = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(requested),
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({
        reason: "not-found",
        scriptPath: requested,
        cause,
      }),
  });

  if (resolved !== root && !resolved.startsWith(`${root}${NodePath.sep}`)) {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: "outside-root",
      scriptPath: resolved,
    });
  }
  if (NodePath.extname(resolved) !== ".js") {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: "not-js",
      scriptPath: resolved,
    });
  }

  // TOCTOU-safe read (review finding): open FIRST, then verify what was
  // actually opened via the file descriptor. Re-checking the path after
  // open would race against a swap; fstat on the handle cannot. The two
  // containment checks fail with their own tagged reasons (not manufactured
  // Errors folded into read-failed); "read-failed" is reserved for genuine
  // platform failures with the real cause attached.
  const read = yield* Effect.tryPromise({
    try: async () => {
      const handle = await NodeFSP.open(resolved, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          return { failure: "not-regular-file" as const };
        }
        // The opened inode must be the same one realpath resolved to: a
        // process swapping the path between realpath and open changes the
        // inode, which this comparison catches.
        const pathStat = await NodeFSP.lstat(resolved);
        if (stat.ino !== pathStat.ino || stat.dev !== pathStat.dev) {
          return { failure: "changed-during-read" as const };
        }
        const truncated = stat.size > SCRIPT_BYTE_CAP;
        const buffer = Buffer.alloc(Math.min(stat.size, SCRIPT_BYTE_CAP));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return {
          contents: buffer.subarray(0, bytesRead).toString("utf8"),
          truncated,
        };
      } finally {
        await handle.close();
      }
    },
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({
        reason: "read-failed",
        scriptPath: resolved,
        cause,
      }),
  });
  if ("failure" in read) {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: read.failure,
      scriptPath: resolved,
    });
  }

  return {
    scriptPath: resolved,
    contents: read.contents,
    truncated: read.truncated,
  };
});

/**
 * The exact source a T3 workflow run used, for Copy script and Download.
 * `threadId` is the run's coordinator thread; the file name comes from the
 * script's name.
 */
export const readWorkflowRunScript = Effect.fn("orchestration.readWorkflowRunScript")(function* (
  threadId: ThreadId,
) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const sources = yield* WorkflowSourceStore.WorkflowSourceStore;
  const notFound = (cause?: unknown) =>
    new OrchestrationGetWorkflowScriptError({
      reason: "not-found",
      scriptPath: threadId,
      ...(cause === undefined ? {} : { cause }),
    });
  const records = yield* threads
    .getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] })
    .pipe(Effect.mapError(notFound));
  const first = records.messages
    .filter((message) => message.role === "user")
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
    )[0];
  const invocation = first === undefined ? Option.none() : parseWorkflowInvocation(first.text);
  if (Option.isNone(invocation)) return yield* notFound();
  const source = yield* sources.get(invocation.value.sourceHash).pipe(Effect.mapError(notFound));
  if (Option.isNone(source)) return yield* notFound();
  const fileName = invocation.value.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return {
    scriptPath: `${fileName || "workflow"}.workflow.js`,
    contents: source.value,
    truncated: false,
  };
});
