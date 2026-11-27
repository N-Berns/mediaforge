import { DEFAULT_LIMITS, type LimitPreset } from "@mediaforge/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bandwidth, type BandwidthSettings, planRates, type RateJob } from "./bandwidth.ts";

const settings = (preset: LimitPreset, limits = {}): BandwidthSettings => ({
  limitPreset: preset,
  limits: { ...DEFAULT_LIMITS, ...limits },
});

describe("planRates", () => {
  it("gives nothing a cap while the preset is unlimited", () => {
    const jobs = [{ id: "a", status: "downloading" as const }];
    expect(planRates(jobs, settings("high"))).toEqual(new Map([["a", undefined]]));
  });

  it("splits the preset evenly, rounding down, over downloading jobs only", () => {
    const jobs: RateJob[] = [
      { id: "a", status: "downloading" },
      { id: "b", status: "downloading" },
      { id: "c", status: "downloading" },
      { id: "q", status: "queued" },
      { id: "p", status: "processing" },
      { id: "z", status: "paused" },
    ];
    expect(planRates(jobs, settings("med"))).toEqual(
      new Map([
        ["a", 1_666_666],
        ["b", 1_666_666],
        ["c", 1_666_666],
      ]),
    );
  });

  it("gives an overridden job its own cap, outside the split", () => {
    const jobs = [
      { id: "a", status: "downloading" as const },
      {
        id: "b",
        status: "downloading" as const,
        limitOverride: "low" as const,
      },
      {
        id: "c",
        status: "downloading" as const,
        limitOverride: "high" as const,
      },
    ];
    expect(planRates(jobs, settings("med"))).toEqual(
      new Map([
        ["a", 5_000_000],
        ["b", 1_000_000],
        ["c", undefined],
      ]),
    );
  });

  it("never splits below 1 byte per second", () => {
    const jobs = [
      { id: "a", status: "downloading" as const },
      { id: "b", status: "downloading" as const },
    ];
    expect(planRates(jobs, settings("custom", { custom: 1 })).get("a")).toBe(1);
  });
});

describe("Bandwidth", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeEngine(jobs: RateJob[]) {
    const rates = new Map<string, number | undefined>();
    const applied = new Map<string, number | undefined>();
    const restarts: string[] = [];
    return {
      jobs,
      rates,
      restarts,
      /** The rate each running job's yt-dlp was started with. */
      applied,
      engine: {
        list: () => jobs.map((j) => ({ ...j })),
        setRate: (id: string, rate: number | undefined) => void rates.set(id, rate),
        applyRate: (id: string) => {
          const job = jobs.find((j) => j.id === id);
          if (job?.status !== "downloading" || rates.get(id) === applied.get(id)) return false;
          restarts.push(id);
          applied.set(id, rates.get(id));
          return true;
        },
      },
    };
  }

  it("sets a starting job's cap at once and restarts the others after 3 s", () => {
    const f = fakeEngine([{ id: "a", status: "downloading" }]);
    const bw = new Bandwidth({
      engine: f.engine,
      overrideOf: () => undefined,
      settings: settings("med"),
    });
    bw.update();
    f.applied.set("a", f.rates.get("a"));
    expect(f.rates.get("a")).toBe(5_000_000);

    f.jobs.push({ id: "b", status: "downloading" });
    bw.update();
    expect(f.rates.get("b")).toBe(2_500_000);
    f.applied.set("b", 2_500_000); // b starts with its share
    expect(f.restarts).toEqual([]);
    vi.advanceTimersByTime(2999);
    expect(f.restarts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(f.restarts).toEqual(["a"]);
    bw.dispose();
  });

  it("restarts each job once for a burst of changes", () => {
    const f = fakeEngine([
      { id: "a", status: "downloading" },
      { id: "b", status: "downloading" },
    ]);
    const bw = new Bandwidth({
      engine: f.engine,
      overrideOf: () => undefined,
      settings: settings("high"),
    });
    bw.setSettings(settings("med"));
    vi.advanceTimersByTime(1000);
    bw.setSettings(settings("low"));
    vi.advanceTimersByTime(1000);
    f.jobs.push({ id: "c", status: "queued" });
    bw.update();
    vi.advanceTimersByTime(3000);
    expect(f.restarts.sort()).toEqual(["a", "b"]);
    expect(f.applied.get("a")).toBe(500_000);
    bw.dispose();
  });

  it("does not restart a job whose cap ends up where it started", () => {
    const f = fakeEngine([{ id: "a", status: "downloading" }]);
    f.applied.set("a", undefined);
    const bw = new Bandwidth({
      engine: f.engine,
      overrideOf: () => undefined,
      settings: settings("high"),
    });
    bw.setSettings(settings("med"));
    bw.setSettings(settings("high"));
    vi.advanceTimersByTime(3000);
    expect(f.restarts).toEqual([]);
    bw.dispose();
  });

  it("leaves a job alone that went on to processing while the restart waited", () => {
    const f = fakeEngine([{ id: "a", status: "downloading" }]);
    const bw = new Bandwidth({
      engine: f.engine,
      overrideOf: () => undefined,
      settings: settings("high"),
    });
    bw.setSettings(settings("med"));
    (f.jobs[0] as RateJob).status = "processing";
    vi.advanceTimersByTime(3000);
    expect(f.restarts).toEqual([]);
    bw.dispose();
  });

  it("reads overrides through overrideOf", () => {
    const f = fakeEngine([{ id: "a", status: "downloading" }]);
    const bw = new Bandwidth({
      engine: f.engine,
      overrideOf: () => "low",
      settings: settings("high"),
    });
    bw.update();
    expect(f.rates.get("a")).toBe(1_000_000);
    bw.dispose();
  });

  it("schedules nothing when no job is downloading, and dispose clears a pending restart", () => {
    const f = fakeEngine([{ id: "a", status: "paused" }]);
    const bw = new Bandwidth({
      engine: f.engine,
      overrideOf: () => undefined,
      settings: settings("med"),
    });
    bw.update();
    expect(vi.getTimerCount()).toBe(0);
    f.jobs[0] = { id: "a", status: "downloading" };
    bw.update();
    expect(vi.getTimerCount()).toBe(1);
    bw.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
