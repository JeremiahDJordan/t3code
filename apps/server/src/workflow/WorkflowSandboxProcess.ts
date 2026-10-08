// @effect-diagnostics globalDate:off - the CPU budget is checked synchronously from QuickJS's interrupt handler.
// @effect-diagnostics nodeBuiltinImport:off - a standalone process speaking line-delimited JSON on stdio.
/**
 * A workflow sandbox process: QuickJS compiled to WebAssembly, running one
 * script (or reading one script's `meta`) for the server, which starts it with
 * the hidden `__workflow-sandbox` command and talks to it over stdin/stdout
 * (WorkflowSandboxProtocol.ts). Script code only ever runs here, so a script
 * that loops in a builtin, overflows the stack or fills memory stalls or
 * breaks nothing but this process, which the server kills.
 *
 * A script sees only the globals the prelude defines; every value crossing
 * into or out of it is JSON text, bounded in size. The soft limits below stop
 * a script with its line; the server's deadlines are the hard bound.
 */
import * as NodeFS from "node:fs";
import * as NodeWorkerThreads from "node:worker_threads";

import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";

import {
  HostMessage,
  makeLineSplitter,
  type SandboxLimits,
  SandboxMessage,
  type SandboxOp,
  WORKFLOW_VALUE_MAX_BYTES,
} from "./WorkflowSandboxProtocol.ts";
import { prepareWorkflowSource } from "./WorkflowScript.ts";

/**
 * The WebAssembly heap a run may grow to, as the memory's own maximum: QuickJS's
 * memory limit cannot see allocator overhead, and its interrupt handler runs
 * too rarely to stop an allocation loop.
 */
const MEMORY_CAP_BYTES = 256 * 1024 * 1024;
const WASM_PAGE_BYTES = 64 * 1024;
// Node has WebAssembly at runtime; this package's TypeScript libs do not declare it.
const WasmMemory = (
  globalThis as unknown as {
    readonly WebAssembly: {
      readonly Memory: new (descriptor: { readonly initial: number; readonly maximum: number }) => {
        readonly buffer: ArrayBuffer;
        grow: (pages: number) => number;
      };
    };
  }
).WebAssembly.Memory;
/** The run's WebAssembly heap, at most `MEMORY_CAP_BYTES`. */
const heap = new WasmMemory({ initial: 256, maximum: MEMORY_CAP_BYTES / WASM_PAGE_BYTES });
/**
 * Whether the heap's latest attempt to grow, in the current turn of script
 * work, failed. Out of memory, QuickJS often cannot even allocate an error
 * and throws `null`; this tells that apart from a script's own `throw`. The
 * heap's size cannot: it grows in steps and never shrinks. QuickJS shrugs off
 * some failed allocations, such as growing its shape table, and those set the
 * flag too, so near the cap a script's own `throw null` can read as running
 * out of memory.
 */
let allocationFailed = false;
const growHeap = heap.grow.bind(heap);
heap.grow = (pages) => {
  try {
    const grown = growHeap(pages);
    // The allocator retries a failed grow with a smaller one; only a grow
    // that fails for good leaves the flag set.
    allocationFailed = false;
    return grown;
  } catch (error) {
    allocationFailed = true;
    throw error;
  }
};
const STACK_LIMIT_BYTES = 1024 * 1024;
/** CPU the sandbox allows itself to read a script's error. */
const HOST_READ_MS = 100;
/** `agent()` and `workspace()` calls one run may make. */
const MAX_HOST_CALLS = 5_000;
/** `log()` and `phase()` calls one run may make; later ones are dropped. */
const MAX_EMITS = 1_000;
const MAX_LOG_CHARS = 4_000;
const MAX_PHASE_CHARS = 200;
/** Jobs run between deadline checks, so a job that queues jobs cannot spin forever. */
const JOBS_PER_CHECK = 64;
const SCRIPT_FILENAME = "workflow.js";

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodeHostMessage = Schema.decodeUnknownResult(Schema.fromJsonString(HostMessage));
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(SandboxMessage));
const lineCount = (text: string) => text.split("\n").length;

class ScriptFailure {
  readonly reason: string;
  readonly line: number | null;
  constructor(reason: string, line: number | null) {
    this.reason = reason;
    this.line = line;
  }
}

/**
 * Captures what the host needs before any script code runs, so a script that
 * replaces `JSON`, `String` or prototypes cannot change how the host reads it.
 * `describe` turns any thrown value into JSON text of strings.
 */
const CAPTURE = String.raw`
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const toText = String;
  const cut = Function.prototype.call.bind(String.prototype.slice);
  const record = Object.create.bind(null, null);
  const attempt = (read) => { try { return read(); } catch { return undefined; } };
  const describe = (error) => {
    const described = record();
    const isObject = error !== null && (typeof error === "object" || typeof error === "function");
    const read = (key) => {
      const value = isObject ? attempt(() => error[key]) : undefined;
      if (typeof value === "string") described[key] = cut(value, 0, 4000);
    };
    read("name");
    read("message");
    read("stack");
    const shown = attempt(() => (isObject ? stringify(error) : toText(error)));
    if (typeof shown === "string") described.shown = cut(shown, 0, 4000);
    return stringify(described);
  };`;

/**
 * Replaces the clock: argless `Date`, `Date.now()` and `Math.random()` call
 * `unavailable`, including through `new Date(0).constructor`.
 */
const NO_CLOCK = String.raw`
  const RealDate = Date;
  function WorkflowDate(...values) {
    if (!new.target) unavailable("Date()")();
    if (values.length === 0) unavailable("new Date()")();
    return new RealDate(...values);
  }
  WorkflowDate.prototype = RealDate.prototype;
  Object.defineProperty(RealDate.prototype, "constructor", {
    value: WorkflowDate,
    writable: true,
    configurable: true,
  });
  WorkflowDate.parse = RealDate.parse;
  WorkflowDate.UTC = RealDate.UTC;
  WorkflowDate.now = unavailable("Date.now()");
  globalThis.Date = WorkflowDate;
  Math.random = unavailable("Math.random()");`;

/** Globals for a run. `__t3host` is removed once the prelude has captured it. */
const RUN_PRELUDE = String.raw`(() => {
  const host = globalThis.__t3host;
  delete globalThis.__t3host;
  ${CAPTURE}
  const unavailable = (name) => () => {
    throw new Error(name + " is not available in a workflow: reruns must replay the same calls. Pass values in args instead.");
  };
  ${NO_CLOCK}
  // Parsed, not evaluated, so a "__proto__" key stays an ordinary key.
  globalThis.args = parse(host.args);
  const toJson = (value, what) => {
    const text = stringify(value);
    if (typeof text !== "string") throw new TypeError(what + " must be JSON data.");
    return text;
  };
  const fromJson = (text) => (text === null ? null : parse(text));
  const text = (value, max) => cut(toText(value), 0, max);
  globalThis.agent = async (prompt, opts) => {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new TypeError("agent(prompt, opts) needs a non-empty prompt string.");
    }
    return fromJson(await host.call("agent", toJson({ prompt, opts: opts ?? {} }, "agent() options")));
  };
  globalThis.workspace = async (name) => fromJson(await host.call("workspace", toJson({ name }, "workspace() name")));
  globalThis.phase = (title) => { host.emit("phase", text(title, ${MAX_PHASE_CHARS})); };
  globalThis.log = (message) => { host.emit("log", text(message, ${MAX_LOG_CHARS})); };
  const MAX_ITEMS = 4096;
  const checkItems = (name, items) => {
    if (!Array.isArray(items)) throw new TypeError(name + " takes an array.");
    if (items.length > MAX_ITEMS) throw new RangeError(name + " takes at most " + MAX_ITEMS + " items.");
  };
  const report = (name, error) => {
    const reason = attempt(() => (error && typeof error.message === "string" ? error.message : toText(error)));
    host.emit("log", text(name + ": a task threw and became null: " + reason, ${MAX_LOG_CHARS}));
    return null;
  };
  globalThis.parallel = async (thunks) => {
    checkItems("parallel()", thunks);
    return Promise.all(thunks.map(async (thunk) => {
      try { return await thunk(); } catch (error) { return report("parallel()", error); }
    }));
  };
  globalThis.pipeline = async (items, ...stages) => {
    checkItems("pipeline()", items);
    return Promise.all(items.map(async (item, index) => {
      let value = item;
      try {
        for (const stage of stages) value = await stage(value, item, index);
        return value;
      } catch (error) {
        return report("pipeline()", error);
      }
    }));
  };
  globalThis.workflow = () => { throw new Error("Nested workflow() calls are not supported in T3 workflows."); };
  const serialize = (value) => (value === undefined ? "null" : toJson(value, "The workflow's result"));
  return { describe, serialize };
})()`;

/** Globals for reading `meta`: every hook, and the clock, stops the body at its first call. */
const META_PRELUDE = String.raw`(() => {
  ${CAPTURE}
  const keys = Object.keys;
  const prototypeOf = Object.getPrototypeOf;
  const descriptorOf = Object.getOwnPropertyDescriptor;
  const isArray = Array.isArray;
  const plainPrototype = Object.prototype;
  const RealSet = Set;
  const has = Function.prototype.call.bind(Set.prototype.has);
  const add = Function.prototype.call.bind(Set.prototype.add);
  const stop = () => { throw new Error("__t3_meta_read_stop"); };
  const unavailable = () => stop;
  for (const name of ["agent", "workspace", "parallel", "pipeline", "phase", "log", "workflow"]) {
    globalThis[name] = stop;
  }
  ${NO_CLOCK}
  const metaJson = () => {
    const seen = new RealSet();
    const problem = (value, path) => {
      if (value === null || typeof value === "string" || typeof value === "boolean") return null;
      if (typeof value === "number") return Number.isFinite(value) ? null : path + " is not a finite number";
      if (typeof value !== "object") return path + " is a " + typeof value + ", not data";
      if (has(seen, value)) return path + " repeats an object";
      add(seen, value);
      if (isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          const found = problem(value[index], path + "[" + index + "]");
          if (found) return found;
        }
        return null;
      }
      const prototype = prototypeOf(value);
      if (prototype !== plainPrototype && prototype !== null) return path + " is not a plain object";
      for (const key of keys(value)) {
        const descriptor = descriptorOf(value, key);
        if (!("value" in descriptor)) return path + "." + key + " is computed";
        const found = problem(descriptor.value, path + "." + key);
        if (found) return found;
      }
      return null;
    };
    const meta = globalThis.__t3meta;
    if (meta === undefined) return stringify({ missing: true });
    const found = problem(meta, "meta");
    return stringify(found ? { problem: found } : { meta });
  };
  return { describe, metaJson };
})()`;

/** Length of the `(async () => {` wrapper `prepareWorkflowSource` puts on line 1. */
const WRAPPER_PREFIX_LENGTH = "(async () => {".length;

/**
 * The 1-based script line an error's stack points at, if any. Frames inside
 * the wrapper itself (its opening on line 1, its call on the last line) say
 * nothing about the script; QuickJS reports them for code without positions.
 */
function scriptLine(stack: unknown, lastLine: number): number | null {
  if (typeof stack !== "string") return null;
  for (const match of stack.matchAll(/workflow\.js:(\d+):(\d+)/g)) {
    const line = Number(match[1]);
    const column = Number(match[2]);
    if ((line === 1 && column <= WRAPPER_PREFIX_LENGTH) || line >= lastLine) continue;
    return line;
  }
  return null;
}

type StopReason = "slice" | "total";

/** A QuickJS runtime and context with the sandbox's limits, for one run. */
function openSandbox(module: QuickJSWASMModule, limits: SandboxLimits, lastLine: number) {
  const runtime = module.newRuntime();
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  // Past by default: any script code reached outside a slice stops at
  // QuickJS's next interrupt check instead of running unbounded.
  let deadline = Number.NEGATIVE_INFINITY;
  let inScript = false;
  let sliceLimit: StopReason = "slice";
  let spentMs = 0;
  /** Why the script was stopped. A stopped run does not continue. */
  let stoppedBy: StopReason | null = null;
  runtime.setInterruptHandler(() => {
    if (Date.now() <= deadline) return false;
    if (inScript) stoppedBy ??= sliceLimit;
    return true;
  });
  const vm = runtime.newContext();
  const tools: { describe?: QuickJSHandle; finish?: QuickJSHandle } = {};

  /** Runs script work under the CPU budget, counting what it uses. */
  const slice = <A>(work: () => A): A => {
    const startedAt = Date.now();
    const remaining = Math.max(0, limits.cpuTotalMs - spentMs);
    sliceLimit = remaining < limits.cpuSliceMs ? "total" : "slice";
    deadline = startedAt + Math.min(limits.cpuSliceMs, remaining);
    inScript = true;
    try {
      return work();
    } finally {
      spentMs += Date.now() - startedAt;
      deadline = Number.NEGATIVE_INFINITY;
      inScript = false;
    }
  };
  /** Runs the host's own reads of script values under a short deadline of their own. */
  const hostRead = <A>(work: () => A): A => {
    deadline = Date.now() + HOST_READ_MS;
    try {
      return work();
    } finally {
      deadline = Number.NEGATIVE_INFINITY;
    }
  };
  /** Runs queued promise jobs a few at a time; a failing job already rejected its promise. */
  const drainJobs = () =>
    slice(() => {
      while (stoppedBy === null && runtime.hasPendingJob()) {
        if (Date.now() > deadline) {
          stoppedBy = sliceLimit;
          return;
        }
        const result = runtime.executePendingJobs(JOBS_PER_CHECK);
        if (result.error) result.error.dispose();
      }
    });
  /** A string the script's code returned, or undefined for anything else. */
  const stringOf = (handle: QuickJSHandle) => {
    const text = vm.typeof(handle) === "string" ? vm.getString(handle) : undefined;
    handle.dispose();
    return text;
  };
  const describe = (value: QuickJSHandle): Record<string, string> => {
    if (tools.describe === undefined) return {};
    const describer = tools.describe;
    const result = hostRead(() => vm.callFunction(describer, vm.undefined, value));
    if (result.error) {
      result.error.dispose();
      return {};
    }
    const text = stringOf(result.value);
    const parsed = text === undefined ? undefined : Result.getOrUndefined(decodeJson(text));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  };
  const stopped = (line: number | null) =>
    new ScriptFailure(
      stoppedBy === "total"
        ? `The script used more than ${limits.cpuTotalMs / 1000} s of CPU in all and was stopped near this line.`
        : "The script ran too long without waiting on agent() and was stopped near this line.",
      line,
    );
  /** A script error as plain fields, disposing the handle. */
  const readError = (handle: QuickJSHandle) => {
    const thrownNull = vm.eq(handle, vm.null);
    const described = describe(handle);
    handle.dispose();
    const line = scriptLine(described.stack, lastLine);
    if (stoppedBy !== null) return stopped(line);
    const name = described.name ?? "Error";
    const message = described.message ?? "";
    const outOfMemory =
      (name === "InternalError" && message === "out of memory") ||
      (allocationFailed && (thrownNull || Object.keys(described).length === 0));
    const reason = outOfMemory
      ? OUT_OF_MEMORY
      : message !== ""
        ? name === "Error"
          ? message
          : `${name}: ${message}`
        : described.name !== undefined
          ? `The script threw ${described.name} without a message.`
          : `The script threw ${described.shown ?? "a value it could not describe"}.`;
    return new ScriptFailure(reason.slice(0, 2_000), line);
  };
  /** Evaluates code under the budget. */
  const evalOrThrow = (code: string, filename: string) => {
    const result = slice(() => vm.evalCode(code, filename));
    if (result.error) throw readError(result.error);
    return result.value as QuickJSHandle;
  };
  /** Evaluates a prelude; its result object becomes the host's tools. */
  const loadPrelude = (code: string, finishName: "serialize" | "metaJson") => {
    const exported = evalOrThrow(code, "prelude.js");
    // The prelude's own object: plain data properties no script can reach.
    tools.describe = vm.getProp(exported, "describe");
    tools.finish = vm.getProp(exported, finishName);
    exported.dispose();
  };
  /** Calls the prelude's finishing function under the budget, for its JSON text. */
  const finish = (argument: QuickJSHandle) => {
    const finisher = tools.finish!;
    const result = slice(() => vm.callFunction(finisher, vm.undefined, argument));
    if (result.error) throw readError(result.error);
    const text = stringOf(result.value);
    if (text === undefined)
      throw new ScriptFailure("The workflow's result must be JSON data.", null);
    return text;
  };
  return {
    vm,
    runtime,
    slice,
    drainJobs,
    readError,
    stopped,
    evalOrThrow,
    loadPrelude,
    finish,
    isStopped: () => stoppedBy !== null,
  };
}

const prepare = (source: string) => {
  const prepared = prepareWorkflowSource(source);
  if (Result.isFailure(prepared)) {
    throw new ScriptFailure(prepared.failure.message, prepared.failure.line);
  }
  return prepared.success.body;
};

/** Reads `meta` by running the body with every hook stubbed to stop it. */
function readMeta(module: QuickJSWASMModule, source: string, limits: SandboxLimits): string {
  const body = prepare(source);
  const sandbox = openSandbox(module, limits, lineCount(body));
  sandbox.loadPrelude(META_PRELUDE, "metaJson");
  // The body is expected to stop at its first hook or fail without one;
  // only a syntax error or a limit means meta cannot be read.
  const result = sandbox.slice(() => sandbox.vm.evalCode(body, SCRIPT_FILENAME));
  if (result.error) {
    const error = sandbox.readError(result.error);
    if (sandbox.isStopped() || error.reason.startsWith("SyntaxError")) throw error;
  } else {
    result.value.dispose();
  }
  sandbox.drainJobs();
  if (sandbox.isStopped()) throw sandbox.stopped(null);
  return sandbox.finish(sandbox.vm.undefined);
}

interface Channel {
  readonly send: (message: SandboxMessage) => void;
  /** The next settle or reject from the server, or null once it is gone. */
  readonly next: () => Promise<HostMessage | null>;
}

/** Runs the script to its result's JSON text, trading host calls with the server. */
async function runScript(
  module: QuickJSWASMModule,
  input: { readonly source: string; readonly argsJson: string; readonly limits: SandboxLimits },
  channel: Channel,
): Promise<string> {
  const body = prepare(input.source);
  const sandbox = openSandbox(module, input.limits, lineCount(body));
  const { vm } = sandbox;
  const ops: Array<SandboxOp> = [];
  const pending = new Map<number, QuickJSDeferredPromise>();
  let nextId = 1;
  let emits = 0;

  /** A promise for the script, rejected at once with `message`. */
  const rejected = (deferred: QuickJSDeferredPromise, message: string) => {
    const error = vm.newError(message);
    try {
      deferred.reject(error);
    } finally {
      error.dispose();
    }
    return deferred.handle;
  };
  // Host functions run inside a script slice: the prelude calls them with
  // strings it made, and the checks keep a broken caller harmless.
  const host = vm.newObject();
  const call = vm.newFunction("call", (kindHandle, payloadHandle) => {
    const kind = vm.typeof(kindHandle) === "string" ? vm.getString(kindHandle) : "";
    const deferred = vm.newPromise();
    if (nextId > MAX_HOST_CALLS) {
      return rejected(
        deferred,
        `A workflow can make at most ${MAX_HOST_CALLS} agent() and workspace() calls.`,
      );
    }
    const payload = vm.typeof(payloadHandle) === "string" ? vm.getString(payloadHandle) : "null";
    const id = nextId++;
    if (utf8Bytes(payload) > WORKFLOW_VALUE_MAX_BYTES) {
      return rejected(deferred, `The ${kind}() input is larger than 1 MB of JSON.`);
    }
    pending.set(id, deferred);
    ops.push({ type: "call", kind: kind === "workspace" ? "workspace" : "agent", id, payload });
    return deferred.handle;
  });
  const emit = vm.newFunction("emit", (kindHandle, textHandle) => {
    if (emits > MAX_EMITS) return;
    emits += 1;
    if (emits > MAX_EMITS) {
      ops.push({
        type: "log",
        text: `The script called log() and phase() more than ${MAX_EMITS} times; later calls are ignored.`,
      });
      return;
    }
    const kind = vm.typeof(kindHandle) === "string" ? vm.getString(kindHandle) : "log";
    const text =
      vm.typeof(textHandle) === "string" ? vm.getString(textHandle).slice(0, MAX_LOG_CHARS) : "";
    ops.push({ type: kind === "phase" ? "phase" : "log", text });
  });
  vm.setProp(host, "call", call);
  vm.setProp(host, "emit", emit);
  const argsText = vm.newString(input.argsJson);
  vm.setProp(host, "args", argsText);
  argsText.dispose();
  vm.setProp(vm.global, "__t3host", host);
  call.dispose();
  emit.dispose();
  host.dispose();
  sandbox.loadPrelude(RUN_PRELUDE, "serialize");
  const main = sandbox.evalOrThrow(body, SCRIPT_FILENAME);

  /** Settles one host call, under the CPU budget: a rejection builds an Error. */
  const settle = (message: HostMessage) => {
    if (message.type === "start") return;
    // A new turn of script work: an earlier failed allocation is behind it.
    allocationFailed = false;
    const deferred = pending.get(message.id);
    if (deferred === undefined) return;
    pending.delete(message.id);
    sandbox.slice(() => {
      try {
        if (message.type === "reject") {
          rejected(deferred, message.message);
        } else if (message.json === null) {
          deferred.resolve(vm.null);
        } else {
          const value = vm.newString(message.json);
          try {
            deferred.resolve(value);
          } finally {
            value.dispose();
          }
        }
      } finally {
        deferred.dispose();
      }
    });
  };

  while (true) {
    if (sandbox.isStopped()) {
      const state = vm.getPromiseState(main);
      if (state.type === "rejected") throw sandbox.readError(state.error);
      throw sandbox.stopped(null);
    }
    sandbox.drainJobs();
    if (sandbox.isStopped()) continue;
    // Hook calls reach the server in script order.
    for (const op of ops.splice(0)) channel.send({ type: "op", op });
    if (sandbox.runtime.hasPendingJob()) continue;
    const state = vm.getPromiseState(main);
    if (state.type === "fulfilled") {
      const text = sandbox.finish(state.value);
      if (utf8Bytes(text) > WORKFLOW_VALUE_MAX_BYTES) {
        throw new ScriptFailure("The workflow's result is larger than 1 MB of JSON.", null);
      }
      return text;
    }
    if (state.type === "rejected") throw sandbox.readError(state.error);
    if (pending.size === 0) {
      throw new ScriptFailure("The script is waiting on something that can never finish.", null);
    }
    channel.send({ type: "idle" });
    const message = await channel.next();
    if (message === null) throw new ScriptFailure("The server went away.", null);
    channel.send({ type: "busy" });
    settle(message);
  }
}

const OUT_OF_MEMORY = `The script ran out of memory; a workflow may use ${MEMORY_CAP_BYTES / 1024 / 1024} MB.`;

/** Why the process itself failed, in words a script author can act on. */
function crashReason(error: unknown): string {
  if (error instanceof RangeError && /call stack/i.test(error.message)) {
    return "The script nested too deeply and overflowed the sandbox's stack.";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/out of memory|enlarge memory|memory access out of bounds/i.test(message))
    return OUT_OF_MEMORY;
  return `The workflow sandbox failed: ${message}`.slice(0, 2_000);
}

/**
 * Kills this process when the server is gone, or when one stretch of script
 * work outlasts the server's own hard deadline, from a thread of its own:
 * script work blocks the main thread, so it can never notice either.
 * `watch` holds the current stretch's start (0 when idle) and its limit, in ms.
 * Windows does not reparent orphans, so there only `kill(ppid, 0)` notices the
 * server's death, and a reused pid can hide it until stdin closes or the
 * stretch's limit passes.
 */
const WATCHDOG = String.raw`
const { workerData } = require("node:worker_threads");
const watch = new BigInt64Array(workerData.watch);
const parentPid = workerData.parentPid;
setInterval(() => {
  let parentAlive = process.ppid === parentPid;
  if (parentAlive) {
    try { process.kill(parentPid, 0); } catch { parentAlive = false; }
  }
  const since = Number(Atomics.load(watch, 0));
  const limit = Number(Atomics.load(watch, 1));
  if (!parentAlive || (since > 0 && limit > 0 && Date.now() - since > limit)) {
    process.kill(process.pid, "SIGKILL");
  }
}, 250);
`;

/** Reads host messages from stdin, line by line; a line that is not one is a protocol error. */
function hostMessages() {
  const split = makeLineSplitter();
  const queued: Array<string> = [];
  const waiting: Array<() => void> = [];
  let ended = false;
  let broken = false;
  const wake = () => {
    for (const resolve of waiting.splice(0)) resolve();
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    const lines = split(chunk);
    if (lines === null) broken = true;
    else queued.push(...lines);
    wake();
  });
  process.stdin.on("end", () => {
    ended = true;
    wake();
  });
  return async (): Promise<HostMessage | null> => {
    while (true) {
      if (broken) throw new ScriptFailure("The server sent a message that was too long.", null);
      const line = queued.shift();
      if (line !== undefined) {
        const decoded = decodeHostMessage(line);
        if (Result.isFailure(decoded)) {
          throw new ScriptFailure("The server sent a message the sandbox could not read.", null);
        }
        return decoded.success;
      }
      if (ended) return null;
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  };
}

/**
 * Writes a message before returning. Script work blocks this process's event
 * loop, so a buffered `busy` would reach the server only after the work it
 * was meant to time.
 */
function sendNow(message: SandboxMessage): void {
  const bytes = Buffer.from(`${encodeMessage(message)}\n`);
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += NodeFS.writeSync(1, bytes, offset);
    } catch (error) {
      // A full pipe; the server is reading.
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
    }
  }
}

/** The `__workflow-sandbox` command: one run or meta read, then exit. */
export async function runWorkflowSandboxProcess(): Promise<void> {
  // Stdout carries the protocol; anything else that prints goes to stderr.
  for (const method of ["log", "info", "debug", "warn"] as const) console[method] = console.error;
  const watch = new BigInt64Array(new SharedArrayBuffer(16));
  new NodeWorkerThreads.Worker(WATCHDOG, {
    eval: true,
    workerData: { watch: watch.buffer, parentPid: process.ppid },
  }).unref();
  const send = (message: SandboxMessage) => {
    if (message.type === "busy") Atomics.store(watch, 0, BigInt(Date.now()));
    if (message.type === "idle") Atomics.store(watch, 0, 0n);
    sendNow(message);
  };
  const next = hostMessages();
  // The server's startup deadline covers loading the module; its CPU
  // deadlines start at the first `busy`.
  const module = await newQuickJSWASMModuleFromVariant(
    newVariant(variant, {
      wasmMemory: heap as NonNullable<Parameters<typeof newVariant>[1]["wasmMemory"]>,
    }),
  );
  try {
    const start = await next();
    if (start === null) process.exit(0);
    if (start.type !== "start") throw new ScriptFailure("The server sent no start message.", null);
    // A little past the server's hard deadline, which normally fires first.
    Atomics.store(watch, 1, BigInt(start.limits.cpuSliceMs * 4 + 3_000));
    send({ type: "busy" });
    const json =
      start.mode === "meta"
        ? readMeta(module, start.source, start.limits)
        : await runScript(
            module,
            { source: start.source, argsJson: start.argsJson ?? "null", limits: start.limits },
            { send, next },
          );
    send({ type: "done", json });
  } catch (error) {
    send(
      error instanceof ScriptFailure
        ? { type: "failed", reason: error.reason, line: error.line }
        : { type: "failed", reason: crashReason(error), line: null },
    );
  }
  // Nothing in this process outlives the run, and every message is written.
  process.exit(0);
}
