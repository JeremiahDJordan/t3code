/**
 * What this server sends T3 Code clients built without Bob support, such as the App Store
 * app and app.t3.codes, and what it keeps when they write settings. This fork's clients
 * announce Bob support on their connection (`clientBobSupport=1`) and get every response
 * unchanged.
 *
 * Upstream clients skip unknown usage providers on decode, so usage needs no adaptation. Three
 * things still do: the onboarding scan names its sources in a closed list, so a candidate
 * naming `bob` fails the whole scan; a client writes a project's whole settings row from a copy
 * that lacks this fork's keys; and an approval's rule choices need option ids those clients
 * neither show apart nor send.
 *
 * @module upstreamClientCompatibility
 */
import type {
  AgentSessionScanResult,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2TurnItem,
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

/**
 * An approval an upstream client can answer as labelled. Those clients key an approval's buttons
 * by decision and answer without an option id, so T3's rule choices, several "Always allow"
 * options told apart only by id, would show as clashing buttons that each approve once. They get
 * the provider's own answers only.
 */
export function turnItemForUpstreamClient(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "approval_request" || item.options === undefined) return item;
  if (!item.options.some((option) => option.optionId !== undefined)) return item;
  return { ...item, options: item.options.filter((option) => option.optionId === undefined) };
}

/** A thread's projection with every turn item adapted for an upstream client. */
export function threadProjectionForUpstreamClient(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  return {
    ...projection,
    turnItems: projection.turnItems.map(turnItemForUpstreamClient),
    visibleTurnItems: projection.visibleTurnItems.map((row) => ({
      ...row,
      item: turnItemForUpstreamClient(row.item),
    })),
  };
}

/** A thread subscription's snapshot or event, adapted for an upstream client. */
export function threadStreamItemForUpstreamClient(
  item: OrchestrationV2ThreadStreamItem,
): OrchestrationV2ThreadStreamItem {
  if (item.kind === "snapshot") {
    return { ...item, projection: threadProjectionForUpstreamClient(item.projection) };
  }
  if (item.kind !== "event") return item;
  const payload = item.event.payload;
  if (item.event.type !== "turn-item.updated" || !isApprovalRequest(payload)) return item;
  return { ...item, event: { ...item.event, payload: turnItemForUpstreamClient(payload) } };
}

function isApprovalRequest(
  value: unknown,
): value is Extract<OrchestrationV2TurnItem, { readonly type: "approval_request" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "approval_request"
  );
}
