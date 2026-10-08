import { describe, expect, it } from "@effect/vitest";

import { compileResultPattern, type ResultPattern } from "./ResultPattern.ts";

const compiled = (source: string): ResultPattern => {
  const result = compileResultPattern(source);
  if ("reason" in result) throw new Error(`${source} ${result.reason}`);
  return result;
};

/** A small deterministic generator, so a failure names a pattern that reproduces. */
function random(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const below = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: ReadonlyArray<T>): T => items[below(items.length)]!;
  return { below, pick };
}

const ATOMS = [
  "a",
  "b",
  "c",
  ".",
  "[ab]",
  "[^a]",
  "[a-c]",
  "[^]",
  "\\d",
  "\\D",
  "\\w",
  "\\W",
  "\\s",
  "\\S",
  "\\p{L}",
  "\\P{L}",
  "\\p{Lu}",
  "😀",
  "\\u{1F600}",
  "\\uD83D\\uDE00",
  "\\n",
  "\\.",
  "[\\d_]",
];
const ANCHORS = ["^", "$", "\\b", "\\B"];
const QUANTIFIERS = ["*", "+", "?", "{2}", "{1,}", "{0,2}", "{1,3}", "*?", "+?", "??", "{1,2}?"];
const CHARS = ["a", "b", "c", "A", "1", "_", " ", "\n", "é", "😀", "\uD83D", "\uDE00", "."];

function pattern(rng: ReturnType<typeof random>, depth: number, names: { count: number }): string {
  const terms = 1 + rng.below(3);
  const alternatives = rng.below(4) === 0 ? 2 : 1;
  const alternative = () => {
    let out = "";
    for (let index = 0; index < terms; index += 1) {
      const roll = rng.below(10);
      let term: string;
      if (roll === 0) term = rng.pick(ANCHORS);
      else if (roll <= 2 && depth > 0) {
        const body = pattern(rng, depth - 1, names);
        const open = rng.pick(["(", "(?:", `(?<n${names.count}>`]);
        if (open.startsWith("(?<")) names.count += 1;
        term = `${open}${body})`;
      } else term = rng.pick(ATOMS);
      if (!ANCHORS.includes(term) && rng.below(3) === 0) term += rng.pick(QUANTIFIERS);
      out += term;
    }
    return out;
  };
  return Array.from({ length: alternatives }, alternative).join("|");
}

describe("ResultPattern", () => {
  it("agrees with the runtime's engine on small patterns and strings", () => {
    const rng = random(17);
    let compared = 0;
    for (let round = 0; round < 400; round += 1) {
      const source = pattern(rng, 2, { count: 0 });
      const matcher = compiled(source);
      const native = new RegExp(source, "u");
      for (let sample = 0; sample < 12; sample += 1) {
        const value = Array.from({ length: rng.below(7) }, () => rng.pick(CHARS)).join("");
        const expected = native.test(value);
        if (matcher.test(value) !== expected) {
          throw new Error(`${JSON.stringify(source)} on ${JSON.stringify(value)}: not ${expected}`);
        }
        compared += 1;
      }
    }
    expect(compared).toBe(400 * 12);
  });

  it("checks an exponentially ambiguous pattern in linear time", () => {
    for (const groups of [28, 40]) {
      const matcher = compiled(`^${"(a|aa)".repeat(groups)}$`);
      const started = performance.now();
      expect(matcher.test("a".repeat(groups * 1.5))).toBe(true);
      expect(matcher.test(`${"a".repeat(groups * 1.5)}b`)).toBe(false);
      expect(matcher.test("a".repeat(groups * 2))).toBe(true);
      expect(matcher.test("a".repeat(groups * 2 + 1))).toBe(false);
      // Milliseconds; the backtracking engine takes longer than anyone waits.
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it("checks strings up to a length set by the pattern's size", () => {
    const small = compiled("^[a-z]+$");
    const large = compiled("^(?:[a-z]?){400}$");
    expect(large.longest).toBeLessThan(small.longest / 50);
    expect(small.test("a".repeat(small.longest))).toBe(true);
    expect(small.test("a".repeat(small.longest + 1))).toBeUndefined();
    const started = performance.now();
    expect(large.test("a".repeat(large.longest))).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("takes its steps from a budget, stopping when they run out", () => {
    const matcher = compiled("^(?:[a-z]?){400}$");
    const value = "a".repeat(1000);
    const budget = { remaining: Number.MAX_SAFE_INTEGER };
    expect(matcher.test(value, budget)).toBe(false);
    const spent = Number.MAX_SAFE_INTEGER - budget.remaining;
    // A step for each state live at each position.
    expect(spent).toBeGreaterThan(400 * 200);
    expect(spent).toBeLessThanOrEqual(3 * matcher.size * (value.length + 1));
    // Short of that, it stops without an answer and leaves the budget spent.
    const short = { remaining: spent - 1 };
    expect(matcher.test(value, short)).toBeUndefined();
    expect(short.remaining).toBeLessThan(0);
    expect(matcher.test("a", short)).toBeUndefined();
    // An answer found early costs little.
    const early = { remaining: 1000 };
    expect(compiled("a").test(`a${"b".repeat(100_000)}`, early)).toBe(true);
    expect(early.remaining).toBeGreaterThan(990);
  });

  it("refuses what it cannot run without backtracking, saying why", () => {
    for (const [source, reason] of [
      ["(a)\\1", "refers back to a group"],
      ["(?<x>a)\\k<x>", "refers back to a group"],
      ["a(?=b)", "looks ahead or behind"],
      ["a(?!b)", "looks ahead or behind"],
      ["(?<=a)b", "looks ahead or behind"],
      ["(?<!a)b", "looks ahead or behind"],
      ["(?i:a)", "sets flags inside the pattern"],
      ["(?:a{40}){40}", "more than 1024 steps"],
      ["(?:){1000000}", "more than 1024 steps"],
      ["a".repeat(257), "longer than 256 characters"],
      ["(a", "not a valid regular expression"],
      ["\\-", "not a valid regular expression"],
    ] as const) {
      const result = compileResultPattern(source);
      expect("reason" in result && result.reason).toContain(reason);
    }
  });
});
