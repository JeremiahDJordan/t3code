import { describe, expect, it } from "vite-plus/test";

import { bobRuleValue } from "./BobRulesSection.logic";

describe("bobRuleValue", () => {
  it("saves a path as typed and a command's words with single spaces", () => {
    expect(bobRuleValue("read", "  ~/.vercel ")).toEqual({ value: "~/.vercel" });
    expect(bobRuleValue("private", "./notes")).toEqual({ value: "./notes" });
    expect(bobRuleValue("write", '/tmp/say "hi"')).toEqual({ value: '/tmp/say "hi"' });
    expect(bobRuleValue("allow-command", "git   commit")).toEqual({ value: "git commit" });
  });

  it("refuses a path the sandbox would read as another", () => {
    for (const path of [
      "~/se\u0001cret",
      "/back\bspace",
      "/nul\0junk",
      "/del\u007f",
      "~/a\uD800",
    ]) {
      expect(bobRuleValue("private", path), JSON.stringify(path)).toEqual({
        error: "Enter a path without control characters.",
      });
    }
    // A whole emoji is a folder name like any other.
    expect(bobRuleValue("private", "~/😀")).toEqual({ value: "~/😀" });
  });

  it("refuses a rule to write in the home folder or above, but not to read there", () => {
    for (const path of ["/", "~", "~/", "//"]) {
      expect(bobRuleValue("write", path), path).toHaveProperty("error");
      expect(bobRuleValue("read", path), path).toEqual({ value: path });
    }
    expect(bobRuleValue("write", "~/Library/Caches/go-build")).toEqual({
      value: "~/Library/Caches/go-build",
    });
  });

  it("refuses a relative path, an empty rule and a command with operators", () => {
    expect(bobRuleValue("read", "notes")).toHaveProperty("error");
    expect(bobRuleValue("read", "   ")).toHaveProperty("error");
    expect(bobRuleValue("allow-command", "git push && rm -rf /")).toHaveProperty("error");
  });
});
