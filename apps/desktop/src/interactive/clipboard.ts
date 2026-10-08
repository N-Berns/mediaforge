import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ClipboardCommand {
  command: string;
  args: string[];
}

/** Commands that print the clipboard text, in the order to try them. */
export function clipboardCommands(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): ClipboardCommand[] {
  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw",
        ],
      },
    ];
  }
  if (platform === "darwin") return [{ command: "pbpaste", args: [] }];
  const wayland = env.WAYLAND_DISPLAY ? [{ command: "wl-paste", args: ["-n"] }] : [];
  return [
    ...wayland,
    { command: "xclip", args: ["-selection", "clipboard", "-o"] },
    { command: "xsel", args: ["--clipboard", "--output"] },
  ];
}

export type RunCommand = (command: string, args: string[]) => Promise<string>;

const defaultRun: RunCommand = async (command, args) =>
  (await execFileAsync(command, args, { timeout: 4000, windowsHide: true, maxBuffer: 1 << 20 }))
    .stdout;

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
