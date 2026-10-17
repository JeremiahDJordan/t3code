import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";

import {
  androidActivityData,
  androidAlertForAggregate,
  androidAlertForState,
  apnsAlertBody,
  apnsLiveActivityBody,
  attentionTransitionRows,
  fitFcmData,
  isExpiredAgentActivityState,
  makeAggregateState,
  shouldAlertForActivity,
  terminalTransitionRows,
} from "./agentActivityPush.ts";

const state: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "Model",
  headline: "Working",
  phase: "running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const aggregate = (states: RelayAgentActivityState[]) =>
  makeAggregateState({ activeStates: states, terminalState: null, nowMs: 0 })!;
const hourMs = 60 * 60 * 1_000;

// Moved from infra/relay's agentActivityPolicy.test.ts with the rules themselves.
describe("shared agent activity policy", () => {
  it.each(["waiting_for_approval", "waiting_for_input"] as const)(
    "keeps an older %s ahead of five running rows",
    (phase) => {
      const running = Array.from({ length: 5 }, (_, i) => ({
        ...state,
        threadId: ThreadId.make(`running-${i}`),
      }));
      const waiting = { ...state, phase, updatedAt: "1969-12-31T23:59:00.000Z" };
      const next = aggregate([...running, waiting]);
      expect(next.activities[0]?.threadId).toBe(state.threadId);
      expect(next.activeCount).toBe(6);
      expect(next.activities).toHaveLength(5);
      expect(
        attentionTransitionRows({
          previousAggregate: aggregate(running),
          nextAggregate: next,
          preferences,
        }),
      ).toMatchObject([{ threadId: state.threadId }]);
    },
  );

  it("allows fresh unobserved completions for events, but not reconciliation or repeats", () => {
    const previousAggregate = aggregate([
      { ...state, threadId: ThreadId.make("old"), phase: "completed" },
    ]);
    const nextAggregate = aggregate([{ ...state, phase: "completed" }]);
    const input = { previousAggregate, nextAggregate, preferences, nowMs: 0 };
    expect(terminalTransitionRows(input)).toEqual([]);
    expect(terminalTransitionRows({ ...input, includeUnobserved: true })).toHaveLength(1);
    expect(
      terminalTransitionRows({
        ...input,
        includeUnobserved: true,
        previousAggregate: nextAggregate,
      }),
    ).toEqual([]);
    expect(terminalTransitionRows({ ...input, includeUnobserved: true, nowMs: 180_000 })).toEqual(
      [],
    );
  });

  it("distinguishes equal thread IDs across environments", () => {
    const waiting = { ...state, phase: "waiting_for_input" as const };
    const other = { ...waiting, environmentId: EnvironmentId.make("other") };
    expect(
      attentionTransitionRows({
        previousAggregate: aggregate([waiting]),
        nextAggregate: aggregate([waiting, other]),
        preferences,
      }),
    ).toMatchObject([{ environmentId: other.environmentId }]);
  });

  it("checks current permission, event preferences, and freshness together", () => {
    const input = { ...state, phase: "completed" as const, preferences, nowMs: 0 };
    expect(shouldAlertForActivity(input)).toBe(true);
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, notificationsEnabled: false },
      }),
    ).toBe(false);
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, notifyOnCompletion: false },
      }),
    ).toBe(false);
    expect(shouldAlertForActivity({ ...input, nowMs: 180_000 })).toBe(false);
  });
});

describe("aggregate", () => {
  it("expires running rows after two hours and waiting rows after a day", () => {
    expect(isExpiredAgentActivityState(state, 2 * hourMs - 1)).toBe(false);
    expect(isExpiredAgentActivityState(state, 2 * hourMs + 1)).toBe(true);
    const waiting = { ...state, phase: "waiting_for_approval" as const };
    expect(isExpiredAgentActivityState(waiting, 23 * hourMs)).toBe(false);
    expect(isExpiredAgentActivityState({ ...state, updatedAt: "not-a-date" }, 0)).toBe(true);
  });

  it("keeps recently finished work beside active agents, then drops it", () => {
    const active = {
      ...state,
      threadId: ThreadId.make("active"),
      updatedAt: "1970-01-01T00:58:00.000Z",
    };
    const done = {
      ...state,
      threadId: ThreadId.make("done"),
      phase: "completed" as const,
      updatedAt: "1970-01-01T00:59:00.000Z",
    };
    expect(
      makeAggregateState({ activeStates: [active, done], terminalState: null, nowMs: hourMs })
        ?.activities,
    ).toMatchObject([
      { threadId: "active", status: "Working" },
      { threadId: "done", status: "Done" },
    ]);
    expect(
      makeAggregateState({
        activeStates: [active, done],
        terminalState: null,
        nowMs: hourMs + 16 * 60 * 1_000,
      })?.activities,
    ).toMatchObject([{ threadId: "active" }]);
    expect(
      makeAggregateState({ activeStates: [state], terminalState: null, nowMs: 3 * hourMs }),
    ).toBeNull();
  });
});

describe("APNs bodies", () => {
  const card = aggregate([state]);

  it("sends a silent update at priority 5 and an alerting one at priority 10", () => {
    const silent = apnsLiveActivityBody({ event: "update", state: card, nowEpochSeconds: 100 });
    expect(silent.priority).toBe("5");
    expect(silent.payload).toMatchObject({
      aps: {
        event: "update",
        timestamp: 100,
        "stale-date": 700,
        "content-state": { name: "AgentActivity", props: JSON.stringify(card) },
      },
    });
    const alerting = apnsLiveActivityBody({
      event: "update",
      state: card,
      alert: { title: "Thread", body: "Approval: Project" },
      nowEpochSeconds: 100,
    });
    expect(alerting.priority).toBe("10");
    expect(alerting.payload).toMatchObject({
      aps: { alert: { title: "Thread", body: "Approval: Project", sound: "default" } },
    });
  });

  it("dismisses a contentless end quickly", () => {
    expect(apnsLiveActivityBody({ event: "end", state: null, nowEpochSeconds: 0 })).toEqual({
      priority: "10",
      payload: { aps: { timestamp: 0, event: "end", "dismissal-date": 15 } },
    });
    expect(
      apnsLiveActivityBody({ event: "end", state: card, nowEpochSeconds: 0 }).payload,
    ).toMatchObject({ aps: { "dismissal-date": 300 } });
  });

  it("routes an alert by thread", () => {
    expect(
      apnsAlertBody({
        title: "Thread",
        body: "Input: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/threads/env/thread",
      }),
    ).toEqual({
      aps: {
        alert: { title: "Thread", body: "Input: Project" },
        sound: "default",
        "thread-id": "env/thread",
      },
      environmentId: "env",
      threadId: "thread",
      deepLink: "/threads/env/thread",
    });
  });
});

describe("Android data", () => {
  it("orders attention, then failure, and names the card", () => {
    const data: Record<string, string> = androidActivityData(
      aggregate([
        state,
        { ...state, threadId: ThreadId.make("failed"), phase: "failed" },
        { ...state, threadId: ThreadId.make("approval"), phase: "waiting_for_approval" },
      ]),
    );
    expect(data.activity_title).toBe("2 active agents · 1 needs attention");
    expect(data.activity_chip).toBe("Review");
    expect(data.activity_line_0).toBe("Approval\tThread\tProject");
    expect(data.activity_line_1).toBe("Failed\tThread\tProject");
    expect(androidActivityData(null).activity_chip).toBe("");
  });

  it("uses iOS alert wording and honors preferences", () => {
    expect(androidAlertForState({ ...state, phase: "completed" }, preferences, 0)).toMatchObject({
      alert_title: "Thread",
      alert_body: "Done: Project",
      alert_path: "/threads/env/thread",
    });
    expect(
      androidAlertForState(
        { ...state, phase: "completed" },
        { ...preferences, notifyOnCompletion: false },
        0,
      ),
    ).toBeNull();
    expect(
      androidAlertForAggregate({
        previousAggregate: aggregate([state, { ...state, threadId: ThreadId.make("other") }]),
        nextAggregate: aggregate([
          { ...state, phase: "completed" },
          { ...state, threadId: ThreadId.make("other"), phase: "failed" },
        ]),
        preferences,
        nowMs: 0,
      }),
    ).toMatchObject({ alert_title: "2 agents finished", alert_path: "/" });
  });

  it("fits the FCM data budget without corrupting text", () => {
    const long = '🤖漢字"\\'.repeat(30);
    const data = fitFcmData({
      ...androidActivityData(
        aggregate(
          Array.from({ length: 5 }, (_, i) => ({
            ...state,
            threadId: ThreadId.make(`thread-${i}`),
            threadTitle: long,
            projectTitle: long,
          })),
        ),
      ),
      alert_body: Array(5).fill(long).join(", "),
      alert_path: "/threads/env/thread",
    });
    expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThanOrEqual(3800);
    expect(data.alert_path).toBe("/threads/env/thread");
    for (const value of Object.values(data))
      expect(new TextDecoder().decode(new TextEncoder().encode(value))).toBe(value);
  });
});
