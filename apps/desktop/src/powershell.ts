import { win32 } from "node:path";

/**
 * Windows PowerShell by its full path, so a `powershell.exe` planted in the current folder
 * never runs in its place.
 */
export function powershellPath(env: Record<string, string | undefined> = process.env): string {
  return win32.join(
    env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}
