import { assert, describe, it } from "@effect/vitest";

import { decodeFrame, encodeFrame, type Frame, FrameError } from "./frames.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("channel frames", () => {
  it("round-trips every frame type", () => {
    const frames: Frame[] = [
      { type: "open", stream: 1 },
      { type: "data", stream: 5, bytes: bytes(0, 1, 255) },
      { type: "data", stream: 5, bytes: new Uint8Array(0) },
      { type: "end", stream: 129 },
      { type: "reset", stream: 2 ** 31 - 1, reason: "café ☕" },
      { type: "reset", stream: 3, reason: "" },
      { type: "credit", stream: 9, bytes: 2 ** 32 },
      { type: "ping", data: bytes(1, 2, 3) },
      { type: "pong", data: new Uint8Array(0) },
      { type: "rekey" },
    ];
    for (const frame of frames) assert.deepStrictEqual(decodeFrame(encodeFrame(frame)), frame);
  });

  it("round-trips varints at their byte boundaries", () => {
    for (const value of [0, 127, 128, 16_383, 16_384, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
      const frame: Frame = { type: "credit", stream: 1, bytes: value };
      assert.deepStrictEqual(decodeFrame(encodeFrame(frame)), frame);
    }
  });

  it("refuses malformed frames", () => {
    const end = encodeFrame({ type: "end", stream: 1 });
    const malformed = {
      empty: new Uint8Array(0),
      truncated: encodeFrame({ type: "reset", stream: 1, reason: "bye" }).subarray(0, 4),
      trailing: Uint8Array.of(...end, 0),
      unknownType: bytes(1, 99),
      controlOnAStream: bytes(1, 8),
      streamFrameOnStreamZero: bytes(0, 3),
      invalidUtf8: bytes(1, 4, 1, 0xff),
      overlongVarint: bytes(255, 255, 255, 255, 255, 255, 255, 255, 1, 3),
    };
    for (const [name, frame] of Object.entries(malformed)) {
      assert.throws(() => decodeFrame(frame), FrameError, undefined, name);
    }
  });

  it("throws only a FrameError for any malformed input", () => {
    let state = 0x2545f491;
    const random = (below: number) => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) % below;
    };
    const valid = [
      encodeFrame({ type: "data", stream: 3, bytes: bytes(1, 2, 3) }),
      encodeFrame({ type: "reset", stream: 5, reason: "gone" }),
      encodeFrame({ type: "credit", stream: 7, bytes: 131_072 }),
      encodeFrame({ type: "ping", data: bytes(9) }),
    ];
    for (let round = 0; round < 20_000; round += 1) {
      let input: Uint8Array;
      if (round % 2 === 0) {
        input = Uint8Array.from({ length: random(16) }, () => random(256));
      } else {
        input = valid[random(valid.length)]!.slice();
        for (let mutation = random(4); mutation >= 0; mutation -= 1) {
          if (input.length > 0) input[random(input.length)] = random(256);
        }
        input = input.subarray(0, random(input.length + 1));
      }
      try {
        decodeFrame(input);
      } catch (error) {
        assert.instanceOf(error, FrameError, `input ${Array.from(input).join(",")}`);
      }
    }
  });
});
