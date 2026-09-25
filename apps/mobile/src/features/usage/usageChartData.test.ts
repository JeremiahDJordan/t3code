import { describe, expect, it, vi } from "vite-plus/test";

import { buildChartDays } from "./usageChartData";

// The color hook's provider imports React Native, which these pure helpers never call.
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));

const daily = [
  {
    day: "2026-08-01",
    costUsd: 10,
    totalTokens: 400,
    byProvider: new Map([
      ["codex" as const, { costUsd: 10, totalTokens: 100 }],
      [
        "bob" as const,
        { costUsd: 0, totalTokens: 300, credits: { amount: 12.3, unit: "Bobcoins" } },
      ],
    ]),
  },
];

describe("buildChartDays", () => {
  it("stacks Bob's tokens but keeps its Bobcoins off the dollar bars", () => {
    const [tokens] = buildChartDays(["2026-08-01"], daily, "tokens");
    const [cost] = buildChartDays(["2026-08-01"], daily, "cost");

    expect(tokens?.values.find((entry) => entry.provider === "bob")?.value).toBe(300);
    expect(tokens?.values.at(-1)?.provider).toBe("bob");
    expect(tokens?.total).toBe(400);
    expect(cost?.values.find((entry) => entry.provider === "bob")?.value).toBe(0);
    expect(cost?.total).toBe(10);
  });
});
