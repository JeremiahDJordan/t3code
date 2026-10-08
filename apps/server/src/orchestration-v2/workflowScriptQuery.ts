import { OrchestrationGetWorkflowScriptError, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { parseWorkflowInvocation } from "../workflow/WorkflowInvocation.ts";
import * as WorkflowSourceStore from "../workflow/WorkflowSourceStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { readContainedWorkflowFile } from "./workflowFileRead.ts";

export const readWorkflowScript = Effect.fn("orchestration.readWorkflowScript")(function* (input: {
  readonly scriptPath: string;
}) {
  const file = yield* readContainedWorkflowFile({
    path: input.scriptPath,
    extension: ".js",
    byteCap: 256 * 1024,
  }).pipe(
    Effect.mapError(
      (error) =>
        new OrchestrationGetWorkflowScriptError({
          reason: error.reason === "wrong-extension" ? "not-js" : error.reason,
          scriptPath: error.path,
          cause: error,
        }),
    ),
  );
  return { scriptPath: file.path, contents: file.contents, truncated: file.truncated };
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
