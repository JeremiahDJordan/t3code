/**
 * Binds a script's roles to this environment's provider instances. A role
 * names a driver and model, or inherits the starting agent's selection; it
 * never names an instance, so the same file binds on any machine.
 */
import {
  ProviderDriverKind,
  type ModelSelection,
  type OrchestratorMcpWorkflowModelRef,
  type OrchestratorMcpWorkflowRole,
  type OrchestratorMcpWorkflowRoleBinding,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";

import type { WorkflowRoleBinding } from "./WorkflowInvocation.ts";
import { claudeModelRole, type WorkflowMeta, type WorkflowRoleRequest } from "./WorkflowScript.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_TIERS = new Set(["opus", "sonnet", "haiku"]);

export interface WorkflowRoleParent {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface WorkflowRoleBindingResult {
  readonly report: ReadonlyArray<OrchestratorMcpWorkflowRole>;
  readonly bindings: Readonly<Record<string, WorkflowRoleBinding>>;
  readonly defaultRole: WorkflowRoleBinding;
  /** Roles asking for modes broader than the starting thread's. */
  readonly modeProblems: ReadonlyArray<{
    readonly role: string;
    readonly mode: "runtime" | "interaction";
    readonly message: string;
  }>;
}

const runtimeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const interactionRank = (mode: ProviderInteractionMode) => (mode === "plan" ? 0 : 1);

/**
 * A binding narrowed to `limit`, the coordinator's modes for this turn: its
 * user can narrow them after the run started, and agents started since never
 * run broader.
 */
export function clampWorkflowRoleBinding(
  binding: WorkflowRoleBinding,
  limit: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
): WorkflowRoleBinding {
  const runtimeMode =
    runtimeRank[binding.runtimeMode] > runtimeRank[limit.runtimeMode]
      ? limit.runtimeMode
      : binding.runtimeMode;
  const interactionMode =
    interactionRank(binding.interactionMode) > interactionRank(limit.interactionMode)
      ? limit.interactionMode
      : binding.interactionMode;
  return runtimeMode === binding.runtimeMode && interactionMode === binding.interactionMode
    ? binding
    : { ...binding, runtimeMode, interactionMode };
}

function modelRefs(
  providers: ReadonlyArray<ServerProvider>,
): Array<OrchestratorMcpWorkflowModelRef> {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({
      providerInstanceId: provider.instanceId,
      driverKind: provider.driver,
      model: model.slug,
    })),
  );
}

/** The select option `effort` maps to: one whose id names effort. */
function effortOption(provider: ServerProvider, model: string): WorkflowRoleBinding["effort"] {
  const descriptor = provider.models
    .find((candidate) => candidate.slug === model)
    ?.capabilities?.optionDescriptors?.find(
      (option) => option.type === "select" && /effort/i.test(option.id),
    );
  return descriptor?.type === "select"
    ? { optionId: descriptor.id, values: descriptor.options.map((option) => option.id) }
    : undefined;
}

function optionSelections(
  options:
    | Readonly<Record<string, string | boolean>>
    | ReadonlyArray<ProviderOptionSelection>
    | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (options === undefined) return undefined;
  if (Array.isArray(options)) return options as ReadonlyArray<ProviderOptionSelection>;
  const entries = Object.entries(options as Readonly<Record<string, string | boolean>>);
  return entries.length === 0 ? undefined : entries.map(([id, value]) => ({ id, value }));
}

/**
 * Binds every role the script names: the T3 dialect's `meta.roles`, or each
 * model a Claude script's `agent()` calls ask for.
 */
export function bindWorkflowRoles(input: {
  readonly meta: WorkflowMeta;
  /** Models a Claude script's calls name. */
  readonly claudeModels: ReadonlyArray<string>;
  /** Instances that can run a child task right now. */
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly parent: WorkflowRoleParent;
  readonly explicit: Readonly<Record<string, OrchestratorMcpWorkflowRoleBinding>>;
  readonly unboundRoles: "fail" | "inherit";
}): WorkflowRoleBindingResult {
  const parentProvider = input.providers.find(
    (provider) => provider.instanceId === input.parent.modelSelection.instanceId,
  );
  const binding = (
    provider: ServerProvider | undefined,
    modelSelection: ModelSelection,
    modes: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
  ): WorkflowRoleBinding => {
    const effort =
      provider === undefined ? undefined : effortOption(provider, modelSelection.model);
    return {
      modelSelection,
      driver: provider?.driver ?? ProviderDriverKind.make(modelSelection.instanceId),
      runtimeMode: modes.runtimeMode,
      interactionMode: modes.interactionMode,
      // A provider that cannot honor plan mode can still edit, so it counts as a writer.
      writer: modes.interactionMode !== "plan" || provider?.showInteractionModeToggle !== true,
      ...(effort === undefined ? {} : { effort }),
    };
  };
  const defaultRole = binding(parentProvider, input.parent.modelSelection, input.parent);
  // A plan-mode thread cannot edit files unless its own provider has no plan
  // mode, so its roles may not run on a provider without one: they would edit.
  const parentCanEdit =
    input.parent.interactionMode !== "plan" || parentProvider?.showInteractionModeToggle === false;
  const planCapable = input.providers.filter(
    (provider) => provider.showInteractionModeToggle !== false,
  );

  const requests: Array<{ readonly role: string; readonly request: WorkflowRoleRequest }> =
    input.meta.dialect === "t3"
      ? Object.entries(input.meta.roles).map(([role, request]) => ({ role, request }))
      : input.claudeModels.map((model) => ({
          role: claudeModelRole(model),
          request: { driver: CLAUDE_DRIVER, model },
        }));

  const report: Array<OrchestratorMcpWorkflowRole> = [];
  const bindings: Record<string, WorkflowRoleBinding> = {};
  const modeProblems: Array<WorkflowRoleBindingResult["modeProblems"][number]> = [];

  for (const { role, request } of requests) {
    const modes = {
      runtimeMode: request.runtimeMode ?? input.parent.runtimeMode,
      interactionMode: request.interactionMode ?? input.parent.interactionMode,
    };
    if (runtimeRank[modes.runtimeMode] > runtimeRank[input.parent.runtimeMode]) {
      modeProblems.push({
        role,
        mode: "runtime",
        message: `Role ${role} asks for runtime mode ${modes.runtimeMode}, broader than this thread's ${input.parent.runtimeMode}.`,
      });
    }
    if (interactionRank(modes.interactionMode) > interactionRank(input.parent.interactionMode)) {
      modeProblems.push({
        role,
        mode: "interaction",
        message: `Role ${role} asks for interaction mode ${modes.interactionMode}, broader than this thread's ${input.parent.interactionMode}.`,
      });
    }
    const requested =
      "inherit" in request
        ? "inherit"
        : [request.driver, request.model].filter((part) => part !== undefined).join(" ");

    const record = (provider: ServerProvider | undefined, selection: ModelSelection) => {
      const value = binding(provider, selection, modes);
      bindings[role] = value;
      report.push({
        role,
        requested,
        bound: {
          providerInstanceId: selection.instanceId,
          driverKind: value.driver,
          model: selection.model,
          runtimeMode: value.runtimeMode,
          interactionMode: value.interactionMode,
          writer: value.writer,
        },
        reason: null,
        candidates: [],
      });
    };
    const unbound = (
      reason: string,
      candidates: ReadonlyArray<OrchestratorMcpWorkflowModelRef>,
    ) => {
      // The thread's own selection is never broader than the thread.
      if (input.unboundRoles === "inherit") {
        record(parentProvider, input.parent.modelSelection);
        return;
      }
      report.push({ role, requested, bound: null, reason, candidates: [...candidates] });
    };
    const bound = (provider: ServerProvider, selection: ModelSelection) => {
      if (
        !parentCanEdit &&
        modes.interactionMode === "plan" &&
        provider.showInteractionModeToggle === false
      ) {
        unbound(
          `This thread is in plan mode, and ${provider.instanceId} has no plan mode, so role ${role} would edit files there. Bind it to a provider with plan mode.`,
          modelRefs(planCapable),
        );
        return;
      }
      record(provider, selection);
    };

    const explicit = input.explicit[role];
    if (explicit !== undefined) {
      const provider = input.providers.find(
        (candidate) => candidate.instanceId === explicit.providerInstanceId,
      );
      const model = explicit.model ?? provider?.models[0]?.slug;
      if (provider === undefined || model === undefined) {
        unbound(
          `Provider instance ${explicit.providerInstanceId} cannot run a child task here.`,
          modelRefs(input.providers),
        );
        continue;
      }
      if (provider.models.length > 0 && !provider.models.some((entry) => entry.slug === model)) {
        unbound(
          `Model ${model} is not advertised by ${provider.instanceId}.`,
          modelRefs([provider]),
        );
        continue;
      }
      const options = optionSelections(explicit.options);
      bound(provider, {
        instanceId: provider.instanceId,
        model,
        ...(options === undefined ? {} : { options }),
      });
      continue;
    }
    if ("inherit" in request) {
      record(parentProvider, input.parent.modelSelection);
      continue;
    }

    const driverProviders = input.providers.filter(
      (provider) => provider.driver === request.driver,
    );
    if (driverProviders.length === 0) {
      unbound(`No ${request.driver} provider can run here.`, modelRefs(input.providers));
      continue;
    }
    // The starting agent's instance wins a tie, then the first usable one.
    const ordered = [
      ...driverProviders.filter((provider) => provider === parentProvider),
      ...driverProviders.filter((provider) => provider !== parentProvider),
    ];
    const tier =
      input.meta.dialect === "claude" &&
      request.model !== undefined &&
      CLAUDE_TIERS.has(request.model)
        ? request.model
        : undefined;
    const match = ordered
      .map((provider) => {
        if (request.model === undefined) {
          const model =
            provider === parentProvider
              ? input.parent.modelSelection.model
              : provider.models[0]?.slug;
          return model === undefined ? undefined : { provider, model };
        }
        const model =
          tier !== undefined
            ? provider.models.find((entry) => entry.slug.toLowerCase().includes(tier))?.slug
            : provider.models.find((entry) => entry.slug === request.model)?.slug;
        return model === undefined ? undefined : { provider, model };
      })
      .find((candidate) => candidate !== undefined);
    if (match === undefined) {
      unbound(
        `No ${request.driver} provider here offers ${request.model ?? "a model"}.`,
        modelRefs(driverProviders),
      );
      continue;
    }
    const options = optionSelections("options" in request ? request.options : undefined);
    bound(match.provider, {
      instanceId: match.provider.instanceId,
      model: match.model,
      ...(options === undefined ? {} : { options }),
    });
  }
  return { report, bindings, defaultRole, modeProblems };
}
