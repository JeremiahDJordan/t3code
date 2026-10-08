import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { bindWorkflowRoles } from "./WorkflowRoles.ts";
import type { WorkflowMeta } from "./WorkflowScript.ts";

function provider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly models: ReadonlyArray<string>;
  readonly planMode?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-07T00:00:00.000Z",
    showInteractionModeToggle: input.planMode ?? true,
    models: input.models.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities:
        slug === "gpt-6.1-sol"
          ? {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Effort",
                  type: "select",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            }
          : null,
    })),
    slashCommands: [],
    skills: [],
  };
}

const codex = provider({ instanceId: "codex", driver: "codex", models: ["gpt-6.1-sol", "gpt-6"] });
const claude = provider({
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"],
});
const bob = provider({ instanceId: "bob", driver: "bob", models: ["bob-1"], planMode: false });

const parent = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

function t3Meta(roles: WorkflowMeta["roles"]): WorkflowMeta {
  return {
    dialect: "t3",
    name: "review",
    description: "",
    argsSchema: null,
    roles,
    limits: {},
    phases: [],
  };
}

describe("bindWorkflowRoles", () => {
  it("binds exact, driver-only and inherited roles, and notes writers and effort", () => {
    const result = bindWorkflowRoles({
      meta: t3Meta({
        reviewer: {
          driver: ProviderDriverKind.make("codex"),
          model: "gpt-6.1-sol",
          interactionMode: "plan",
        },
        judge: { driver: ProviderDriverKind.make("claudeAgent") },
        fixer: { inherit: true },
      }),
      claudeModels: [],
      providers: [codex, claude],
      parent,
      explicit: {},
      unboundRoles: "fail",
    });
    expect(result.modeProblems).toEqual([]);
    expect(result.bindings.reviewer).toMatchObject({
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      interactionMode: "plan",
      writer: false,
      effort: { optionId: "reasoningEffort", values: ["low", "high"] },
    });
    expect(result.bindings.judge?.modelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
    expect(result.bindings.fixer).toMatchObject({
      modelSelection: parent.modelSelection,
      runtimeMode: "full-access",
      writer: true,
    });
    expect(result.defaultRole.modelSelection).toEqual(parent.modelSelection);
  });

  it("leaves a missing model or driver unbound with candidates, unless told to inherit", () => {
    const meta = t3Meta({
      reviewer: { driver: ProviderDriverKind.make("codex"), model: "gpt-9" },
      judge: { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" },
    });
    const failing = bindWorkflowRoles({
      meta,
      claudeModels: [],
      providers: [codex],
      parent,
      explicit: {},
      unboundRoles: "fail",
    });
    const reviewer = failing.report.find((role) => role.role === "reviewer")!;
    expect(reviewer.bound).toBeNull();
    expect(reviewer.candidates.map((candidate) => candidate.model)).toEqual([
      "gpt-6.1-sol",
      "gpt-6",
    ]);
    const judge = failing.report.find((role) => role.role === "judge")!;
    expect(judge.reason).toContain("No claudeAgent provider");
    expect(judge.candidates.map((candidate) => candidate.providerInstanceId)).toEqual([
      "codex",
      "codex",
    ]);
    expect(failing.bindings).toEqual({});

    const inheriting = bindWorkflowRoles({
      meta,
      claudeModels: [],
      providers: [codex],
      parent,
      explicit: {},
      unboundRoles: "inherit",
    });
    expect(inheriting.bindings.judge?.modelSelection).toEqual(parent.modelSelection);
    expect(inheriting.report.every((role) => role.bound !== null)).toBe(true);
  });

  it("takes explicit bindings over the script's request", () => {
    const result = bindWorkflowRoles({
      meta: t3Meta({
        judge: { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" },
      }),
      claudeModels: [],
      providers: [codex, bob],
      parent,
      explicit: {
        judge: { providerInstanceId: ProviderInstanceId.make("bob"), model: "bob-1" },
      },
      unboundRoles: "fail",
    });
    expect(result.bindings.judge).toMatchObject({
      modelSelection: { instanceId: "bob", model: "bob-1" },
      driver: "bob",
    });
  });

  it("refuses a role broader than the starting thread's modes", () => {
    const result = bindWorkflowRoles({
      meta: t3Meta({ fixer: { inherit: true, interactionMode: "default" } }),
      claudeModels: [],
      providers: [codex],
      parent: { ...parent, runtimeMode: "approval-required", interactionMode: "plan" },
      explicit: {},
      unboundRoles: "fail",
    });
    expect(result.modeProblems).toEqual([
      expect.objectContaining({ role: "fixer", mode: "interaction" }),
    ]);
  });

  it("counts a plan-mode role on a provider without plan mode as a writer", () => {
    const result = bindWorkflowRoles({
      meta: t3Meta({ reviewer: { inherit: true, interactionMode: "plan" } }),
      claudeModels: [],
      providers: [bob],
      parent: {
        ...parent,
        modelSelection: { instanceId: ProviderInstanceId.make("bob"), model: "bob-1" },
      },
      explicit: {},
      unboundRoles: "fail",
    });
    expect(result.bindings.reviewer?.writer).toBe(true);
  });

  it("leaves a plan-mode thread's role on a provider without plan mode unbound", () => {
    const meta = t3Meta({
      reviewer: { driver: ProviderDriverKind.make("bob") },
      judge: { driver: ProviderDriverKind.make("codex") },
    });
    const planParent = { ...parent, interactionMode: "plan" } as const;
    const result = bindWorkflowRoles({
      meta,
      claudeModels: [],
      providers: [codex, bob],
      parent: planParent,
      explicit: {},
      unboundRoles: "fail",
    });
    expect(result.modeProblems).toEqual([]);
    const reviewer = result.report.find((role) => role.role === "reviewer")!;
    expect(reviewer.bound).toBeNull();
    expect(reviewer.reason).toContain("bob has no plan mode");
    expect(reviewer.candidates.every((candidate) => candidate.providerInstanceId === "codex")).toBe(
      true,
    );
    expect(result.bindings.judge).toMatchObject({ interactionMode: "plan", writer: false });

    // An explicit binding is held to the same rule; inheriting runs it on the thread's model.
    const explicit = bindWorkflowRoles({
      meta,
      claudeModels: [],
      providers: [codex, bob],
      parent: planParent,
      explicit: { judge: { providerInstanceId: ProviderInstanceId.make("bob"), model: "bob-1" } },
      unboundRoles: "inherit",
    });
    expect(explicit.bindings.judge?.modelSelection).toEqual(parent.modelSelection);
    expect(explicit.bindings.reviewer?.modelSelection).toEqual(parent.modelSelection);

    // A thread whose own provider has no plan mode already edits, so its roles may too.
    const onBob = bindWorkflowRoles({
      meta,
      claudeModels: [],
      providers: [codex, bob],
      parent: {
        ...planParent,
        modelSelection: { instanceId: ProviderInstanceId.make("bob"), model: "bob-1" },
      },
      explicit: {},
      unboundRoles: "fail",
    });
    expect(onBob.bindings.reviewer).toMatchObject({ interactionMode: "plan", writer: true });
  });

  it("binds a Claude script's model tiers to the current model of each tier", () => {
    const result = bindWorkflowRoles({
      meta: { ...t3Meta({}), dialect: "claude" },
      claudeModels: ["haiku", "sonnet"],
      providers: [codex, claude],
      parent,
      explicit: {},
      unboundRoles: "fail",
    });
    expect(result.bindings["model:haiku"]?.modelSelection.model).toBe("claude-haiku-4-5");
    expect(result.bindings["model:sonnet"]?.modelSelection.model).toBe("claude-sonnet-5-5");
  });
});
