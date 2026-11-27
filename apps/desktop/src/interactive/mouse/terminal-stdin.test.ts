import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { InputHub } from "./input.ts";
import { type TerminalSource, terminalStdin } from "./terminal-stdin.ts";
import { clickAt } from "./testing.ts";

function fakeSource() {
  const emitter = new EventEmitter();
  const source = Object.assign(emitter, {
    setEncoding: vi.fn(),
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  });
  return source as unknown as TerminalSource &
    EventEmitter &
    Record<string, ReturnType<typeof vi.fn>>;
}

describe("terminalStdin", () => {
  it("gives Ink the keys without the mouse reports", async () => {
    const source = fakeSource();
    const hub = new InputHub();
    const clicks = vi.fn();
    hub.onMouse(clicks);
    const { stream } = terminalStdin(hub, source, () => {});
    stream.setEncoding("utf8");
    source.emit("data", `a${clickAt(0, 0)}b`);
    await new Promise((r) => setImmediate(r));
    expect(stream.read()).toBe("ab");
    expect(clicks).toHaveBeenCalledTimes(2);
  });

  it("is a TTY whose raw mode switches the terminal's, then runs onRaw", () => {
    const source = fakeSource();
    const onRaw = vi.fn();
    const { stream } = terminalStdin(new InputHub(), source, onRaw);
    expect(stream.isTTY).toBe(true);
    stream.setRawMode(true);
    expect(source.setRawMode).toHaveBeenCalledWith(true);
    expect(onRaw).toHaveBeenCalledTimes(1);
    stream.setRawMode(false);
    expect(source.setRawMode).toHaveBeenLastCalledWith(false);
    expect(onRaw).toHaveBeenCalledTimes(1);
  });

  it("close stops reading the terminal", () => {
    const source = fakeSource();
    const { close } = terminalStdin(new InputHub(), source, () => {});
    close();
    expect(source.listenerCount("data")).toBe(0);
    expect(source.pause).toHaveBeenCalled();
  });
});
