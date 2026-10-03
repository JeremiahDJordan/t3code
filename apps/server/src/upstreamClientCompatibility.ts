/**
 * What this server sends T3 Code clients built without Bob support, such as the App Store
 * app and app.t3.codes, and what it keeps when they write settings. This fork's clients
 * announce Bob support on their connection (`clientBobSupport=1`) and get every response
 * unchanged.
 *
 * Upstream clients skip unknown usage providers on decode, so usage needs no adaptation. Two
 * things still do: the onboarding scan names its sources in a closed list, so a candidate
 * naming `bob` fails the whole scan, and a client writes a project's whole settings row from a
 * copy that lacks this fork's keys.
 *
 * @module upstreamClientCompatibility
 */
import type {
  AgentSessionScanResult,
  ProjectScopedServerSettingKey,
  ProjectSettingsOverrides,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Struct from "effect/Struct";

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
  "checkInRepeatLimitHours",
] as const satisfies ReadonlyArray<ProjectScopedServerSettingKey>;

/**
 * A settings patch from an upstream client, with each project row it writes or resets keeping
 * that row's fork settings. Upstream clients send a project's whole row from a copy without
 * them, and the server replaces the row, which would turn a project's check-ins back on.
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
