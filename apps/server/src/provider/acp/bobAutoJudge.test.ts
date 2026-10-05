// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  AppleBobAutoJudge,
  appleBobAutoJudgeProgram,
  bobAutoJudgePrompt,
  bobAutoJudgement,
  makeAppleBobAutoJudge,
  makeEndpointBobAutoJudge,
  readEndpointAnswer,
} from "./bobAutoJudge.ts";

describe("bobAutoJudgePrompt", () => {
  it("shows the model the user's latest six messages whole, and the call", () => {
    const call = "runs a command in the project folder: npm test";
    const prompt = bobAutoJudgePrompt({
      userMessages: [
        "first",
        "no web searches for the rest of this task",
        "b",
        "c",
        "d",
        "e",
        `look this up ${"x".repeat(3_900)} please`,
      ],
      call,
    });
    // A long message stays whole, and an earlier restriction stays beside it.
    assert.include(prompt, "1. no web searches for the rest of this task");
    assert.include(prompt, "please");
    assert.notInclude(prompt, "first");
    // The call comes first, so the user's messages cannot pose as part of it.
    assert.isTrue(prompt?.startsWith(`The tool call: ${call}`));
    assert.include(bobAutoJudgePrompt({ userMessages: [], call: "x" }), "(none)");
    // Messages too long to show whole are not judged, rather than judged without some of them.
    assert.isUndefined(bobAutoJudgePrompt({ userMessages: ["x".repeat(7_000)], call }));
    assert.isUndefined(bobAutoJudgePrompt({ userMessages: ["no web", "y".repeat(5_999)], call }));
  });
});

describe("bobAutoJudgement", () => {
  it("allows only a call the user asked for that is not risky", () => {
    assert.equal(bobAutoJudgement({ requested: true, risky: false }).decision, "allow");
    assert.equal(bobAutoJudgement({ requested: true, risky: true }).decision, "ask");
    assert.equal(bobAutoJudgement({ requested: false, risky: false }).decision, "ask");
  });
});

describe("readEndpointAnswer", () => {
  it("reads the answer after a thinking block or inside a code fence, and asks otherwise", () => {
    assert.equal(readEndpointAnswer('{"requested": true, "risky": false}').decision, "allow");
    assert.equal(
      readEndpointAnswer(
        '<think>{"requested": false}</think>```json\n{"action": "runs tests", "requested": true, "risky": false}\n```',
      ).decision,
      "allow",
    );
    assert.equal(readEndpointAnswer("allow").decision, "ask");
    // JSON inside prose, or after an unfinished thought, is no answer.
    assert.equal(
      readEndpointAnswer('If it were fine I would say {"requested": true, "risky": false}')
        .decision,
      "ask",
    );
    assert.equal(
      readEndpointAnswer('<think>maybe {"requested": true, "risky": false}').decision,
      "ask",
    );
    assert.equal(readEndpointAnswer('{"requested": "yes", "risky": false}').decision, "ask");
    assert.equal(readEndpointAnswer('{"requested": true}').decision, "ask");
  });
});

describe("makeEndpointBobAutoJudge", () => {
  const judgeWith = (respond: (body: string, authorization: string | undefined) => Response) => {
    const httpClient = HttpClient.make((request) =>
      Effect.promise(async () => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        return HttpClientResponse.fromWeb(request, respond(body, request.headers.authorization));
      }),
    );
    return makeEndpointBobAutoJudge({
      url: "http://localhost:11434/v1/",
      model: "qwen3:8b",
      apiKey: "key",
      httpClient,
    });
  };
  const input = { userMessages: ["run the tests"], call: "runs npm test" };

  it.effect("asks the model by chat completions and allows on its answer", () =>
    Effect.gen(function* () {
      let sent: { body: string; authorization: string | undefined } | undefined;
      const judge = judgeWith((body, authorization) => {
        sent = { body, authorization };
        return Response.json({
          choices: [{ message: { content: '{"requested": true, "risky": false}' } }],
        });
      });
      assert.equal((yield* judge.judge(input)).decision, "allow");
      const body = JSON.parse(sent?.body ?? "{}") as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      assert.equal(body.model, "qwen3:8b");
      assert.include(body.messages[1]?.content, "The tool call: runs npm test");
      assert.equal(sent?.authorization, "Bearer key");
    }),
  );

  it.effect("asks the user when the endpoint fails or does not answer in time", () =>
    Effect.gen(function* () {
      const failing = judgeWith(() => new Response("down", { status: 500 }));
      assert.equal((yield* failing.judge(input)).decision, "ask");
      const silent = makeEndpointBobAutoJudge({
        url: "http://localhost:11434/v1",
        model: "qwen3:8b",
        httpClient: HttpClient.make(() => Effect.never),
      });
      const waiting = yield* Effect.forkChild(silent.judge(input));
      yield* TestClock.adjust("7 seconds");
      assert.equal((yield* Fiber.join(waiting)).decision, "ask");
    }),
  );
});

describe("makeAppleBobAutoJudge", () => {
  const cacheDirs: Array<string> = [];
  afterAll(() => {
    for (const dir of cacheDirs) NodeFS.rmSync(dir, { recursive: true, force: true });
  });
  /** A stand-in for the compiled program, answering by the prompt's tool call. */
  const fakeProgram = (lines: string) => {
    const cacheDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bob-auto-judge-"));
    cacheDirs.push(cacheDir);
    const program = appleBobAutoJudgeProgram(cacheDir);
    NodeFS.mkdirSync(NodePath.dirname(program), { recursive: true });
    NodeFS.writeFileSync(
      program,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(__filename + ".pid", String(process.pid));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
${lines}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, prompt } = JSON.parse(line);
  if (prompt.includes("crash")) process.exit(1);
  out({ type: "verdict", id, action: "runs tests", requested: prompt.includes("npm test"), risky: false });
});
`,
      { mode: 0o755 },
    );
    return cacheDir;
  };

  it.effect("answers through the program it keeps running", () =>
    Effect.gen(function* () {
      const judge = makeAppleBobAutoJudge({
        cacheDir: fakeProgram('out({ type: "ready" });'),
        platform: "darwin",
      });
      yield* judge.warm;
      const run = { userMessages: ["run the tests"], call: "runs npm test" };
      assert.equal((yield* judge.judge(run)).decision, "allow");
      assert.equal((yield* judge.judge({ ...run, call: "runs make deploy" })).decision, "ask");
      // A program that dies mid-call asks, and the next call starts it again.
      assert.equal((yield* judge.judge({ ...run, call: "crash" })).decision, "ask");
      assert.equal((yield* judge.judge(run)).decision, "allow");
      yield* judge.close;
    }),
  );

  it.effect("asks at each call's own deadline while the model is busy", () =>
    Effect.promise(async () => {
      const cacheDir = fakeProgram('out({ type: "ready" });');
      // A program that answers each call only after a pause.
      const program = appleBobAutoJudgeProgram(cacheDir);
      NodeFS.writeFileSync(
        program,
        NodeFS.readFileSync(program, "utf8")
          .replace('  out({ type: "verdict"', '  setTimeout(() => out({ type: "verdict"')
          .replace("risky: false });", "risky: false }), 300);"),
      );
      const judge = new AppleBobAutoJudge({ cacheDir, platform: "darwin", timeoutMs: 100 });
      await judge.start();
      const run = { userMessages: ["run the tests"], call: "runs npm test" };
      const started = performance.now();
      const answers = await Promise.all([judge.judge(run), judge.judge(run), judge.judge(run)]);
      assert.deepEqual(
        answers.map((answer) => answer.decision),
        ["ask", "ask", "ask"],
      );
      assert.isBelow(performance.now() - started, 250);
      await judge.close();
    }),
  );

  it.effect("keeps no listener per call on its program", () =>
    Effect.promise(async () => {
      const judge = new AppleBobAutoJudge({
        cacheDir: fakeProgram('out({ type: "ready" });'),
        platform: "darwin",
      });
      const warnings: Array<string> = [];
      const onWarning = (warning: Error) => warnings.push(warning.name);
      process.on("warning", onWarning);
      const run = { userMessages: ["run the tests"], call: "runs npm test" };
      for (let call = 0; call < 15; call += 1) await judge.judge(run);
      await new Promise((resolve) => setImmediate(resolve));
      process.off("warning", onWarning);
      assert.notInclude(warnings, "MaxListenersExceededWarning");
      await judge.close();
    }),
  );

  it.effect("stops its program when closed, and starts none once closed", () =>
    Effect.gen(function* () {
      const cacheDir = fakeProgram('out({ type: "ready" });');
      const judge = makeAppleBobAutoJudge({ cacheDir, platform: "darwin" });
      yield* judge.warm;
      const pid = Number(NodeFS.readFileSync(`${appleBobAutoJudgeProgram(cacheDir)}.pid`, "utf8"));
      yield* judge.close;
      assert.throws(() => process.kill(pid, 0));
      const run = { userMessages: ["run the tests"], call: "runs npm test" };
      assert.equal((yield* judge.judge(run)).decision, "ask");
    }),
  );

  it.effect("asks the user when Apple's model is unavailable or the Mac is not one", () =>
    Effect.gen(function* () {
      const run = { userMessages: ["run the tests"], call: "runs npm test" };
      const unavailable = makeAppleBobAutoJudge({
        cacheDir: fakeProgram(
          'out({ type: "unavailable", reason: "appleIntelligenceNotEnabled" }); process.exit(0);',
        ),
        platform: "darwin",
      });
      assert.equal((yield* unavailable.judge(run)).decision, "ask");
      const linux = makeAppleBobAutoJudge({
        cacheDir: fakeProgram('out({ type: "ready" });'),
        platform: "linux",
      });
      assert.equal((yield* linux.judge(run)).decision, "ask");
    }),
  );
});
