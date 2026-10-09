/**
 * `Noise_IK_25519_ChaChaPoly_SHA256`, the one handshake the secure channel speaks
 * (https://noiseprotocol.org/noise.html). The client already holds the server's static key from
 * pairing and sends its own static key, encrypted, in message 1; the server answers with message
 * 2, and each side ends with a pair of transport ciphers. Pure code on the `@noble` primitives, so
 * the same bytes come out on Node, in the browser and under Hermes. A platform whose JavaScript is
 * too slow for the cipher, or that lacks `crypto.getRandomValues`, passes its own `primitives`.
 *
 * @module secureChannel/noise
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";

const PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_SHA256";
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const EMPTY = new Uint8Array(0);
/** Noise's nonce 2^64-1, reserved for `REKEY`. */
const REKEY_NONCE = Uint8Array.of(0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255);

/** The largest Noise message, handshake or transport. */
export const NOISE_MAX_MESSAGE_BYTES = 65_535;
/** The largest plaintext one transport message carries. */
export const NOISE_MAX_PLAINTEXT_BYTES = NOISE_MAX_MESSAGE_BYTES - TAG_BYTES;

export interface KeyPair {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/** ChaCha20-Poly1305 with a 32-byte key and a 12-byte nonce; `open` throws for a bad tag. */
export interface Aead {
  readonly seal: (
    key: Uint8Array,
    nonce: Uint8Array,
    ad: Uint8Array,
    plaintext: Uint8Array,
  ) => Uint8Array;
  readonly open: (
    key: Uint8Array,
    nonce: Uint8Array,
    ad: Uint8Array,
    ciphertext: Uint8Array,
  ) => Uint8Array;
}

/** What a platform may supply in place of the `@noble` defaults. */
export interface NoisePrimitives {
  readonly aead?: Aead;
  /** Cryptographically secure bytes, for platforms without `crypto.getRandomValues`. */
  readonly randomBytes?: (length: number) => Uint8Array;
}

export const nobleAead: Aead = {
  seal: (key, nonce, ad, plaintext) => chacha20poly1305(key, nonce, ad).encrypt(plaintext),
  open: (key, nonce, ad, ciphertext) => chacha20poly1305(key, nonce, ad).decrypt(ciphertext),
};

/** What every handshake or transport failure throws. Its message never includes key material. */
export class NoiseError extends Error {
  readonly _tag = "NoiseError";
}

export function generateKeyPair(randomBytes?: (length: number) => Uint8Array): KeyPair {
  // X25519 clamps any 32 bytes into a valid scalar.
  return keyPairFromSecretKey(
    randomBytes ? randomBytes(KEY_BYTES) : x25519.utils.randomPrivateKey(),
  );
}

export function keyPairFromSecretKey(secretKey: Uint8Array): KeyPair {
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    // A low-order public key, whose shared secret would be all zeros.
    throw new NoiseError("Invalid public key.");
  }
}

/** Noise's HKDF with two outputs, the only kind IK needs. */
function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmac(sha256, chainingKey, inputKeyMaterial);
  const first = hmac(sha256, tempKey, Uint8Array.of(1));
  const second = hmac(sha256, tempKey, concatBytes(first, Uint8Array.of(2)));
  return [first, second];
}

/** ChaChaPoly's nonce: 32 zero bits, then the counter as 64 bits little-endian. */
function nonceBytes(counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, counter % 2 ** 32, true);
  view.setUint32(8, Math.floor(counter / 2 ** 32), true);
  return nonce;
}

/**
 * One direction's key and nonce counter. Before the handshake mixes in a key it passes plaintext
 * through, as Noise specifies.
 */
export class CipherState {
  readonly #aead: Aead;
  #key: Uint8Array | undefined;
  #nonce = 0;

  constructor(key?: Uint8Array, aead: Aead = nobleAead) {
    this.#key = key;
    this.#aead = aead;
  }

  get hasKey(): boolean {
    return this.#key !== undefined;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.#key === undefined) return plaintext;
    const ciphertext = this.#aead.seal(this.#key, this.#nextNonce(), ad, plaintext);
    this.#nonce += 1;
    return ciphertext;
  }

  /** Throws a `NoiseError` for a message that doesn't authenticate, leaving the counter as it was. */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.#key === undefined) return ciphertext;
    let plaintext: Uint8Array;
    try {
      plaintext = this.#aead.open(this.#key, this.#nextNonce(), ad, ciphertext);
    } catch {
      throw new NoiseError("A message failed to authenticate.");
    }
    this.#nonce += 1;
    return plaintext;
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    return this.encryptWithAd(EMPTY, plaintext);
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    return this.decryptWithAd(EMPTY, ciphertext);
  }

  /** Noise's `REKEY`: replaces the key with one derived from it, keeping the nonce counter. */
  rekey(): void {
    if (this.#key === undefined) return;
    this.#key = this.#aead
      .seal(this.#key, REKEY_NONCE, EMPTY, new Uint8Array(KEY_BYTES))
      .slice(0, KEY_BYTES);
  }

  #nextNonce(): Uint8Array {
    // 2^53 messages is out of reach; stopping there keeps the counter an exact number.
    if (this.#nonce >= Number.MAX_SAFE_INTEGER) throw new NoiseError("Nonce exhausted.");
    return nonceBytes(this.#nonce);
  }
}

class SymmetricState {
  readonly #aead: Aead;
  #chainingKey: Uint8Array;
  #hash: Uint8Array;
  #cipher: CipherState;

  constructor(prologue: Uint8Array, aead: Aead) {
    this.#aead = aead;
    this.#cipher = new CipherState(undefined, aead);
    // The protocol name is exactly 32 bytes, so it becomes the hash as is.
    this.#hash = utf8ToBytes(PROTOCOL_NAME);
    this.#chainingKey = this.#hash;
    this.mixHash(prologue);
  }

  get handshakeHash(): Uint8Array {
    return this.#hash;
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [chainingKey, key] = hkdf(this.#chainingKey, inputKeyMaterial);
    this.#chainingKey = chainingKey;
    this.#cipher = new CipherState(key, this.#aead);
  }

  mixHash(data: Uint8Array): void {
    this.#hash = sha256(concatBytes(this.#hash, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.#cipher.encryptWithAd(this.#hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.#cipher.decryptWithAd(this.#hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  /** The initiator's sending cipher, then the responder's. */
  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.#chainingKey, EMPTY);
    return [new CipherState(first, this.#aead), new CipherState(second, this.#aead)];
  }
}

/** What a finished handshake leaves each side: one cipher per direction. */
export interface NoiseTransport {
  readonly handshakeHash: Uint8Array;
  readonly remoteStaticKey: Uint8Array;
  readonly send: CipherState;
  readonly receive: CipherState;
}

/** The client's message 1 and the step that reads the server's answer. */
export interface NoiseInitiation {
  readonly message: Uint8Array;
  /** Reads message 2. Throws a `NoiseError` if it doesn't come from the expected server. */
  readonly readResponse: (message: Uint8Array) => {
    readonly payload: Uint8Array;
    readonly transport: NoiseTransport;
  };
}

/**
 * Starts the handshake as the client, writing IK's `e, es, s, ss` with `payload` encrypted to
 * `serverKey`. `ephemeralKey` is fixed only by tests.
 */
export function initiateHandshake(input: {
  readonly prologue: Uint8Array;
  readonly staticKey: KeyPair;
  readonly serverKey: Uint8Array;
  readonly payload: Uint8Array;
  readonly primitives?: NoisePrimitives;
  readonly ephemeralKey?: KeyPair;
}): NoiseInitiation {
  const { staticKey, serverKey } = input;
  if (serverKey.length !== KEY_BYTES) throw new NoiseError("Invalid server key.");
  const state = new SymmetricState(input.prologue, input.primitives?.aead ?? nobleAead);
  state.mixHash(serverKey);

  const ephemeral = input.ephemeralKey ?? generateKeyPair(input.primitives?.randomBytes);
  state.mixHash(ephemeral.publicKey);
  state.mixKey(dh(ephemeral.secretKey, serverKey));
  const encryptedStatic = state.encryptAndHash(staticKey.publicKey);
  state.mixKey(dh(staticKey.secretKey, serverKey));
  const encryptedPayload = state.encryptAndHash(input.payload);
  const message = concatBytes(ephemeral.publicKey, encryptedStatic, encryptedPayload);
  if (message.length > NOISE_MAX_MESSAGE_BYTES) throw new NoiseError("Payload too large.");

  let read = false;
  return {
    message,
    readResponse: (response) => {
      if (read) throw new NoiseError("The handshake already finished.");
      read = true;
      if (response.length < KEY_BYTES + TAG_BYTES) throw new NoiseError("Message 2 is too short.");
      const remoteEphemeral = response.subarray(0, KEY_BYTES);
      state.mixHash(remoteEphemeral);
      state.mixKey(dh(ephemeral.secretKey, remoteEphemeral));
      state.mixKey(dh(staticKey.secretKey, remoteEphemeral));
      const payload = state.decryptAndHash(response.subarray(KEY_BYTES));
      const [send, receive] = state.split();
      return {
        payload,
        transport: {
          handshakeHash: state.handshakeHash,
          remoteStaticKey: serverKey,
          send,
          receive,
        },
      };
    },
  };
}

/** The server's view of a valid message 1, and the step that answers it. */
export interface NoiseAcceptance {
  readonly clientKey: Uint8Array;
  readonly payload: Uint8Array;
  /** Writes message 2. `ephemeralKey` is fixed only by tests. */
  readonly respond: (
    payload: Uint8Array,
    ephemeralKey?: KeyPair,
  ) => { readonly message: Uint8Array; readonly transport: NoiseTransport };
}

/**
 * Reads the client's message 1 as the server. Throws a `NoiseError` unless it was written to this
 * server's key under the same prologue.
 */
export function acceptHandshake(input: {
  readonly prologue: Uint8Array;
  readonly staticKey: KeyPair;
  readonly message: Uint8Array;
  readonly primitives?: NoisePrimitives;
}): NoiseAcceptance {
  const { message, staticKey } = input;
  if (message.length < KEY_BYTES + KEY_BYTES + TAG_BYTES + TAG_BYTES) {
    throw new NoiseError("Message 1 is too short.");
  }
  const state = new SymmetricState(input.prologue, input.primitives?.aead ?? nobleAead);
  state.mixHash(staticKey.publicKey);

  const remoteEphemeral = message.subarray(0, KEY_BYTES);
  state.mixHash(remoteEphemeral);
  state.mixKey(dh(staticKey.secretKey, remoteEphemeral));
  const clientKey = state.decryptAndHash(message.subarray(KEY_BYTES, 2 * KEY_BYTES + TAG_BYTES));
  state.mixKey(dh(staticKey.secretKey, clientKey));
  const payload = state.decryptAndHash(message.subarray(2 * KEY_BYTES + TAG_BYTES));

  let responded = false;
  return {
    clientKey,
    payload,
    respond: (responsePayload, ephemeralKey) => {
      if (responded) throw new NoiseError("The handshake already finished.");
      responded = true;
      const ephemeral = ephemeralKey ?? generateKeyPair(input.primitives?.randomBytes);
      state.mixHash(ephemeral.publicKey);
      state.mixKey(dh(ephemeral.secretKey, remoteEphemeral));
      state.mixKey(dh(ephemeral.secretKey, clientKey));
      const response = concatBytes(ephemeral.publicKey, state.encryptAndHash(responsePayload));
      if (response.length > NOISE_MAX_MESSAGE_BYTES) throw new NoiseError("Payload too large.");
      const [receive, send] = state.split();
      return {
        message: response,
        transport: {
          handshakeHash: state.handshakeHash,
          remoteStaticKey: clientKey,
          send,
          receive,
        },
      };
    },
  };
}
