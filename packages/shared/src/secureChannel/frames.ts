/**
 * The plaintext of one channel message: `[stream id: varint][type: u8][payload]`. A stream is a
 * byte pipe, like one TCP connection; stream 0 carries the channel's own control frames (ping,
 * pong, rekey), and client streams are odd. Integers are unsigned LEB128 varints and strings are a
 * varint byte length then UTF-8.
 *
 * @module secureChannel/frames
 */
import { concatBytes } from "@noble/hashes/utils";

export type Frame =
  | { readonly type: "open"; readonly stream: number }
  | { readonly type: "data"; readonly stream: number; readonly bytes: Uint8Array }
  /** This side sends nothing more on the stream, like a TCP half-close. */
  | { readonly type: "end"; readonly stream: number }
  | { readonly type: "reset"; readonly stream: number; readonly reason: string }
  | { readonly type: "credit"; readonly stream: number; readonly bytes: number }
  | { readonly type: "ping"; readonly data: Uint8Array }
  | { readonly type: "pong"; readonly data: Uint8Array }
  | { readonly type: "rekey" };

const TYPE_CODES = {
  open: 1,
  data: 2,
  end: 3,
  reset: 4,
  credit: 5,
  ping: 6,
  pong: 7,
  rekey: 8,
} as const satisfies Record<Frame["type"], number>;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 that refuses malformed bytes, for strings read off the channel. */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new FrameError("Invalid UTF-8.");
  }
}

export function encodeUtf8(value: string): Uint8Array {
  return utf8Encoder.encode(value);
}

/** What decoding a malformed frame throws. */
export class FrameError extends Error {
  readonly _tag = "FrameError";
}

/** The encoded length of `value` as a varint. */
export function varintLength(value: number): number {
  let length = 1;
  for (let rest = value; rest >= 128; rest = Math.floor(rest / 128)) length += 1;
  return length;
}

class ByteWriter {
  readonly #parts: Uint8Array[] = [];

  varint(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0) throw new FrameError("Invalid varint.");
    const bytes = new Uint8Array(varintLength(value));
    let rest = value;
    for (let index = 0; index < bytes.length - 1; index += 1) {
      bytes[index] = (rest % 128) | 128;
      rest = Math.floor(rest / 128);
    }
    bytes[bytes.length - 1] = rest;
    this.#parts.push(bytes);
    return this;
  }

  u8(value: number): this {
    this.#parts.push(Uint8Array.of(value));
    return this;
  }

  bytes(value: Uint8Array): this {
    this.#parts.push(value);
    return this;
  }

  string(value: string): this {
    const bytes = encodeUtf8(value);
    return this.varint(bytes.length).bytes(bytes);
  }

  finish(): Uint8Array {
    return concatBytes(...this.#parts);
  }
}

class ByteReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  varint(): number {
    let value = 0;
    for (let index = 0, scale = 1; index < 8; index += 1, scale *= 128) {
      const byte = this.u8();
      value += (byte & 127) * scale;
      if ((byte & 128) === 0) {
        if (!Number.isSafeInteger(value)) break;
        return value;
      }
    }
    throw new FrameError("Invalid varint.");
  }

  u8(): number {
    const byte = this.#bytes[this.#offset];
    if (byte === undefined) throw new FrameError("Truncated frame.");
    this.#offset += 1;
    return byte;
  }

  bytes(length: number): Uint8Array {
    if (this.#offset + length > this.#bytes.length) throw new FrameError("Truncated frame.");
    const bytes = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return bytes;
  }

  rest(): Uint8Array {
    return this.bytes(this.#bytes.length - this.#offset);
  }

  string(): string {
    return decodeUtf8(this.bytes(this.varint()));
  }

  end(): void {
    if (this.#offset !== this.#bytes.length) throw new FrameError("Trailing bytes in frame.");
  }
}

/** The bytes a `data` frame adds in front of its payload. */
export function dataFrameOverhead(stream: number): number {
  return varintLength(stream) + 1;
}

export function encodeFrame(frame: Frame): Uint8Array {
  const writer = new ByteWriter()
    .varint("stream" in frame ? frame.stream : 0)
    .u8(TYPE_CODES[frame.type]);
  switch (frame.type) {
    case "data":
      return writer.bytes(frame.bytes).finish();
    case "reset":
      return writer.string(frame.reason).finish();
    case "credit":
      return writer.varint(frame.bytes).finish();
    case "ping":
    case "pong":
      return writer.bytes(frame.data).finish();
    case "open":
    case "end":
    case "rekey":
      return writer.finish();
  }
}

/** Decodes one frame, throwing a `FrameError` for anything malformed or out of place. */
export function decodeFrame(bytes: Uint8Array): Frame {
  const reader = new ByteReader(bytes);
  const stream = reader.varint();
  const code = reader.u8();
  const isControl =
    code === TYPE_CODES.ping || code === TYPE_CODES.pong || code === TYPE_CODES.rekey;
  if (isControl !== (stream === 0)) throw new FrameError("Frame on the wrong stream.");
  let frame: Frame;
  switch (code) {
    case TYPE_CODES.open:
      frame = { type: "open", stream };
      break;
    case TYPE_CODES.data:
      frame = { type: "data", stream, bytes: reader.rest() };
      break;
    case TYPE_CODES.end:
      frame = { type: "end", stream };
      break;
    case TYPE_CODES.reset:
      frame = { type: "reset", stream, reason: reader.string() };
      break;
    case TYPE_CODES.credit:
      frame = { type: "credit", stream, bytes: reader.varint() };
      break;
    case TYPE_CODES.ping:
      frame = { type: "ping", data: reader.rest() };
      break;
    case TYPE_CODES.pong:
      frame = { type: "pong", data: reader.rest() };
      break;
    case TYPE_CODES.rekey:
      frame = { type: "rekey" };
      break;
    default:
      throw new FrameError("Unknown frame type.");
  }
  reader.end();
  return frame;
}
