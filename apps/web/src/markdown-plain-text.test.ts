import { describe, expect, it } from "vite-plus/test";

import { markdownToPlainText } from "./markdown-plain-text";

describe("markdownToPlainText", () => {
  it.each([
    ["Found **18** files", "Found 18 files"],
    ["*one* and _two_ and __three__", "one and two and three"],
    ["***both*** at once", "both at once"],
    ["Run `vp test` then ``a ` b``", "Run vp test then a ` b"],
    ["## Summary ##", "Summary"],
    ["See [the docs](https://e.org/a_(b)) and ![logo](x.png)", "See the docs and logo"],
    ["[`file.ts`](src/file.ts:12) and <https://t3.codes>", "file.ts and https://t3.codes"],
  ])("strips the syntax from %j", (markdown, plain) => {
    expect(markdownToPlainText(markdown)).toBe(plain);
  });

  it.each([
    "snake_case_name and 2 * 3 * 4",
    "#hashtag and C# code",
    "**unclosed and `unclosed",
    "* a list item",
  ])("leaves %j as written", (text) => {
    expect(markdownToPlainText(text)).toBe(text);
  });

  it("keeps code contents and escaped characters literal", () => {
    expect(markdownToPlainText("`**kwargs` and \\*not emphasis\\*")).toBe(
      "**kwargs and *not emphasis*",
    );
    expect(markdownToPlainText("# Result\n```ts\nconst a = **b**;\n```\nDone")).toBe(
      "Result\nconst a = **b**;\nDone",
    );
  });
});
