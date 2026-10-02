import { describe, expect, it } from "vite-plus/test";

import { earlierStepsText } from "./taskTranscript.ts";

describe("earlierStepsText", () => {
  it("writes each step under a heading, noting steps left out after the prompt", () => {
    expect(
      earlierStepsText({
        entries: [
          { _tag: "prompt", text: "Fix the parser." },
          { _tag: "message", text: "Reading it first." },
          { _tag: "tool", title: "Read: parser.ts", failed: true },
        ],
        omittedEntries: 3,
      }),
    ).toBe(
      [
        "── Earlier steps ──",
        "▸ Prompt\nFix the parser.",
        "▸ 3 older steps not shown",
        "▸ Note\nReading it first.",
        "▸ Read: parser.ts (failed)",
      ].join("\n\n"),
    );
  });

  it("is undefined without steps", () => {
    expect(earlierStepsText({ entries: [] })).toBeUndefined();
  });
});
