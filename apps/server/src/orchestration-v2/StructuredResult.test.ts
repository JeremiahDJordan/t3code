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

  it("scans a long message of unclosed brackets in bounded time", () => {
    // Each unclosed bracket once scanned to the end of the text: minutes for this one.
    const noise = "x {".repeat(150_000);
    expect(Result.isFailure(structuredResultFromText(VERDICT, noise))).toBe(true);
    expect(
      structuredResultFromText(VERDICT, `${noise}\n{"refuted": false, "reason": "r"}`),
    ).toEqual(Result.succeed({ refuted: false, reason: "r" }));
  });
});
