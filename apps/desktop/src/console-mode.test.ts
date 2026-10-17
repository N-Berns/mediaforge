import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ConsoleChild,
  enableVtInput,
  resetConsoleInput,
  settleVtInput,
  VT_INPUT_SCRIPT,
} from "./console-mode.ts";
import { powershellPath } from "./powershell.ts";

const fakeChild = () => Object.assign(new EventEmitter(), { kill: vi.fn() });

describe("enableVtInput", () => {
  it("does nothing off Windows", () => {
    const spawn = vi.fn();
    const handle = enableVtInput({ platform: "linux", spawn });
    expect(spawn).not.toHaveBeenCalled();
    expect(handle.running).toBe(false);
    expect(() => handle.stop()).not.toThrow();
  });

  it("runs the constant script, encoded, with PowerShell by full path, on Windows", () => {
    const spawn = vi.fn((_command: string, _args: string[]) => fakeChild());
    enableVtInput({ platform: "win32", spawn, env: {} });
    const [command, args = []] = spawn.mock.calls[0] ?? [];
    expect(command).toBe(powershellPath({}));
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(args[3] ?? "", "base64").toString("utf16le")).toBe(VT_INPUT_SCRIPT);
  });

  it("sets 0x200 on the console input handle", () => {
    expect(VT_INPUT_SCRIPT).toContain("GetStdHandle(-10)");
    expect(VT_INPUT_SCRIPT).toContain("-bor 0x200");
  });

  it("never throws", () => {
    let handle: ReturnType<typeof enableVtInput> | undefined;
    expect(() => {
      handle = enableVtInput({
        platform: "win32",
        spawn: () => {
          throw new Error("no powershell");
        },
      });
    }).not.toThrow();
    expect(handle?.running).toBe(false);
  });

  it("stop() kills the child while it runs", () => {
    const child = fakeChild();
    const handle = enableVtInput({ platform: "win32", spawn: () => child, env: {} });
    expect(handle.running).toBe(true);
    handle.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("stop() does nothing once the child has exited", async () => {
    const child = fakeChild();
    const handle = enableVtInput({ platform: "win32", spawn: () => child, env: {} });
    child.emit("exit", 0, null);
    expect(handle.running).toBe(false);
    await handle.exited;
    handle.stop();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("counts a child that failed to start as exited", async () => {
    const child = fakeChild();
    const handle = enableVtInput({ platform: "win32", spawn: () => child, env: {} });
    child.emit("error", new Error("ENOENT"));
    expect(handle.running).toBe(false);
    await handle.exited;
  });
});

describe("resetConsoleInput", () => {
  it("switches raw mode on, then off, so libuv rewrites the whole input mode", () => {
    const setRawMode = vi.fn();
    resetConsoleInput({ setRawMode });
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it("never throws", () => {
    expect(() =>
      resetConsoleInput({
        setRawMode: () => {
          throw new Error("closed");
        },
      }),
    ).not.toThrow();
  });
});

describe("settleVtInput", () => {
  afterEach(() => vi.useRealTimers());

  const running = (child: ConsoleChild) =>
    enableVtInput({ platform: "win32", spawn: () => child, env: {} });

  it("kills a running child, waits for it, then resets the input mode", async () => {
    const child = fakeChild();
    child.kill.mockImplementation(() => setTimeout(() => child.emit("exit", null, "SIGTERM"), 5));
    const setRawMode = vi.fn();
    await settleVtInput(running(child), "win32", { setRawMode });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it("waits at most 300 ms for the child to go", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const setRawMode = vi.fn();
    const done = settleVtInput(running(child), "win32", { setRawMode });
    await vi.advanceTimersByTimeAsync(299);
    expect(setRawMode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it("does nothing when the child had already exited", async () => {
    const child = fakeChild();
    const handle = running(child);
    child.emit("exit", 0, null);
    const setRawMode = vi.fn();
    await settleVtInput(handle, "win32", { setRawMode });
    expect(child.kill).not.toHaveBeenCalled();
    expect(setRawMode).not.toHaveBeenCalled();
  });

  it("does nothing off Windows or without a handle", async () => {
    const setRawMode = vi.fn();
    await settleVtInput(running(fakeChild()), "linux", { setRawMode });
    await settleVtInput(undefined, "win32", { setRawMode });
    expect(setRawMode).not.toHaveBeenCalled();
  });
});
