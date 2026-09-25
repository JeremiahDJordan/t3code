/**
 * What this server sends T3 Code clients built without Bob support, such as the App Store
 * app and app.t3.codes. Those clients decode closed lists of providers that do not include
 * `bob`, so a response naming it would fail whole: the Usage page would drop this server,
 * and the onboarding scan would fail. This fork's clients announce Bob support on their
 * connection (`clientBobSupport=1`) and get every response unchanged.
 *
 * @module upstreamClientCompatibility
 */
import type {
  AgentSessionScanResult,
  BobUsageInUpstreamClients,
  UsageSummary,
} from "@t3tools/contracts";

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
