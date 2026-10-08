import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  blankNonCode,
  decodeWorkflowMeta,
  prepareWorkflowSource,
  scanClaudeScript,
  WORKFLOW_SOURCE_MAX_BYTES,
} from "./WorkflowScript.ts";

describe("WorkflowScript", () => {
  it("blanks comments and strings without moving lines", () => {
    const source = "const a = 'x // y' // note\n/* b\n c */ const t = `q ${a + `n`} r`";
    const code = blankNonCode(source);
    expect(code.length).toBe(source.length);
    expect(code.split("\n").length).toBe(3);
    expect(code).not.toContain("note");
    expect(code).not.toContain("x // y");
    expect(code).toContain("${a + ");
  });

  it("needs meta first and refuses other module syntax", () => {
    expect(
      Result.isSuccess(prepareWorkflowSource("export const meta = { name: 'x' }\nreturn 1")),
    ).toBe(true);
    const late = prepareWorkflowSource("const x = 1\nexport const meta = { name: 'x' }");
    expect(Result.isFailure(late) && late.failure.line).toBe(2);
    const imported = prepareWorkflowSource(
      "export const meta = { name: 'x' }\nimport fs from 'node:fs'",
    );
    expect(Result.isFailure(imported) && imported.failure).toEqual({
      message: "A workflow script cannot use `import`; only `meta` is exported.",
      line: 2,
    });
    // Any of JavaScript's line breaks starts a statement and ends a `//` comment.
    for (const lineBreak of ["\r", "\r\n", "\u2028", "\u2029"]) {
      const after = prepareWorkflowSource(
        `export const meta = { name: 'x' }${lineBreak}import fs from 'node:fs'`,
      );
      expect(Result.isFailure(after) && after.failure.message).toBe(
        "A workflow script cannot use `import`; only `meta` is exported.",
      );
      const afterComment = prepareWorkflowSource(
        `export const meta = { name: 'x' }\n// a note${lineBreak}export const y = 1`,
      );
      expect(Result.isFailure(afterComment) && afterComment.failure.message).toBe(
        "A workflow script cannot use `export`; only `meta` is exported.",
      );
    }
    // `export` inside a prompt string is not module syntax.
    expect(
      Result.isSuccess(
        prepareWorkflowSource("export const meta = { name: 'x' }\nawait agent('export the data')"),
      ),
    ).toBe(true);
    const huge = prepareWorkflowSource(
      `export const meta = {}\n${"x".repeat(WORKFLOW_SOURCE_MAX_BYTES)}`,
    );
    expect(Result.isFailure(huge) && huge.failure.message).toContain("at most 512 KB");
  });

  // A quadratic check takes tens of seconds on these sources; linear ones take milliseconds.
  it("checks sources near the size cap in linear time", { timeout: 10_000 }, () => {
    const meta = "export const meta = { name: 'x' }";
    // Long runs of line breaks once made the module-syntax check quadratic.
    const blankLines = prepareWorkflowSource(`${meta}${"\n".repeat(200_000)}import x from 'y'`);
    expect(Result.isFailure(blankLines) && blankLines.failure.line).toBe(200_001);
    const carriageReturns = prepareWorkflowSource(`${meta}\n${"\r".repeat(200_000)}return 1`);
    expect(Result.isSuccess(carriageReturns)).toBe(true);
    const indented = prepareWorkflowSource(`${meta};\n\n  \n\texport const y = 1`);
    expect(Result.isFailure(indented) && indented.failure).toEqual({
      message: "A workflow script cannot use `export`; only `meta` is exported.",
      line: 4,
    });

    const scan = scanClaudeScript(
      `${meta}\n${"await agent('p', { agentType: 'a' })\n".repeat(10_000)}`,
    );
    expect(scan.problems.map((problem) => problem.line)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 2),
    );
  });

  it("reports Claude features T3 cannot run, with their lines", () => {
    const scan = scanClaudeScript(
      [
        "export const meta = { name: 'x', description: 'd', phases: [{ title: 'A', model: 'opus' }] }",
        "await agent('find bugs', { model: 'haiku', isolation: 'worktree' })",
        "await agent('review', { agentType: 'code-reviewer' })",
        "while (budget.remaining() > 1000) {}",
        "await workflow('child')",
        "await agent('mention agentType: in a prompt is fine')",
        "// budget.total in a comment is fine",
        "await agent('x', { model: 'claude-opus-5-5' })",
      ].join("\n"),
    );
    expect(scan.problems.map((problem) => problem.line)).toEqual([3, 4, 5]);
    expect(scan.problems[0]?.message).toContain("agentType");
    expect(scan.models).toEqual(["haiku", "claude-opus-5-5"]);
  });

  it("decodes both dialects' meta", () => {
    const t3 = decodeWorkflowMeta({
      t3: 1,
      name: "review",
      roles: { reviewer: { driver: "codex", model: "gpt-6.1-sol", interactionMode: "plan" } },
      limits: { concurrency: 20 },
      phases: [{ title: "Review" }],
    });
    expect(Result.isSuccess(t3) && t3.success).toMatchObject({
      dialect: "t3",
      limits: { concurrency: 20 },
      phases: [{ title: "Review" }],
    });
    const claude = decodeWorkflowMeta({ name: "find-flaky", description: "Find flaky tests" });
    expect(Result.isSuccess(claude) && claude.success.dialect).toBe("claude");
    const bad = decodeWorkflowMeta({
      t3: 1,
      name: "x",
      roles: { judge: { driver: "codex", model: 3 } },
    });
    expect(Result.isFailure(bad)).toBe(true);
  });
});
