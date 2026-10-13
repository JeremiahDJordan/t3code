import { describe, expect, it } from "vite-plus/test";

import { bobOwnApprovals } from "./bobOwnApprovals.ts";

describe("bobOwnApprovals", () => {
  it("finds nothing in Bob's defaults, which only read", () => {
    expect(bobOwnApprovals({})).toEqual([]);
    expect(bobOwnApprovals(undefined)).toEqual([]);
    expect(
      bobOwnApprovals({
        approval: {
          allowed_permissions: ["read", "execute"],
          allowedExecutors: [{ toolId: "execute_command", approvedCommands: ["cat", "git log"] }],
        },
      }),
    ).toEqual([]);
  });

  it("names what a permissive Bob approves on its own", () => {
    expect(
      bobOwnApprovals({
        approval: {
          outsideWorkspaceAllowed: true,
          allowed_permissions: ["read", "edit", "execute", "mcp", "todo"],
          allowedExecutors: [
            { toolId: "execute_command", approvedCommands: ["cat", "gh", "git", "curl", "rm"] },
          ],
        },
      }),
    ).toEqual([
      "edit files",
      "run gh, git, curl and 1 more command",
      "use MCP tools",
      "work outside the project",
    ]);
  });

  it("finds nothing once Bob's auto-approval is off", () => {
    expect(
      bobOwnApprovals({
        approval: { autoApprovalEnabled: false, allowed_permissions: ["edit", "execute"] },
      }),
    ).toEqual([]);
  });
});
