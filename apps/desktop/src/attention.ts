import { spawn as spawnChild } from "node:child_process";
import { powershellPath } from "./powershell.ts";

export interface FlashDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Writes to the terminal (BEL). */
  write: (text: string) => void;
  /** Starts a process sharing this console; must not throw. */
  spawn: (command: string, args: string[]) => void;
}

/**
 * Flashes the console window this process belongs to: FLASHW_TRAY (2) | FLASHW_TIMERNOFG (12),
 * until the window comes to the front. A constant: nothing is ever interpolated into it.
 */
export const FLASH_SCRIPT = [
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;",
  "public static class MediaForgeFlash {",
  "[StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO {",
  "public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }",
  '[DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO info);',
  '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
  "public static void Run() { FLASHWINFO f = new FLASHWINFO(); f.cbSize = (uint)Marshal.SizeOf(f);",
  "f.hwnd = GetConsoleWindow(); f.dwFlags = 14; f.uCount = 0; f.dwTimeout = 0; FlashWindowEx(ref f); } }';",
  "[MediaForgeFlash]::Run()",
].join(" ");

const defaults = (): FlashDeps => ({
  platform: process.platform,
  env: process.env,
  write: (text) => void process.stdout.write(text),
  // The child must share this console, so GetConsoleWindow finds the manager's window: no
  // detached, no hidden window style (hiding a shared console would hide the manager).
  spawn: (command, args) => {
    const child = spawnChild(command, args, { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  },
});

/** Draws the user's eye to this terminal window. Best effort: never throws. */
export function flashWindow(overrides: Partial<FlashDeps> = {}): void {
  const deps = { ...defaults(), ...overrides };
  try {
    if (deps.platform === "win32" && !deps.env.WT_SESSION) {
      // Encoded, so Windows argument quoting cannot touch the quotes in the C# source.
      const encoded = Buffer.from(FLASH_SCRIPT, "utf16le").toString("base64");
      deps.spawn(powershellPath(deps.env), [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encoded,
      ]);
    } else {
      // Windows Terminal and most Linux terminals mark the window on a bell.
      deps.write("\x07");
    }
  } catch {
    // A flash is a nicety; failing to flash changes nothing else.
  }
}
