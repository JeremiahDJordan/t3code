import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  BOB_API_KEY_REQUIRED_MESSAGE,
  BOB_SSO_SIGN_IN_MESSAGE,
  bobAcpSpawnArgs,
  buildBobAcpSpawnInput,
  bobRewindCutIndex,
  describeBobAcpSetupError,
  moveBobTask,
  rewindBobTask,
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

  it("recognizes Bob's license and trust errors in another language by the flag they name", () => {
    // Bob 2.0.5's German and Japanese translations; the flag names stay untranslated.
    const german = EffectAcpErrors.AcpRequestError.invalidRequest(
      "Invalid request: Eine Lizenzvereinbarung ist erforderlich. Überprüfen Sie diese mit --show-license und akzeptieren Sie sie mit --accept-license.",
    );
    expect(describeBobAcpSetupError(german, "sso")).toMatch(/--accept-license\. Run `bob` once/);
    const japanese = EffectAcpErrors.AcpRequestError.invalidRequest(
      "Invalid request: ワークスペース「/tmp/project」は信頼されていません。このACPサーバーで開かれる各ワークスペースを信頼するには --trust を渡すか、このフォルダーでBob Shellを対話的に実行して信頼レベルを選択してから、ACPチャット・セッションを再度開いてください。",
    );
    expect(describeBobAcpSetupError(japanese, "sso")).toMatch(/choose a trust level\.$/);
    const japaneseLicense = EffectAcpErrors.AcpRequestError.invalidRequest(
      "Invalid request: ライセンス契約が必要です。--show-licenseで確認し、--accept-licenseで同意してください。",
    );
    expect(describeBobAcpSetupError(japaneseLicense, "sso")).toMatch(/accept it\.$/);
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

describe("moveBobTask", () => {
  const exported = {
    version: 1,
    tasks: [{ task: { id: "old" }, messages: [] }],
  };

  /** A Bob that answers each method from `answers` and records every request it gets. */
  const fakeBob = (answers: Record<string, unknown>) => {
    const requests: Array<string> = [];
    return {
      requests,
      runtime: {
        request: (method: string) =>
          Effect.suspend(() => {
            requests.push(method);
            return method in answers
              ? Effect.succeed(answers[method])
              : Effect.fail(EffectAcpErrors.AcpRequestError.methodNotFound(method));
          }),
      },
    };
  };

  it.effect("keeps the original task when Bob cannot export it", () =>
    Effect.gen(function* () {
      const bob = fakeBob({});
      expect(yield* moveBobTask(bob.runtime, "old", "/new")).toBeUndefined();
      expect(bob.requests).toEqual(["_bob/task/export"]);
    }),
  );

  it.effect("keeps the original task when the import does not return a new one", () =>
    Effect.gen(function* () {
      const bob = fakeBob({ "_bob/task/export": exported, "_bob/task/import": { sessionIds: [] } });
      expect(yield* moveBobTask(bob.runtime, "old", "/new")).toBeUndefined();
      expect(bob.requests).toEqual(["_bob/task/export", "_bob/task/import"]);
    }),
  );

  it.effect("returns the copy and leaves the original for the caller to delete once it opens", () =>
    Effect.gen(function* () {
      const bob = fakeBob({
        "_bob/task/export": exported,
        "_bob/task/import": { sessionIds: ["copy"] },
        "session/delete": {},
      });
      expect(yield* moveBobTask(bob.runtime, "old", "/new")).toBe("copy");
      expect(bob.requests).toEqual(["_bob/task/export", "_bob/task/import"]);
    }),
  );
});

describe("bobRewindCutIndex", () => {
  /** An exported Bob message, as `_bob/task/export` lists it. */
  const message = (role: string, timestamp?: number, meta: Record<string, unknown> = {}) => ({
    id: `${role}-${timestamp ?? 0}`,
    role,
    data: {
      role,
      content: "",
      _meta: { ...(timestamp === undefined ? {} : { timestamp }), ...meta },
    },
    createdAt: 1,
  });
  const messages = [
    message("system"),
    message("user", 100),
    message("assistant", 110),
    // Messages Bob adds as the user, such as a reverted-changes note, are not prompts.
    message("user", 150, { notAi: true }),
    message("user", 160, { hide: true }),
    message("user", 200),
    message("assistant", 210),
    message("user", 300),
    message("assistant", 310),
  ];

  it("cuts at the first prompt Bob stamped at or after the turn's start", () => {
    expect(bobRewindCutIndex(messages, { atMs: 120 })).toBe(5);
    expect(bobRewindCutIndex(messages, { atMs: 300 })).toBe(7);
    expect(bobRewindCutIndex(messages, { atMs: 301 })).toBeUndefined();
  });

  it("counts prompts from the end when turn start times are unknown", () => {
    expect(bobRewindCutIndex(messages, { lastTurns: 1 })).toBe(7);
    expect(bobRewindCutIndex(messages, { lastTurns: 2 })).toBe(5);
    expect(bobRewindCutIndex(messages, { lastTurns: 9 })).toBe(1);
    expect(bobRewindCutIndex(messages, { lastTurns: 0 })).toBeUndefined();
  });
});

describe("rewindBobTask", () => {
  const exportOf = (timestamps: ReadonlyArray<number>) => ({
    version: 1,
    tasks: [
      {
        task: { id: "old" },
        messages: [
          { id: "system", role: "system", data: { role: "system", content: "" } },
          ...timestamps.map((timestamp) => ({
            id: `prompt-${timestamp}`,
            role: "user",
            data: { role: "user", content: "", _meta: { timestamp } },
          })),
        ],
      },
    ],
  });
  const fakeBob = (answers: Record<string, unknown>) => {
    const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
    return {
      requests,
      runtime: {
        request: (method: string, params: unknown) =>
          Effect.suspend(() => {
            requests.push({ method, params });
            return method in answers
              ? Effect.succeed(answers[method])
              : Effect.fail(EffectAcpErrors.AcpRequestError.methodNotFound(method));
          }),
      },
    };
  };

  it.effect("imports the messages before the cut as a new task and leaves the original", () =>
    Effect.gen(function* () {
      const bob = fakeBob({
        "_bob/task/export": exportOf([100, 200]),
        "_bob/task/import": { sessionIds: ["rewound"] },
      });
      expect(yield* rewindBobTask(bob.runtime, "old", "/work", { atMs: 150 })).toEqual({
        _tag: "Rewound",
        sessionId: "rewound",
      });
      const imported = bob.requests[1]?.params as {
        readonly cwd: string;
        readonly snapshot: { readonly tasks: ReadonlyArray<{ readonly messages: unknown[] }> };
      };
      expect(bob.requests.map((request) => request.method)).toEqual([
        "_bob/task/export",
        "_bob/task/import",
      ]);
      expect(imported.cwd).toBe("/work");
      expect(imported.snapshot.tasks[0]?.messages).toHaveLength(2);
    }),
  );

  it.effect("imports nothing when the cut drops every prompt or none", () =>
    Effect.gen(function* () {
      const bob = fakeBob({ "_bob/task/export": exportOf([100, 200]) });
      expect(yield* rewindBobTask(bob.runtime, "old", "/work", { atMs: 50 })).toEqual({
        _tag: "Emptied",
      });
      expect(yield* rewindBobTask(bob.runtime, "old", "/work", { atMs: 250 })).toEqual({
        _tag: "Unchanged",
      });
      expect(bob.requests.map((request) => request.method)).toEqual([
        "_bob/task/export",
        "_bob/task/export",
      ]);
    }),
  );

  it.effect("reports a Bob that cannot export the task", () =>
    Effect.gen(function* () {
      const result = yield* rewindBobTask(fakeBob({}).runtime, "old", "/work", { atMs: 1 });
      expect(result._tag).toBe("Failed");
    }),
  );
});
