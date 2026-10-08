import { describe, expect, it, vi } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  checkResultSchema,
  structuredResultFromText,
  validateStructuredResult,
} from "./StructuredResult.ts";

const VERDICT = {
  type: "object",
  required: ["refuted", "reason"],
  properties: { refuted: { type: "boolean" }, reason: { type: "string" } },
};

describe("StructuredResult", () => {
  it("accepts a matching value and explains a mismatch", () => {
    expect(validateStructuredResult(VERDICT, { refuted: false, reason: "reproduced" })).toEqual(
      Result.succeed({ refuted: false, reason: "reproduced" }),
    );
    const mismatch = validateStructuredResult(VERDICT, { refuted: "no", reason: "x" });
    expect(Result.isFailure(mismatch)).toBe(true);
    expect(Result.isFailure(mismatch) && mismatch.failure).toContain("refuted");
  });

  it("decides oneOf membership on the value as given, extra fields included", () => {
    const closed = (properties: Record<string, object>) => ({
      type: "object",
      required: Object.keys(properties),
      properties,
      additionalProperties: false,
    });
    const verdict = {
      oneOf: [
        closed({ ok: { type: "boolean" } }),
        closed({ ok: { type: "boolean" }, reason: { type: "string" } }),
      ],
    };
    // Only the second branch allows `reason`, so exactly one matches.
    for (const value of [{ ok: true }, { ok: false, reason: "x" }]) {
      expect(validateStructuredResult(verdict, value)).toEqual(Result.succeed(value));
    }
    expect(Result.isFailure(validateStructuredResult(verdict, { ok: true, extra: 1 }))).toBe(true);
    // An open object keeps the fields it does not name.
    const open = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    expect(validateStructuredResult(open, { ok: true, note: "kept" })).toEqual(
      Result.succeed({ ok: true, note: "kept" }),
    );
  });

  it("refuses a schema it cannot use", () => {
    expect(Result.isFailure(checkResultSchema("not a schema"))).toBe(true);
    expect(Result.isSuccess(checkResultSchema(VERDICT))).toBe(true);
  });

  it("refuses a cyclic schema, and fails rather than throws on one the check missed", () => {
    const cyclic = { $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" };
    const pair = {
      $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } },
      $ref: "#/$defs/a",
    };
    expect(Result.isFailure(checkResultSchema(cyclic))).toBe(true);
    expect(Result.isFailure(checkResultSchema(pair))).toBe(true);
    expect(Result.isFailure(validateStructuredResult(cyclic, 1))).toBe(true);
    expect(Result.isFailure(structuredResultFromText(cyclic, 'x {"a":1}'))).toBe(true);
    // The probes never reach a cycle under an optional property, so only decoding finds it.
    const nested = {
      type: "object",
      required: ["y"],
      properties: { y: { type: "object", properties: { x: { $ref: "#/$defs/a" } } } },
      $defs: { a: { $ref: "#/$defs/a" } },
    };
    expect(Result.isSuccess(checkResultSchema(nested))).toBe(true);
    const value = validateStructuredResult(nested, { y: { x: 1 } });
    expect(Result.isFailure(value) && value.failure).toContain("could not check");
    expect(Result.isFailure(structuredResultFromText(nested, 'x {"y":{"x":1}}'))).toBe(true);
  });

  it("enforces a pattern, and refuses one it cannot check without backtracking", () => {
    const decision = (pattern: string) => ({
      type: "object",
      required: ["decision"],
      properties: { decision: { type: "string", pattern } },
    });
    const verdict = decision("^(accept|reject)$");
    expect(validateStructuredResult(verdict, { decision: "accept" })).toEqual(
      Result.succeed({ decision: "accept" }),
    );
    const maybe = validateStructuredResult(verdict, { decision: "maybe" });
    expect(Result.isFailure(maybe) && maybe.failure).toContain("decision");
    expect(Result.isFailure(maybe) && maybe.failure).toContain("^(accept|reject)$");
    expect(Result.isFailure(structuredResultFromText(verdict, '{"decision":"maybe"}'))).toBe(true);
    expect(structuredResultFromText(verdict, 'Done: {"decision":"reject"}')).toEqual(
      Result.succeed({ decision: "reject" }),
    );

    // A backreference, lookaround or an inline flag has no NFA to run on, and
    // a long or hugely repeated pattern is refused rather than expanded.
    for (const [pattern, reason] of [
      ["^(a)\\1$", "refers back to a group"],
      ["^(?<x>a)\\k<x>$", "refers back to a group"],
      ["^(?=a)", "looks ahead or behind"],
      ["(?<!a)b", "looks ahead or behind"],
      ["^(?i:a)$", "sets flags"],
      ["^a{2000}$", "more than 1024"],
      ["^(?:){100000}$", "more than 1024"],
      ["a".repeat(257), "longer than 256"],
      ["^(a", "not a valid regular expression"],
    ] as const) {
      const refused = checkResultSchema(decision(pattern));
      expect(Result.isFailure(refused) && refused.failure).toContain("properties/decision/pattern");
      expect(Result.isFailure(refused) && refused.failure).toContain(reason);
      expect(Result.isFailure(validateStructuredResult(decision(pattern), { decision: "a" }))).toBe(
        true,
      );
    }
    // Repeated groups, once refused, are checked: linear time whatever the value.
    for (const [pattern, good, bad] of [
      ["^(a+)+$", "aaa", `${"a".repeat(5000)}b`],
      ["^(\\w+\\.)*\\w+$", "a.b.c", `${"a.".repeat(5000)}!`],
    ] as const) {
      expect(validateStructuredResult(decision(pattern), { decision: good })).toEqual(
        Result.succeed({ decision: good }),
      );
      expect(Result.isFailure(validateStructuredResult(decision(pattern), { decision: bad }))).toBe(
        true,
      );
    }
    const keyed = {
      type: "object",
      patternProperties: { "^(x)\\1$": { type: "string" } },
      $defs: { enum: { type: "string", pattern: "^(?=y)" } },
    };
    const refusedKey = checkResultSchema({ ...keyed, $defs: {} });
    expect(Result.isFailure(refusedKey) && refusedKey.failure).toContain("patternProperties");
    // A definition named like a data keyword is still a schema.
    const refusedDef = checkResultSchema({ ...keyed, patternProperties: {} });
    expect(Result.isFailure(refusedDef) && refusedDef.failure).toContain("$defs/enum/pattern");
    // Data under default and examples is not a constraint.
    expect(
      checkResultSchema({
        type: "object",
        properties: {
          decision: {
            type: "string",
            default: { pattern: "(b)\\1" },
            examples: [{ pattern: "^(?=a)" }],
          },
        },
      }),
    ).toEqual(Result.succeed(undefined));
  });

  it("checks a pattern in time linear in the value, whatever the pattern", () => {
    const string = (pattern: string, extra: Record<string, unknown> = {}) => ({
      type: "object",
      required: ["v"],
      properties: { v: { type: "string", pattern, ...extra } },
    });
    const verdict = (pattern: string, value: string) =>
      Result.isSuccess(validateStructuredResult(string(pattern), { v: value }));
    const started = performance.now();
    // Concatenated ambiguous choices backtrack exponentially with no quantifier at all.
    for (const groups of [28, 40]) {
      const pattern = `^${"(a|aa)".repeat(groups)}$`;
      expect(Result.isSuccess(checkResultSchema(string(pattern)))).toBe(true);
      expect(verdict(pattern, "a".repeat(groups * 1.5))).toBe(true);
      expect(verdict(pattern, `${"a".repeat(groups * 1.5)}b`)).toBe(false);
      expect(verdict(pattern, "a".repeat(groups * 2 + 1))).toBe(false);
    }
    // Chains of quantifiers backtrack polynomially, the chain's length the exponent.
    for (const pattern of [
      `^${"\\d+".repeat(12)}$`,
      `^${".*".repeat(10)}=$`,
      `^${"a?".repeat(25)}a{25}$`,
      `^${"\\d{1,3}".repeat(16)}$`,
      `^${"[a-z]*".repeat(5)}$`,
      `${"\\d+".repeat(4)}x`,
      `^a|${"\\d+".repeat(4)}x`,
    ]) {
      expect(verdict(pattern, `${"1".repeat(20_000)}!`)).toBe(false);
      for (const value of ["1".repeat(13), "1111x", "aaaa", "ab=", "", "abc"]) {
        expect(verdict(pattern, value)).toBe(new RegExp(pattern, "u").test(value));
      }
    }
    // Generous for a loaded machine: the engine took seconds to minutes on these.
    expect(performance.now() - started).toBeLessThan(2000);

    // No length is imposed beyond the schema's own, up to what a check can take.
    expect(verdict("^\\d+-\\d+-\\d+$", `${"1".repeat(100_000)}-1-1`)).toBe(true);
    const tight = validateStructuredResult(string("^[a-z]+$", { maxLength: 3 }), { v: "abcd" });
    expect(Result.isFailure(tight) && tight.failure).toContain("at most 3");
    const huge = validateStructuredResult(string("^(a|aa)+$"), { v: "a".repeat(5_000_000) });
    expect(Result.isFailure(huge) && huge.failure).toContain("Too long to check");
    // Everyday patterns are enforced as written.
    for (const [pattern, good, bad] of [
      ["^(accept|reject)$", "accept", "maybe"],
      ["^[a-z0-9-]+$", "my-slug", "My Slug"],
      ["^\\d{4}-\\d{2}-\\d{2}$", "2026-10-10", "2026-1-10"],
      ["^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", "a.b@example.com", "not an email"],
      ["^[A-Za-z0-9._/-]+\\.tsx?$", "apps/web/src/x.tsx", "x.js"],
      ["^https?://\\S+$", "https://x.y/z", "ftp://x"],
      ["^\\p{L}+$", "héllo", "h3llo"],
      ["\\bfoo\\b", "a foo.", "afoo"],
      ["^😀{2}$", "😀😀", "😀"],
      ["accept", "I accept", "I refuse"],
    ] as const) {
      expect(validateStructuredResult(string(pattern), { v: good })).toEqual(
        Result.succeed({ v: good }),
      );
      expect(Result.isFailure(validateStructuredResult(string(pattern), { v: bad }))).toBe(true);
    }
    // A key pattern is checked the same way, on names of any length.
    const ambiguous = `^${"(a|aa)".repeat(28)}$`;
    const keyed = (pattern: string) => ({
      type: "object",
      patternProperties: { [pattern]: { type: "string" } },
      additionalProperties: false,
    });
    expect(Result.isSuccess(validateStructuredResult(keyed("^[a-z]+$"), { abc: "x" }))).toBe(true);
    expect(Result.isFailure(validateStructuredResult(keyed("^[a-z]+$"), { abc: 1 }))).toBe(true);
    expect(
      Result.isSuccess(validateStructuredResult(keyed("^[a-z]+$"), { ["a".repeat(65536)]: "x" })),
    ).toBe(true);
    // A name the key pattern matches must hold a number; any other is refused
    // rather than left out, as JSON Schema refuses it, so that dropping it
    // cannot make a `oneOf` branch match.
    const numbers = {
      type: "object",
      patternProperties: { [ambiguous]: { type: "number" } },
      additionalProperties: false,
    };
    for (const [name, matches] of [
      ["a".repeat(42), true],
      [`${"a".repeat(42)}b`, false],
      ["a".repeat(57), false],
    ] as const) {
      expect(Result.isSuccess(validateStructuredResult(numbers, { [name]: 1 }))).toBe(matches);
      expect(Result.isFailure(validateStructuredResult(numbers, { [name]: "x" }))).toBe(true);
    }
    // A property named like the keyword is data, left as it is.
    expect(
      validateStructuredResult(
        { type: "object", properties: { pattern: { type: "string" } } },
        { pattern: "x".repeat(10_000) },
      ),
    ).toEqual(Result.succeed({ pattern: "x".repeat(10_000) }));
  });

  it("bounds the pattern work of a whole result, not only each check", () => {
    const heavy = "^(?:(?:a?){400})*$";
    const list = { type: "array", items: { type: "string", pattern: heavy } };
    // Each string fits one check, but checking 200 of them took seconds.
    const started = performance.now();
    const many = validateStructuredResult(
      list,
      Array.from({ length: 200 }, () => "a".repeat(4000)),
    );
    expect(Result.isFailure(many) && many.failure).toContain("too long to check");
    expect(Result.isFailure(many) && many.failure).toContain("at [2]");
    // As did one string checked against a pattern repeated 100 times.
    const repeated = {
      allOf: Array.from({ length: 100 }, () => ({
        type: "string",
        pattern: "(?:a?){200}a{200}b|b",
      })),
    };
    const once = validateStructuredResult(repeated, `${"a".repeat(6000)}b`);
    expect(Result.isFailure(once) && once.failure).toContain("too long to check");
    // Generous for a loaded machine: about 70 ms each.
    expect(performance.now() - started).toBeLessThan(1500);

    // Each validation has the whole budget, though the decoder is cached:
    // two strings take most of it, again and again.
    const pair = ["a".repeat(4000), "a".repeat(4000)];
    for (let round = 0; round < 3; round += 1) {
      expect(validateStructuredResult(list, pair)).toEqual(Result.succeed(pair));
    }

    // A large result of everyday patterns is nowhere near it.
    const findings = Array.from({ length: 2000 }, (_, index) => ({
      file: `apps/server/src/orchestration-v2/File${index}.ts`,
      severity: "P2",
      rule: "no-explicit-any",
      note: "A note about this finding that runs on for a sentence or two. ".repeat(3),
    }));
    const review = {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string", pattern: "^[\\w./-]+$" },
          severity: { type: "string", pattern: "^P[0-3]$" },
          rule: { type: "string", pattern: "^[a-z]+(-[a-z]+)*$" },
          note: { type: "string", pattern: "^[\\p{L}\\p{P}\\s]+$" },
        },
      },
    };
    expect(validateStructuredResult(review, findings)).toEqual(Result.succeed(findings));
  });

  it("checks many short strings against large patterns quickly", () => {
    // Each check is charged a few steps, but once set up state for all of a
    // pattern's thousand states: these 3 million checks took about 6 s.
    const large = {
      type: "array",
      items: {
        type: "string",
        allOf: Array.from({ length: 9 }, (_, index) => ({
          pattern: `(?:a{${1020 - index}})?`,
        })),
      },
    };
    const empties = Array.from({ length: 340_000 }, () => "");
    validateStructuredResult(large, [""]);
    const started = performance.now();
    validateStructuredResult(large, empties);
    // Generous for a loaded machine: about 100 ms.
    expect(performance.now() - started).toBeLessThan(1000);
    // Strings checked after many others still match as they should.
    const one = { type: "array", items: { type: "string", pattern: "^(?:a{1020})?$" } };
    expect(validateStructuredResult(one, empties)).toEqual(Result.succeed(empties));
    const words = ["", "a".repeat(1020), "", "a".repeat(1020)];
    expect(validateStructuredResult(one, words)).toEqual(Result.succeed(words));
    expect(Result.isFailure(validateStructuredResult(one, ["", "a".repeat(1019)]))).toBe(true);
  });

  it("never runs the runtime's own engine on a value", () => {
    const schema = {
      type: "object",
      required: ["v"],
      properties: {
        v: { type: "string", pattern: "^[ab]+$" },
        named: {
          type: "object",
          patternProperties: { "^a+$": { type: "number" } },
          additionalProperties: false,
        },
        list: { type: "array", items: { type: "string", pattern: "b" } },
      },
    };
    const value = { v: "a".repeat(64), named: { ["a".repeat(64)]: 1 }, list: ["a".repeat(64)] };
    // `RegExp.prototype.test` runs through `exec`.
    const exec = vi.spyOn(RegExp.prototype, "exec");
    let inputs: Array<string>;
    try {
      const checked = validateStructuredResult(schema, value);
      expect(Result.isFailure(checked) && checked.failure).toContain("list");
      inputs = exec.mock.calls.map(([input]) => String(input));
    } finally {
      exec.mockRestore();
    }
    // Only single code points, each tested against one item of a pattern.
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.filter((input) => input.length > 2)).toEqual([]);
  });

  it("keeps what patterns decide about the schema's own names and values", () => {
    // A named property a key pattern matches takes that pattern's schema too.
    const named = (pattern: string) => ({
      allOf: [
        { type: "object", properties: { ab: { type: "string" } }, additionalProperties: false },
        { type: "object", patternProperties: { [pattern]: { type: "string", minLength: 3 } } },
      ],
    });
    expect(Result.isFailure(validateStructuredResult(named("^a(b|bb)$"), { ab: "x" }))).toBe(true);
    expect(Result.isSuccess(validateStructuredResult(named("^a(b|bb)$"), { ab: "xyz" }))).toBe(
      true,
    );
    expect(Result.isSuccess(validateStructuredResult(named("^z"), { ab: "x" }))).toBe(true);
    // A name longer than a pattern can check, here about 4,000 characters, is
    // refused rather than taken as unmatched, which would skip the pattern's schema.
    const long = "a".repeat(5000);
    const tooLong = checkResultSchema({
      allOf: [
        { type: "object", properties: { [long]: { type: "string" } }, additionalProperties: false },
        { type: "object", patternProperties: { "^a{1000}": { type: "string", minLength: 3 } } },
      ],
    });
    expect(Result.isFailure(tooLong) && tooLong.failure).toContain(
      'too long to check against the pattern "^a{1000}"',
    );
    // A constant must satisfy a pattern beside it.
    const constant = (pattern: string) => ({
      allOf: [{ const: "yes" }, { type: "string", pattern }],
    });
    expect(validateStructuredResult(constant("^y(e|es)s?$"), "yes")).toEqual(Result.succeed("yes"));
    expect(Result.isFailure(validateStructuredResult(constant("^n"), "yes"))).toBe(true);
    // Matching every pattern against every name is bounded too.
    const crowded = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [
          `p${index}`,
          { type: "string", pattern: `^${index}(a|b)*$` },
        ]),
      ),
      $defs: {
        names: { enum: Array.from({ length: 2000 }, (_, index) => `${index}`.padEnd(100, "a")) },
      },
    };
    const refused = checkResultSchema(crowded);
    expect(Result.isFailure(refused) && refused.failure).toContain("too many patterns");
  });

  it("refuses at once a schema the importer would take seconds to match against itself", () => {
    // Every pattern matches every name, so the importer tests a long
    // placeholder for each pair: seconds at 300, minutes for the repeat.
    const crowd = (count: number) => {
      const names = Array.from({ length: count }, (_, index) => `p${index}`);
      const properties = Object.fromEntries(names.map((name) => [name, { type: "string" }]));
      const patterns = Array.from({ length: count }, (_, index) => `^p|^q${index}`);
      return {
        keyed: {
          type: "object",
          properties,
          patternProperties: Object.fromEntries(patterns.map((pattern) => [pattern, {}])),
        },
        listed: { allOf: [{ enum: names }, ...patterns.map((pattern) => ({ pattern }))] },
        repeated: {
          allOf: Array.from({ length: count / 2 }, () => ({
            type: "object",
            properties,
            patternProperties: { "^p": { type: "string" } },
          })),
        },
      };
    };
    const started = performance.now();
    for (const schema of Object.values(crowd(300))) {
      const refused = checkResultSchema(schema);
      expect(Result.isFailure(refused) && refused.failure).toContain("too many patterns");
    }
    // Generous for a loaded machine.
    expect(performance.now() - started).toBeLessThan(2000);
    // A schema of a realistic size compiles.
    expect(checkResultSchema(crowd(100).listed)).toEqual(Result.succeed(undefined));
    const review = {
      type: "object",
      required: ["verdict", "findings"],
      properties: {
        verdict: { enum: ["approve", "request-changes", "comment"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            required: ["file", "severity"],
            properties: {
              file: { type: "string", pattern: "^[\\w./-]+$" },
              line: { type: "integer", minimum: 1 },
              severity: { type: "string", pattern: "^P[0-3]$" },
              rule: { type: "string", pattern: "^[a-z]+(-[a-z]+)*$" },
            },
          },
        },
        labels: {
          type: "object",
          patternProperties: { "^[a-z]+$": { type: "string" } },
          additionalProperties: false,
        },
      },
    };
    const value = {
      verdict: "approve",
      findings: [{ file: "src/a.ts", line: 3, severity: "P2", rule: "no-any" }],
      labels: { area: "server" },
    };
    expect(validateStructuredResult(review, value)).toEqual(Result.succeed(value));
  });

  it("refuses at once a schema whose parts the importer would take long to combine", () => {
    const fragment = (name: string, inner: object = { type: "string" }) => ({
      type: "object",
      properties: { [name]: inner },
    });
    // Each allOf member is lowered with every name and member before it:
    // about 0.4 s at 300, cubic beyond.
    const wide = { allOf: Array.from({ length: 300 }, (_, index) => fragment(`p${index}`)) };
    // Members sharing a nested path are intersected again at every level.
    const deep = {
      allOf: Array.from({ length: 8 }, (_, index) => {
        let schema = fragment(`leaf${index}`);
        for (let level = 0; level < 8; level += 1) schema = fragment("a", schema);
        return schema;
      }),
    };
    // Each definition is two copies of the one before, intersected.
    const doubled = {
      $defs: Object.fromEntries([
        ["d0", fragment("x")],
        ...Array.from({ length: 16 }, (_, index) => [
          `d${index + 1}`,
          { allOf: [{ $ref: `#/$defs/d${index}` }, { $ref: `#/$defs/d${index}` }] },
        ]),
      ]),
      $ref: "#/$defs/d16",
    };
    for (const schema of [wide, deep, doubled]) {
      const started = performance.now();
      const refused = checkResultSchema(schema);
      expect(Result.isFailure(refused) && refused.failure).toContain(
        "too large to compile quickly",
      );
      // Generous for a loaded machine.
      expect(performance.now() - started).toBeLessThan(100);
    }
    // Composed schemas of a realistic size compile.
    const base = fragment("id");
    const tree = {
      $defs: { node: fragment("children", { type: "array", items: { $ref: "#/$defs/node" } }) },
      $ref: "#/$defs/node",
    };
    const event = {
      ...base,
      required: ["kind"],
      oneOf: Array.from({ length: 8 }, (_, index) => ({
        properties: { kind: { const: `k${index}` }, [`v${index}`]: { type: "number" } },
      })),
    };
    for (const schema of [{ allOf: [base, fragment("name"), fragment("tags")] }, tree, event]) {
      expect(checkResultSchema(schema)).toEqual(Result.succeed(undefined));
    }
    expect(validateStructuredResult(event, { kind: "k3", v3: 1 })).toEqual(
      Result.succeed({ kind: "k3", v3: 1 }),
    );
  });

  it("refuses at once a union beside a definition many paths reach, and reads a type once", () => {
    const fragment = (name: string, inner: object = { type: "string" }) => ({
      type: "object",
      properties: { [name]: inner },
    });
    // Each definition holds the one before twice. Beside a union, effect walks every path to
    // check the rest holds no choice: about 0.25 s at 21 levels, doubling with each.
    const shared = {
      $defs: Object.fromEntries([
        ["d0", fragment("x")],
        ...Array.from({ length: 21 }, (_, index) => [
          `d${index + 1}`,
          {
            type: "object",
            properties: { a: { $ref: `#/$defs/d${index}` }, b: { $ref: `#/$defs/d${index}` } },
          },
        ]),
      ]),
      $ref: "#/$defs/d21",
      anyOf: [
        { type: "object", required: ["r0"] },
        { type: "object", required: ["r1"] },
      ],
    };
    let started = performance.now();
    const refused = checkResultSchema(shared);
    expect(Result.isFailure(refused) && refused.failure).toContain("too large to compile quickly");
    expect(performance.now() - started).toBeLessThan(100);
    // Without the union the same definitions are translated once each.
    const { anyOf: _union, ...alone } = shared;
    expect(checkResultSchema(alone)).toEqual(Result.succeed(undefined));
    // A type listed twice was translated twice at each level: about 0.5 s at 15.
    let repeated: object = { type: "string" };
    for (let level = 0; level < 15; level += 1) {
      repeated = { type: ["object", "object", "null"], properties: { a: repeated } };
    }
    started = performance.now();
    expect(checkResultSchema(repeated)).toEqual(Result.succeed(undefined));
    expect(performance.now() - started).toBeLessThan(100);
    expect(validateStructuredResult(repeated, { a: null })).toEqual(Result.succeed({ a: null }));
  });

  it("keeps every other check in a schema with a pattern", () => {
    const schema = {
      type: "object",
      required: ["id", "n", "i", "tags", "names", "extra"],
      properties: {
        id: { type: "string", pattern: "^[a-z]+$", minLength: 2, maxLength: 4 },
        n: { type: "number", minimum: 1, maximum: 9, exclusiveMinimum: 0, multipleOf: 0.5 },
        i: { type: "integer", exclusiveMaximum: 10 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        names: { type: "object", propertyNames: { pattern: "^x" }, minProperties: 1 },
        extra: { type: "object", maxProperties: 1 },
      },
    };
    const good = { id: "abc", n: 1.5, i: 3, tags: ["a"], names: { x1: 1 }, extra: { any: [1] } };
    expect(validateStructuredResult(schema, good)).toEqual(Result.succeed(good));
    for (const [key, bad] of [
      ["id", "a"],
      ["id", "abcde"],
      ["id", "ABC"],
      ["n", 1.25],
      ["n", 10],
      ["i", 1.5],
      ["i", 10],
      ["tags", []],
      ["tags", ["a", "a"]],
      ["names", { y: 1 }],
      ["names", {}],
      ["extra", { a: 1, b: 2 }],
    ] as const) {
      const checked = validateStructuredResult(schema, { ...good, [key]: bad });
      expect(Result.isFailure(checked) && checked.failure).toContain(key);
    }
  });

  it("recovers the last matching JSON object from a final message", () => {
    const text = [
      "I looked at it. An aside: {not json}.",
      'Earlier draft: {"refuted": true}',
      "```json",
      '{ "refuted": false, "reason": "the test fails with \\"}\\" in output" }',
      "```",
    ].join("\n");
    expect(structuredResultFromText(VERDICT, text)).toEqual(
      Result.succeed({ refuted: false, reason: 'the test fails with "}" in output' }),
    );
    const none = structuredResultFromText(VERDICT, "No JSON here.");
    expect(Result.isFailure(none) && none.failure).toContain("no JSON");
    const wrong = structuredResultFromText(VERDICT, '{"refuted": 1}');
    expect(Result.isFailure(wrong) && wrong.failure).toContain("does not match");
  });

  it("reads a final message's last value without a field a closed object leaves out", () => {
    const closed = (properties: Record<string, object>) => ({
      type: "object",
      required: Object.keys(properties),
      properties,
      additionalProperties: false,
    });
    const ok = closed({ ok: { type: "boolean" } });
    // The value the message ends with is the result, not the one it mentions before it.
    const text = (last: string) =>
      [
        'At first I expected the answer to be {"ok": true}, but the tests disagree.',
        "",
        "```json",
        last,
        "```",
      ].join("\n");
    expect(structuredResultFromText(ok, text('{"ok": false, "reason": "two tests fail"}'))).toEqual(
      Result.succeed({ ok: false }),
    );
    // A returned value is still checked as given.
    expect(Result.isFailure(validateStructuredResult(ok, { ok: false, reason: "x" }))).toBe(true);
    // A `oneOf` branch the value matches as given still decides: only the second allows
    // `reason`, so it is kept, and the first is not taken for dropping it.
    const verdict = {
      oneOf: [ok, closed({ ok: { type: "boolean" }, reason: { type: "string" } })],
    };
    for (const last of ['{"ok": false, "reason": "two tests fail"}', '{"ok": false}']) {
      expect(structuredResultFromText(verdict, text(last))).toEqual(
        Result.succeed(JSON.parse(last)),
      );
    }
  });

  it("takes a JSON value whole, never a piece nested in it, whatever follows it", () => {
    const OK = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    const outer = { ok: false, details: { ok: true } };
    const json = '{"ok":false,"details":{"ok":true}}';
    for (const text of [
      json,
      `Result: ${json}.`,
      `Result: \`${json}\``,
      `**${json}**`,
      "```json\n" + json + "\n```",
      "```json\n" + json + "\n```\nLet me know if you need anything else.",
      `${json} "see }"`,
      `${json} and then } done`,
      `${json}\n{"ok": tru}`,
    ]) {
      expect(structuredResultFromText(OK, text)).toEqual(Result.succeed(outer));
    }
    expect(
      structuredResultFromText(
        OK,
        'Verdict:\n```json\n{"ok": false, "details": {"ok": true, "note": "\\"}\\""}}\n```\n',
      ),
    ).toEqual(Result.succeed({ ok: false, details: { ok: true, note: '"}"' } }));
    // A value that is JSON but not the result hides its pieces; an earlier value still counts.
    const wrapped = structuredResultFromText(OK, '{"result":{"ok":true}}');
    expect(Result.isFailure(wrapped) && wrapped.failure).toContain("does not match");
    expect(Result.isFailure(structuredResultFromText(OK, '[{"ok":true}, {"ok":false}]'))).toBe(
      true,
    );
    expect(structuredResultFromText(OK, '{"ok":false}\nthen {"result":{"ok":true}}')).toEqual(
      Result.succeed({ ok: false }),
    );
    // So does a bracketed span that is not JSON: a verdict with a slip in it is
    // missed rather than read from one of its pieces.
    for (const text of [
      '{"ok":false,"details":{"ok":true},}',
      'Notes {details: {"ok":true}} end',
    ]) {
      const missed = structuredResultFromText(OK, text);
      expect(Result.isFailure(missed) && missed.failure).toContain("no JSON");
    }
    // And a value too long to read whole.
    const long = `{"ok":false,"pad":"${"x".repeat(600 * 1024)}","details":{"ok":true}}`;
    expect(Result.isFailure(structuredResultFromText(OK, long))).toBe(true);
    // Prose after the value: the last matching value wins, as before.
    expect(structuredResultFromText(OK, 'Result {"ok":false}. See {"ok":true} above.')).toEqual(
      Result.succeed({ ok: true }),
    );
  });

  it("bounds the pattern work of reading a result from text, across every candidate", () => {
    const costly = {
      type: "array",
      items: {
        type: "string",
        allOf: Array.from({ length: 40 }, (_, index) => ({
          pattern: `^(?:(?:a?){400})*$${"b?".repeat(index)}`,
        })),
      },
    };
    const attempt = JSON.stringify(["a".repeat(400)]);
    const attempts = `Here are my attempts:\n${Array.from({ length: 200 }, () => attempt).join("\n")}`;
    const large = {
      type: "array",
      items: {
        type: "string",
        allOf: Array.from({ length: 9 }, (_, index) => ({
          pattern: `(?:a{${1020 - index}})?`,
        })),
      },
    };
    const empties = JSON.stringify([...Array.from({ length: 170_000 }, () => ""), 0]);
    const started = performance.now();
    // Each candidate had a budget of its own: 81 KB took about 12 s.
    const read = structuredResultFromText(costly, attempts);
    expect(Result.isFailure(read) && read.failure).toContain("too long to check");
    // As did 3.5 MB of candidates that each nearly run out.
    const many = structuredResultFromText(
      large,
      Array.from({ length: 7 }, () => empties).join("\n"),
    );
    expect(Result.isFailure(many) && many.failure).toContain("too long to check");
    // Generous for a loaded machine: about 200 ms.
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("scans a long message of unclosed brackets in bounded time", () => {
    // Each unclosed bracket once scanned to the end of the text: minutes for this one.
    const noise = "x {".repeat(150_000);
    expect(Result.isFailure(structuredResultFromText(VERDICT, noise))).toBe(true);
    expect(
      structuredResultFromText(VERDICT, `${noise}\n{"refuted": false, "reason": "r"}`),
    ).toEqual(Result.succeed({ refuted: false, reason: "r" }));
  });

  it("reads nothing from inside a value cut short or closed with the wrong bracket", () => {
    const OK = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    for (const json of [
      '{"ok":false,"details":{"ok":true}]',
      '{"ok":false,"details":{"ok":true}',
      '{"ok":false,"items":[{"x":1},{"ok":true}',
      '{"ok":false,"a":{"b":{"ok":true}}',
      '[{"ok":true}',
      // Cut short inside a string, so the inner value is that string's text.
      '{"ok":false,"note":"oops {"ok":true}',
    ]) {
      for (const text of [
        json,
        `Result: ${json}`,
        "```json\n" + json + "\n```",
        "```json\n" + json + "\n```\nLet me know if you need anything else.",
      ]) {
        const read = structuredResultFromText(OK, text);
        expect(Result.isFailure(read)).toBe(true);
        if (json.startsWith('{"ok":false,"details"') || json.includes("oops")) {
          expect(Result.isFailure(read) && read.failure).toContain("unfinished or malformed");
        }
      }
    }
    // Nor from inside one whose syntax goes wrong before it, though closing
    // its brackets would not make it valid.
    for (const json of [
      '{"ok":false "details":{"ok":true}',
      '{"ok":false,"details" {"ok":true}',
      '{"ok":false,"reason":unquoted,"details":{"ok":true}',
      '{"ok":False,"details":{"ok":true}',
      '{"ok":false,,"details":{"ok":true}',
      '[{"ok":false} {"ok":true}',
    ]) {
      for (const text of [
        json,
        `Result: ${json}`,
        "```json\n" + json + "\n```",
        "```json\n" + json + "\n```\nLet me know if you need anything else.",
      ]) {
        const read = structuredResultFromText(OK, text);
        expect(Result.isFailure(read) && read.failure).toContain("unfinished or malformed");
      }
    }
    // In a fence, a value that mismatches before the match holds it too.
    for (const json of [
      '{"ok":false,"earlier":[1},"details":{"ok":true}',
      '{"ok":false,"earlier":[1},"details":{"ok":true}}',
    ]) {
      const read = structuredResultFromText(OK, "```json\n" + json + "\n```");
      expect(Result.isFailure(read) && read.failure).toContain("unfinished or malformed");
    }
    // A fence of separate values, or of a note and a value, still gives the last.
    for (const text of [
      '```json\n{"ok":false}\n{"ok":true}\n```',
      '```\n[draft] {"ok":true}\n```',
      'Notes:\n```\nI typed { by hand {"ok":true}\n```',
    ]) {
      expect(structuredResultFromText(OK, text)).toEqual(Result.succeed({ ok: true }));
    }
    // A whole value with a stray bracket after it is read whole.
    expect(structuredResultFromText(OK, '{"ok":false,"details":{"ok":true}}]')).toEqual(
      Result.succeed({ ok: false, details: { ok: true } }),
    );
    // A result before the broken value still counts, as does one after a
    // stray bracket in prose, which begins no JSON.
    expect(
      structuredResultFromText(OK, '{"ok":false}\nThen: {"ok":true,"details":{"ok":true}'),
    ).toEqual(Result.succeed({ ok: false }));
    for (const text of [
      'I typed [ and { by hand. {"ok":true}',
      '[draft] {"ok":true}',
      'See [1, 2 and {"ok":true}',
      '{ "note": unquoted, {"ok":true}',
      'Use { to open, "quoted text {"ok":true}',
    ]) {
      expect(structuredResultFromText(OK, text)).toEqual(Result.succeed({ ok: true }));
    }
    // A label with a colon is prose, not a member, after an unclosed bracket
    // and a quoted name earlier: a diff hunk, a cut-short example or code.
    const hunk = [
      "I switched the test script to a single run:",
      "",
      "```diff",
      "@@ -5,7 +5,7 @@",
      '   "scripts": {',
      '     "build": "tsc -b",',
      '-    "test": "vitest",',
      '+    "test": "vitest run",',
      '     "lint": "oxlint"',
      "```",
      "",
    ].join("\n");
    for (const text of [
      `${hunk}Result: {"ok":true}`,
      `${hunk}Result:\n{"ok":true}`,
      'The API now responds with {"items": [ ... ] and a cursor.\n\nResult: {"ok":true}',
      'The config has {"retries": 3\nResult: {"ok":true}',
      '```python\npayload = {"name": name,\n           "tags": tags,\n```\nResult:\n{"ok":true}',
    ]) {
      expect(structuredResultFromText(OK, text)).toEqual(Result.succeed({ ok: true }));
    }
    // A bracket that mismatches after the result is not a scan running out,
    // however long the prose before it.
    for (const prefix of [0, 500 * 1024, 600 * 1024]) {
      const text = `${"x".repeat(prefix)}\n{"ok":false} [}`;
      expect(structuredResultFromText(OK, text)).toEqual(Result.succeed({ ok: false }));
    }
  });

  it("scans a megabyte of any shape in bounded time", () => {
    const OK = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    const size = 1024 * 1024;
    const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length));
    const started = performance.now();
    for (const [text, ok] of [
      [`${fill("x")}{"ok":true}`, true],
      [`${fill("[")}{"ok":true}`, false],
      [`${fill('{"a":')}{"ok":true}`, false],
      [`{"ok":false,"items":[${fill('{"ok":true},')}`, false],
      [fill('{"ok":true}'), true],
      [fill('{"ok":1}'), false],
      [fill("}"), false],
      [fill('"{'), false],
      [`${fill('"x" {')}{"ok":true}`, true],
      ["```json\n" + fill('{"ok":true}'), true],
      ["```json\n" + fill('{"a":[1},'), false],
      [fill('```\n{"ok":false "d":{"ok":true}\n'), false],
      [fill('```\n[{"ok":true}]]\n'), false],
      [fill("```\n"), false],
    ] as const) {
      expect(Result.isSuccess(structuredResultFromText(OK, text))).toBe(ok);
    }
    // Generous for a loaded machine; a quadratic scan takes minutes.
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
