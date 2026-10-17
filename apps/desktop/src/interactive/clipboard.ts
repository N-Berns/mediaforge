import { spawn } from "node:child_process";
import { execFileText } from "@mediaforge/binary-resolver";
import { powershellPath } from "../powershell.ts";

export interface ClipboardCommand {
  command: string;
  args: string[];
}

/*
 * The Windows scripts read and write UTF-8 through the raw standard streams. Setting
 * [Console]::InputEncoding or OutputEncoding instead would change the code page of the
 * console the child shares with the app, and leave it changed after the child exits.
 */
const READ_SCRIPT =
  "$w = New-Object IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object Text.UTF8Encoding $false)); $t = Get-Clipboard -Raw; if ($null -ne $t) { $w.WriteLine($t) }; $w.Flush()";
const COPY_SCRIPT =
  "$r = New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8); Set-Clipboard -Value $r.ReadToEnd()";

/** Commands that print the clipboard text, in the order to try them. */
export function clipboardCommands(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): ClipboardCommand[] {
  if (platform === "win32") {
    return [
      {
        command: powershellPath(env),
        args: ["-NoProfile", "-NonInteractive", "-Command", READ_SCRIPT],
      },
    ];
  }
  const wayland = env.WAYLAND_DISPLAY ? [{ command: "wl-paste", args: ["-n"] }] : [];
  return [
    ...wayland,
    { command: "xclip", args: ["-selection", "clipboard", "-o"] },
    { command: "xsel", args: ["--clipboard", "--output"] },
  ];
}

export type RunCommand = (command: string, args: string[]) => Promise<string>;

const defaultRun: RunCommand = (command, args) =>
  execFileText(command, args, { timeoutMs: 4000, maxBuffer: 1 << 20 });

/** Clipboard text, or undefined when it is empty or no clipboard tool works. */
export async function readClipboard(
  run: RunCommand = defaultRun,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  for (const { command, args } of clipboardCommands(platform, env)) {
    try {
      const text = await run(command, args);
      return text.trim() ? text : undefined;
    } catch {
      // Try the next tool.
    }
  }
  return undefined;
}

/** Commands that set the clipboard to their stdin, in the order to try them. */
export function copyCommands(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env,
): ClipboardCommand[] {
  if (platform === "win32") {
    return [
      {
        command: powershellPath(env),
        args: ["-NoProfile", "-NonInteractive", "-Command", COPY_SCRIPT],
      },
    ];
  }
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

export type RunWithInput = (command: string, args: string[], input: string) => Promise<void>;

const COPY_TIMEOUT_MS = 4000;

const defaultRunWithInput: RunWithInput = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      timeout: COPY_TIMEOUT_MS,
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
  });

/** Puts `text` on the clipboard. False when no clipboard tool works. */
export async function writeClipboard(
  text: string,
  run: RunWithInput = defaultRunWithInput,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  for (const { command, args } of copyCommands(platform)) {
    try {
      await run(command, args, text);
      return true;
    } catch {
      // Try the next tool.
    }
  }
  return false;
}
