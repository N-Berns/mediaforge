import { describe, expect, it } from "vitest";
import { createDecoder, encodeMessage, FramingError } from "./framing.ts";

describe("framing", () => {
  it("round-trips a message with a little-endian length header", () => {
    const frame = encodeMessage({ hello: "wörld" });
    const length = new DataView(frame.buffer).getUint32(0, true);
    expect(length).toBe(frame.byteLength - 4);
    expect(createDecoder().push(frame)).toEqual([{ hello: "wörld" }]);
  });

  it("reassembles messages split across chunks", () => {
    const frame = encodeMessage({ n: 1, text: "x".repeat(100) });
    const decoder = createDecoder();
    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2, 50))).toEqual([]);
    expect(decoder.pending).toBe(50);
    expect(decoder.push(frame.subarray(50))).toEqual([{ n: 1, text: "x".repeat(100) }]);
    expect(decoder.pending).toBe(0);
  });

  it("decodes several messages from one chunk, keeping the remainder", () => {
    const a = encodeMessage({ a: 1 });
    const b = encodeMessage({ b: 2 });
    const c = encodeMessage({ c: 3 });
    const joined = new Uint8Array([...a, ...b, ...c.subarray(0, 3)]);
    const decoder = createDecoder();
    expect(decoder.push(joined)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(decoder.push(c.subarray(3))).toEqual([{ c: 3 }]);
  });

  it("rejects outgoing messages over the limit", () => {
    expect(() => encodeMessage({ big: "x".repeat(2048) }, 1024)).toThrow(FramingError);
  });

  it("rejects incoming frames that declare an oversized length", () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 5000, true);
    const decoder = createDecoder(1024);
    expect(() => decoder.push(header)).toThrow(FramingError);
    expect(decoder.pending).toBe(0);
  });

  it("reports invalid JSON bodies", () => {
    const body = new TextEncoder().encode("{nope");
    const frame = new Uint8Array(4 + body.byteLength);
    new DataView(frame.buffer).setUint32(0, body.byteLength, true);
    frame.set(body, 4);
    expect(() => createDecoder().push(frame)).toThrow(/not valid JSON/);
  });
});
