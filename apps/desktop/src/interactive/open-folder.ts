import { spawn } from "node:child_process";
import { dirname } from "node:path";

export interface OpenCommand {
  command: string;
  args: string[];
  /** Windows needs the quoting below passed through untouched. */
  verbatim: boolean;
}

/** The OS command that shows `path` in the file manager (selected, where supported). */
export function openCommand(
  path: string,
  platform: NodeJS.Platform = process.platform,
): OpenCommand {
  if (platform === "win32") {
    return { command: "explorer.exe", args: [`/select,"${path}"`], verbatim: true };
  }
  if (platform === "darwin") return { command: "open", args: ["-R", path], verbatim: false };
  return { command: "xdg-open", args: [dirname(path)], verbatim: false };
}

/** Show a file in the file manager. Never throws: failing to open a window is not worth an error. */
export function openFolder(path: string): Promise<void> {
  const { command, args, verbatim } = openCommand(path);
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
