import { describe, expect, it } from "@effect/vitest";
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

  it("enforces a pattern, and refuses one it cannot check in bounded time", () => {
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
    expect(Result.isFailure(structuredResultFromText(verdict, '{"decision":"maybe"}'))).toBe(true);
    expect(structuredResultFromText(verdict, 'Done: {"decision":"reject"}')).toEqual(
      Result.succeed({ decision: "reject" }),
    );

    // A repeated group or a backreference could backtrack without bound on a value the child chose.
    for (const pattern of ["^(a+)+$", "^(\\w+\\.)*\\w+$", "^(a)\\1$", "a".repeat(257)]) {
      const refused = checkResultSchema(decision(pattern));
      expect(Result.isFailure(refused) && refused.failure).toContain("properties/decision/pattern");
      expect(Result.isFailure(validateStructuredResult(decision(pattern), { decision: "a" }))).toBe(
        true,
      );
    }
    const keyed = {
      type: "object",
      patternProperties: { "^(x+)+$": { type: "string" } },
      $defs: { enum: { type: "string", pattern: "^(y+)+$" } },
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
            default: { pattern: "(b)+" },
            examples: [{ pattern: "^(a+)+$" }],
          },
        },
      }),
    ).toEqual(Result.succeed(undefined));
  });

  it("bounds the time a pattern can take on a value the child chose", () => {
    const string = (pattern: string, extra: Record<string, unknown> = {}) => ({
      type: "object",
      required: ["v"],
      properties: { v: { type: "string", pattern, ...extra } },
    });
    const refused = (schema: unknown) => {
      const checked = checkResultSchema(schema);
      return Result.isFailure(checked) ? checked.failure : undefined;
    };
    // Chains of quantifiers backtrack polynomially in the value's length, with
    // the chain's length as the exponent: seconds for a short value.
    for (const pattern of [
      `^${"\\d+".repeat(12)}$`,
      `^${".*".repeat(10)}=$`,
      `^${"a?".repeat(25)}a{25}$`,
      `^${"\\d{1,3}".repeat(16)}$`,
      `^${"[a-z]*".repeat(5)}$`,
      // Not anchored, so the engine retries from every position: one more.
      `${"\\d+".repeat(4)}x`,
      `^a|${"\\d+".repeat(4)}x`,
    ]) {
      expect(refused(string(pattern))).toContain("properties/v/pattern");
    }
    // The rest are checked against strings the engine finishes quickly, by
    // quantifier count; a longer string fails on its length instead.
    const longest = (pattern: string, length: number) => {
      const fits = validateStructuredResult(string(pattern), { v: "1".repeat(length) });
      expect(Result.isFailure(fits) && fits.failure).not.toContain("at most");
      const over = validateStructuredResult(string(pattern), { v: "1".repeat(length + 1) });
      expect(Result.isFailure(over) && over.failure).toContain(`at most ${length}`);
    };
    longest("^\\d+$", 4096);
    longest("^\\d+-\\d+$", 4096);
    longest("^\\d+-\\d+-\\d+$", 256);
    longest("^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$", 64);
    longest("\\d+x", 4096);
    longest("\\d+\\d+x", 256);
    // A lazy modifier and a group prefix are not quantifiers of their own.
    longest("^a+?b*?c??(?:d)$", 256);
    // The schema's own, tighter limit stays.
    const tight = validateStructuredResult(string("^[a-z]+$", { maxLength: 3 }), { v: "abcd" });
    expect(Result.isFailure(tight) && tight.failure).toContain("at most 3");
    // A looser one listed after the pattern does not lift the cap.
    const loose = validateStructuredResult(string("^\\d+\\d+\\d+\\d+$", { maxLength: 1_000_000 }), {
      v: `${"1".repeat(500)}x`,
    });
    expect(Result.isFailure(loose) && loose.failure).toContain("at most 64");
    // Everyday patterns are enforced as written.
    for (const [pattern, good, bad] of [
      ["^(accept|reject)$", "accept", "maybe"],
      ["^[a-z0-9-]+$", "my-slug", "My Slug"],
      ["^\\d{4}-\\d{2}-\\d{2}$", "2026-10-10", "2026-1-10"],
      ["^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", "a.b@example.com", "not an email"],
      ["^[A-Za-z0-9._/-]+\\.tsx?$", "apps/web/src/x.tsx", "x.js"],
      ["^https?://\\S+$", "https://x.y/z", "ftp://x"],
      ["^\\p{L}+$", "héllo", "h3llo"],
      ["accept", "I accept", "I refuse"],
    ] as const) {
      expect(validateStructuredResult(string(pattern), { v: good })).toEqual(
        Result.succeed({ v: good }),
      );
      expect(Result.isFailure(validateStructuredResult(string(pattern), { v: bad }))).toBe(true);
    }
    // A property name has no length limit, so a key pattern must be linear.
    const keyed = (pattern: string) => ({
      type: "object",
      patternProperties: { [pattern]: { type: "string" } },
      additionalProperties: false,
    });
    expect(refused(keyed("^\\d+-\\d+$"))).toContain("patternProperties");
    expect(refused(keyed("x\\d+"))).toContain("patternProperties");
    expect(refused(keyed("^[a-z]+$"))).toBeUndefined();
    expect(Result.isSuccess(validateStructuredResult(keyed("^[a-z]+$"), { abc: "x" }))).toBe(true);
    expect(
      Result.isSuccess(validateStructuredResult(keyed("^[a-z]+$"), { ["a".repeat(65536)]: "x" })),
    ).toBe(true);
    // A property named like the keyword is data, left as it is.
    expect(
      validateStructuredResult(
        { type: "object", properties: { pattern: { type: "string" } } },
        { pattern: "x".repeat(10_000) },
      ),
    ).toEqual(Result.succeed({ pattern: "x".repeat(10_000) }));
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
