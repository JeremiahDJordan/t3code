import { describe, expect, it } from "@effect/vitest";

import { UsageAggregator } from "./usageAggregation.ts";
import type { RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const rates: RateTable = new Map([
  [
    "claude-fable-5",
    {
      inputCostPerToken: 1e-5,
      outputCostPerToken: 5e-5,
      cacheReadCostPerToken: 1e-6,
      cacheCreationCostPerToken: 1.25e-5,
      fastMultiplier: 1,
    },
  ],
]);

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    // 2026-08-07T04:05Z is still Aug 6 in Los Angeles.
    timestampMs: Date.parse("2026-08-07T04:05:13.944Z"),
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    fast: false,
    dedupeKey: null,
    ...overrides,
  };
}

function aggregate(
  records: readonly UsageRecord[],
  timeZone = "UTC",
  resolution: "day" | "hour" = "day",
) {
  const hourlyBounds =
    resolution === "hour"
      ? {
          sinceTimeMs: Date.parse("2026-08-06T04:37:00.000Z"),
          untilTimeMs: Date.parse("2026-08-07T04:37:00.000Z"),
        }
      : {};
  const aggregator = new UsageAggregator({
    timeZone,
    sinceDay: "2026-08-01",
    untilDay: "2026-08-31",
    resolution,
    ...hourlyBounds,
    rates,
  });
  for (const item of records) aggregator.add(item);
  return aggregator.finish();
}

describe("UsageAggregator", () => {
  it("requires exact bounds for hourly aggregation", () => {
    expect(
      () =>
        new UsageAggregator({
          timeZone: "UTC",
          sinceDay: "2026-08-01",
          untilDay: "2026-08-31",
          resolution: "hour",
          rates,
        }),
    ).toThrow("requires exact time bounds");
  });

  it("keeps only the first record for a repeated dedupe key", () => {
    const result = aggregate([
      record({ dedupeKey: "msg_1:" }),
      record({ dedupeKey: "msg_1:" }),
      record({ dedupeKey: "msg_1:" }),
    ]);

    expect(result.duplicatesDropped).toBe(2);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.records).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("still sums records that carry no dedupe key", () => {
    const result = aggregate([record(), record()]);

    expect(result.duplicatesDropped).toBe(0);
    expect(result.buckets[0]?.totals.outputTokens).toBe(100);
  });

  it("buckets by the day in the requested time zone", () => {
    const utc = aggregate([record()], "UTC");
    const losAngeles = aggregate([record()], "America/Los_Angeles");

    expect(utc.buckets[0]?.day).toBe("2026-08-07");
    expect(losAngeles.buckets[0]?.day).toBe("2026-08-06");
  });

  it("splits an hourly request into fixed buckets anchored to its exact start", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-07T02:40:13.944Z") }),
        record({ timestampMs: Date.parse("2026-08-07T03:40:13.944Z") }),
      ],
      "America/Los_Angeles",
      "hour",
    );

    expect(result.buckets.map((bucket) => [bucket.day, bucket.hourStart])).toEqual([
      ["2026-08-06", "2026-08-07T02:37:00.000Z"],
      ["2026-08-06", "2026-08-07T03:37:00.000Z"],
    ]);
  });

  it("uses an inclusive start and exclusive end for rolling windows", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-06T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-06T04:37:00.000Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:37:00.000Z") }),
      ],
      "UTC",
      "hour",
    );

    expect(result.outOfWindow).toBe(2);
    expect(result.buckets.map((bucket) => bucket.hourStart)).toEqual([
      "2026-08-06T04:37:00.000Z",
      "2026-08-07T03:37:00.000Z",
    ]);
  });

  it("keeps daily payloads collapsed when hourly resolution is not requested", () => {
    const result = aggregate([
      record({ timestampMs: Date.parse("2026-08-07T04:05:13.944Z") }),
      record({ timestampMs: Date.parse("2026-08-07T05:05:13.944Z") }),
    ]);

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.hourStart).toBeUndefined();
    expect(result.buckets[0]?.records).toBe(2);
  });

  it("prices against the rate table", () => {
    const result = aggregate([record()]);

    // 100*1e-5 + 1000*1e-6 + 10*1.25e-5 + 50*5e-5
    expect(result.buckets[0]?.costUsd).toBeCloseTo(0.004625, 9);
    expect(result.buckets[0]?.costSource).toBe("modelPriced");
  });

  it("counts tokens but not cost for a model with no rate", () => {
    const result = aggregate([record({ model: "kimi-k3" })]);

    expect(result.buckets[0]?.costUsd).toBe(0);
    expect(result.buckets[0]?.costSource).toBe("unpriced");
    expect(result.buckets[0]?.unpricedRecords).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("prefers a reported cost over the rate table", () => {
    const result = aggregate([record({ reportedCostUsd: 1.25 })]);

    expect(result.buckets[0]?.costUsd).toBe(1.25);
    expect(result.buckets[0]?.costSource).toBe("providerReported");
  });

  it("drops records outside the window", () => {
    const result = aggregate([record({ timestampMs: Date.parse("2026-07-01T12:00:00Z") })]);

    expect(result.outOfWindow).toBe(1);
    expect(result.buckets).toHaveLength(0);
  });

  it("reports whether a record contributed", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
    });

    expect(aggregator.add(record({ dedupeKey: "msg_1:" }))).toBe(true);
    expect(aggregator.add(record({ dedupeKey: "msg_1:" }))).toBe(false);
    expect(aggregator.add(record({ timestampMs: Date.parse("2026-07-01T12:00:00Z") }))).toBe(false);
  });

  it("totals Bobcoins apart from dollars and never prices them from the public table", () => {
    const bob = (amount: number, dedupeKey: string) =>
      record({
        provider: "bob",
        // A Bob tier that shares its id with a public model must still not be priced as one.
        model: "claude-fable-5",
        sessionId: "task-a",
        credits: { amount, unit: "Bobcoins" },
        dedupeKey,
      });
    const result = aggregate([bob(0.25, "bob:m-1"), bob(0.5, "bob:m-2"), record()]);
    const bobBucket = result.buckets.find((bucket) => bucket.provider === "bob");
    const claudeBucket = result.buckets.find((bucket) => bucket.provider === "claude");

    expect(bobBucket).toMatchObject({
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "unpriced",
      credits: { amount: 0.75, unit: "Bobcoins" },
      records: 2,
      unpricedRecords: 2,
    });
    expect(bobBucket?.totals.outputTokens).toBe(100);
    expect(claudeBucket?.costSource).toBe("modelPriced");
    expect(claudeBucket).not.toHaveProperty("credits");
  });

  it("prices credit-billed records at a custom price the user set", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      priceOverrides: new Map([
        [
          "premium-ide",
          {
            inputCostPerToken: 1e-6,
            outputCostPerToken: 1e-6,
            cacheReadCostPerToken: 1e-6,
            cacheCreationCostPerToken: 1e-6,
            fastMultiplier: 1,
          },
        ],
      ]),
    });
    aggregator.add(
      record({
        provider: "bob",
        model: "premium-ide",
        credits: { amount: 0.25, unit: "Bobcoins" },
      }),
    );
    const [bucket] = aggregator.finish().buckets;

    expect(bucket?.costSource).toBe("modelPriced");
    expect(bucket?.costUsd).toBeCloseTo(1160e-6, 12);
    expect(bucket?.credits).toEqual({ amount: 0.25, unit: "Bobcoins" });
  });

  it("separates providers and models into their own buckets", () => {
    const result = aggregate([
      record(),
      record({ provider: "codex", model: "gpt-5.6-sol" }),
      record({ model: "claude-opus-5" }),
    ]);

    expect(result.buckets).toHaveLength(3);
  });
});
