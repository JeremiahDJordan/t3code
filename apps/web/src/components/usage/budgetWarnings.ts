import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { formatUsageCredits } from "@t3tools/shared/usageFormat";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { formatUpcomingTimestamp } from "../../timestampFormat";

/** The shares of a budget used at which T3 warns, highest first. */
const BUDGET_WARNING_THRESHOLDS = [95, 80] as const;

export interface BudgetWarning {
  /** Names the account, window, budget period and threshold, so each warns once. */
  readonly key: string;
  readonly providerName: string;
  readonly window: ServerProviderUsageWindow & {
    readonly amount: NonNullable<ServerProviderUsageWindow["amount"]>;
  };
}

/**
 * The budgets past a warning threshold: windows that report amounts, such as Bob's monthly
 * Bobcoins, in each provider's limits and in each folder's own. Where several environments or
 * folders report one account's budget, the freshest read decides, as Usage → Limits does, so a
 * budget raised since an older read does not warn. A read from a period that reset by `now`
 * warns of nothing.
 */
export function collectBudgetWarnings(
  presentations: LimitPresentations,
  now: number,
): ReadonlyArray<BudgetWarning> {
  const budgets = new Map<
    string,
    { readonly checkedAt: number; readonly warning: Omit<BudgetWarning, "key"> }
  >();
  for (const [environmentId, presentation] of presentations) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      const reports = [
        provider.usageLimits,
        ...(provider.workspaceSnapshots ?? []).map((snapshot) => snapshot.usageLimits),
      ];
      for (const limits of reports) {
        if (limits === undefined) continue;
        const checkedAt = Date.parse(limits.checkedAt);
        const account = limits.credentialFingerprint ?? `${environmentId}:${provider.instanceId}`;
        for (const window of limits.windows) {
          const amount = window.amount;
          if (amount === undefined) continue;
          if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now) continue;
          const budget = `${account}:${window.id}:${window.resetsAt ?? ""}`;
          const known = budgets.get(budget);
          if (known !== undefined && known.checkedAt >= checkedAt) continue;
          budgets.set(budget, {
            checkedAt,
            warning: {
              providerName: provider.displayName ?? provider.driver,
              window: { ...window, amount },
            },
          });
        }
      }
    }
  }
  return [...budgets].flatMap(([budget, { warning }]) => {
    const threshold = BUDGET_WARNING_THRESHOLDS.find(
      (share) => warning.window.usedPercent >= share,
    );
    return threshold === undefined ? [] : [{ ...warning, key: `${budget}:${threshold}` }];
  });
}

/** What a warning says: how much of the budget is used, what is left, and when it resets. */
export function budgetWarningText(
  warning: BudgetWarning,
  timestampFormat: TimestampFormat,
  now: number,
): { readonly title: string; readonly body: string } {
  const { window } = warning;
  const unit = window.amount.unit;
  const left = Math.max(0, window.amount.limit - window.amount.used);
  return {
    title: `${warning.providerName} has used ${Math.floor(window.usedPercent)}% of its ${window.label.toLowerCase()} ${unit}`,
    body: `${formatUsageCredits(left)} of ${formatUsageCredits(window.amount.limit)} ${unit} left${
      window.resetsAt
        ? ` · resets ${formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}`
        : ""
    }`,
  };
}

const BUDGET_WARNINGS_STORAGE_KEY = "t3code:budget-warnings:v1";
/** Enough for every budget's thresholds over a few periods; older keys fall off. */
const MAX_REMEMBERED_WARNINGS = 100;
const BudgetWarningsSchema = Schema.Struct({ keys: Schema.Array(Schema.String) });
/** For when this device cannot store them, so a warning still shows once per load. */
const warnedThisLoad = new Set<string>();

function readWarned(): ReadonlyArray<string> {
  try {
    return getLocalStorageItem(BUDGET_WARNINGS_STORAGE_KEY, BudgetWarningsSchema)?.keys ?? [];
  } catch {
    return [];
  }
}

/** The warnings this device has not shown yet, which are then remembered as shown. */
export function takeUnshownBudgetWarnings(
  warnings: ReadonlyArray<BudgetWarning>,
): ReadonlyArray<BudgetWarning> {
  const warned = new Set([...readWarned(), ...warnedThisLoad]);
  const unshown = warnings.filter((warning) => !warned.has(warning.key));
  if (unshown.length === 0) return unshown;
  for (const warning of unshown) warnedThisLoad.add(warning.key);
  try {
    setLocalStorageItem(
      BUDGET_WARNINGS_STORAGE_KEY,
      {
        keys: [...readWarned(), ...unshown.map((warning) => warning.key)].slice(
          -MAX_REMEMBERED_WARNINGS,
        ),
      },
      BudgetWarningsSchema,
    );
  } catch {
    // Storage is unavailable; `warnedThisLoad` still holds them for this load.
  }
  return unshown;
}
