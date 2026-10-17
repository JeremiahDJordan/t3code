import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import { describe, expect, it } from "vite-plus/test";

import { acpMcpToolCallOutput } from "./adapter.ts";

describe("acpMcpToolCallOutput", () => {
  it("reads Bob's text result, so html_render shows inline", () => {
    // Captured from Bob 2.0.6: a finished MCP call's rawOutput is its text content as a string.
    const output = acpMcpToolCallOutput({
      result:
        '{"htmlRender":{"attachmentId":"render-fixture","title":"Review fixture","height":320}}',
    });
    expect(htmlRenderFromToolItem({ toolName: "t3-code.html_render", output })).toEqual({
      attachmentId: "render-fixture",
      title: "Review fixture",
      height: 320,
    });
  });

  it("keeps structured results and errors as other agents report them", () => {
    expect(acpMcpToolCallOutput({ result: { structuredContent: { ok: true } } })).toEqual({
      ok: true,
    });
    expect(acpMcpToolCallOutput({ error: { message: "boom" } })).toEqual({ error: "boom" });
  });
});
