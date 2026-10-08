/**
 * A workflow run's invocation: the coordinator thread's first message, which
 * its engine turn reads. It names the source by hash and carries everything
 * bound when the run started, so a rerun replays the same calls.
 */
import {
  ModelSelection,
  OrchestrationV2WorkflowPhase,
  PositiveInt,
  ProviderDriverKind,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const WorkflowRoleBinding = Schema.Struct({
  modelSelection: ModelSelection,
  driver: ProviderDriverKind,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /** Writers take turns in a checkout. */
  writer: Schema.Boolean,
  /** The model option `effort` maps to, and its allowed values, when the model has one. */
  effort: Schema.optional(
    Schema.Struct({ optionId: Schema.String, values: Schema.Array(Schema.String) }),
  ),
});
export type WorkflowRoleBinding = typeof WorkflowRoleBinding.Type;

export const WorkflowInvocation = Schema.Struct({
  t3Workflow: Schema.Literal(1),
  name: Schema.String,
  dialect: Schema.Literals(["t3", "claude"]),
  sourceHash: Schema.String,
  args: Schema.Json,
  phases: Schema.Array(OrchestrationV2WorkflowPhase),
  roles: Schema.Record(Schema.String, WorkflowRoleBinding),
  /** The starting agent's selection, for calls that name no role. */
  defaultRole: WorkflowRoleBinding,
  limits: Schema.Struct({ concurrency: PositiveInt, agents: PositiveInt }),
  /** A Claude script's model only known at run time falls back to the default role. */
  unboundRolesInherit: Schema.Boolean,
});
export type WorkflowInvocation = typeof WorkflowInvocation.Type;

const InvocationJson = Schema.fromJsonString(WorkflowInvocation);
const encodeInvocation = Schema.encodeSync(InvocationJson);
const decodeInvocation = Schema.decodeUnknownOption(InvocationJson);
const FENCE = "```";

/** The coordinator's task prompt: a line for people, then the invocation. */
export function workflowInvocationMessage(invocation: WorkflowInvocation): string {
  return `Run workflow ${invocation.name}.\n\n${FENCE}json\n${encodeInvocation(invocation)}\n${FENCE}`;
}

export function parseWorkflowInvocation(text: string): Option.Option<WorkflowInvocation> {
  const start = text.indexOf(`${FENCE}json\n`);
  const end = text.lastIndexOf(`\n${FENCE}`);
  if (start === -1 || end <= start) return Option.none();
  return decodeInvocation(text.slice(start + FENCE.length + 5, end));
}
