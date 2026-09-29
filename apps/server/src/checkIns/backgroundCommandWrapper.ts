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
 */
export const BACKGROUND_COMMAND_WRAPPER_SOURCE = String.raw`import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
  try {
    mkdirSync(dirname(spec.exitPath), { recursive: true });
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

const copy = (from, pane, file) =>
  from.on("data", (chunk) => {
    try { pane.write(chunk); } catch {}
    file.write(chunk);
  });
copy(child.stdout, process.stdout, files[0]);
copy(child.stderr, process.stderr, files[1]);

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
