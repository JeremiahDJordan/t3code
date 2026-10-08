// @effect-diagnostics nodeBuiltinImport:off - spawns a stand-in server process to kill.
// @effect-diagnostics globalTimers:off - spaces raw writes to a sandbox process's stdin.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import * as WorkflowSandbox from "./WorkflowSandbox.ts";
import { makeLineSplitter, SandboxMessage } from "./WorkflowSandboxProtocol.ts";

const provide = Effect.provide(WorkflowSandbox.layerTest);

const noHost: WorkflowSandbox.WorkflowSandboxHost<never> = {
  agent: () => Effect.die("unused"),
  workspace: () => Effect.die("unused"),
  phase: () => Effect.void,
  log: () => Effect.void,
};

/** The script error an effect fails with. */
const failure = <A, R>(effect: Effect.Effect<A, WorkflowSandbox.WorkflowScriptError, R>) =>
  effect.pipe(Effect.asVoid, Effect.flip);

const runScript = (
  source: string,
  host = noHost,
  args: unknown = null,
  options?: WorkflowSandbox.WorkflowSandboxOptions,
) =>
  WorkflowSandbox.WorkflowSandbox.use((sandbox) =>
    sandbox.run({ source, args, host, ...(options === undefined ? {} : { options }) }),
  );

const header = "export const meta = { name: 'x' }\n";

const bin = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));

/** A stand-in sandbox process running `code`, to test the server's side of the protocol. */
const standIn = (code: string) =>
  Effect.provide(
    WorkflowSandbox.layerWithLauncher({ command: process.execPath, args: ["-e", code] }),
  );

/**
 * The real sandbox process, started directly with no server deadlines around
 * it. The first write reaches its stdin after `firstWriteMs`, the rest 300 ms
 * apart, and it is killed after 20 s. Resolves with its stdout lines, the
 * signal that ended it, and whether it had to be killed.
 */
const runSandboxDirectly = (
  writes: ReadonlyArray<string | Buffer>,
  options?: { readonly firstWriteMs?: number },
) =>
  Effect.promise(
    () =>
      new Promise<{
        readonly lines: ReadonlyArray<string>;
        readonly signal: string | null;
        readonly timedOut: boolean;
      }>((resolve) => {
        const child = NodeChildProcess.spawn(process.execPath, [bin, "__workflow-sandbox"], {
          stdio: ["pipe", "pipe", "ignore"],
        });
        let output = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, 20_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (output += chunk));
        child.stdin.on("error", () => undefined);
        child.on("close", (_code, signal) => {
          clearTimeout(timer);
          resolve({ lines: output.split("\n").filter((line) => line !== ""), signal, timedOut });
        });
        writes.forEach((write, index) =>
          setTimeout(() => child.stdin.write(write), (options?.firstWriteMs ?? 0) + index * 300),
        );
      }),
  );

const startMessage = (input: {
  readonly mode: "meta" | "run";
  readonly source: string;
  readonly cpuSliceMs?: number;
}) =>
  `${JSON.stringify({
    type: "start",
    mode: input.mode,
    source: input.source,
    argsJson: "null",
    limits: { cpuSliceMs: input.cpuSliceMs ?? 250, cpuTotalMs: 10_000 },
  })}\n`;

const decodeMessage = Schema.decodeUnknownResult(Schema.fromJsonString(SandboxMessage));

describe("WorkflowSandbox", () => {
  it.live("reads meta without running past the first hook", () =>
    Effect.gen(function* () {
      const sandbox = yield* WorkflowSandbox.WorkflowSandbox;
      const meta = yield* sandbox.readMeta(
        [
          "export const meta = { t3: 1, name: 'review', phases: [{ title: 'Review' }] }",
          "const found = await agent('look', { phase: 'Review' })",
          "throw new Error('the body ran past agent()')",
        ].join("\n"),
      );
      expect(meta).toEqual({ t3: 1, name: "review", phases: [{ title: "Review" }] });
      // A body that fails before any hook still yields its meta.
      const early = yield* sandbox.readMeta(
        "export const meta = { name: 'x', description: 'd' }\nargs.areas.map((a) => a)",
      );
      expect(early).toEqual({ name: "x", description: "d" });
    }).pipe(provide),
  );

  it.live("refuses meta that is not plain data, and scripts without meta", () =>
    Effect.gen(function* () {
      const sandbox = yield* WorkflowSandbox.WorkflowSandbox;
      const computed = yield* sandbox
        .readMeta("export const meta = { name: 'x', run() { return 1 } }")
        .pipe(failure);
      expect(computed.reason).toContain("meta.run is a function");
      const missing = yield* sandbox.readMeta("const x = 1").pipe(failure);
      expect(missing.reason).toContain("export const meta");
      const syntax = yield* sandbox
        .readMeta("export const meta = { name: 'x' }\nconst = 2")
        .pipe(failure);
      expect(syntax.reason).toContain("SyntaxError");
      expect(syntax.line).toBe(2);
    }).pipe(provide),
  );

  it.live("throws on Date.now, argless Date and Math.random, and keeps dated values", () =>
    Effect.gen(function* () {
      const header = "export const meta = { name: 'x' }\n";
      for (const expression of ["Date.now()", "new Date()", "Date()", "Math.random()"]) {
        const error = yield* runScript(`${header}return ${expression}`).pipe(failure);
        expect(error.reason).toContain("is not available in a workflow");
        expect(error.line).toBe(2);
      }
      const fixed = yield* runScript(`${header}return new Date(0).toISOString()`);
      expect(fixed).toBe("1970-01-01T00:00:00.000Z");
    }).pipe(provide),
  );

  it.live("kills a loop that never waits, reporting its line", () =>
    Effect.gen(function* () {
      const error = yield* runScript(
        "export const meta = { name: 'x' }\nlet total = 0\nfor (let i = 0; ; i++) { total = Math.max(total, i) }",
        noHost,
        null,
        { cpuSliceMs: 50 },
      ).pipe(failure);
      expect(error.reason).toContain("ran too long");
      // QuickJS checks its deadline every 10,000 operations and names the last
      // position it recorded, which for a tight loop can be an earlier line.
      expect([1, 2, 3]).toContain(error.line);
    }).pipe(provide),
  );

  it.live("runs agent calls through the host and returns the script's result", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const logs = yield* Ref.make<ReadonlyArray<string>>([]);
      const host: WorkflowSandbox.WorkflowSandboxHost<never> = {
        agent: (request, context) =>
          Ref.update(calls, (all) => [...all, { request, phase: context.phase }]).pipe(
            Effect.as(
              (request as { readonly prompt: string }).prompt === "fail"
                ? null
                : { echoed: (request as { readonly prompt: string }).prompt },
            ),
          ),
        workspace: () => Effect.die("unused"),
        phase: () => Effect.void,
        log: (message) => Ref.update(logs, (all) => [...all, message]),
      };
      const result = yield* runScript(
        [
          "export const meta = { name: 'x', phases: [{ title: 'A' }] }",
          "phase('A')",
          "const results = await parallel(args.items.map((item) => () => agent(item, { label: item })))",
          "log(`got ${results.filter(Boolean).length}`)",
          "const piped = await pipeline(['p'], (value) => agent(value), (value, item, index) => ({ value, item, index }))",
          "return { results, piped }",
        ].join("\n"),
        host,
        { items: ["one", "fail", "two"] },
      );
      expect(result).toEqual({
        results: [{ echoed: "one" }, null, { echoed: "two" }],
        piped: [{ value: { echoed: "p" }, item: "p", index: 0 }],
      });
      const recorded = yield* Ref.get(calls);
      expect(recorded[0]).toEqual({
        request: { prompt: "one", opts: { label: "one" } },
        phase: "A",
      });
      expect(yield* Ref.get(logs)).toEqual(["got 2"]);
    }).pipe(provide),
  );

  it.live("turns a failed host call into a catchable script error", () =>
    Effect.gen(function* () {
      const host: WorkflowSandbox.WorkflowSandboxHost<never> = {
        ...noHost,
        agent: () =>
          Effect.fail(new WorkflowSandbox.WorkflowScriptError({ reason: "no role", line: null })),
      };
      const caught = yield* runScript(
        "export const meta = { name: 'x' }\ntry { await agent('a') } catch (error) { return error.message }",
        host,
      );
      expect(caught).toBe("no role");
      const uncaught = yield* runScript(
        "export const meta = { name: 'x' }\nawait agent('a')",
        host,
      ).pipe(failure);
      expect(uncaught.reason).toBe("no role");
    }).pipe(provide),
  );

  it.live("bounds values crossing the sandbox", () =>
    Effect.gen(function* () {
      const host: WorkflowSandbox.WorkflowSandboxHost<never> = {
        ...noHost,
        agent: () => Effect.succeed("ok"),
      };
      const big = yield* runScript(
        "export const meta = { name: 'x' }\ntry { await agent('x'.repeat(2 * 1024 * 1024)) } catch (error) { return error.message }",
        host,
      );
      expect(big).toContain("larger than 1 MB");
      const result = yield* runScript(
        "export const meta = { name: 'x' }\nreturn 'y'.repeat(2 * 1024 * 1024)",
      ).pipe(failure);
      expect(result.reason).toContain("larger than 1 MB");
      const tooManyArgs = yield* runScript("export const meta = { name: 'x' }\nreturn 1", noHost, {
        text: "z".repeat(2 * 1024 * 1024),
      }).pipe(failure);
      expect(tooManyArgs.reason).toContain("args is larger than 1 MB");
    }).pipe(provide),
  );

  it.live("keeps script code under the CPU limit wherever the host reads its values", () =>
    Effect.gen(function* () {
      const options = { cpuSliceMs: 50 };
      const spin = "for (;;) {}";
      // Each of these once ran script code with no deadline and hung the server.
      const thrown = yield* runScript(
        `${header}throw { toJSON() { ${spin} }, get message() { ${spin} } }`,
        noHost,
        null,
        options,
      ).pipe(failure);
      expect(thrown.reason).toContain("could not describe");
      const result = yield* runScript(
        `${header}return { toJSON() { ${spin} } }`,
        noHost,
        null,
        options,
      ).pipe(failure);
      expect(result.reason).toContain("ran too long");
      const replaced = yield* runScript(
        `${header}JSON.stringify = () => { ${spin} }\nglobalThis.__t3json = () => { ${spin} }\nreturn { ok: true }`,
        noHost,
        null,
        options,
      );
      expect(replaced).toEqual({ ok: true });
      const promise = yield* runScript(`${header}throw Promise.resolve(1)`).pipe(failure);
      expect(promise.reason).toContain("The script threw");
      const sandbox = yield* WorkflowSandbox.WorkflowSandbox;
      const meta = yield* sandbox
        .readMeta(
          `${header}Object.defineProperty(globalThis, "__t3meta", { get() { ${spin} } })`,
          options,
        )
        .pipe(failure);
      expect(meta.reason).toContain("ran too long");
    }).pipe(provide),
  );

  it.live("stops promise jobs that keep queueing jobs", () =>
    Effect.gen(function* () {
      const error = yield* runScript(
        `${header}const spin = () => { Promise.resolve().then(spin); Promise.resolve().then(spin) }\nspin()\nawait new Promise(() => {})`,
        noHost,
        null,
        { cpuSliceMs: 50 },
      ).pipe(failure);
      expect(error.reason).toContain("ran too long");
    }).pipe(provide),
  );

  it.live("limits a run's CPU in all, not only per slice", () =>
    Effect.gen(function* () {
      const host: WorkflowSandbox.WorkflowSandboxHost<never> = {
        ...noHost,
        agent: () =>
          Effect.fail(new WorkflowSandbox.WorkflowScriptError({ reason: "nope", line: null })),
      };
      // Each slice stays under its limit, but the run never ends on its own.
      const error = yield* runScript(
        `${header}for (;;) {\n  let n = 0\n  for (let i = 0; i < 200000; i++) n += i\n  try { await agent("x") } catch {}\n}`,
        host,
        null,
        { cpuSliceMs: 1_000, cpuTotalMs: 200 },
      ).pipe(failure);
      expect(error.reason).toContain("CPU in all");
    }).pipe(provide),
  );

  it.live("caps log() and phase() calls and the text they carry", () =>
    Effect.gen(function* () {
      const logs = yield* Ref.make<ReadonlyArray<string>>([]);
      const host: WorkflowSandbox.WorkflowSandboxHost<never> = {
        ...noHost,
        log: (message) => Ref.update(logs, (all) => [...all, message]),
      };
      yield* runScript(
        `${header}log("y".repeat(100000))\nfor (let i = 0; i < 3000; i++) log("line " + i)`,
        host,
      );
      const recorded = yield* Ref.get(logs);
      expect(recorded[0]?.length).toBe(4_000);
      expect(recorded).toHaveLength(1_001);
      expect(recorded.at(-1)).toContain("later calls are ignored");
    }).pipe(provide),
  );

  it.live("keeps a script that overflows the stack from breaking later runs", () =>
    Effect.gen(function* () {
      const sandbox = yield* WorkflowSandbox.WorkflowSandbox;
      // Repeated, these once wedged a shared QuickJS module for every later run;
      // each run now has a process of its own.
      for (let index = 0; index < 2; index += 1) {
        yield* sandbox
          .readMeta(`${header}function f(n) { return f(n + 1) + 1 }\nf(0)`)
          .pipe(Effect.ignore);
      }
      expect(yield* runScript(`${header}return 1 + 1`)).toBe(2);
    }).pipe(provide),
  );

  it.live("kills a builtin that never checks the deadline", () =>
    Effect.gen(function* () {
      const error = yield* runScript(`${header}for (;;) "x".repeat(1 << 22)`, noHost, null, {
        cpuSliceMs: 50,
      }).pipe(failure);
      expect(error.reason).toContain("ran too long");
    }).pipe(provide),
  );

  it.live("charges script code that runs while a host call settles", () =>
    Effect.gen(function* () {
      const host: WorkflowSandbox.WorkflowSandboxHost<never> = {
        ...noHost,
        agent: () =>
          Effect.fail(new WorkflowSandbox.WorkflowScriptError({ reason: "nope", line: null })),
      };
      const error = yield* runScript(
        `${header}Object.defineProperty(Error.prototype, "message", { set() { for (;;) {} } })\ntry { await agent("x") } catch {}\nreturn "finished"`,
        host,
        null,
        { cpuSliceMs: 50 },
      ).pipe(failure);
      expect(error.reason).toContain("ran too long");
    }).pipe(provide),
  );

  it.live("stops a script that keeps memory past the cap", () =>
    Effect.gen(function* () {
      const error = yield* runScript(
        `${header}const kept = []\nfor (;;) kept.push("x".repeat(1_000_000) + kept.length)`,
        noHost,
        null,
        { cpuSliceMs: 30_000, cpuTotalMs: 60_000 },
      ).pipe(failure);
      expect(error.reason).toBe("The script ran out of memory; a workflow may use 256 MB.");
      // Small objects fill the heap until QuickJS cannot even allocate an error.
      const small = yield* runScript(
        `${header}const kept = new Map()\nfor (let i = 0; ; i++) kept.set(i, { i, s: "x" + i })`,
        noHost,
        null,
        { cpuSliceMs: 30_000, cpuTotalMs: 60_000 },
      ).pipe(failure);
      expect(small.reason).toBe("The script ran out of memory; a workflow may use 256 MB.");
    }).pipe(provide),
  );

  it.live("keeps the clock out of reach and args as plain data", () =>
    Effect.gen(function* () {
      const clock = yield* runScript(`${header}return new Date(0).constructor.now()`).pipe(failure);
      expect(clock.reason).toContain("is not available in a workflow");
      const meta = yield* WorkflowSandbox.WorkflowSandbox.use((sandbox) =>
        sandbox.readMeta("export const meta = { name: 'x', at: new Date().getTime() }"),
      ).pipe(failure);
      expect(meta.reason).toContain("meta");
      const args = yield* runScript(
        `${header}return [Object.prototype.hasOwnProperty.call(args, "__proto__"), args.polluted ?? null]`,
        noHost,
        JSON.parse('{"__proto__": {"polluted": true}, "a": 1}'),
      );
      expect(args).toEqual([true, null]);
    }).pipe(provide),
  );

  it.live("carries line and paragraph separators through every message", () =>
    Effect.gen(function* () {
      // JSON leaves U+2028 and U+2029 unescaped; a line reader that splits on
      // them once left the run waiting forever. (In script source they are line
      // terminators, so they go in a string.)
      const odd = "a\u2028b\u2029c";
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      const host: WorkflowSandbox.WorkflowSandboxHost<never> = {
        ...noHost,
        agent: (request) =>
          Ref.update(seen, (all) => [...all, (request as { readonly prompt: string }).prompt]).pipe(
            Effect.as({ echoed: odd }),
          ),
        log: (message) => Ref.update(seen, (all) => [...all, message]),
      };
      const result = yield* runScript(
        `${header}const marker = "\u2028"\nconst reply = await agent(args.text)\nlog(args.text)\nreturn { reply, text: args.text }`,
        host,
        { text: odd },
      );
      expect(result).toEqual({ reply: { echoed: odd }, text: odd });
      expect(yield* Ref.get(seen)).toEqual([odd, odd]);
      const meta = yield* WorkflowSandbox.WorkflowSandbox.use((sandbox) =>
        sandbox.readMeta(`export const meta = { name: "${odd}" }`),
      );
      expect(meta).toEqual({ name: odd });
    }).pipe(provide),
  );

  it("splits protocol lines on newlines alone and refuses an endless one", () => {
    const split = makeLineSplitter(10);
    expect(split("a\u2028b\nc")).toEqual(["a\u2028b"]);
    expect(split("d\n")).toEqual(["cd"]);
    expect(split("x".repeat(11))).toBeNull();
  });

  it.live("ends a sandbox process whose server is gone, even mid-script", () =>
    Effect.gen(function* () {
      const bin = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
      // A stand-in server: starts a sandbox on an endless loop that no soft or
      // hard limit will stop soon, reports its pid once it is busy, then dies.
      const standIn = String.raw`
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, [process.argv[1], "__workflow-sandbox"], {
          stdio: ["pipe", "pipe", "ignore"],
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          if (!chunk.includes('"busy"')) return;
          process.stdout.write(String(child.pid) + "\n", () => process.kill(process.pid, "SIGKILL"));
        });
        child.stdin.write(JSON.stringify({
          type: "start", mode: "run", argsJson: "null",
          source: "export const meta = { name: 'x' }\nfor (;;) {}",
          limits: { cpuSliceMs: 60000, cpuTotalMs: 600000 },
        }) + "\n");
      `;
      const sandboxPid = yield* Effect.promise(
        () =>
          new Promise<number>((resolve, reject) => {
            const parent = NodeChildProcess.spawn(process.execPath, ["-e", standIn, bin], {
              stdio: ["ignore", "pipe", "inherit"],
            });
            let output = "";
            parent.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
            parent.on("exit", () =>
              output.trim() === ""
                ? reject(new Error("no sandbox pid"))
                : resolve(Number(output.trim())),
            );
          }),
      );
      const alive = () => {
        try {
          process.kill(sandboxPid, 0);
          return true;
        } catch {
          return false;
        }
      };
      // Process death has no event to await here; poll the OS, briefly.
      for (let tries = 0; tries < 40 && alive(); tries += 1) yield* Effect.sleep("100 millis");
      const stillAlive = alive();
      if (stillAlive) process.kill(sandboxPid, "SIGKILL");
      expect(stillAlive).toBe(false);
    }),
  );

  it.live("fails a run whose sandbox sends a line that is not a message, or one too long", () =>
    Effect.gen(function* () {
      const garbled = yield* runScript(`${header}return 1`).pipe(
        standIn(
          `process.stdout.write('{"type":"busy"}\\nnot a message\\n'); setInterval(() => {}, 1000)`,
        ),
        failure,
      );
      expect(garbled.reason).toContain("could not read");
      const endless = yield* runScript(`${header}return 1`).pipe(
        standIn(
          `process.stdout.write('{"type":"busy"}\\n' + "x".repeat(9 * 1024 * 1024)); setInterval(() => {}, 1000)`,
        ),
        failure,
      );
      expect(endless.reason).toContain("could not read");
    }),
  );

  it.live("fails a sandbox the server sends a line that is not a message, or one too long", () =>
    Effect.gen(function* () {
      const garbled = yield* runSandboxDirectly(["not a message\n"]);
      expect(garbled.timedOut).toBe(false);
      expect(garbled.lines.at(-1)).toContain("could not read");
      const endless = yield* runSandboxDirectly(["x".repeat(9 * 1024 * 1024)]);
      expect(endless.timedOut).toBe(false);
      expect(endless.lines.at(-1)).toContain("too long");
    }),
  );

  it.live("keeps a character split across chunks whole, both ways", () =>
    Effect.gen(function* () {
      const face = "\u{1F600}";
      // Server to sandbox: the start message arrives in two pieces, mid-character.
      const start = Buffer.from(
        startMessage({ mode: "meta", source: `export const meta = { name: "${face}" }` }),
      );
      const cut = start.indexOf(Buffer.from(face)) + 2;
      // Written once the process has loaded QuickJS and is reading, so the
      // two pieces arrive as two chunks.
      const meta = yield* runSandboxDirectly([start.subarray(0, cut), start.subarray(cut)], {
        firstWriteMs: 1_500,
      });
      expect(meta.lines.at(-1)).toBe(
        JSON.stringify({ type: "done", json: JSON.stringify({ meta: { name: face } }) }),
      );
      // Sandbox to server: the result arrives the same way.
      const result = yield* runScript(`${header}return 1`).pipe(
        standIn(String.raw`
          const line = Buffer.from(JSON.stringify({ type: "done", json: JSON.stringify("${face}") }) + "\n");
          const cut = line.indexOf(Buffer.from("${face}")) + 2;
          process.stdout.write('{"type":"busy"}\n');
          process.stdout.write(line.subarray(0, cut));
          setTimeout(() => process.stdout.write(line.subarray(cut)), 100);
          setInterval(() => {}, 1000);
        `),
      );
      expect(result).toBe(face);
    }),
  );

  it.live("kills itself when one stretch of script work outlasts the server's deadline", () =>
    Effect.gen(function* () {
      // No server here to kill it, and the builtin never reaches QuickJS's own check.
      const ended = yield* runSandboxDirectly([
        startMessage({
          mode: "run",
          source: `${header}for (;;) "x".repeat(1 << 22)`,
          cpuSliceMs: 50,
        }),
      ]);
      expect(ended.lines).toEqual([JSON.stringify({ type: "busy" })]);
      expect(ended.timedOut).toBe(false);
      expect(ended.signal).toBe("SIGKILL");
    }),
  );

  it.live("does not charge the server's own work on hook calls to the script", () =>
    Effect.gen(function* () {
      const logs = yield* Ref.make(0);
      const slowHost: WorkflowSandbox.WorkflowSandboxHost<never> = {
        ...noHost,
        agent: () => Effect.succeed("ok"),
        // Together these logs take the server far longer than the script's budget.
        log: () => Effect.sleep("250 millis").pipe(Effect.andThen(Ref.update(logs, (n) => n + 1))),
      };
      // Awaiting an agent after each log ends each stretch of script work, so
      // the server handles every log inside a stretch it is timing.
      const result = yield* runScript(
        `${header}for (let i = 0; i < 15; i++) {\n  log("line " + i)\n  await agent("go")\n}\nreturn "done"`,
        slowHost,
        null,
        { cpuSliceMs: 250, cpuTotalMs: 500 },
      );
      expect(result).toBe("done");
      expect(yield* Ref.get(logs)).toBe(15);
    }).pipe(provide),
  );

  it.live("names what a script threw, even after it held a large heap", () =>
    Effect.gen(function* () {
      // The heap grows in steps and never shrinks; past about 202 MiB its size
      // alone once made every later throw read as running out of memory.
      const afterBigHeap = (thrown: string) =>
        runScript(
          `${header}const kept = []\nfor (let i = 0; i < 205; i++) kept.push("x".repeat(1 << 20) + i)\nthrow ${thrown}`,
          noHost,
          null,
          { cpuSliceMs: 30_000, cpuTotalMs: 60_000 },
        ).pipe(failure);
      expect((yield* afterBigHeap('"x"')).reason).toBe("The script threw x.");
      expect((yield* afterBigHeap("null")).reason).toBe("The script threw null.");
      // One large allocation can leave the heap where the allocator's first
      // grow fails and its smaller retry succeeds.
      const nearCap = yield* runScript(
        `${header}const kept = []\nfor (let i = 0; i < 160; i++) kept.push("x".repeat(1 << 20) + i)\nconst buffer = new ArrayBuffer(55 << 20)\nkept.push("x".repeat(12 << 20))\nthrow null`,
        noHost,
        null,
        { cpuSliceMs: 30_000, cpuTotalMs: 60_000 },
      ).pipe(failure);
      expect(nearCap.reason).toBe("The script threw null.");
      // Running out of memory is behind a script that caught it and has since
      // waited on the host, though the full heap can no longer grow.
      const recovered = yield* runScript(
        `${header}const fill = () => {\n  const kept = []\n  for (;;) kept.push("x".repeat(1 << 20) + kept.length)\n}\ntry { fill() } catch {}\nawait agent("go")\nthrow null`,
        { ...noHost, agent: () => Effect.succeed("ok") },
        null,
        { cpuSliceMs: 30_000, cpuTotalMs: 60_000 },
      ).pipe(failure);
      expect(recovered.reason).toBe("The script threw null.");
      const bare = yield* runScript(`${header}throw new Error()`).pipe(failure);
      expect(bare.reason).toBe("The script threw Error without a message.");
    }).pipe(provide),
  );

  it.live(
    "starts the sandbox without the server's environment, writing only protocol messages",
    () =>
      Effect.gen(function* () {
        process.env.T3_WORKFLOW_TEST_SECRET = "not for scripts";
        const keys = yield* runScript(`${header}return 1`).pipe(
          standIn(
            `process.stdout.write('{"type":"busy"}\\n' + JSON.stringify({ type: "done", json: JSON.stringify(Object.keys(process.env)) }) + "\\n"); setInterval(() => {}, 1000)`,
          ),
          Effect.ensuring(Effect.sync(() => delete process.env.T3_WORKFLOW_TEST_SECRET)),
        );
        expect(keys).toContain("ELECTRON_RUN_AS_NODE");
        expect(keys).not.toContain("T3_WORKFLOW_TEST_SECRET");
        expect(keys).not.toContain("HOME");
        const output = yield* runSandboxDirectly([
          startMessage({ mode: "run", source: `${header}phase("A")\nlog("hello")\nreturn 1` }),
        ]);
        expect(output.lines.map((line) => Result.isSuccess(decodeMessage(line)))).toEqual(
          output.lines.map(() => true),
        );
        expect(output.lines.at(-1)).toBe(JSON.stringify({ type: "done", json: "1" }));
      }),
  );

  it.live("fails a script that waits on nothing", () =>
    Effect.gen(function* () {
      const error = yield* runScript(
        "export const meta = { name: 'x' }\nawait new Promise(() => {})",
      ).pipe(failure);
      expect(error.reason).toContain("can never finish");
    }).pipe(provide),
  );
});
