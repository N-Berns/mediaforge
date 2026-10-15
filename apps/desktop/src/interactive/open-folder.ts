import { spawn } from "node:child_process";
import { dirname } from "node:path";

export interface OpenCommand {
  command: string;
  args: string[];
  /** Windows needs the quoting below passed through untouched. */
  verbatim: boolean;
}

/**
 * The OS command that shows `path` in the file manager: a file selected in its folder (where
 * supported), or with `select` off, a folder opened on its own.
 */
export function openCommand(
  path: string,
  platform: NodeJS.Platform = process.platform,
  select = true,
): OpenCommand {
  if (platform === "win32") {
    return {
      command: "explorer.exe",
      args: [select ? `/select,"${path}"` : `"${path}"`],
      verbatim: true,
    };
  }
  return { command: "xdg-open", args: [select ? dirname(path) : path], verbatim: false };
}

/** Show a file in the file manager. Never throws: failing to open a window is not worth an error. */
export function openFolder(path: string, select = true): Promise<void> {
  const { command, args, verbatim } = openCommand(path, process.platform, select);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: verbatim,
    });
    child.once("error", () => resolve());
    child.unref();
    resolve();
  });
}
