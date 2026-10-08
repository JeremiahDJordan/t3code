/**
 * Messages between the server and a workflow sandbox process, one JSON object
 * per line on the process's stdin and stdout. The process marks each stretch
 * of script work with `busy` and `idle`, which is what the server times.
 */
import * as Schema from "effect/Schema";

/** The hidden CLI command that runs a sandbox process (see `bin.ts`). */
export const WORKFLOW_SANDBOX_COMMAND = "__workflow-sandbox";

/** Largest value that crosses the sandbox boundary, as JSON text. */
export const WORKFLOW_VALUE_MAX_BYTES = 1024 * 1024;

/** Longest protocol line either side accepts; a longer one is a protocol error. */
const PROTOCOL_LINE_MAX_CHARS = 8 * 1024 * 1024;

/**
 * Splits a stream's text into lines on `\n` alone. `readline` also splits on
 * U+2028 and U+2029, which `JSON.stringify` leaves unescaped inside strings,
 * so a result quoting them would arrive as undecodable halves. Returns null
 * once a line grows past the limit.
 */
export function makeLineSplitter(maxChars = PROTOCOL_LINE_MAX_CHARS) {
  let pending = "";
  return (chunk: string): ReadonlyArray<string> | null => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    if (pending.length > maxChars || lines.some((line) => line.length > maxChars)) return null;
    return lines;
  };
}

export const SandboxLimits = Schema.Struct({
  /** CPU a script may use between host calls before it is stopped. */
  cpuSliceMs: Schema.Number,
  /** CPU a run may use in all. */
  cpuTotalMs: Schema.Number,
});
export type SandboxLimits = typeof SandboxLimits.Type;

export const HostMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start"),
    mode: Schema.Literals(["meta", "run"]),
    source: Schema.String,
    /** The run's args as JSON text; absent when reading meta. */
    argsJson: Schema.optional(Schema.String),
    limits: SandboxLimits,
  }),
  Schema.Struct({
    type: Schema.Literal("settle"),
    id: Schema.Number,
    /** The call's result as JSON text, or null. */
    json: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("reject"),
    id: Schema.Number,
    message: Schema.String,
  }),
]);
export type HostMessage = typeof HostMessage.Type;

export const SandboxOp = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["phase", "log"]), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("call"),
    kind: Schema.Literals(["agent", "workspace"]),
    id: Schema.Number,
    payload: Schema.String,
  }),
]);
export type SandboxOp = typeof SandboxOp.Type;

export const SandboxMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["busy", "idle"]) }),
  Schema.Struct({ type: Schema.Literal("op"), op: SandboxOp }),
  /** The meta's or the result's JSON text. */
  Schema.Struct({ type: Schema.Literal("done"), json: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    reason: Schema.String,
    line: Schema.NullOr(Schema.Number),
  }),
]);
export type SandboxMessage = typeof SandboxMessage.Type;
