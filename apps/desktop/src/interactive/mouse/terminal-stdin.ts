import { PassThrough } from "node:stream";
import type { InputHub } from "./input.ts";

/** The parts of `process.stdin` this uses. */
export interface TerminalSource {
  setEncoding(encoding: "utf8"): unknown;
  setRawMode(on: boolean): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  off(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  ref(): unknown;
  unref(): unknown;
}

/**
 * The input stream Ink reads: the terminal's keys with the mouse reports taken out by `hub`.
 * Raw mode passes through to the terminal; `onRaw` runs after each switch into raw mode (on
 * Windows, raw mode resets the console input mode, so the mouse bit goes back on there).
 */
export function terminalStdin(
  hub: InputHub,
  source: TerminalSource,
  onRaw: () => void,
): { stream: NodeJS.ReadStream; close: () => void } {
  const stream = new PassThrough();
  hub.deliver = (text) => stream.write(text);
  const onData = (chunk: string | Buffer) => hub.feed(String(chunk));
  source.setEncoding("utf8");
  source.on("data", onData);
  const tty = Object.assign(stream, {
    isTTY: true,
    setRawMode(on: boolean) {
      source.setRawMode(on);
      if (on) {
        source.resume();
        onRaw();
      }
      return tty;
    },
    ref() {
      source.ref();
      return tty;
    },
    unref() {
      source.unref();
      return tty;
    },
  });
  return {
    stream: tty as unknown as NodeJS.ReadStream,
    close: () => {
      source.off("data", onData);
      source.pause();
    },
  };
}
