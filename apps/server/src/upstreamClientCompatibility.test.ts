import {
  type AgentSessionScanResult,
  AgentSessionScanResult as AgentSessionScanResultSchema,
  AgentSessionProjectCandidate,
  DEFAULT_SERVER_SETTINGS,
  ForwardCompatibleArray,
  ProjectId,
  ProjectSettingsOverrides,
  type ServerSettings,
  type ServerSettingsPatch,
  USAGE_CONTRACT_VERSION,
  UsageBucket,
  type UsageDay,
  UsageProviderKind,
  UsageSource,
  UsageSourceFingerprint,
  UsageSummary,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { describe, expect, it } from "vite-plus/test";

import {
  agentSessionScanForUpstreamClient,
  FORK_PROJECT_SETTING_KEYS,
  settingsPatchFromUpstreamClient,
} from "./upstreamClientCompatibility.ts";

/** Sources and providers as upstream clients decode them: their lists end before Bob. */
const UpstreamUsageProvider = Schema.Literals(
  UsageProviderKind.literals.filter((provider) => provider !== "bob"),
);
const UpstreamAgentSessionSource = Schema.Literals(["claudeAgent", "codex"]);

/** A usage summary as upstream clients decode it, with forward-compatible bucket and source lists. */
const decodeUsageInUpstreamClient = Schema.decodeUnknownExit(
  Schema.Struct({
    ...UsageSummary.fields,
    buckets: ForwardCompatibleArray(
      Schema.Struct({ ...UsageBucket.fields, provider: UpstreamUsageProvider }),
    ),
    sources: ForwardCompatibleArray(
      Schema.Struct({
        ...UsageSource.fields,
        fingerprint: Schema.Struct({
          ...UsageSourceFingerprint.fields,
          provider: UpstreamUsageProvider,
        }),
      }),
    ),
  }),
);
const encodeUsageSummary = Schema.encodeSync(UsageSummary);

/** An onboarding scan as upstream clients decode it: a closed list of sources. */
const decodeScanInUpstreamClient = Schema.decodeUnknownExit(
  Schema.Struct({
    ...AgentSessionScanResultSchema.fields,
    candidates: Schema.Array(
      Schema.Struct({
        ...AgentSessionProjectCandidate.fields,
        sources: Schema.Array(UpstreamAgentSessionSource),
      }),
    ),
  }),
);

describe("usage in upstream clients", () => {
  it("keeps this server's usage and skips Bob's entries without any adaptation", () => {
    const bucket = (provider: UsageProviderKind): UsageBucket => ({
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
    });
    const source = (provider: UsageProviderKind, resolvedHomePath: string): UsageSource => ({
      fingerprint: { hostId: "mac", provider, resolvedHomePath, volumeId: "vol" },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    });
    const summary: UsageSummary = {
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

    const decoded = decodeUsageInUpstreamClient(encodeUsageSummary(summary));

    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) {
      expect(decoded.value.buckets.map((entry) => entry.provider)).toEqual(["codex"]);
      expect(decoded.value.sources.map((entry) => entry.fingerprint.provider)).toEqual(["codex"]);
    }
  });
});

describe("agentSessionScanForUpstreamClient", () => {
  const decodesInUpstreamClient = (result: AgentSessionScanResult) =>
    Exit.isSuccess(decodeScanInUpstreamClient(result));

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
    const adapted = agentSessionScanForUpstreamClient(result);

    // Naming Bob fails the whole scan in an upstream client.
    expect(decodesInUpstreamClient(result)).toBe(false);
    expect(decodesInUpstreamClient(adapted)).toBe(true);
    expect(adapted.candidates.map((candidate) => [candidate.path, candidate.sources])).toEqual([
      ["/work/app", ["codex"]],
      ["/work/bob-only", []],
    ]);
  });
});

describe("settingsPatchFromUpstreamClient", () => {
  const APP = ProjectId.make("project-app");
  const OTHER = ProjectId.make("project-other");
  const forkSettings = { enableAgentCheckIns: false, checkInRepeatLimitHours: 4 } as const;
  const current: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: {
      [APP]: { defaultAutoPull: true, ...forkSettings },
      [OTHER]: { defaultAutoPull: true },
    },
  };
  /** A project's row as upstream clients decode it: their struct has no fork keys. */
  const decodeRowInUpstreamClient = Schema.decodeUnknownSync(
    Schema.Struct(Struct.omit(ProjectSettingsOverrides.fields, FORK_PROJECT_SETTING_KEYS)),
  );
  const savedByUpstreamClient = (patch: ServerSettingsPatch) =>
    applyServerSettingsPatch(current, settingsPatchFromUpstreamClient(patch, current));

  it("keeps the fork settings when an upstream client edits another setting in the row", () => {
    const patch: ServerSettingsPatch = {
      projectSettingsOverrides: {
        [APP]: {
          ...decodeRowInUpstreamClient(current.projectSettingsOverrides[APP]),
          defaultAutoPull: false,
        },
      },
    };

    // Replacing the row as sent turns the project's check-ins back on.
    expect(
      resolveProjectSettings(applyServerSettingsPatch(current, patch), APP).settings
        .enableAgentCheckIns,
    ).toBe(true);
    const saved = savedByUpstreamClient(patch);
    expect(saved.projectSettingsOverrides[APP]).toEqual({
      defaultAutoPull: false,
      ...forkSettings,
    });
    expect(resolveProjectSettings(saved, APP).settings.enableAgentCheckIns).toBe(false);
  });

  it("leaves only the fork settings when an upstream client resets the row", () => {
    const saved = savedByUpstreamClient({ projectSettingsOverrides: { [APP]: null } });

    expect(saved.projectSettingsOverrides[APP]).toEqual(forkSettings);
  });

  it("still removes a reset row that has no fork settings", () => {
    const saved = savedByUpstreamClient({ projectSettingsOverrides: { [OTHER]: null } });

    expect(saved.projectSettingsOverrides).not.toHaveProperty(OTHER);
    expect(saved.projectSettingsOverrides[APP]).toEqual({ defaultAutoPull: true, ...forkSettings });
  });

  it("passes a patch without project rows through untouched", () => {
    const patch: ServerSettingsPatch = { enableAgentCheckIns: false };

    expect(settingsPatchFromUpstreamClient(patch, current)).toBe(patch);
  });
});
