// @effect-diagnostics-next-line nodeBuiltinImport:off -- node:crypto is the independent ChaCha20-Poly1305 the rekey test checks against.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

import {
  type Aead,
  acceptHandshake,
  CipherState,
  generateKeyPair,
  initiateHandshake,
  keyPairFromSecretKey,
  nobleAead,
  NoiseError,
} from "./noise.ts";
import { noiseIkVector as vector } from "./noiseIkVector.fixture.ts";

const message = (index: number) => {
  const entry = vector.messages[index];
  if (entry === undefined) throw new Error(`The vector has no message ${index}.`);
  return { payload: hexToBytes(entry.payload), ciphertext: entry.ciphertext };
};

function vectorHandshake() {
  const initiation = initiateHandshake({
    prologue: hexToBytes(vector.initPrologue),
    staticKey: keyPairFromSecretKey(hexToBytes(vector.initStatic)),
    serverKey: hexToBytes(vector.initRemoteStatic),
    payload: message(0).payload,
    ephemeralKey: keyPairFromSecretKey(hexToBytes(vector.initEphemeral)),
  });
  const acceptance = acceptHandshake({
    prologue: hexToBytes(vector.respPrologue),
    staticKey: keyPairFromSecretKey(hexToBytes(vector.respStatic)),
    message: initiation.message,
  });
  const response = acceptance.respond(
    message(1).payload,
    keyPairFromSecretKey(hexToBytes(vector.respEphemeral)),
  );
  const initiator = initiation.readResponse(response.message);
  return { initiation, acceptance, response, initiator };
}

function pairedHandshake() {
  const client = generateKeyPair();
  const server = generateKeyPair();
  const encoder = new TextEncoder();
  const initiation = initiateHandshake({
    prologue: encoder.encode("prologue"),
    staticKey: client,
    serverKey: server.publicKey,
    payload: encoder.encode("hello"),
  });
  return { client, server, encoder, initiation };
}

describe("Noise_IK_25519_ChaChaPoly_SHA256", () => {
  it("matches the cacophony vector byte for byte", () => {
    const { initiation, acceptance, response, initiator } = vectorHandshake();

    assert.strictEqual(bytesToHex(initiation.message), message(0).ciphertext);
    assert.strictEqual(bytesToHex(acceptance.payload), bytesToHex(message(0).payload));
    assert.strictEqual(
      bytesToHex(acceptance.clientKey),
      bytesToHex(keyPairFromSecretKey(hexToBytes(vector.initStatic)).publicKey),
    );
    assert.strictEqual(bytesToHex(response.message), message(1).ciphertext);
    assert.strictEqual(bytesToHex(initiator.payload), bytesToHex(message(1).payload));
    assert.strictEqual(bytesToHex(initiator.transport.handshakeHash), vector.handshakeHash);
    assert.strictEqual(bytesToHex(response.transport.handshakeHash), vector.handshakeHash);

    // Transport messages alternate, initiator first, and each side reads what the other wrote.
    const sides = [
      { writer: initiator.transport, reader: response.transport },
      { writer: response.transport, reader: initiator.transport },
    ];
    for (const index of [2, 3, 4, 5]) {
      const { writer, reader } = sides[index % 2]!;
      const { payload, ciphertext } = message(index);
      const written = writer.send.encrypt(payload);
      assert.strictEqual(bytesToHex(written), ciphertext);
      assert.strictEqual(bytesToHex(reader.receive.decrypt(written)), bytesToHex(payload));
    }
  });

  it("refuses message 1 written under another prologue", () => {
    const { server, initiation } = pairedHandshake();
    assert.throws(
      () =>
        acceptHandshake({
          prologue: new TextEncoder().encode("other prologue"),
          staticKey: server,
          message: initiation.message,
        }),
      NoiseError,
    );
  });

  it("refuses message 1 written to another server's key", () => {
    const { encoder, initiation } = pairedHandshake();
    assert.throws(
      () =>
        acceptHandshake({
          prologue: encoder.encode("prologue"),
          staticKey: generateKeyPair(),
          message: initiation.message,
        }),
      NoiseError,
    );
  });

  it("refuses a tampered message 1", () => {
    const { server, encoder, initiation } = pairedHandshake();
    const tampered = initiation.message.slice();
    tampered[tampered.length - 1]! ^= 1;
    assert.throws(
      () =>
        acceptHandshake({
          prologue: encoder.encode("prologue"),
          staticKey: server,
          message: tampered,
        }),
      NoiseError,
    );
  });

  it("refuses message 2 from anyone but the server it was written to", () => {
    const { client, encoder, initiation } = pairedHandshake();
    // An impostor can't read message 1, so it can only answer as itself.
    const impostor = generateKeyPair();
    const forged = initiateHandshake({
      prologue: encoder.encode("prologue"),
      staticKey: client,
      serverKey: impostor.publicKey,
      payload: new Uint8Array(0),
    });
    const impostorResponse = acceptHandshake({
      prologue: encoder.encode("prologue"),
      staticKey: impostor,
      message: forged.message,
    }).respond(new Uint8Array(0));
    assert.throws(() => initiation.readResponse(impostorResponse.message), NoiseError);
  });

  it("refuses a low-order ephemeral key", () => {
    const { server, encoder, initiation } = pairedHandshake();
    const lowOrder = initiation.message.slice();
    lowOrder.fill(0, 0, 32);
    assert.throws(
      () =>
        acceptHandshake({
          prologue: encoder.encode("prologue"),
          staticKey: server,
          message: lowOrder,
        }),
      NoiseError,
    );
  });

  it("rekeys to the first 32 bytes of the key encrypting zeros at nonce 2^64-1", () => {
    const key = NodeCrypto.randomBytes(32);
    const nonce = Buffer.from([0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255]);
    const cipher = NodeCrypto.createCipheriv("chacha20-poly1305", key, nonce, {
      authTagLength: 16,
    });
    const expectedKey = cipher.update(Buffer.alloc(32));

    const rekeyed = new CipherState(new Uint8Array(key));
    rekeyed.rekey();
    const expected = new CipherState(new Uint8Array(expectedKey));
    const plaintext = new TextEncoder().encode("after rekey");
    assert.strictEqual(
      bytesToHex(rekeyed.encrypt(plaintext)),
      bytesToHex(expected.encrypt(plaintext)),
    );
  });

  it("runs on a platform's own cipher and random source", () => {
    let sealed = 0;
    let opened = 0;
    const counting: Aead = {
      seal: (...args) => ((sealed += 1), nobleAead.seal(...args)),
      open: (...args) => ((opened += 1), nobleAead.open(...args)),
    };
    const fixedRandom = (length: number) => new Uint8Array(length).fill(9);
    const primitives = { aead: counting, randomBytes: fixedRandom };
    const server = generateKeyPair();
    const start = () =>
      initiateHandshake({
        prologue: new Uint8Array(0),
        staticKey: keyPairFromSecretKey(hexToBytes(vector.initStatic)),
        serverKey: server.publicKey,
        payload: new Uint8Array(0),
        primitives,
      });
    const initiation = start();
    // The ephemeral key came from the injected source, so message 1 is reproducible.
    assert.strictEqual(bytesToHex(start().message), bytesToHex(initiation.message));
    const response = acceptHandshake({
      prologue: new Uint8Array(0),
      staticKey: server,
      message: initiation.message,
      primitives,
    }).respond(new Uint8Array(0));
    const { transport } = initiation.readResponse(response.message);
    const plaintext = new TextEncoder().encode("native");
    assert.strictEqual(
      new TextDecoder().decode(
        response.transport.receive.decrypt(transport.send.encrypt(plaintext)),
      ),
      "native",
    );
    // Each message 1 (written twice above) seals two fields, message 2 one, and the transport
    // message one; every matching open went through the injected cipher too.
    assert.deepStrictEqual({ sealed, opened }, { sealed: 6, opened: 4 });
  });

  it("refuses a replayed transport message and keeps the counter for the next real one", () => {
    const { initiator, response } = vectorHandshake();
    const first = initiator.transport.send.encrypt(new TextEncoder().encode("one"));
    const second = initiator.transport.send.encrypt(new TextEncoder().encode("two"));
    response.transport.receive.decrypt(first);
    assert.throws(() => response.transport.receive.decrypt(first), NoiseError);
    assert.strictEqual(new TextDecoder().decode(response.transport.receive.decrypt(second)), "two");
  });
});
