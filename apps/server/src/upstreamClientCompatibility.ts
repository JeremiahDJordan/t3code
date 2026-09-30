/**
 * What this server sends T3 Code clients built without Bob support, such as the App Store
 * app and app.t3.codes, and what it keeps when they write settings. Those clients decode
 * closed lists of providers that do not include `bob`, so a response naming it would fail
 * whole: the Usage page would drop this server, and the onboarding scan would fail. This
 * fork's clients announce Bob support on their connection (`clientBobSupport=1`) and get
 * every response unchanged.
 *
 * @module upstreamClientCompatibility
 */
import type {
  AgentSessionScanResult,
  BobUsageInUpstreamClients,
  ProjectScopedServerSettingKey,
  ProjectSettingsOverrides,
  ServerSettings,
  ServerSettingsPatch,
  UsageSummary,
} from "@t3tools/contracts";
import * as Struct from "effect/Struct";

/**
 * A usage summary an upstream client can read: Bob's entries dropped or shown as the
 * provider `bobAs` names, and no `credits`. Upstream clients show spend only in dollars, so
 * a relabeled Bob reports its Bobcoins as that provider's cost.
 */
export function usageSummaryForUpstreamClient(
  summary: UsageSummary,
  bobAs: BobUsageInUpstreamClients,
): UsageSummary {
  const provider = bobAs === "hidden" ? undefined : bobAs;
  return {
    ...summary,
    buckets: summary.buckets.flatMap(({ credits, ...bucket }) => {
      if (bucket.provider !== "bob") return [bucket];
      if (!provider) return [];
      return [
        {
          ...bucket,
          provider,
          ...(credits
            ? {
                costUsd: credits.amount,
                costSource: "providerReported" as const,
                unpricedRecords: 0,
              }
            : {}),
        },
      ];
    }),
    sources: summary.sources.flatMap((source) => {
      if (source.fingerprint.provider !== "bob") return [source];
      if (!provider) return [];
      return [{ ...source, fingerprint: { ...source.fingerprint, provider } }];
    }),
  };
}

/**
 * An onboarding scan an upstream client can read. Bob's history still imports with the
 * project; only its icon is missing from the project row.
 */
export function agentSessionScanForUpstreamClient(
  result: AgentSessionScanResult,
): AgentSessionScanResult {
  return {
    ...result,
    candidates: result.candidates.map((candidate) => ({
      ...candidate,
      sources: candidate.sources.filter((source) => source !== "bob"),
    })),
  };
}

/** This fork's project settings. Upstream clients drop them when they copy a project's row. */
export const FORK_PROJECT_SETTING_KEYS = [
  "enableAgentCheckIns",
  "enableAgentThreads",
  "checkInRepeatLimitHours",
] as const satisfies ReadonlyArray<ProjectScopedServerSettingKey>;

/**
 * A settings patch from an upstream client, with each project row it writes or resets keeping
 * that row's fork settings. Upstream clients send a project's whole row from a copy without
 * them, and the server replaces the row, which would turn a project's agent threads back on.
 */
export function settingsPatchFromUpstreamClient(
  patch: ServerSettingsPatch,
  current: Pick<ServerSettings, "projectSettingsOverrides">,
): ServerSettingsPatch {
  const rows = patch.projectSettingsOverrides;
  if (rows === undefined) return patch;
  const currentRows: Readonly<Record<string, ProjectSettingsOverrides>> =
    current.projectSettingsOverrides;
  return {
    ...patch,
    projectSettingsOverrides: Object.fromEntries(
      Object.entries(rows).map(([projectId, row]) => {
        const currentRow = currentRows[projectId];
        const kept = currentRow ? Struct.pick(currentRow, FORK_PROJECT_SETTING_KEYS) : {};
        // A reset of a row without fork settings still removes it.
        return [projectId, Object.keys(kept).length === 0 ? row : { ...kept, ...row }];
      }),
    ),
  };
}
