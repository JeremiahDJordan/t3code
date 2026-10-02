import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The program each background command runs under, inside its tmux pane. The server writes it to
 * the state directory at startup, so a running command never depends on the server's install.
 *
 * It reads a spec file (and deletes it, since it holds the environment), starts the command in
 * its own process group, copies stdout and stderr to the pane and to their files, and records
 * how the command ended in `exit-status` (written to a temporary name and renamed, so a reader
 * never sees half of it). It survives its pane going away: SIGHUP is ignored and pane write
 * errors are swallowed, so the command and the files carry on. Ctrl-C in the pane and SIGTERM
 * are forwarded to the command's group.
 *
 * With a `notifyOn` pattern it also tests each output line, and appends each match to the
 * matches file as a JSON line: which stream, the byte offset where the line starts in that
 * stream's file, and the line. The server reports new matches to the agent from there, so
 * matches are recorded while the server is down too.
 */
export const BACKGROUND_COMMAND_WRAPPER_SOURCE = String.raw`import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setFlagsFromString } from "node:v8";
import { Script, createContext } from "node:vm";

// A notifyOn pattern that backtracks without end would stop this process draining the command's
// output. Past a backtrack limit V8 runs it on its linear-time engine instead, but that engine
// takes no ignore-case flag, lookahead or backreference, so matching also gets a second per
// chunk. Past that, the stream's lines stop being tested and its output keeps flowing.
setFlagsFromString("--enable-experimental-regexp-engine-on-excessive-backtracks");
const guard = new Script("run()");
const guardContext = createContext({ run: null });
const withinLimit = (run) => {
  guardContext.run = run;
  guard.runInContext(guardContext, { timeout: 1000 });
};

const specPath = process.argv[2];
const spec = JSON.parse(readFileSync(specPath, "utf8"));
try { unlinkSync(specPath); } catch {}

const startedAt = new Date().toISOString();
mkdirSync(dirname(spec.exitPath), { recursive: true });
const files = [createWriteStream(spec.stdoutPath, { flags: "a" }), createWriteStream(spec.stderrPath, { flags: "a" })];
for (const stream of [...files, process.stdout, process.stderr]) stream.on("error", () => {});

let ended = false;
const writeStatus = (status) => {
  if (ended) return;
  ended = true;
  // Never recreates the job folder: it is gone only when its thread was deleted.
  try {
    writeFileSync(spec.exitPath + ".tmp", JSON.stringify({ startedAt, endedAt: new Date().toISOString(), ...status }));
    renameSync(spec.exitPath + ".tmp", spec.exitPath);
  } catch {}
};

let child;
try {
  child = spawn(spec.shell, spec.shellArgs, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["inherit", "pipe", "pipe"],
    detached: true,
  });
} catch (error) {
  writeStatus({ code: null, signal: null, error: String(error && error.message || error) });
  process.exit(1);
}

child.on("error", (error) => {
  writeStatus({ code: null, signal: null, error: String(error && error.message || error) });
  process.exit(1);
});
if (child.pid !== undefined) {
  try { writeFileSync(spec.pidPath, String(child.pid)); } catch {}
}

// Lines are tested on their first 4 KB, so a huge line cannot stall the output behind a slow
// pattern. Every match is recorded; the server reads the file a bounded piece at a time.
const LINE_TEST_BYTES = 4096;
const watchLines = (stream) => {
  if (!spec.notifyOn) return undefined;
  const ignoreCase = spec.notifyOn.startsWith("(?i)");
  const pattern = new RegExp(ignoreCase ? spec.notifyOn.slice(4) : spec.notifyOn, ignoreCase ? "i" : "");
  let offset = 0;
  let lineStart = 0;
  let pieces = [];
  let kept = 0;
  const test = () => {
    if (kept === 0) return;
    const text = Buffer.concat(pieces).toString("utf8").replace(/\r$/, "");
    if (!pattern.test(text)) return;
    try {
      appendFileSync(spec.matchesPath, JSON.stringify({ stream, offset: lineStart, line: text.slice(0, 500) }) + "\n");
    } catch {}
  };
  return {
    data: (chunk) => {
      const base = offset;
      offset += chunk.length;
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline;
        if (kept < LINE_TEST_BYTES && end > start) {
          const piece = chunk.subarray(start, Math.min(end, start + LINE_TEST_BYTES - kept));
          pieces.push(piece);
          kept += piece.length;
        }
        if (newline === -1) return;
        test();
        pieces = [];
        kept = 0;
        start = newline + 1;
        lineStart = base + start;
      }
    },
    end: () => test(),
  };
};

const copy = (from, pane, file, lines) => {
  from.on("data", (chunk) => {
    try { pane.write(chunk); } catch {}
    file.write(chunk);
    if (!lines) return;
    try { withinLimit(() => lines.data(chunk)); } catch { lines = undefined; }
  });
  from.on("end", () => {
    if (!lines) return;
    try { withinLimit(() => lines.end()); } catch {}
  });
};
copy(child.stdout, process.stdout, files[0], watchLines("stdout"));
copy(child.stderr, process.stderr, files[1], watchLines("stderr"));

const forward = (signal) => () => {
  try { process.kill(-child.pid, signal); } catch {}
};
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
process.on("SIGHUP", () => {});

const drained = (stream) =>
  new Promise((resolve) => {
    if (stream.readableEnded || stream.destroyed) return resolve();
    stream.once("end", resolve);
    stream.once("close", resolve);
  });

// Recorded on exit, not on close: a descendant that keeps the pipes open (a server started
// with &) must not keep the command looking alive. The pipes get five seconds to drain.
child.on("exit", (code, signal) => {
  const endedAt = new Date().toISOString();
  Promise.race([
    Promise.all([drained(child.stdout), drained(child.stderr)]),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ])
    .then(() => Promise.all(files.map((file) => new Promise((resolve) => file.end(resolve)))))
    .then(() => {
      writeStatus({ code, signal, endedAt });
      process.exit(code ?? 1);
    });
});
`;

/** What the server hands the wrapper: where to run what, and where to write. */
export const BackgroundCommandSpec = Schema.Struct({
  cwd: Schema.String,
  shell: Schema.String,
  shellArgs: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  stdoutPath: Schema.String,
  stderrPath: Schema.String,
  exitPath: Schema.String,
  pidPath: Schema.String,
  /** A JavaScript regular expression; a leading `(?i)` ignores case. */
  notifyOn: Schema.NullOr(Schema.String),
  matchesPath: Schema.String,
});
export const encodeBackgroundCommandSpec = Schema.encodeSync(
  Schema.fromJsonString(BackgroundCommandSpec),
);

/** How a background command ended, as its wrapper recorded it. */
export const BackgroundCommandExit = Schema.Struct({
  code: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  error: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
});
export type BackgroundCommandExit = typeof BackgroundCommandExit.Type;

const decodeExit = Schema.decodeUnknownOption(Schema.fromJsonString(BackgroundCommandExit));

export function parseBackgroundCommandExit(text: string): BackgroundCommandExit | undefined {
  return Option.getOrUndefined(decodeExit(text));
}

/** Where a command's wrapper records the output lines that matched its `notifyOn`. */
export function backgroundCommandMatchesPath(jobDir: string): string {
  return `${jobDir}/matches.log`;
}

/** One output line that matched `notifyOn`, as the wrapper recorded it. */
export const BackgroundCommandMatch = Schema.Struct({
  stream: Schema.Literals(["stdout", "stderr"]),
  /** Where the line starts in its stream's file. */
  offset: Schema.Number,
  line: Schema.String,
});
export type BackgroundCommandMatch = typeof BackgroundCommandMatch.Type;

const decodeMatch = Schema.decodeUnknownOption(Schema.fromJsonString(BackgroundCommandMatch));

/** The matches in a piece of the matches file, skipping any line that does not parse. */
export function parseBackgroundCommandMatches(text: string): ReadonlyArray<BackgroundCommandMatch> {
  return text.split("\n").flatMap((line) => Option.toArray(decodeMatch(line)));
}

/** A `notifyOn` pattern as the wrapper compiles it: JavaScript syntax, `(?i)` ignores case. */
function compileNotifyOn(pattern: string): RegExp {
  const ignoreCase = pattern.startsWith("(?i)");
  return new RegExp(ignoreCase ? pattern.slice(4) : pattern, ignoreCase ? "i" : "");
}

/** The problem with a `notifyOn` pattern, or undefined when the wrapper can use it. */
export function notifyOnPatternProblem(pattern: string): string | undefined {
  try {
    compileNotifyOn(pattern);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** `exit 0`, `signal SIGTERM`, or the spawn error. */
export function describeBackgroundCommandExit(exit: BackgroundCommandExit): string {
  if (exit.error !== undefined) return `failed to start: ${exit.error}`;
  if (exit.signal !== null) return `signal ${exit.signal}`;
  return `exit ${exit.code ?? "unknown"}`;
}

const POSIX_SHELLS = new Set(["bash", "zsh", "sh", "dash", "ksh"]);

/**
 * The shell a command runs in: the user's login shell when it is POSIX-like, since agents write
 * POSIX commands, else bash, else sh.
 */
export function backgroundCommandShell(userShell: string | undefined, hasBash: boolean): string {
  const name = userShell?.split("/").at(-1);
  if (userShell && name && POSIX_SHELLS.has(name)) return userShell;
  return hasBash ? "/bin/bash" : "/bin/sh";
}
