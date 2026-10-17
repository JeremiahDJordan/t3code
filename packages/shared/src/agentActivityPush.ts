/**
 * What a phone is shown about agent work, and when it is buzzed: the aggregate a Live Activity
 * or Android card renders, the alert rules, and the APNs and FCM payload shapes.
 *
 * Fork: moved here from `infra/relay/src/agentActivity` so the server can build pushes for the
 * owner's push gateway; the relay's modules re-export these.
 */
import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPhase,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export interface AgentActivityNotification {
  readonly title: string;
  readonly body: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly deepLink: string;
  readonly phase?: RelayAgentAwarenessPhase | undefined;
  readonly updatedAt?: string | undefined;
}

export function isTerminalPhase(state: Pick<RelayAgentActivityState, "phase">): boolean {
  return state.phase === "completed" || state.phase === "failed";
}

// Rows are only removed when their environment publishes a terminal state. An
// environment that dies mid-run (machine off, process killed) never does, so
// without an age cutoff its threads inflate activeCount forever.
const RUNNING_AGENT_ACTIVITY_ROW_TTL_MS = 2 * 60 * 60 * 1_000;
const WAITING_AGENT_ACTIVITY_ROW_TTL_MS = 24 * 60 * 60 * 1_000;

export function agentActivityExpiresAt(
  state: Pick<RelayAgentActivityState, "phase" | "updatedAt">,
): number {
  const updatedAtMs = Option.match(DateTime.make(state.updatedAt), {
    onNone: () => Number.NaN,
    onSome: (dt) => dt.epochMilliseconds,
  });
  if (Number.isNaN(updatedAtMs)) {
    return Number.NaN;
  }
  const ttlMs =
    state.phase === "running" || state.phase === "starting"
      ? RUNNING_AGENT_ACTIVITY_ROW_TTL_MS
      : WAITING_AGENT_ACTIVITY_ROW_TTL_MS;
  return updatedAtMs + ttlMs;
}

export function isExpiredAgentActivityState(
  state: Pick<RelayAgentActivityState, "phase" | "updatedAt">,
  nowMs: number,
): boolean {
  const expiresAt = agentActivityExpiresAt(state);
  return !Number.isFinite(expiresAt) || nowMs > expiresAt;
}

const MAX_SUMMARY_TEXT_LENGTH = 120;
const MAX_STATUS_TEXT_LENGTH = 40;
const MAX_DEEP_LINK_LENGTH = 512;
// The Live Activity banner (lock screen / Notification Center) renders up to
// five rows; the expanded Dynamic Island shows the top three of these.
export const MAX_ACTIVITY_ROWS = 5;

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength - 3).trimEnd() + "...";
}

function sanitizeDeepLink(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return "/";
  }
  return truncateText(trimmed, MAX_DEEP_LINK_LENGTH);
}

export function sanitizeAgentActivityAggregateRow(
  row: RelayAgentActivityAggregateRow,
): RelayAgentActivityAggregateRow {
  return {
    ...row,
    projectTitle: truncateText(row.projectTitle, MAX_SUMMARY_TEXT_LENGTH),
    threadTitle: truncateText(row.threadTitle, MAX_SUMMARY_TEXT_LENGTH),
    modelTitle: truncateText(row.modelTitle, MAX_SUMMARY_TEXT_LENGTH),
    status: truncateText(row.status, MAX_STATUS_TEXT_LENGTH),
    deepLink: sanitizeDeepLink(row.deepLink),
  };
}

export function sanitizeAgentActivityAggregateState(
  aggregate: RelayAgentActivityAggregateState,
): RelayAgentActivityAggregateState {
  return {
    ...aggregate,
    title: truncateText(aggregate.title, MAX_SUMMARY_TEXT_LENGTH),
    subtitle: truncateText(aggregate.subtitle, MAX_SUMMARY_TEXT_LENGTH),
    activities: aggregate.activities
      .slice(0, MAX_ACTIVITY_ROWS)
      .map(sanitizeAgentActivityAggregateRow),
  };
}

export function sanitizeApnsNotificationPayload<T extends AgentActivityNotification>(
  notification: T,
): T {
  return {
    ...notification,
    title: truncateText(notification.title, MAX_SUMMARY_TEXT_LENGTH),
    body: truncateText(notification.body, MAX_SUMMARY_TEXT_LENGTH),
    deepLink: sanitizeDeepLink(notification.deepLink),
  };
}

export function notificationForActivity(
  row: RelayAgentActivityAggregateRow,
): AgentActivityNotification {
  const activity = sanitizeAgentActivityAggregateRow(row);
  return sanitizeApnsNotificationPayload({
    title: activity.threadTitle,
    body: `${activity.status}: ${activity.projectTitle}`,
    environmentId: activity.environmentId,
    threadId: activity.threadId,
    deepLink: activity.deepLink,
    phase: activity.phase,
    updatedAt: activity.updatedAt,
  });
}

export function statusForPhase(phase: RelayAgentActivityState["phase"]): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "starting":
      // Matches the web sidebar's pill wording (Sidebar.logic.ts) so the same
      // thread reads the same across surfaces.
      return "Connecting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

function aggregateRowForState(state: RelayAgentActivityState) {
  return {
    environmentId: state.environmentId,
    threadId: state.threadId,
    projectTitle: state.projectTitle,
    threadTitle: state.threadTitle,
    modelTitle: state.modelTitle,
    phase: state.phase,
    status: statusForPhase(state.phase),
    updatedAt: state.updatedAt,
    deepLink: state.deepLink,
  };
}

function terminalAggregateState(state: RelayAgentActivityState): RelayAgentActivityAggregateState {
  return sanitizeAgentActivityAggregateState({
    title: "T3 Code",
    subtitle: state.phase === "failed" ? "Agent work failed" : "Agent work completed",
    activeCount: 0,
    updatedAt: state.updatedAt,
    activities: [aggregateRowForState(state)],
  });
}

export const TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS = 15 * 60 * 1_000;

function isRecentTerminalState(state: RelayAgentActivityState, nowMs: number): boolean {
  if (!isTerminalPhase(state)) {
    return false;
  }
  const updatedAtMs = Option.match(DateTime.make(state.updatedAt), {
    onNone: () => Number.NaN,
    onSome: (dt) => dt.epochMilliseconds,
  });
  if (Number.isNaN(updatedAtMs)) {
    return false;
  }
  return nowMs - updatedAtMs <= TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS;
}

export function makeAggregateState(input: {
  readonly activeStates: ReadonlyArray<RelayAgentActivityState>;
  readonly terminalState: RelayAgentActivityState | null;
  readonly nowMs: number;
}): RelayAgentActivityAggregateState | null {
  const activeStates = input.activeStates.filter(
    (state) => !isTerminalPhase(state) && !isExpiredAgentActivityState(state, input.nowMs),
  );
  if (activeStates.length === 0) {
    if (input.terminalState !== null) {
      return terminalAggregateState(input.terminalState);
    }
    // The newly-terminal alert rules key off the previously delivered
    // aggregate, so replays repaint this without buzzing.
    const recentTerminal = input.activeStates
      .filter((state) => isRecentTerminalState(state, input.nowMs))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const newest = recentTerminal[0];
    if (!newest) {
      return null;
    }
    return sanitizeAgentActivityAggregateState({
      title: "T3 Code",
      subtitle: newest.phase === "failed" ? "Agent work failed" : "Agent work completed",
      activeCount: 0,
      updatedAt: newest.updatedAt,
      activities: recentTerminal.slice(0, MAX_ACTIVITY_ROWS).map(aggregateRowForState),
    });
  }
  const recentTerminalStates = input.activeStates
    .filter((state) => isRecentTerminalState(state, input.nowMs))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const displayedStates = [
    ...[...activeStates]
      .sort((a, b) => activityPhasePriority(a.phase) - activityPhasePriority(b.phase))
      .slice(0, MAX_ACTIVITY_ROWS),
    ...recentTerminalStates,
  ].slice(0, MAX_ACTIVITY_ROWS);
  const updatedAt = [...activeStates, ...recentTerminalStates].reduce((latest, state) =>
    state.updatedAt.localeCompare(latest.updatedAt) > 0 ? state : latest,
  ).updatedAt;
  return sanitizeAgentActivityAggregateState({
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount: activeStates.length,
    updatedAt,
    activities: displayedStates.map(aggregateRowForState),
  });
}

export function activityPhasePriority(phase: RelayAgentActivityState["phase"]): number {
  if (phase === "waiting_for_approval" || phase === "waiting_for_input") return 0;
  if (phase === "failed") return 1;
  if (phase === "starting" || phase === "running") return 2;
  return 3;
}

export interface AgentActivityAlert {
  readonly title: string;
  readonly body: string;
}

export const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;

export function isFreshTerminalNotification(updatedAt: string, nowMs: number): boolean {
  const timestamp = Option.getOrNull(DateTime.make(updatedAt));
  return (
    timestamp !== null && nowMs - timestamp.epochMilliseconds <= TERMINAL_NOTIFICATION_FRESHNESS_MS
  );
}

type TransitionInput = {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences | null;
};

function rowKey(row: RelayAgentActivityAggregateRow): string {
  return JSON.stringify([row.environmentId, row.threadId]);
}

export function isAttentionPhase(phase: string): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input";
}

export function alertAllowedForPhase(
  preferences: RelayAgentAwarenessPreferences | null,
  phase: string,
): boolean {
  if (preferences === null) return true;
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

// A missing baseline is a replay, not a transition that should buzz the phone.
export function attentionTransitionRows(input: TransitionInput) {
  if (input.previousAggregate === null) return [];
  const previouslyAttention = new Set(
    input.previousAggregate.activities.filter((row) => isAttentionPhase(row.phase)).map(rowKey),
  );
  return input.nextAggregate.activities.filter(
    (row) =>
      isAttentionPhase(row.phase) &&
      !previouslyAttention.has(rowKey(row)) &&
      alertAllowedForPhase(input.preferences, row.phase),
  );
}

export function newlyTerminalRows(
  previousAggregate: RelayAgentActivityAggregateState | null,
  nextAggregate: RelayAgentActivityAggregateState,
  includeUnobserved = false,
): ReadonlyArray<RelayAgentActivityAggregateRow> {
  if (previousAggregate === null) return [];
  const previousPhases = new Map(
    previousAggregate.activities.map((row) => [rowKey(row), row.phase]),
  );
  return nextAggregate.activities.filter((row) => {
    if (row.phase !== "completed" && row.phase !== "failed") return false;
    const previousPhase = previousPhases.get(rowKey(row));
    return (
      (includeUnobserved || previousPhase !== undefined) &&
      previousPhase !== "completed" &&
      previousPhase !== "failed"
    );
  });
}

export function terminalTransitionRows(
  input: TransitionInput & { readonly nowMs: number; readonly includeUnobserved?: boolean },
) {
  return newlyTerminalRows(
    input.previousAggregate,
    input.nextAggregate,
    input.includeUnobserved,
  ).filter((row) => {
    return (
      alertAllowedForPhase(input.preferences, row.phase) &&
      isFreshTerminalNotification(row.updatedAt, input.nowMs)
    );
  });
}

export function alertForActivityRows(
  rows: ReadonlyArray<RelayAgentActivityAggregateRow>,
): AgentActivityAlert | null {
  const first = rows[0];
  if (!first) return null;
  if (rows.length === 1) {
    return { title: first.threadTitle, body: `${first.status}: ${first.projectTitle}` };
  }
  return {
    title: `${rows.length} agents ${isAttentionPhase(first.phase) ? "need attention" : "finished"}`,
    body: rows.map((row) => row.threadTitle).join(", "),
  };
}

export function alertForAttentionTransition(input: TransitionInput): AgentActivityAlert | null {
  return alertForActivityRows(attentionTransitionRows(input));
}

export function alertForNewlyTerminal(
  input: TransitionInput & { readonly nowMs: number; readonly includeUnobserved?: boolean },
): AgentActivityAlert | null {
  return alertForActivityRows(terminalTransitionRows(input));
}

export function alertForTerminalAggregate(input: {
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly preferences: RelayAgentAwarenessPreferences | null;
}): AgentActivityAlert | null {
  const row = input.aggregate?.activities[0];
  if (!row || (row.phase !== "completed" && row.phase !== "failed")) return null;
  return alertAllowedForPhase(input.preferences, row.phase) ? alertForActivityRows([row]) : null;
}

export function shouldAlertForActivity(input: {
  readonly phase: RelayAgentActivityAggregateRow["phase"];
  readonly updatedAt: string;
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly nowMs: number;
}): boolean {
  return (
    input.preferences?.notificationsEnabled === true &&
    alertAllowedForPhase(input.preferences, input.phase) &&
    ((input.phase !== "completed" && input.phase !== "failed") ||
      isFreshTerminalNotification(input.updatedAt, input.nowMs))
  );
}

export const MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 15_000;

function aggregateNeedsAttention(aggregate: RelayAgentActivityAggregateState): boolean {
  return aggregate.activities.some(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
}

export function shouldUpdateLiveActivity(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly lastDeliveryAt: string | null;
  readonly nowMs: number;
}): boolean {
  if (!input.previousAggregate) {
    return true;
  }
  if (JSON.stringify(input.previousAggregate) === JSON.stringify(input.nextAggregate)) {
    return false;
  }
  if (input.previousAggregate.activeCount !== input.nextAggregate.activeCount) {
    return true;
  }
  if (aggregateNeedsAttention(input.nextAggregate)) {
    return true;
  }
  // A thread finishing must never be throttled away: when a completion and a
  // new start land in the same window, activeCount is unchanged and the Done
  // transition (and its alert) would otherwise be suppressed.
  if (newlyTerminalRows(input.previousAggregate, input.nextAggregate, true).length > 0) {
    return true;
  }
  const lastDeliveryAtMs =
    input.lastDeliveryAt === null
      ? null
      : Option.match(DateTime.make(input.lastDeliveryAt), {
          onNone: () => Number.NaN,
          onSome: (dt) => dt.epochMilliseconds,
        });
  return (
    lastDeliveryAtMs === null ||
    Number.isNaN(lastDeliveryAtMs) ||
    input.nowMs - lastDeliveryAtMs >= MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS
  );
}

const PERMANENT_APNS_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

/** APNs will never accept this token again, so it is dropped rather than retried. */
export function isPermanentApnsTokenFailure(result: {
  readonly ok: boolean;
  readonly status: number;
  readonly reason?: string | undefined;
}): boolean {
  return (
    !result.ok &&
    (result.status === 410 ||
      (result.status === 400 &&
        result.reason !== undefined &&
        PERMANENT_APNS_TOKEN_REASONS.has(result.reason)))
  );
}

export function androidActivityData(aggregate: RelayAgentActivityAggregateState | null) {
  const rows = [...(aggregate?.activities ?? [])].sort(
    (a, b) => activityPhasePriority(a.phase) - activityPhasePriority(b.phase),
  );
  const activeCount = aggregate?.activeCount ?? 0;
  const attentionCount = rows.filter((row) => activityPhasePriority(row.phase) === 0).length;
  const failed = rows.some((row) => row.phase === "failed");
  const clean = (value: string) => value.replace(/\s+/g, " ").trim();
  const lines = rows.map((row) =>
    [row.status, clean(row.threadTitle), clean(row.projectTitle)].join("\t"),
  );
  const hero = rows[0];
  const title =
    activeCount > 0
      ? `${activeCount} active agent${activeCount === 1 ? "" : "s"}${attentionCount ? ` · ${attentionCount} need${attentionCount === 1 ? "s" : ""} attention` : ""}`
      : failed
        ? "Agent work failed"
        : "Agent work completed";
  const expiresAt = Math.max(
    0,
    ...rows.map((row) =>
      row.phase === "completed" || row.phase === "failed"
        ? Date.parse(row.updatedAt) + TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS
        : agentActivityExpiresAt(row),
    ),
  );
  return {
    active: String(activeCount > 0),
    activity_chip: activeCount > 0 ? (attentionCount > 0 ? "Review" : "Active") : "",
    activity_title: title,
    activity_phase: hero?.phase ?? "",
    activity_active_count: String(activeCount),
    activity_attention_count: String(attentionCount),
    activity_body: hero
      ? `${hero.status}: ${clean(hero.threadTitle)} · ${clean(hero.projectTitle)}`
      : "",
    ...Object.fromEntries(lines.map((line, index) => [`activity_line_${index}`, line])),
    activity_path: rows[0]?.deepLink ?? "/",
    activity_expires_at: String(expiresAt),
  };
}

/** Keep Unicode, escaping and grouped alerts within FCM's 4 KB data budget. */
export function fitFcmData(input: Readonly<Record<string, string>>): Record<string, string> {
  const data = { ...input };
  const encoder = new TextEncoder();
  const textKeys = Object.keys(data).filter(
    (key) => key.endsWith("_body") || key.endsWith("_title") || key.startsWith("activity_line_"),
  );
  while (encoder.encode(JSON.stringify(data)).length > 3800) {
    const key = textKeys.sort(
      (a, b) => encoder.encode(data[b]!).length - encoder.encode(data[a]!).length,
    )[0];
    if (!key) break;
    if (data[key]!.length <= 8) {
      textKeys.splice(textKeys.indexOf(key), 1);
      continue;
    }
    const parts = key.startsWith("activity_line_") ? data[key]!.split("\t") : [data[key]!];
    const part = parts.length === 3 ? (parts[1]!.length > parts[2]!.length ? 1 : 2) : 0;
    const characters = Array.from(parts[part]!);
    // Five characters would become four plus the ellipsis and never shrink.
    if (characters.length <= 5) {
      textKeys.splice(textKeys.indexOf(key), 1);
      continue;
    }
    parts[part] =
      characters
        .slice(0, Math.floor(characters.length * 0.8))
        .join("")
        .trimEnd() + "…";
    data[key] = parts.join("\t");
  }
  return data;
}

export function androidAlertForState(
  state: RelayAgentActivityState,
  preferences: RelayAgentAwarenessPreferences,
  nowMs: number,
) {
  if (!shouldAlertForActivity({ ...state, preferences, nowMs })) return null;
  const notification = notificationForActivity({ ...state, status: statusForPhase(state.phase) });
  return {
    alert_id: JSON.stringify([state.environmentId, state.threadId, state.phase, state.updatedAt]),
    alert_group: JSON.stringify([state.environmentId, state.threadId]),
    alert_title: notification.title,
    alert_body: notification.body,
    alert_path: notification.deepLink,
  };
}

export function androidAlertForAggregate(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences;
  readonly nowMs: number;
}) {
  if (!input.preferences.notificationsEnabled) return null;
  const attention = attentionTransitionRows(input);
  const activities =
    attention.length > 0
      ? attention
      : terminalTransitionRows({ ...input, includeUnobserved: true });
  const first = activities[0];
  const alert = alertForActivityRows(activities);
  if (!first || !alert) return null;
  if (activities.length === 1) {
    const notification = notificationForActivity(first);
    return {
      alert_id: JSON.stringify([first.environmentId, first.threadId, first.phase, first.updatedAt]),
      alert_group: JSON.stringify([first.environmentId, first.threadId]),
      alert_title: notification.title,
      alert_body: notification.body,
      alert_path: notification.deepLink,
    };
  }
  return {
    // Every contributing queue job identifies the same group, including after
    // retries or a different database row order. The native handler deduplicates it.
    alert_id: JSON.stringify(
      activities
        .map((row) => [row.environmentId, row.threadId, row.phase, row.updatedAt])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ),
    alert_title: alert.title,
    alert_body: alert.body,
    // A multi-thread alert targets the overview so one visible thread cannot
    // suppress notifications for the other threads in the group.
    alert_path: "/",
  };
}

const LIVE_ACTIVITY_NAME = "AgentActivity";
// Updates only flow on domain events, so a healthy agent can be silent for
// minutes (long tool calls, pending approvals).
export const LIVE_ACTIVITY_STALE_AFTER_SECONDS = 10 * 60;
const DISMISS_AFTER_SECONDS = 5 * 60;
// An end without a final content-state leaves whatever the card last showed
// frozen on the lock screen until dismissal — get it off quickly instead of
// parading stale state for the full window.
const CONTENTLESS_DISMISS_AFTER_SECONDS = 15;

export type ApnsLiveActivityEvent = "start" | "update" | "end";

export interface ApnsLiveActivityBody {
  readonly priority: "5" | "10";
  readonly payload: unknown;
}

function contentState(state: RelayAgentActivityAggregateState) {
  return {
    name: LIVE_ACTIVITY_NAME,
    props: JSON.stringify(state),
  };
}

// An alert dict on an update/end makes it an "alerting" update: iOS wakes the
// screen and plays the haptic (the Apple Sports score-change behavior) instead
// of silently redrawing the activity.
function liveActivityAlertPayload(alert: AgentActivityAlert) {
  return {
    alert: {
      title: alert.title,
      body: alert.body,
      sound: "default",
    },
  };
}

export type ApnsLiveActivityBodyInput =
  | {
      readonly event: "end";
      readonly nowEpochSeconds: number;
      readonly state: RelayAgentActivityAggregateState | null;
      readonly alert?: AgentActivityAlert | null;
    }
  | {
      readonly event: "start" | "update";
      readonly nowEpochSeconds: number;
      readonly state: RelayAgentActivityAggregateState;
      readonly alert?: AgentActivityAlert | null;
    };

/** The body and priority of a `liveactivity` push to topic `<bundleId>.push-type.liveactivity`. */
export function apnsLiveActivityBody(input: ApnsLiveActivityBodyInput): ApnsLiveActivityBody {
  const timestamp = input.nowEpochSeconds;
  if (input.event === "end") {
    return {
      priority: "10",
      payload: {
        aps: {
          timestamp,
          event: "end",
          ...(input.state ? { "content-state": contentState(input.state) } : {}),
          ...(input.alert ? liveActivityAlertPayload(input.alert) : {}),
          "dismissal-date":
            timestamp + (input.state ? DISMISS_AFTER_SECONDS : CONTENTLESS_DISMISS_AFTER_SECONDS),
        },
      },
    };
  }

  const state = input.state;
  return {
    priority: input.event === "update" && !input.alert ? "5" : "10",
    payload: {
      aps: {
        timestamp,
        event: input.event,
        ...(input.event === "start"
          ? {
              "attributes-type": "LiveActivityAttributes",
              attributes: {},
              "input-push-token": 1,
              alert: {
                title: state.title,
                body: state.subtitle,
              },
            }
          : {}),
        ...(input.event === "update" && input.alert ? liveActivityAlertPayload(input.alert) : {}),
        "content-state": contentState(state),
        "stale-date": timestamp + LIVE_ACTIVITY_STALE_AFTER_SECONDS,
      },
    },
  };
}

function notificationThreadId(notification: AgentActivityNotification): string {
  return notification.threadId.length > 0
    ? `${notification.environmentId}/${notification.threadId}`
    : "t3-agent-alerts";
}

/** The body of an `alert` push to topic `<bundleId>`; the app routes taps by `deepLink`. */
export function apnsAlertBody(notification: AgentActivityNotification) {
  return {
    aps: {
      alert: {
        title: notification.title,
        body: notification.body,
      },
      sound: "default",
      "thread-id": notificationThreadId(notification),
    },
    environmentId: notification.environmentId,
    threadId: notification.threadId,
    deepLink: notification.deepLink,
  };
}
