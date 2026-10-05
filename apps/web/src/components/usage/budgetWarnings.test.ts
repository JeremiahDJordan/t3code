import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  budgetWarningText,
  collectBudgetWarnings,
  takeUnshownBudgetWarnings,
} from "./budgetWarnings";

const RESETS_AT = "2026-11-01T00:00:00.000Z";
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const collect = (presentations: LimitPresentations) => collectBudgetWarnings(presentations, NOW);

function limits(used: number, fingerprint?: string): ServerProviderUsageLimits {
  return {
    checkedAt: "2026-10-05T12:00:00.000Z",
    windows: [
      {
        id: "monthly",
        kind: "monthly",
        label: "Monthly",
        usedPercent: used,
        resetsAt: RESETS_AT,
        amount: { used, limit: 100, unit: "Bobcoins" },
      },
    ],
    ...(fingerprint ? { credentialFingerprint: fingerprint } : {}),
  };
}

function bob(usageLimits: ServerProviderUsageLimits, extra: Partial<ServerProvider> = {}) {
  return {
    instanceId: ProviderInstanceId.make("bob"),
    driver: ProviderDriverKind.make("bob"),
    displayName: "Bob",
    usageLimits,
    ...extra,
  } as ServerProvider;
}

function presentations(
  ...environments: ReadonlyArray<ReadonlyArray<ServerProvider>>
): LimitPresentations {
  return new Map(
    environments.map((providers, index) => [
      EnvironmentId.make(`environment-${index}`),
      { entry: { target: { label: `Machine ${index}` } }, serverConfig: { providers } },
    ]),
  );
}

describe("collectBudgetWarnings", () => {
  it("warns at 80% and 95% used, once at the highest share reached", () => {
    expect(collect(presentations([bob(limits(79))]))).toEqual([]);
    expect(collect(presentations([bob(limits(80))])).map((w) => w.key)).toEqual([
      `environment-0:bob:monthly:${RESETS_AT}:80`,
    ]);
    expect(collect(presentations([bob(limits(97))])).map((w) => w.key)).toEqual([
      `environment-0:bob:monthly:${RESETS_AT}:95`,
    ]);
  });

  it("warns once for a team that several environments or folders report", () => {
    const team = limits(85, "team-a");
    const warnings = collect(
      presentations(
        [bob(team, { workspaceSnapshots: [{ cwd: "/repo", usageLimits: team }] as never })],
        [bob(team)],
      ),
    );
    expect(warnings.map((warning) => warning.key)).toEqual([`team-a:monthly:${RESETS_AT}:80`]);
  });

  it("warns for a folder's own team past a threshold", () => {
    const warnings = collect(
      presentations([
        bob(limits(10, "team-a"), {
          workspaceSnapshots: [{ cwd: "/repo", usageLimits: limits(96, "team-b") }] as never,
        }),
      ]),
    );
    expect(warnings.map((warning) => warning.key)).toEqual([`team-b:monthly:${RESETS_AT}:95`]);
  });

  it("lets an account's freshest read decide, as after a raised budget", () => {
    const at = (checkedAt: string, used: number, limit: number) => ({
      ...limits(used, "team-a"),
      checkedAt,
      windows: [
        {
          ...limits(used).windows[0]!,
          usedPercent: (used / limit) * 100,
          amount: { used, limit, unit: "Bobcoins" },
        },
      ],
    });
    // An older read at 80 of 100 next to a newer one at 80 of 200.
    const stale = at("2026-10-05T10:00:00.000Z", 80, 100);
    const fresh = at("2026-10-05T12:00:00.000Z", 80, 200);
    expect(collect(presentations([bob(stale)], [bob(fresh)]))).toEqual([]);
    expect(collect(presentations([bob(fresh)], [bob(stale)]))).toEqual([]);
    // Over 95% in the newer read warns once, at 95.
    const higher = at("2026-10-05T12:00:00.000Z", 96, 100);
    expect(collect(presentations([bob(stale)], [bob(higher)])).map((w) => w.key)).toEqual([
      `team-a:monthly:${RESETS_AT}:95`,
    ]);
  });

  it("warns of nothing from a read whose period already reset", () => {
    expect(
      collectBudgetWarnings(presentations([bob(limits(96))]), Date.parse(RESETS_AT) + 1),
    ).toEqual([]);
  });

  it("ignores windows without amounts", () => {
    const percentOnly = limits(99);
    const { amount: _amount, ...window } = percentOnly.windows[0]!;
    expect(collect(presentations([bob({ ...percentOnly, windows: [window] })]))).toEqual([]);
  });
});

describe("budgetWarningText", () => {
  it("says how much is used, what is left and when it resets", () => {
    const [warning] = collect(presentations([bob(limits(82.6))]));
    const text = budgetWarningText(warning!, "24-hour", Date.parse("2026-10-05T12:00:00Z"));
    expect(text.title).toBe("Bob has used 82% of its monthly Bobcoins");
    expect(text.body).toMatch(/^17\.40? of 100(\.00)? Bobcoins left · resets /);
  });
});

describe("takeUnshownBudgetWarnings", () => {
  it("shows each warning once", () => {
    const warnings = collect(presentations([bob(limits(90, "team-once"))]));
    expect(takeUnshownBudgetWarnings(warnings)).toHaveLength(1);
    expect(takeUnshownBudgetWarnings(warnings)).toHaveLength(0);
  });
});
