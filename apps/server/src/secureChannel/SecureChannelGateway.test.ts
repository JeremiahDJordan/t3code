// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- The gateway is raw sockets, so its tests drive it as clients do: raw sockets, plain fetch and wall-clock message timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { afterEach, assert, describe, it, vi } from "@effect/vitest";
import { ChannelConnector, type ChannelRoute } from "@t3tools/shared/secureChannel/connector";
import {
  channelPath,
  encodeChannelKey,
  initiateChannel,
} from "@t3tools/shared/secureChannel/handshake";
import { startNodeForwarder } from "@t3tools/shared/secureChannel/nodeForwarder";
import { generateKeyPair, type KeyPair } from "@t3tools/shared/secureChannel/noise";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { WebSocketServer } from "ws";

import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as SecureChannelClients from "./SecureChannelClients.ts";
import {
  admission,
  type GatewayAdmission,
  type GatewayAdmit,
  type GatewayLimits,
  limiterKeys,
  recheckDelay,
  startSecureChannelGateway,
} from "./SecureChannelGateway.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** The server the gateway forwards to: `/echo` reports which channel client a request came from. */
async function startTarget(marks: Map<number, string>) {
  const server = NodeHttp.createServer((request, response) => {
    if (request.url === "/large") {
      const body = JSON.stringify({
        rows: Array.from({ length: 40_000 }, (_, id) => ({ id, title: "A thread" })),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
      return;
    }
    if (request.method === "POST") {
      const hash = NodeCrypto.createHash("sha256");
      let length = 0;
      request.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        length += chunk.length;
      });
      request.on("end", () => response.end(JSON.stringify({ length, sha256: hash.digest("hex") })));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        path: request.url,
        client: marks.get(request.socket.remotePort ?? -1) ?? null,
      }),
    );
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) =>
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary })),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  return { port: typeof address === "object" && address !== null ? address.port : 0 };
}

/** The tunnel's public origin, which every handshake binds; tests reach the gateway directly. */
const PUBLIC_ORIGIN = "https://quiet.example.test";
/** A message 1 by its shape alone, which counts against the limits but never handshakes. */
const FORGED = `t3c.2, ${"A".repeat(200)}`;
const HOUR = 60 * 60_000;
const paired: GatewayAdmission = { until: Date.now() + HOUR, byCode: false };

async function startGateway(options?: {
  readonly admit?: GatewayAdmit;
  readonly now?: () => number;
  readonly limits?: Partial<GatewayLimits>;
}) {
  const serverKey = generateKeyPair();
  const marks = new Map<number, string>();
  const target = await startTarget(marks);
  const gateway = await startSecureChannelGateway({
    port: 0,
    serverKey,
    origin: PUBLIC_ORIGIN,
    target: { host: "127.0.0.1", port: target.port },
    admit: options?.admit ?? (async () => paired),
    onUpstreamConnected: (local, clientKey) => marks.set(local.port, clientKey),
    onUpstreamClosed: (port) => marks.delete(port),
    ...(options?.now === undefined ? {} : { now: options.now }),
    ...(options?.limits === undefined ? {} : { limits: options.limits }),
  });
  cleanups.push(() => gateway.close());
  tunnelPort = gateway.port;
  return { serverKey, gateway, origin: PUBLIC_ORIGIN };
}

/** Where the test's stand-in tunnel delivers the public origin: the latest gateway. */
let tunnelPort = 0;

async function startClient(route: ChannelRoute) {
  const connector = new ChannelConnector({
    route,
    openSocket: (url, protocols, headers) =>
      new WebSocket(
        url.replace(PUBLIC_ORIGIN.replace("https", "wss"), `ws://127.0.0.1:${tunnelPort}`),
        {
          protocols: [...protocols],
          ...(headers === undefined ? {} : { headers }),
        },
      ),
  });
  const forwarder = await startNodeForwarder(connector);
  cleanups.push(() => forwarder.close());
  return { connector, forwarder };
}

/** Sends raw bytes to the gateway and reports everything it answers before closing. */
function probe(port: number, request: string | Buffer): Promise<number> {
  return new Promise((resolve) => {
    let received = 0;
    const socket = NodeNet.connect({ host: "127.0.0.1", port }, () => socket.write(request));
    socket.on("data", (chunk: Buffer) => (received += chunk.length));
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(received));
  });
}

function upgrade(path: string, protocols?: string, extra = ""): string {
  return [
    `GET ${path} HTTP/1.1`,
    "Host: 127.0.0.1",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...(protocols === undefined ? [] : [`Sec-WebSocket-Protocol: ${protocols}`]),
    ...(extra ? [extra] : []),
    "",
    "",
  ].join("\r\n");
}

function routeTo(origin: string, serverKey: KeyPair, extra?: Partial<ChannelRoute>): ChannelRoute {
  return { origin, serverKey: serverKey.publicKey, clientKey: generateKeyPair(), ...extra };
}

describe("secure channel gateway", () => {
  it("carries HTTP and a WebSocket through the channel, marked with the client's key", async () => {
    const { serverKey, origin } = await startGateway();
    const route = routeTo(origin, serverKey);
    const { forwarder } = await startClient(route);

    const echo = (await (await fetch(`${forwarder.origin}/echo?x=1`)).json()) as {
      path: string;
      client: string;
    };
    assert.deepStrictEqual(echo, {
      path: "/echo?x=1",
      client: encodeChannelKey(route.clientKey.publicKey),
    });

    const large = await fetch(`${forwarder.origin}/large`);
    assert.strictEqual(((await large.json()) as { rows: unknown[] }).rows.length, 40_000);

    const socket = new WebSocket(`${forwarder.origin.replace("http", "ws")}/ws`);
    const reply = await new Promise<string>((resolve, reject) => {
      socket.addEventListener("open", () => socket.send("hello through the channel"));
      socket.addEventListener("message", (event) => resolve(String(event.data)));
      socket.addEventListener("error", () => reject(new Error("The WebSocket failed.")));
    });
    socket.close();
    assert.strictEqual(reply, "hello through the channel");
  });

  it("carries a large incompressible upload intact", async () => {
    const { serverKey, origin } = await startGateway();
    const { forwarder } = await startClient(routeTo(origin, serverKey));
    const body = NodeCrypto.randomBytes(3 * 1024 * 1024);
    const response = await fetch(`${forwarder.origin}/upload`, { method: "POST", body });
    assert.deepStrictEqual(await response.json(), {
      length: body.length,
      sha256: NodeCrypto.createHash("sha256").update(body).digest("hex"),
    });
  });

  it("opens a channel for an unpaired client only with a live pairing code", async () => {
    const admit: GatewayAdmit = async ({ pairingCode }) =>
      pairingCode === "LIVECODE2345" ? { until: Date.now() + HOUR, byCode: true } : undefined;
    const { serverKey, origin } = await startGateway({ admit });
    const paired = await startClient(routeTo(origin, serverKey, { pairingCode: "LIVECODE2345" }));
    await paired.connector.connect();

    const stranger = await startClient(routeTo(origin, serverKey));
    const refused = await stranger.connector.connect().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert.include(String(refused), "couldn't connect");
  });

  it("answers nothing but a valid upgrade: every other attempt gets zero bytes and a closed socket", async () => {
    let admitted = 0;
    const { serverKey, gateway } = await startGateway({
      admit: async () => {
        admitted += 1;
        return undefined;
      },
    });
    const path = channelPath(serverKey.publicKey);
    // A fresh message 1 per probe, so the replay check can't stand in for the one under test.
    const fresh = (origin = PUBLIC_ORIGIN) =>
      initiateChannel({
        origin,
        serverKey: serverKey.publicKey,
        clientKey: generateKeyPair(),
      }).protocols.join(", ");
    const stale = initiateChannel({
      origin: PUBLIC_ORIGIN,
      serverKey: serverKey.publicKey,
      clientKey: generateKeyPair(),
      now: () => Date.now() - 10 * 60_000,
    }).protocols.join(", ");
    const attempts = {
      plainGet: "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
      hostless: "GET / HTTP/1.1\r\n\r\n",
      hostlessUpgrade: upgrade(path, fresh()).replace("Host: 127.0.0.1\r\n", ""),
      paddedMessage: upgrade(path, `${fresh()}=`),
      // An older client's wire format, whose data frames would reach the server garbled.
      oldProtocol: upgrade(path, fresh().replace("t3c.2", "t3c.1")),
      // Bound to a hostname the client claims, which a tunnel's `Host` would carry.
      otherOrigin: upgrade(
        path,
        fresh("https://attacker.example"),
        "X-Forwarded-Proto: https",
      ).replace("Host: 127.0.0.1", "Host: attacker.example"),
      channelPathWithoutUpgrade: `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
      continueExpected: `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nExpect: 100-continue\r\nContent-Length: 10\r\n\r\n`,
      malformed: "NOT HTTP AT ALL\r\n\r\n",
      wrongPath: upgrade("/somewhere-else", fresh()),
      wrongMethod: upgrade(path, fresh()).replace("GET ", "PUT "),
      noMessage: upgrade(path),
      onlyProtocol: upgrade(path, "t3c.2"),
      garbled: upgrade(path, `t3c.2, ${"A".repeat(150)}`),
      stale: upgrade(path, stale),
      notAdmitted: upgrade(path, fresh()),
    };
    for (const [name, request] of Object.entries(attempts)) {
      assert.strictEqual(await probe(gateway.port, request), 0, name);
    }
    // Only the well-formed, fresh messages 1 reached the admission check: the one never admitted,
    // and the one without `Host`, which the gateway never reads.
    assert.strictEqual(admitted, 2);
  });

  it("ignores an address that keeps trying, even with a valid message", async () => {
    const { serverKey, gateway, origin } = await startGateway();
    const path = channelPath(serverKey.publicKey);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      assert.strictEqual(await probe(gateway.port, upgrade(path, FORGED)), 0);
    }
    const { connector } = await startClient(routeTo(origin, serverKey));
    const refused = await connector.connect().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert.isDefined(refused);
  });

  it("answers a message 1 once, and drops it when replayed", async () => {
    const { serverKey, gateway } = await startGateway();
    const path = channelPath(serverKey.publicKey);
    const protocols = initiateChannel({
      origin: PUBLIC_ORIGIN,
      serverKey: serverKey.publicKey,
      clientKey: generateKeyPair(),
    }).protocols.join(", ");
    const first = await new Promise<string>((resolve) => {
      const socket = NodeNet.connect({ host: "127.0.0.1", port: gateway.port }, () =>
        socket.write(upgrade(path, protocols)),
      );
      socket.once("data", (chunk: Buffer) => {
        resolve(chunk.toString("latin1").split("\r\n")[0] ?? "");
        socket.destroy();
      });
    });
    assert.strictEqual(first, "HTTP/1.1 101 Switching Protocols");
    assert.strictEqual(await probe(gateway.port, upgrade(path, protocols)), 0);
  });

  it("fails closed when the gateway isn't the server the client pinned", async () => {
    // An impostor answering at any path, as an attacker at the tunnel's edge could.
    const impostor = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      handleProtocols: () => "t3c.2",
    });
    impostor.on("connection", (socket) => socket.send(NodeCrypto.randomBytes(80)));
    cleanups.push(() => new Promise<void>((resolve) => impostor.close(() => resolve())));
    await new Promise<void>((resolve) => impostor.once("listening", resolve));
    const address = impostor.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const { connector, forwarder } = await startClient(
      routeTo(`http://127.0.0.1:${port}`, generateKeyPair()),
    );

    const failure = await connector.connect().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert.include(String(failure), "doesn't match");
    const request = await fetch(`${forwarder.origin}/echo`).then(
      () => "answered",
      () => "failed",
    );
    assert.strictEqual(request, "failed");
  });

  it("closes a revoked client's channels", async () => {
    const { serverKey, gateway, origin } = await startGateway();
    const route = routeTo(origin, serverKey);
    const { forwarder } = await startClient(route);
    const socket = new WebSocket(`${forwarder.origin.replace("http", "ws")}/ws`);
    await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve()),
    );
    gateway.closeClient(encodeChannelKey(route.clientKey.publicKey));
    await closed;
  });

  it("counts attempts only at the channel's path, so a scanner can't lock a client out", async () => {
    const { serverKey, gateway, origin } = await startGateway();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      assert.strictEqual(await probe(gateway.port, upgrade("/", "t3c.2, AAAA")), 0);
    }
    const { connector } = await startClient(routeTo(origin, serverKey));
    await connector.connect();
  });

  it("admits at most two channels on one pairing code", async () => {
    const admit: GatewayAdmit = async () => ({ until: Date.now() + HOUR, byCode: true });
    const { serverKey, origin } = await startGateway({ admit });
    const withCode = () => startClient(routeTo(origin, serverKey, { pairingCode: "LIVECODE2345" }));
    await (await withCode()).connector.connect();
    await (await withCode()).connector.connect();
    const third = await (await withCode()).connector.connect().then(
      () => "connected",
      () => "refused",
    );
    assert.strictEqual(third, "refused");
  });

  it("closes a code's channels once the code is used up, keeping the one whose key it paired", async () => {
    const pairedKeys = new Set<string>();
    let codeLive = true;
    const admit: GatewayAdmit = async ({ clientKey }) =>
      pairedKeys.has(clientKey)
        ? paired
        : codeLive
          ? { until: Date.now() + HOUR, byCode: true }
          : undefined;
    const { serverKey, gateway, origin } = await startGateway({ admit });
    const device = routeTo(origin, serverKey, { pairingCode: "LIVECODE2345" });
    const onlooker = routeTo(origin, serverKey, { pairingCode: "LIVECODE2345" });
    const deviceSocket = await openSocketThrough(await startClient(device));
    const onlookerSocket = await openSocketThrough(await startClient(onlooker));

    pairedKeys.add(encodeChannelKey(device.clientKey.publicKey));
    codeLive = false;
    const onlookerClosed = closedEvent(onlookerSocket);
    await gateway.recheckPairings();
    await onlookerClosed;
    assert.strictEqual(deviceSocket.readyState, WebSocket.OPEN);
    deviceSocket.close();
  });

  it("closes a channel once its admission runs out, and forgets its address", async () => {
    let asked = 0;
    const lapsing = generateKeyPair();
    const lapsingKey = encodeChannelKey(lapsing.publicKey);
    const admit: GatewayAdmit = async ({ clientKey }) =>
      clientKey !== lapsingKey
        ? paired
        : (asked += 1) === 1
          ? { until: Date.now(), byCode: false }
          : undefined;
    const { serverKey, gateway, origin } = await startGateway({
      admit,
      limits: { strangerAttemptsPerMinute: 2 },
    });
    const from = { "cf-connecting-ip": "203.0.113.80" };
    const socket = await openSocketThrough(
      await startClient(routeTo(origin, serverKey, { clientKey: lapsing, headers: from })),
    );
    await closedEvent(socket);
    assert.isAtLeast(asked, 2);

    // The address it made known is a stranger again once the cap is spent.
    await probe(
      gateway.port,
      upgrade(channelPath(serverKey.publicKey), FORGED, "CF-Connecting-IP: 198.51.100.70"),
    );
    const { connector } = await startClient(routeTo(origin, serverKey, { headers: from }));
    const outcome = await connector.connect().then(
      () => "connected",
      () => "refused",
    );
    assert.strictEqual(outcome, "refused");
  });

  it("drops a handshake whose key was revoked while it was being admitted", async () => {
    const asked = deferred<void>();
    const answer = deferred<void>();
    const admit: GatewayAdmit = async () => {
      asked.resolve();
      await answer.promise;
      return paired;
    };
    const { serverKey, gateway, origin } = await startGateway({ admit });
    const route = routeTo(origin, serverKey);
    const { connector } = await startClient(route);
    const connecting = connector.connect().then(
      () => "connected",
      () => "refused",
    );
    await asked.promise;
    gateway.closeClient(encodeChannelKey(route.clientKey.publicKey));
    answer.resolve();
    assert.strictEqual(await connecting, "refused");
  });

  it("answers nothing to a handshake admitted while the gateway stops", async () => {
    const asked = deferred<void>();
    const answer = deferred<void>();
    const admit: GatewayAdmit = async () => {
      asked.resolve();
      await answer.promise;
      return paired;
    };
    const { serverKey, gateway } = await startGateway({ admit });
    const protocols = initiateChannel({
      origin: PUBLIC_ORIGIN,
      serverKey: serverKey.publicKey,
      clientKey: generateKeyPair(),
    }).protocols.join(", ");
    const answered = probe(gateway.port, upgrade(channelPath(serverKey.publicKey), protocols));
    await asked.promise;
    const stopped = gateway.close();
    answer.resolve();
    assert.strictEqual(await answered, 0);
    await stopped;
  });

  it("counts an IPv6 /64 as one address", async () => {
    const { serverKey, gateway, origin } = await startGateway();
    const path = channelPath(serverKey.publicKey);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const from = `CF-Connecting-IP: 2001:db8:1:1::${attempt.toString(16)}`;
      assert.strictEqual(await probe(gateway.port, upgrade(path, FORGED, from)), 0);
    }
    const connect = (address: string) =>
      startClient(routeTo(origin, serverKey, { headers: { "cf-connecting-ip": address } })).then(
        ({ connector }) =>
          connector.connect().then(
            () => "connected",
            () => "refused",
          ),
      );
    assert.strictEqual(await connect("2001:db8:1:1:ffff::1"), "refused");
    assert.strictEqual(await connect("2001:db8:1:2::1"), "connected");
  });

  it("spends no limit on a request that couldn't carry message 1, nor on a refused one", async () => {
    const { serverKey, gateway, origin } = await startGateway({
      limits: { attemptsPerMinute: 3, networkAttemptsPerMinute: 4 },
    });
    const path = channelPath(serverKey.publicKey);
    const connect = (address: string) =>
      startClient(routeTo(origin, serverKey, { headers: { "cf-connecting-ip": address } })).then(
        ({ connector }) =>
          connector.connect().then(
            () => "connected",
            () => "refused",
          ),
      );
    const from = "CF-Connecting-IP: 203.0.113.5";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const protocols = attempt % 2 === 0 ? `t3c.2, ${"!".repeat(135)}` : undefined;
      assert.strictEqual(await probe(gateway.port, upgrade(path, protocols, from)), 0);
    }
    assert.strictEqual(await connect("203.0.113.5"), "connected");

    // Spends 203.0.113.5's own limit; the refused attempts after it leave its /24 the rest.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.strictEqual(await probe(gateway.port, upgrade(path, FORGED, from)), 0);
    }
    assert.strictEqual(await connect("203.0.113.5"), "refused");
    assert.strictEqual(await connect("203.0.113.6"), "connected");
  });

  it("keeps a spent address remembered through a flood of refused attempts", async () => {
    const { serverKey, gateway, origin } = await startGateway({
      limits: { attemptsPerMinute: 2, networkAttemptsPerMinute: 4, trackedKeys: 8 },
    });
    const path = channelPath(serverKey.publicKey);
    const spend = (from: string) =>
      probe(gateway.port, upgrade(path, FORGED, `CF-Connecting-IP: ${from}`));
    await spend("198.51.100.7");
    await spend("198.51.100.7");
    // Twenty /64s in one /48: four count, and the refused rest add nothing to the table.
    for (let host = 0; host < 20; host += 1) await spend(`2001:db8:9:${host.toString(16)}::1`);
    const { connector } = await startClient(
      routeTo(origin, serverKey, { headers: { "cf-connecting-ip": "198.51.100.7" } }),
    );
    const outcome = await connector.connect().then(
      () => "connected",
      () => "refused",
    );
    assert.strictEqual(outcome, "refused");
  });

  it("lets a device that connected before through a flood of strangers", async () => {
    const { serverKey, gateway, origin } = await startGateway({
      limits: { strangerAttemptsPerMinute: 3, networkAttemptsPerMinute: 2 },
    });
    const path = channelPath(serverKey.publicKey);
    const connect = (address: string) =>
      startClient(routeTo(origin, serverKey, { headers: { "cf-connecting-ip": address } })).then(
        ({ connector }) =>
          connector.connect().then(
            () => "connected",
            () => "refused",
          ),
      );
    // The user's device connects once, and is known from then on.
    assert.strictEqual(await connect("203.0.113.9"), "connected");
    // Strangers from its own /24 spend that network, and strangers elsewhere spend the cap.
    for (const from of ["203.0.113.50", "203.0.113.51", "198.51.100.1", "192.0.2.1"]) {
      await probe(gateway.port, upgrade(path, FORGED, `CF-Connecting-IP: ${from}`));
    }
    assert.strictEqual(await connect("203.0.113.60"), "refused");
    assert.strictEqual(await connect("2001:db8:7::1"), "refused");
    assert.strictEqual(await connect("203.0.113.9"), "connected");
  });

  it("knows an address only once a paired device used it, never on a pairing code alone", async () => {
    const admit: GatewayAdmit = async ({ pairingCode }) =>
      pairingCode === undefined ? paired : { until: Date.now() + HOUR, byCode: true };
    const { serverKey, gateway, origin } = await startGateway({
      admit,
      limits: { strangerAttemptsPerMinute: 2 },
    });
    const path = channelPath(serverKey.publicKey);
    const connect = (address: string, pairingCode?: string) =>
      startClient(
        routeTo(origin, serverKey, {
          headers: { "cf-connecting-ip": address },
          ...(pairingCode === undefined ? {} : { pairingCode }),
        }),
      ).then(({ connector }) =>
        connector.connect().then(
          () => "connected",
          () => "refused",
        ),
      );
    assert.strictEqual(await connect("203.0.113.20", "LIVECODE2345"), "connected");
    assert.strictEqual(await connect("203.0.113.21"), "connected");
    // A stranger spends the cap; the address a code alone opened stays a stranger.
    await probe(gateway.port, upgrade(path, FORGED, "CF-Connecting-IP: 198.51.100.40"));
    assert.strictEqual(await connect("203.0.113.20", "LIVECODE2345"), "refused");
    assert.strictEqual(await connect("203.0.113.21"), "connected");
  });

  it("forgets the addresses of a key that's revoked or no longer admitted", async () => {
    const refusedKeys = new Set<string>();
    const admit: GatewayAdmit = async ({ clientKey }) =>
      refusedKeys.has(clientKey) ? undefined : paired;
    const { serverKey, gateway, origin } = await startGateway({
      admit,
      limits: { strangerAttemptsPerMinute: 3 },
    });
    const path = channelPath(serverKey.publicKey);
    const connect = (address: string, clientKey = generateKeyPair()) =>
      startClient(
        routeTo(origin, serverKey, { clientKey, headers: { "cf-connecting-ip": address } }),
      ).then(({ connector }) =>
        connector.connect().then(
          () => "connected",
          () => "refused",
        ),
      );
    const revoked = generateKeyPair();
    const refused = generateKeyPair();
    assert.strictEqual(await connect("203.0.113.40", revoked), "connected");
    assert.strictEqual(await connect("203.0.113.41", refused), "connected");
    gateway.closeClient(encodeChannelKey(revoked.publicKey));
    // Revoked from another process: the key's next handshake is refused, and that forgets it.
    refusedKeys.add(encodeChannelKey(refused.publicKey));
    assert.strictEqual(await connect("203.0.113.41", refused), "refused");
    await probe(gateway.port, upgrade(path, FORGED, "CF-Connecting-IP: 198.51.100.50"));
    assert.strictEqual(await connect("203.0.113.40"), "refused");
    assert.strictEqual(await connect("203.0.113.41"), "refused");
  });

  it("keeps an address known for one device when another there roams on or is revoked", async () => {
    const { serverKey, gateway, origin } = await startGateway({
      // The laptop, two roamed addresses and one probe spend it exactly.
      limits: { strangerAttemptsPerMinute: 4, knownKeysPerClient: 2 },
    });
    const path = channelPath(serverKey.publicKey);
    const connect = (address: string, clientKey = generateKeyPair()) =>
      startClient(
        routeTo(origin, serverKey, { clientKey, headers: { "cf-connecting-ip": address } }),
      ).then(({ connector }) =>
        connector.connect().then(
          () => "connected",
          () => "refused",
        ),
      );
    const laptop = generateKeyPair();
    const phone = generateKeyPair();
    const home = "203.0.113.90";
    assert.strictEqual(await connect(home, laptop), "connected");
    assert.strictEqual(await connect(home, phone), "connected");
    // The phone roams far enough to drop home from its own known addresses, then is revoked.
    assert.strictEqual(await connect("2001:db8:a:1::1", phone), "connected");
    assert.strictEqual(await connect("2001:db8:b:1::1", phone), "connected");
    gateway.closeClient(encodeChannelKey(phone.publicKey));
    await probe(gateway.port, upgrade(path, FORGED, "CF-Connecting-IP: 198.51.100.80"));
    assert.strictEqual(await connect(home), "connected");
  });

  it("keeps a key's addresses when admission fails rather than refuses", async () => {
    let failing = false;
    const admit: GatewayAdmit = async () => {
      if (failing) throw new Error("The database is busy.");
      return paired;
    };
    const { serverKey, gateway, origin } = await startGateway({
      admit,
      limits: { strangerAttemptsPerMinute: 2 },
    });
    const path = channelPath(serverKey.publicKey);
    const device = generateKeyPair();
    const connect = (clientKey = generateKeyPair()) =>
      startClient(
        routeTo(origin, serverKey, {
          clientKey,
          headers: { "cf-connecting-ip": "203.0.113.95" },
        }),
      ).then(({ connector }) =>
        connector.connect().then(
          () => "connected",
          () => "refused",
        ),
      );
    assert.strictEqual(await connect(device), "connected");
    failing = true;
    assert.strictEqual(await connect(device), "refused");
    failing = false;
    await probe(gateway.port, upgrade(path, FORGED, "CF-Connecting-IP: 198.51.100.85"));
    assert.strictEqual(await connect(), "connected");
  });

  it("keeps a key's addresses when a re-check's lookup fails, closing its channel", async () => {
    let asked = 0;
    const device = generateKeyPair();
    const deviceKey = encodeChannelKey(device.publicKey);
    const admit: GatewayAdmit = async ({ clientKey }) => {
      if (clientKey !== deviceKey) return paired;
      asked += 1;
      if (asked === 1) return { until: Date.now(), byCode: false };
      throw new Error("The database is busy.");
    };
    const { serverKey, gateway, origin } = await startGateway({
      admit,
      limits: { strangerAttemptsPerMinute: 2 },
    });
    const from = { "cf-connecting-ip": "203.0.113.97" };
    const socket = await openSocketThrough(
      await startClient(routeTo(origin, serverKey, { clientKey: device, headers: from })),
    );
    await closedEvent(socket);
    assert.isAtLeast(asked, 2);

    await probe(
      gateway.port,
      upgrade(channelPath(serverKey.publicKey), FORGED, "CF-Connecting-IP: 198.51.100.87"),
    );
    const { connector } = await startClient(routeTo(origin, serverKey, { headers: from }));
    const outcome = await connector.connect().then(
      () => "connected",
      () => "refused",
    );
    assert.strictEqual(outcome, "connected");
  });

  it("lets one device's standing on an address lapse after a day while another keeps it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    cleanups.push(() => void vi.useRealTimers());
    const start = Date.now();
    const admit: GatewayAdmit = async ({ pairingCode }) => ({
      until: Date.now() + HOUR,
      byCode: pairingCode !== undefined,
    });
    const { serverKey, gateway, origin } = await startGateway({
      admit,
      limits: { strangerAttemptsPerMinute: 1 },
    });
    const home = "203.0.113.98";
    const connect = (extra: Partial<ChannelRoute>) =>
      startClient(
        routeTo(origin, serverKey, { ...extra, headers: { "cf-connecting-ip": home } }),
      ).then(({ connector }) =>
        connector.connect().then(
          () => "connected",
          () => "refused",
        ),
      );
    const phone = generateKeyPair();
    // The laptop, revoked from the CLI, never connects again; the phone renews home later.
    assert.strictEqual(await connect({}), "connected");
    vi.setSystemTime(start + 23 * HOUR);
    assert.strictEqual(await connect({ clientKey: phone }), "connected");
    vi.setSystemTime(start + 25 * HOUR);
    await probe(
      gateway.port,
      upgrade(channelPath(serverKey.publicKey), FORGED, "CF-Connecting-IP: 198.51.100.88"),
    );
    // A code makes nothing known, so it gets through the spent cap only while home is known.
    assert.strictEqual(await connect({ pairingCode: "LIVECODE2345" }), "connected");
    gateway.closeClient(encodeChannelKey(phone.publicKey));
    assert.strictEqual(await connect({ pairingCode: "LIVECODE6789" }), "refused");
  });

  it("keeps only a key's most recent known addresses", async () => {
    const { serverKey, gateway, origin } = await startGateway({
      limits: { strangerAttemptsPerMinute: 4, knownKeysPerClient: 2 },
    });
    const path = channelPath(serverKey.publicKey);
    const connect = (address: string, clientKey = generateKeyPair()) =>
      startClient(
        routeTo(origin, serverKey, { clientKey, headers: { "cf-connecting-ip": address } }),
      ).then(({ connector }) =>
        connector.connect().then(
          () => "connected",
          () => "refused",
        ),
      );
    const roaming = generateKeyPair();
    for (const address of ["203.0.113.70", "203.0.113.71", "203.0.113.72"]) {
      assert.strictEqual(await connect(address, roaming), "connected");
    }
    await probe(gateway.port, upgrade(path, FORGED, "CF-Connecting-IP: 198.51.100.60"));
    assert.strictEqual(await connect("203.0.113.70"), "refused");
    assert.strictEqual(await connect("203.0.113.72"), "connected");
  });

  it("limits a network block of strangers as a whole", async () => {
    const { serverKey, gateway, origin } = await startGateway({
      limits: { attemptsPerMinute: 2, networkAttemptsPerMinute: 4 },
    });
    const path = channelPath(serverKey.publicKey);
    // Two addresses in one IPv4 /24 and two /64s in one IPv6 /48 use up their networks.
    for (const from of ["198.51.100.1", "198.51.100.2", "2001:db8:5:1::1", "2001:db8:5:2::1"]) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.strictEqual(
          await probe(gateway.port, upgrade(path, FORGED, `CF-Connecting-IP: ${from}`)),
          0,
        );
      }
    }
    const connect = (address: string) =>
      startClient(routeTo(origin, serverKey, { headers: { "cf-connecting-ip": address } })).then(
        ({ connector }) =>
          connector.connect().then(
            () => "connected",
            () => "refused",
          ),
      );
    assert.strictEqual(await connect("198.51.100.3"), "refused");
    assert.strictEqual(await connect("2001:db8:5:3::1"), "refused");
    // Every other network still gets in, however busy those were, while strangers stay under the cap.
    assert.strictEqual(await connect("203.0.113.1"), "connected");
    assert.strictEqual(await connect("2001:db8:6::1"), "connected");
  });
});

describe("admission", () => {
  it.effect("refuses a key with no live session or code, and fails when a lookup fails", () =>
    Effect.gen(function* () {
      const lookups = (
        pairedUntil: SecureChannelClients.SecureChannelClients["Service"]["pairedUntil"],
      ) =>
        Layer.mergeAll(
          Layer.mock(SecureChannelClients.SecureChannelClients)({ pairedUntil }),
          Layer.mock(PairingGrantStore.PairingGrantStore)({
            liveUntil: () => Effect.succeed(Option.none()),
          }),
        );
      const input = { clientKey: "key", pairingCode: "LIVECODE2345" };
      const refused = yield* admission(input).pipe(
        Effect.provide(lookups(() => Effect.succeed(Option.none()))),
      );
      assert.isUndefined(refused);
      const failed = yield* admission(input).pipe(
        Effect.provide(
          lookups(() =>
            Effect.fail(
              new SecureChannelClients.SecureChannelClientsError({
                operation: "pairedUntil",
                cause: new Error("disk I/O error"),
              }),
            ),
          ),
        ),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(failed));
    }),
  );
});

describe("limiterKeys", () => {
  it("keys an address as itself or its IPv6 /64, and its network as an IPv4 /24 or IPv6 /48", () => {
    assert.deepStrictEqual(limiterKeys("2001:db8:1:1::1"), {
      address: "2001:db8:1:1::/64",
      network: "2001:db8:1::/48",
    });
    assert.deepStrictEqual(limiterKeys("2001:0db8:0001:0001:0000:0000:0000:0002"), {
      address: "2001:db8:1:1::/64",
      network: "2001:db8:1::/48",
    });
    assert.deepStrictEqual(limiterKeys("::ffff:192.0.2.1"), {
      address: "192.0.2.1",
      network: "192.0.2.0/24",
    });
    assert.deepStrictEqual(limiterKeys("fe80::1%en0"), {
      address: "fe80:0:0:0::/64",
      network: "fe80:0:0::/48",
    });
  });
});

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((settle) => (resolve = settle));
  return { promise, resolve };
}

/** A WebSocket through a client's forwarder, once it's open. */
async function openSocketThrough(client: { readonly forwarder: { readonly origin: string } }) {
  const socket = new WebSocket(`${client.forwarder.origin.replace("http", "ws")}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("The WebSocket failed.")));
  });
  return socket;
}

function closedEvent(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) resolve();
    else socket.addEventListener("close", () => resolve());
  });
}

describe("recheckDelay", () => {
  it("asks again at the admission's end, but no sooner than a second and no later than an hour", () => {
    assert.strictEqual(recheckDelay(10_000 + 5 * 60_000, 10_000), 5 * 60_000);
    assert.strictEqual(recheckDelay(5_000, 10_000), 1000);
    assert.strictEqual(recheckDelay(10_000 + 30 * 24 * 60 * 60_000, 10_000), 60 * 60_000);
  });
});
