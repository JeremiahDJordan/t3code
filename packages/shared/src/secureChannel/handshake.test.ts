import { assert, describe, it } from "@effect/vitest";

import {
  acceptChannel,
  CHANNEL_PROTOCOL,
  channelKeyFingerprint,
  channelPath,
  decodeChannelKey,
  decodeClientHello,
  encodeChannelKey,
  encodeClientHello,
  initiateChannel,
  messageFromProtocols,
} from "./handshake.ts";
import { generateKeyPair, NoiseError } from "./noise.ts";

const ORIGIN = "https://quiet.example.com";
const NOW = Date.UTC(2026, 9, 7, 12);
/** RFC 9110's token, which every subprotocol value must be; `ws` checks the same. */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function attempt(options?: {
  readonly clientOrigin?: string;
  readonly serverOrigin?: string;
  readonly clientNow?: number;
  readonly pairingCode?: string;
}) {
  const serverKey = generateKeyPair();
  const clientKey = generateKeyPair();
  const initiation = initiateChannel({
    origin: options?.clientOrigin ?? ORIGIN,
    serverKey: serverKey.publicKey,
    clientKey,
    now: () => options?.clientNow ?? NOW,
    ...(options?.pairingCode === undefined ? {} : { pairingCode: options.pairingCode }),
  });
  const accept = (protocols: string | undefined) =>
    acceptChannel({
      origin: options?.serverOrigin ?? ORIGIN,
      serverKey,
      protocols,
      now: () => NOW,
    });
  return { serverKey, clientKey, initiation, accept, header: initiation.protocols.join(", ") };
}

describe("secure channel handshake", () => {
  it("carries message 1 in a subprotocol value beside t3c.2", () => {
    const { initiation, header } = attempt({ pairingCode: "ABCDEFGHJKLM" });
    const [protocol, message] = initiation.protocols;
    assert.strictEqual(protocol, CHANNEL_PROTOCOL);
    assert.match(message, HTTP_TOKEN);
    assert.isDefined(messageFromProtocols(header));
    assert.deepStrictEqual(
      messageFromProtocols(`${message},${protocol}`),
      messageFromProtocols(header),
    );

    for (const refused of [
      undefined,
      "",
      CHANNEL_PROTOCOL,
      message,
      `${header}, extra`,
      `${CHANNEL_PROTOCOL}, ${message.slice(0, 8)}+${message.slice(9)}`,
      `${CHANNEL_PROTOCOL}, ${CHANNEL_PROTOCOL}`,
    ]) {
      assert.isUndefined(messageFromProtocols(refused), String(refused));
    }
  });

  it("opens a channel that names the client's key and its pairing code", () => {
    const { clientKey, initiation, accept, header } = attempt({ pairingCode: "ABCDEFGHJKLM" });
    const acceptance = accept(header);
    assert.isDefined(acceptance);
    assert.deepStrictEqual(acceptance?.clientKey, clientKey.publicKey);
    assert.strictEqual(acceptance?.pairingCode, "ABCDEFGHJKLM");

    const { message, channel: server } = acceptance!.accept();
    const client = initiation.finish(message);
    client.ping(Uint8Array.of(1));
    server.receive(client.takeOutgoing()!);
    assert.deepStrictEqual(client.receive(server.takeOutgoing()!), [
      { type: "pong", data: Uint8Array.of(1) },
    ]);
  });

  it("refuses a handshake written for another hostname", () => {
    const { accept, header } = attempt({ clientOrigin: "https://other.example.com" });
    assert.isUndefined(accept(header));
  });

  it("refuses message 1 sent outside the clock skew, in either direction", () => {
    const skew = 5 * 60_000;
    const fresh = attempt({ clientNow: NOW - skew + 1000 });
    assert.isDefined(fresh.accept(fresh.header));
    for (const clientNow of [NOW - skew - 1000, NOW + skew + 1000]) {
      const { accept, header } = attempt({ clientNow });
      assert.isUndefined(accept(header), String(clientNow - NOW));
    }
  });

  it("refuses message 1 written to another server, or garbled", () => {
    const { accept, header } = attempt();
    const toSomeoneElse = attempt().header;
    assert.isUndefined(accept(toSomeoneElse));
    const garbled = header.slice(0, -4) + (header.endsWith("AAAA") ? "BBBB" : "AAAA");
    assert.isUndefined(accept(garbled));
    assert.isUndefined(accept(`${CHANNEL_PROTOCOL}, AAAA`));
  });

  it("refuses a malformed origin instead of throwing", () => {
    const serverKey = generateKeyPair();
    const { header } = attempt();
    assert.isUndefined(acceptChannel({ origin: "https://bad host", serverKey, protocols: header }));
  });

  it("fails the client when message 2 comes from another server", () => {
    const real = attempt();
    const impostor = attempt();
    const { message } = impostor.accept(impostor.header)!.accept();
    assert.throws(() => real.initiation.finish(message), NoiseError);
  });

  it("derives a 22-character path from the server key", () => {
    const key = generateKeyPair().publicKey;
    const path = channelPath(key);
    assert.match(path, /^\/[A-Za-z0-9_-]{22}$/);
    assert.strictEqual(channelPath(key), path);
    assert.notStrictEqual(channelPath(generateKeyPair().publicKey), path);
    assert.strictEqual(attempt().initiation.path.length, 23);
  });

  it("encodes channel keys as 43 base64url characters", () => {
    const key = generateKeyPair().publicKey;
    const encoded = encodeChannelKey(key);
    assert.strictEqual(encoded.length, 43);
    assert.deepStrictEqual(decodeChannelKey(encoded), key);
    assert.isUndefined(decodeChannelKey(encoded.slice(1)));
    assert.isUndefined(decodeChannelKey(`${encoded}AAAA`));
    assert.isUndefined(decodeChannelKey(encoded.replace(/^./, "+")));
  });

  it("fingerprints a key as eight groups of its SHA-256", () => {
    const key = new Uint8Array(32);
    // SHA-256 of 32 zero bytes begins 66687aadf862bd776c8fc18b8e9f8e20.
    assert.strictEqual(channelKeyFingerprint(key), "6668 7aad f862 bd77 6c8f c18b 8e9f 8e20");
  });

  it("round-trips the client hello", () => {
    assert.deepStrictEqual(decodeClientHello(encodeClientHello({ sentAt: NOW })), { sentAt: NOW });
    assert.deepStrictEqual(
      decodeClientHello(encodeClientHello({ sentAt: NOW + 999, pairingCode: "ABC" })),
      {
        sentAt: NOW,
        pairingCode: "ABC",
      },
    );
    assert.isUndefined(decodeClientHello(Uint8Array.of(0, 0, 0, 0, 3, 65)));
    assert.isUndefined(decodeClientHello(Uint8Array.of(0, 0, 0, 0, 1, 0xff)));
  });
});
