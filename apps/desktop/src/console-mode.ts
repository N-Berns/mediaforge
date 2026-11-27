import { spawn as spawnChild } from "node:child_process";
import { powershellPath } from "./powershell.ts";

/**
 * Turns on ENABLE_VIRTUAL_TERMINAL_INPUT (0x200) for the console input this process shares,
 * so the console sends mouse reports as text (Node's raw mode drops mouse records). A
 * constant: nothing is ever interpolated into it.
 */
export const VT_INPUT_SCRIPT = [
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;",
  "public static class MediaForgeConsole {",
  '[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int which);',
  '[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint mode);',
  '[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint mode);',
  "}';",
  "$h = [MediaForgeConsole]::GetStdHandle(-10); $m = 0;",
  "if ([MediaForgeConsole]::GetConsoleMode($h, [ref]$m)) {",
  "[void][MediaForgeConsole]::SetConsoleMode($h, $m -bor 0x200) }",
].join(" ");

/** The parts of a child process this uses. */
export interface ConsoleChild {
  kill(): unknown;
  once(event: "exit" | "error", listener: () => void): unknown;
}

interface ConsoleModeDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Starts a process whose stdin is this console. */
  spawn: (command: string, args: string[]) => ConsoleChild;
}

const defaults = (): ConsoleModeDeps => ({
  platform: process.platform,
  env: process.env,
  // stdin is inherited: GetStdHandle(-10) in the child is this console's input buffer.
  spawn: (command, args) => {
    const child = spawnChild(command, args, { stdio: ["inherit", "ignore", "ignore"] });
    child.on("error", () => {});
    child.unref();
    return child;
  },
});

/** The PowerShell child that turns the mouse bit on. */
export interface VtInputHandle {
  /** True until the child exits: it may still set the bit. */
  readonly running: boolean;
  /** Resolves when the child has exited (at once when none ran). */
  readonly exited: Promise<void>;
  /** Kills the child if it has not exited; otherwise does nothing. */
  stop(): void;
}

const idle: VtInputHandle = { running: false, exited: Promise.resolve(), stop: () => {} };

/** Lets the Windows console send mouse reports. Best effort: never throws; a no-op elsewhere. */
export function enableVtInput(overrides: Partial<ConsoleModeDeps> = {}): VtInputHandle {
  const deps = { ...defaults(), ...overrides };
  if (deps.platform !== "win32") return idle;
  try {
    // Encoded, so Windows argument quoting cannot touch the quotes in the C# source.
    const encoded = Buffer.from(VT_INPUT_SCRIPT, "utf16le").toString("base64");
    const child = deps.spawn(powershellPath(deps.env), [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encoded,
    ]);
    let running = true;
    const exited = new Promise<void>((resolve) => {
      const done = () => {
        running = false;
        resolve();
      };
      child.once("exit", done);
      child.once("error", done);
    });
    return {
      get running() {
        return running;
      },
      exited,
      stop: () => {
        if (!running) return;
        try {
          child.kill();
        } catch {
          // Gone already.
        }
      },
    };
  } catch {
    // Without it the mouse does not work in this console; the keys still do.
    return idle;
  }
}

/**
 * Resets the console input mode, dropping the mouse bit. Both switches are needed: libuv
 * skips a switch to the mode it thinks is set, and writes the whole input mode on a real one.
 * Call it on `process.stdin` itself. Never throws.
 */
export function resetConsoleInput(stdin: { setRawMode?: (on: boolean) => unknown }): void {
  try {
    stdin.setRawMode?.(true);
    stdin.setRawMode?.(false);
  } catch {
    // Not a console any more.
  }
}

/** How long quitting waits for a killed child to go before resetting the mode anyway. */
const SETTLE_WAIT_MS = 300;

/**
 * On quitting: a child still running could set the mouse bit after raw mode went off, and
 * leave it on in the user's shell. Kill it, give it a moment to go, then reset the mode.
 */
export async function settleVtInput(
  handle: VtInputHandle | undefined,
  platform: NodeJS.Platform,
  stdin: { setRawMode?: (on: boolean) => unknown },
): Promise<void> {
  if (platform !== "win32" || !handle?.running) return;
  handle.stop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    handle.exited,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SETTLE_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  resetConsoleInput(stdin);
}
