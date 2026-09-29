/**
 * The relay that holds one `bob acp` for a Bob instance that runs in tmux, in a pane on T3's own
 * tmux server. The server writes it to the state directory; it runs under Node with no
 * dependencies.
 *
 * Bob talks to the relay over plain pipes; T3 talks to it over a private Unix socket, one
 * newline-delimited JSON frame per line. When T3 goes away (stopped or killed), Bob and its tool
 * calls keep running and the relay keeps what Bob says. When T3 comes back it attaches again:
 * the relay answers the ACP handshake itself (Bob is already initialized), then on `replay`
 * sends what T3 has not acknowledged and asks again what T3 left unanswered, and hands the reply
 * to the prompt that was running to T3's new request for it.
 *
 * JSON-RPC ids: T3's requests get the relay's own ids toward Bob, so the ids of a T3 that
 * restarted (which count from the start again) never meet a reply meant for the one before.
 *
 * Frames from T3: start {command,args,cwd,env,meta}, attach, replay, in {line}, ack {seq},
 * adopt, meta {meta}, settled, kill. `start`, `attach` and `kill` take the relay over from the
 * T3 that held it; `status` on any connection answers with the state and changes nothing.
 * Frames to T3: state, out {seq,line}, err {data}, exit {code,signal}.
 */
export const BOB_RELAY_SOURCE = String.raw`import { spawn } from "node:child_process";
import { chmodSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";

const socketPath = process.argv[2];
try { unlinkSync(socketPath); } catch {}

let bob = null;
let exited = null;
let conn = null;
let seq = 0;
let acked = 0;
let outBuffer = [];
let nextBobId = 1;
// Bob-side id of each request T3 sent, with the id T3 gave it (undefined once that T3 is gone).
const pending = new Map();
const cache = { initialize: null, setup: null };
const cacheKinds = new Map();
let inflight = null;
// The reply to the last prompt, until T3 says it has settled that turn.
let lastPrompt = null;
// Bob's requests T3 has not answered, by Bob's id, as Bob sent them.
const unanswered = new Map();
let adoptNext = false;
let attached = false;
// After an attach, Bob's own messages wait for the replay so they reach T3 in order.
let holding = false;
let meta = {};
let lastSeen = Date.now();

const send = (frame) => {
  if (!conn) return;
  try { conn.write(JSON.stringify(frame) + "\n"); } catch {}
};
// Bob's requests and notifications are numbered and kept until T3 acknowledges them, and
// after an attach they wait for the replay, so they reach T3 in order.
const emitOut = (line) => {
  seq += 1;
  const frame = { t: "out", seq, line };
  outBuffer.push(frame);
  if (!holding) send(frame);
};
// A reply to the connected T3's request goes straight to it, unnumbered: it means nothing to
// any other T3, and a number would acknowledge Bob's messages still waiting for the replay.
const emitReply = (line) => send({ t: "out", seq: 0, line });
const isResponse = (msg) => msg && typeof msg === "object" && "id" in msg && !("method" in msg);
const isRequest = (msg) => msg && typeof msg === "object" && "id" in msg && "method" in msg;
const toBob = (value) => {
  if (!bob || exited) return;
  try { bob.stdin.write((typeof value === "string" ? value : JSON.stringify(value)) + "\n"); } catch {}
};

const fromBob = (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { emitOut(line); return; }
  if (isResponse(msg)) {
    const key = String(msg.id);
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    const kind = cacheKinds.get(key);
    if (kind) {
      cacheKinds.delete(key);
      if ("result" in msg) cache[kind] = msg.result;
    }
    if (inflight === key) {
      inflight = null;
      lastPrompt = msg;
    }
    if (entry.t3Id === undefined) return;
    emitReply(JSON.stringify({ ...msg, id: entry.t3Id }));
    return;
  }
  if (isRequest(msg)) unanswered.set(String(msg.id), line);
  emitOut(line);
};

const answer = (id, result) => emitReply(JSON.stringify({ jsonrpc: "2.0", id, result }));

const fromT3 = (line) => {
  let msg;
  // A line cut short by a T3 that died mid-write.
  try { msg = JSON.parse(line); } catch { return; }
  if (isRequest(msg)) {
    if (attached && msg.method === "initialize" && cache.initialize) return answer(msg.id, cache.initialize);
    if (
      attached &&
      cache.setup &&
      (msg.method === "session/resume" || msg.method === "session/load" || msg.method === "session/new")
    ) {
      return answer(msg.id, cache.setup);
    }
    if (msg.method === "session/prompt" && adoptNext) {
      adoptNext = false;
      if (inflight) {
        pending.get(inflight).t3Id = msg.id;
        return;
      }
      if (lastPrompt) return emitReply(JSON.stringify({ ...lastPrompt, id: msg.id }));
      return answer(msg.id, { stopReason: "cancelled" });
    }
    const key = String(nextBobId++);
    pending.set(key, { t3Id: msg.id, method: msg.method });
    if (msg.method === "initialize") cacheKinds.set(key, "initialize");
    if (msg.method === "session/new" || msg.method === "session/resume" || msg.method === "session/load") {
      cacheKinds.set(key, "setup");
    }
    if (msg.method === "session/prompt") {
      inflight = key;
      lastPrompt = null;
    }
    return toBob({ ...msg, id: Number(key) });
  }
  if (isResponse(msg)) unanswered.delete(String(msg.id));
  toBob(line);
};

const lines = (onLine) => {
  let rest = "";
  return (chunk) => {
    rest += chunk;
    let index;
    while ((index = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, index);
      rest = rest.slice(index + 1);
      if (line.length > 0) onLine(line);
    }
  };
};

const startBob = (frame) => {
  if (bob) return;
  meta = frame.meta ?? {};
  try {
    bob = spawn(frame.command, frame.args ?? [], {
      cwd: frame.cwd,
      env: frame.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, with no terminal: a tool that asks for a password fails rather
      // than waiting on the pane.
      detached: true,
    });
  } catch (error) {
    exited = { code: null, signal: null, error: String((error && error.message) || error) };
    send(state());
    return;
  }
  // T3 waits for this state: Bob's pid, or why it could not start.
  let spawned = false;
  bob.once("spawn", () => {
    spawned = true;
    send(state());
  });
  bob.stdout.setEncoding("utf8");
  bob.stderr.setEncoding("utf8");
  bob.stdout.on("data", lines(fromBob));
  bob.stderr.on("data", (data) => send({ t: "err", data }));
  bob.stdin.on("error", () => {});
  bob.on("error", (error) => {
    if (exited) return;
    exited = { code: null, signal: null, error: String((error && error.message) || error) };
    if (!spawned) send(state());
    else if (!holding) send({ t: "exit", ...exited });
  });
  // After Bob's output is read to the end.
  bob.on("close", (code, signal) => {
    if (exited) return;
    exited = { code, signal };
    if (!holding) send({ t: "exit", ...exited });
  });
};

const killBob = () => {
  if (bob && !exited) {
    try { process.kill(-bob.pid, "SIGTERM"); } catch {}
    setTimeout(() => {
      try { process.kill(-bob.pid, "SIGKILL"); } catch {}
    }, 2000).unref();
  }
  setTimeout(() => process.exit(0), 2500).unref();
};

const state = () => ({
  t: "state",
  bobPid: bob ? bob.pid : null,
  exited,
  promptInFlight: inflight !== null,
  promptEnded: inflight === null && lastPrompt !== null,
  meta,
});

const attach = () => {
  attached = true;
  holding = true;
  // Replies to the requests of the T3 that went away mean nothing to this one.
  for (const entry of pending.values()) entry.t3Id = undefined;
  send(state());
};

const replay = () => {
  const replayed = new Set();
  for (const frame of outBuffer) {
    let msg;
    try { msg = JSON.parse(frame.line); } catch { msg = undefined; }
    if (msg && isRequest(msg)) replayed.add(String(msg.id));
    send(frame);
  }
  // Questions T3 saw but never answered, as the one that went away cannot now.
  for (const [id, line] of unanswered) {
    if (replayed.has(id)) continue;
    seq += 1;
    const frame = { t: "out", seq, line };
    outBuffer.push(frame);
    send(frame);
  }
  holding = false;
  if (exited) send({ t: "exit", ...exited });
};

const onFrame = (frame) => {
  switch (frame.t) {
    case "start": return startBob(frame);
    case "attach": return attach();
    case "replay": return replay();
    case "in": return fromT3(frame.line);
    case "ack":
      acked = Math.max(acked, frame.seq);
      outBuffer = outBuffer.filter((buffered) => buffered.seq > acked);
      return;
    case "adopt":
      adoptNext = true;
      return;
    case "meta":
      meta = { ...meta, ...frame.meta };
      return;
    case "settled":
      lastPrompt = null;
      return;
    case "kill":
      return killBob();
  }
};

const server = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.on("data", lines((line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    // A look at the state, which leaves the T3 that holds the relay alone.
    if (frame.t === "status") {
      try { socket.write(JSON.stringify(state()) + "\n"); } catch {}
      return;
    }
    if (conn !== socket) {
      // Only these take the relay over from the T3 that held it.
      if (frame.t !== "start" && frame.t !== "attach" && frame.t !== "kill") return;
      if (conn) conn.destroy();
      conn = socket;
      lastSeen = Date.now();
    }
    try { onFrame(frame); } catch {}
  }));
  socket.on("error", () => {});
  socket.on("close", () => {
    if (conn === socket) {
      conn = null;
      lastSeen = Date.now();
    }
  });
});
server.listen(socketPath, () => {
  try { chmodSync(socketPath, 0o600); } catch {}
});
process.on("SIGHUP", () => {});
process.on("exit", () => {
  try { unlinkSync(socketPath); } catch {}
});

// A relay nobody has come back to for a day gives up, stopping its Bob; one whose Bob has ended
// gives up after an hour.
setInterval(() => {
  if (!conn && Date.now() - lastSeen > 24 * 60 * 60 * 1000) killBob();
  if (!conn && exited && Date.now() - lastSeen > 60 * 60 * 1000) process.exit(0);
}, 60 * 1000).unref();
`;
