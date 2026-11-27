import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, formatBytes, formatLimit, formatRate, parseRate } from "./units.ts";

describe("formatBytes", () => {
  it("uses decimal steps and the largest unit that is at least 1", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1000)).toBe("1.0 kB");
    expect(formatBytes(1536)).toBe("1.5 kB");
    expect(formatBytes(5_000_000)).toBe("5.0 MB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.2 MB");
    expect(formatBytes(412_000_000)).toBe("412 MB");
    expect(formatBytes(1e12)).toBe("1.0 TB");
    expect(formatBytes(2.5e15)).toBe("2.5 PB");
  });

  it("shows one decimal under 100 and none from 100 up", () => {
    expect(formatBytes(99_940_000)).toBe("99.9 MB");
    expect(formatBytes(99_960_000)).toBe("100 MB");
    expect(formatBytes(100_000_000)).toBe("100 MB");
  });

  it("moves to the next unit when rounding reaches 1000", () => {
    expect(formatBytes(999.6)).toBe("1.0 kB");
    expect(formatBytes(999_960)).toBe("1.0 MB");
    expect(formatBytes(999_400)).toBe("999 kB");
  });

  it("stays in PB above the largest unit", () => {
    expect(formatBytes(5e18)).toBe("5000 PB");
  });
});

describe("formatRate", () => {
  it("shows bytes per second", () => {
    expect(formatRate(512, "bytes")).toBe("512 B/s");
    expect(formatRate(6_100_000, "bytes")).toBe("6.1 MB/s");
    expect(formatRate(120_000_000, "bytes")).toBe("120 MB/s");
  });

  it("shows bits per second, eight bits to a byte", () => {
    expect(formatRate(100, "bits")).toBe("800 bps");
    expect(formatRate(125, "bits")).toBe("1.0 kbps");
    expect(formatRate(6_100_000, "bits")).toBe("48.8 Mbps");
    expect(formatRate(15_000_000, "bits")).toBe("120 Mbps");
    expect(formatRate(1.25e14, "bits")).toBe("1.0 Pbps");
  });
});

describe("formatLimit", () => {
  it("says no limit for null and formats the rest", () => {
    expect(formatLimit(null, "bytes")).toBe("no limit");
    expect(formatLimit(DEFAULT_LIMITS.med, "bytes")).toBe("5.0 MB/s");
    expect(formatLimit(DEFAULT_LIMITS.med, "bits")).toBe("40.0 Mbps");
  });
});

describe("parseRate", () => {
  it("reads a bare number with the current unit's M prefix", () => {
    expect(parseRate("5", "bytes")).toEqual({
      ok: true,
      bytesPerSec: 5_000_000,
    });
    expect(parseRate("40", "bits")).toEqual({
      ok: true,
      bytesPerSec: 5_000_000,
    });
    expect(parseRate(" 2,5 ", "bytes")).toEqual({
      ok: true,
      bytesPerSec: 2_500_000,
    });
  });

  it("reads a prefix and a unit", () => {
    expect(parseRate("5 MB/s", "bits")).toEqual({
      ok: true,
      bytesPerSec: 5_000_000,
    });
    expect(parseRate("40 Mbps", "bytes")).toEqual({
      ok: true,
      bytesPerSec: 5_000_000,
    });
    expect(parseRate("500k", "bytes")).toEqual({
      ok: true,
      bytesPerSec: 500_000,
    });
    expect(parseRate("500 kb/s", "bytes")).toEqual({
      ok: true,
      bytesPerSec: 62_500,
    });
    expect(parseRate("1.5gB", "bits")).toEqual({
      ok: true,
      bytesPerSec: 1_500_000_000,
    });
    expect(parseRate("800 B/s", "bits")).toEqual({
      ok: true,
      bytesPerSec: 800,
    });
    expect(parseRate("2 Mbit/s", "bytes")).toEqual({
      ok: true,
      bytesPerSec: 250_000,
    });
  });

  it("reads empty and 0 as unlimited", () => {
    expect(parseRate("", "bytes")).toEqual({ ok: true, bytesPerSec: null });
    expect(parseRate("   ", "bits")).toEqual({ ok: true, bytesPerSec: null });
    expect(parseRate("0", "bytes")).toEqual({ ok: true, bytesPerSec: null });
    expect(parseRate("0 Mbps", "bytes")).toEqual({
      ok: true,
      bytesPerSec: null,
    });
  });

  it("rejects text it cannot read, rates under 1 B/s and rates over 1 PB/s", () => {
    expect(parseRate("fast", "bytes")).toEqual({
      ok: false,
      error: "Type a speed such as 5, 5 MB/s or 40 Mbps.",
    });
    expect(parseRate("-5", "bytes").ok).toBe(false);
    expect(parseRate("5 MB/h", "bytes").ok).toBe(false);
    expect(parseRate("1 b", "bits")).toEqual({
      ok: false,
      error: "The smallest limit is 1 B/s.",
    });
    expect(parseRate("2 PB/s", "bytes")).toEqual({
      ok: false,
      error: "The largest limit is 1 PB/s.",
    });
  });
});
