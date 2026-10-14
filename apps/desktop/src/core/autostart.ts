import { basename } from "node:path";
import { execFileText } from "@mediaforge/binary-resolver";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "MediaForge";

const runningThroughNode = (execPath: string): boolean =>
  basename(execPath.replace(/\\/g, "/"))
    .toLowerCase()
    .replace(/\.exe$/, "") === "node";

/** The command that starts the core: the packaged exe, or node plus the script in development. */
export function coreSpawnCommand(
  execPath: string,
  argv1: string | undefined,
): { command: string; args: string[] } {
  if (runningThroughNode(execPath) && argv1) {
    return { command: execPath, args: [argv1, "--core"] };
  }
  return { command: execPath, args: ["--core"] };
}

export interface AutostartDeps {
  platform: NodeJS.Platform;
  execPath: string;
  argv1: string | undefined;
  run: (file: string, args: string[]) => Promise<unknown>;
}

const defaults = (): AutostartDeps => ({
  platform: process.platform,
  execPath: process.execPath,
  argv1: process.argv[1],
  // Not `promisify(execFile)`: pkg patches `execFile`, which breaks the promisified form inside
  // the packaged exe (docs/superpowers/spike-pkg-sea.md). `execFileText` hides the window too.
  run: (file, args) => execFileText(file, args),
});

/**
 * Start the core at login (Windows, packaged exe only). Anything else is a no-op, and a failure
 * never reaches the caller: autostart is a convenience, not something a download depends on.
 */
export async function applyAutostart(
  enabled: boolean,
  deps: AutostartDeps = defaults(),
): Promise<void> {
  if (deps.platform !== "win32" || runningThroughNode(deps.execPath)) return;
  try {
    if (enabled) {
      const { command, args } = coreSpawnCommand(deps.execPath, deps.argv1);
      await deps.run("reg.exe", [
        "add",
        RUN_KEY,
        "/v",
        VALUE_NAME,
        "/t",
        "REG_SZ",
        "/d",
        `"${command}" ${args.join(" ")}`,
        "/f",
      ]);
    } else {
      await deps.run("reg.exe", ["delete", RUN_KEY, "/v", VALUE_NAME, "/f"]);
    }
  } catch {
    // The key may already be absent, or the registry may be locked down.
  }
}
