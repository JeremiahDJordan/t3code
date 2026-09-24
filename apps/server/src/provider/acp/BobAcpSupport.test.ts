import { describe, expect, it } from "@effect/vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  BOB_API_KEY_REQUIRED_MESSAGE,
  BOB_SSO_SIGN_IN_MESSAGE,
  bobAcpSpawnArgs,
  buildBobAcpSpawnInput,
  describeBobAcpSetupError,
} from "./BobAcpSupport.ts";

describe("bobAcpSpawnArgs", () => {
  it("trusts the workspace and forwards permission prompts outside Full access", () => {
    for (const runtimeMode of [
      undefined,
      "approval-required",
      "auto-accept-edits",
      "auto",
    ] as const) {
      expect(bobAcpSpawnArgs(runtimeMode)).toEqual(["acp", "--trust"]);
    }
  });

  it("auto-approves tool calls in Full access", () => {
    expect(bobAcpSpawnArgs("full-access")).toEqual(["acp", "--trust", "--auto-approve"]);
  });

  it("starts without MCP servers or subagents only when asked", () => {
    expect(bobAcpSpawnArgs(undefined, { disableMcpAndSubagents: true })).toEqual([
      "acp",
      "--trust",
      "--disable-mcp",
      "--disable-subagents",
    ]);
    expect(bobAcpSpawnArgs("full-access", { disableMcpAndSubagents: false })).toEqual([
      "acp",
      "--trust",
      "--auto-approve",
    ]);
  });
});

describe("buildBobAcpSpawnInput", () => {
  const environment = { PATH: "/usr/bin", BOB_API_KEY: "key", BOBSHELL_API_KEY: "key" };

  it("falls back to `bob` on PATH when no binary path is configured", () => {
    expect(
      buildBobAcpSpawnInput({ binaryPath: "", authMethod: "sso" }, "/tmp/project", {}),
    ).toEqual({
      command: "bob",
      args: ["acp", "--trust"],
      cwd: "/tmp/project",
      env: {},
      extendEnv: false,
    });
  });

  it("drops API keys for IBM SSO so a server-wide key cannot take over", () => {
    expect(
      buildBobAcpSpawnInput({ binaryPath: "bob", authMethod: "sso" }, "/tmp/project", environment)
        .env,
    ).toEqual({ PATH: "/usr/bin" });
  });

  it("uses the configured binary and passes the API key through", () => {
    expect(
      buildBobAcpSpawnInput(
        { binaryPath: "/opt/bob/bin/bob", authMethod: "apiKey" },
        "/tmp/project",
        environment,
        "full-access",
      ),
    ).toEqual({
      command: "/opt/bob/bin/bob",
      args: ["acp", "--trust", "--auto-approve"],
      cwd: "/tmp/project",
      env: environment,
      extendEnv: false,
    });
  });
});

describe("describeBobAcpSetupError", () => {
  it("explains how to sign in with the instance's auth method", () => {
    const error = EffectAcpErrors.AcpRequestError.authRequired();
    expect(describeBobAcpSetupError(error, "sso")).toBe(BOB_SSO_SIGN_IN_MESSAGE);
    expect(describeBobAcpSetupError(error, "apiKey")).toBe(BOB_API_KEY_REQUIRED_MESSAGE);
  });

  it("keeps Bob's license message and says how to accept it", () => {
    const error = EffectAcpErrors.AcpRequestError.invalidRequest(
      "Invalid request: A license agreement is required. Review it with --show-license and accept it with --accept-license.",
    );
    expect(describeBobAcpSetupError(error, "sso")).toBe(
      "A license agreement is required. Review it with --show-license and accept it with --accept-license. Run `bob` once in a terminal to accept it.",
    );
  });

  it("explains an untrusted workspace", () => {
    const error = EffectAcpErrors.AcpRequestError.invalidRequest(
      'Invalid request: Workspace "/tmp/project" is not trusted. Pass --trust to trust each workspace opened by this ACP server.',
    );
    expect(describeBobAcpSetupError(error, "sso")).toBe(
      'Workspace "/tmp/project" is not trusted. Pass --trust to trust each workspace opened by this ACP server. Run `bob` in the project folder and choose a trust level.',
    );
  });

  it("leaves other ACP failures to the generic mapping", () => {
    expect(
      describeBobAcpSetupError(EffectAcpErrors.AcpRequestError.invalidRequest("Bad prompt"), "sso"),
    ).toBeUndefined();
    expect(
      describeBobAcpSetupError(new EffectAcpErrors.AcpProcessExitedError({ code: 1 }), "sso"),
    ).toBeUndefined();
  });
});
