import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { enableVtInput } from "../console-mode.ts";
import { exitHooks, MOUSE_OFF, MOUSE_ON, mouseExitHook } from "./start.tsx";

const vtHandle = (exited: boolean) => {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const handle = enableVtInput({ platform: "win32", spawn: () => child, env: {} });
  if (exited) child.emit("exit", 0, null);
  return { child, handle };
};

describe("exitHooks", () => {
  const fakeProcess = () => {
    const emitter = new EventEmitter();
    const exit = vi.fn();
    return { emitter, exit, proc: Object.assign(emitter, { exit }) as never };
  };

  it("cleans up once on exit, SIGTERM or SIGHUP, and exits on a signal", () => {
    for (const [signal, code] of [
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ] as const) {
      const { emitter, exit, proc } = fakeProcess();
      const onExit = vi.fn();
      exitHooks(onExit, proc);
      emitter.emit(signal, signal);
      emitter.emit("exit");
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(code);
    }
  });

  it("removes every listener", () => {
    const { emitter, proc } = fakeProcess();
    const onExit = vi.fn();
    exitHooks(onExit, proc)();
    expect(emitter.listenerCount("exit") + emitter.listenerCount("SIGTERM")).toBe(0);
    expect(emitter.listenerCount("SIGHUP")).toBe(0);
    emitter.emit("exit");
    expect(onExit).not.toHaveBeenCalled();
  });
});

describe("mouse switches", () => {
  it("are the SGR press/release/wheel modes", () => {
    expect(MOUSE_ON).toBe("\u001b[?1000h\u001b[?1003h\u001b[?1006h");
    expect(MOUSE_OFF).toBe("\u001b[?1003l\u001b[?1000l\u001b[?1006l");
  });

  it("the exit hook turns the mouse off and leaves raw mode", () => {
    const write = vi.fn();
    const setRawMode = vi.fn();
    mouseExitHook(write, { isTTY: true, setRawMode })();
    expect(write.mock.calls[0]?.[0]).toContain(MOUSE_OFF);
    expect(setRawMode.mock.calls).toEqual([[false]]);
  });

  it("the exit hook skips raw mode on a non-TTY", () => {
    const setRawMode = vi.fn();
    mouseExitHook(vi.fn(), { isTTY: false, setRawMode })();
    expect(setRawMode).not.toHaveBeenCalled();
  });

  it("the exit hook kills a still-running Windows child and resets the input mode", () => {
    const { child, handle } = vtHandle(false);
    const setRawMode = vi.fn();
    mouseExitHook(vi.fn(), { isTTY: true, setRawMode }, () => handle, "win32")();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it("the exit hook only leaves raw mode when the child had exited", () => {
    const { child, handle } = vtHandle(true);
    const setRawMode = vi.fn();
    mouseExitHook(vi.fn(), { isTTY: true, setRawMode }, () => handle, "win32")();
    expect(child.kill).not.toHaveBeenCalled();
    expect(setRawMode.mock.calls).toEqual([[false]]);
  });

  it("the exit hook does not reset the input mode off Windows", () => {
    const { handle } = vtHandle(false);
    const setRawMode = vi.fn();
    mouseExitHook(vi.fn(), { isTTY: true, setRawMode }, () => handle, "linux")();
    expect(setRawMode.mock.calls).toEqual([[false]]);
  });

  it("the exit hook never throws", () => {
    const { handle } = vtHandle(false);
    const setRawMode = () => {
      throw new Error("closed");
    };
    expect(() =>
      mouseExitHook(vi.fn(), { isTTY: true, setRawMode }, () => handle, "win32")(),
    ).not.toThrow();
    expect(() => mouseExitHook(vi.fn(), { isTTY: true, setRawMode })()).not.toThrow();
  });
});
