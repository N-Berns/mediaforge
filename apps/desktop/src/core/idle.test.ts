import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleMonitor } from "./idle.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(state: { idle: boolean; keep: boolean }) {
  const onIdle = vi.fn();
  const monitor = new IdleMonitor({
    graceMs: 60_000,
    isIdle: () => state.idle,
    keepRunning: async () => state.keep,
    onIdle,
  });
  return { monitor, onIdle };
}

describe("IdleMonitor", () => {
  it("exits after the grace period when idle and not kept running", async () => {
    const { monitor, onIdle } = setup({ idle: true, keep: false });
    await monitor.check();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does not exit while jobs or clients are active", async () => {
    const state = { idle: false, keep: false };
    const { monitor, onIdle } = setup(state);
    await monitor.check();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("cancels the countdown when work arrives", async () => {
    const state = { idle: true, keep: false };
    const { monitor, onIdle } = setup(state);
    await monitor.check();
    state.idle = false;
    await monitor.check();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("never exits while keepRunning is on, and exits once it is turned off", async () => {
    const state = { idle: true, keep: true };
    const { monitor, onIdle } = setup(state);
    await monitor.check();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onIdle).not.toHaveBeenCalled();
    state.keep = false;
    await monitor.check();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("re-checks when the timer fires, so late work wins", async () => {
    const state = { idle: true, keep: false };
    const { monitor, onIdle } = setup(state);
    await monitor.check();
    state.idle = false;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("leaves no timer behind after stop() or when work arrives", async () => {
    const state = { idle: true, keep: false };
    const { monitor } = setup(state);
    await monitor.check();
    expect(vi.getTimerCount()).toBe(1);
    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);

    await monitor.check();
    expect(vi.getTimerCount()).toBe(1);
    state.idle = false;
    await monitor.check();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the original deadline when check() is called again", async () => {
    const { monitor, onIdle } = setup({ idle: true, keep: false });
    await monitor.check();
    await vi.advanceTimersByTimeAsync(30_000);
    await monitor.check();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});

/** `keepRunning` answers only when the test says so, to model state changing mid-await. */
function gated(state: { idle: boolean }) {
  const pending: Array<(keep: boolean) => void> = [];
  const onIdle = vi.fn();
  const monitor = new IdleMonitor({
    graceMs: 60_000,
    isIdle: () => state.idle,
    keepRunning: () => new Promise<boolean>((resolve) => pending.push(resolve)),
    onIdle,
  });
  const release = (keep = false) => {
    for (const resolve of pending.splice(0)) resolve(keep);
  };
  return { monitor, onIdle, pending, release };
}

describe("IdleMonitor with state that changes while keepRunning is awaited", () => {
  it("does not arm the timer when work arrives during check()", async () => {
    const state = { idle: true };
    const { monitor, release } = gated(state);
    const checking = monitor.check();
    state.idle = false;
    release();
    await checking;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not exit when work arrives while the fired check awaits keepRunning", async () => {
    const state = { idle: true };
    const { monitor, onIdle, pending, release } = gated(state);
    const first = monitor.check();
    release();
    await first;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending).toHaveLength(1);
    state.idle = false;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("does not exit when stop() is called while the fired check awaits keepRunning", async () => {
    const state = { idle: true };
    const { monitor, onIdle, pending, release } = gated(state);
    const first = monitor.check();
    release();
    await first;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending).toHaveLength(1);
    monitor.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(onIdle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not arm the timer when stop() is called during check()", async () => {
    const state = { idle: true };
    const { monitor, onIdle, release } = gated(state);
    const checking = monitor.check();
    monitor.stop();
    release();
    await checking;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("can arm again after stop(), once its in-flight work has been dropped", async () => {
    const state = { idle: true };
    const { monitor, onIdle, pending, release } = gated(state);
    const first = monitor.check();
    release();
    await first;
    await vi.advanceTimersByTimeAsync(60_000);
    monitor.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(0);

    const again = monitor.check();
    release();
    await again;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("calls onIdle once even if check() re-arms while the fired check is awaiting", async () => {
    const state = { idle: true };
    const { monitor, onIdle, release } = gated(state);
    const first = monitor.check();
    release();
    await first;
    await vi.advanceTimersByTimeAsync(60_000);
    const second = monitor.check();
    release();
    await second;
    await vi.advanceTimersByTimeAsync(0);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
