import {
  type AgentSessionScanResult,
  type EnvironmentId,
  UPSTREAM_USAGE_PROVIDERS,
  USAGE_CONTRACT_VERSION,
  UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  UsageSource,
  UsageSourceFingerprint,
  UsageSummary,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  agentSessionScanForUpstreamClient,
  usageSummaryForUpstreamClient,
} from "./upstreamClientCompatibility.ts";

/** The summary as upstream clients decode it: their provider lists end before Bob. */
const UpstreamProvider = Schema.Literals(UPSTREAM_USAGE_PROVIDERS);
const decodeInUpstreamClient = Schema.decodeUnknownExit(
  Schema.Struct({
    ...UsageSummary.fields,
    buckets: Schema.Array(Schema.Struct({ ...UsageBucket.fields, provider: UpstreamProvider })),
    sources: Schema.Array(
      Schema.Struct({
        ...UsageSource.fields,
        fingerprint: Schema.Struct({
          ...UsageSourceFingerprint.fields,
          provider: UpstreamProvider,
        }),
      }),
    ),
  }),
);
const decodesInUpstreamClient = (summary: UsageSummary) =>
  Exit.isSuccess(decodeInUpstreamClient(summary));

function bucket(provider: UsageProviderKind, overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-09-24" as UsageDay,
    provider,
    model: provider === "bob" ? "premium-ide" : "gpt-6-astra",
    totals: {
      uncachedInputTokens: 1000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 100,
      reasoningTokens: 0,
    },
    costUsd: provider === "bob" ? 0 : 2,
    cacheSavingsUsd: 0,
    costSource: provider === "bob" ? "unpriced" : "modelPriced",
    records: 3,
    unpricedRecords: provider === "bob" ? 3 : 0,
    sessions: 1,
    ...(provider === "bob" ? { credits: { amount: 3.39, unit: "Bobcoins" } } : {}),
    ...overrides,
  };
}

/** A summary from this server, with Codex and Bob history. */
function forkSummary(): UsageSummary {
  const source = (provider: UsageProviderKind, resolvedHomePath: string) => ({
    fingerprint: { hostId: "mac", provider, resolvedHomePath, volumeId: "vol" },
    status: "ok" as const,
    scannedFiles: 1,
    skippedFiles: 0,
    malformedRecords: 0,
    distinctSessions: 1,
    message: null,
  });
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-09-25T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-09-01" as UsageDay,
    untilDay: "2026-09-30" as UsageDay,
    buckets: [bucket("codex"), bucket("bob")],
    sources: [source("codex", "/home/.codex/sessions"), source("bob", "/home/.bob/db/bob.db")],
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    scanDurationMs: 1,
  };
}

/** Totals as an upstream client computes them from this summary. */
function mergedByUpstreamClient(summary: UsageSummary) {
  return mergeUsage(
    [{ environmentId: "mac" as EnvironmentId, label: "Mac", summary }],
    USAGE_CONTRACT_VERSION,
  );
}

describe("usageSummaryForUpstreamClient", () => {
  it("leaves out Bob by default, so upstream clients keep this server's other usage", () => {
    const adapted = usageSummaryForUpstreamClient(forkSummary(), "hidden");

    // Naming Bob fails the whole summary in an upstream client.
    expect(decodesInUpstreamClient(forkSummary())).toBe(false);
    expect(decodesInUpstreamClient(adapted)).toBe(true);
    expect(adapted.sources.map((source) => source.fingerprint.provider)).toEqual(["codex"]);
    expect(mergedByUpstreamClient(adapted).providers.map((totals) => totals.provider)).toEqual([
      "codex",
    ]);
  });

  it("shows Bob as the chosen provider, with Bobcoins as its cost", () => {
    const adapted = usageSummaryForUpstreamClient(forkSummary(), "antigravity");

    expect(decodesInUpstreamClient(adapted)).toBe(true);
    for (const entry of adapted.buckets) expect(entry).not.toHaveProperty("credits");
    const bob = mergedByUpstreamClient(adapted).models.find(
      (model) => model.model === "premium-ide",
    );
    expect(bob).toMatchObject({ provider: "antigravity", costUsd: 3.39, unpricedRecords: 0 });
    expect(adapted.sources.map((source) => source.fingerprint.provider)).toEqual([
      "codex",
      "antigravity",
    ]);
  });
});

describe("agentSessionScanForUpstreamClient", () => {
  it("keeps projects with Bob history but names only the sources upstream clients know", () => {
    const result: AgentSessionScanResult = {
      scannedAt: "2026-09-25T00:00:00.000Z",
      candidates: [
        {
          path: "/work/app",
          title: "app",
          sources: ["codex", "bob"],
          threadCount: 3,
          lastActiveAt: null,
          alreadyImported: false,
        },
        {
          path: "/work/bob-only",
          title: "bob-only",
          sources: ["bob"],
          threadCount: 1,
          lastActiveAt: null,
          alreadyImported: false,
        },
      ],
    };

    expect(
      agentSessionScanForUpstreamClient(result).candidates.map((candidate) => [
        candidate.path,
        candidate.sources,
      ]),
    ).toEqual([
      ["/work/app", ["codex"]],
      ["/work/bob-only", []],
    ]);
  });
});
