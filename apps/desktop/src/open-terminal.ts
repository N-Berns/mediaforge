import { spawn as spawnChild } from "node:child_process";
import { basename } from "node:path";
import { powershellPath } from "./powershell.ts";

export type OpenResult = "launched" | "no-terminal";

export interface OpenTerminalDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  execPath: string;
  argv1: string | undefined;
  /** Starts a process; resolves `true` when the launch worked. Must not throw. */
  run: (
    command: string,
    args: string[],
    env: Record<string, string | undefined>,
  ) => Promise<boolean>;
}

/**
 * Opens a new console window running the program named by MEDIAFORGE_OPEN_FILE with the
 * arguments in MEDIAFORGE_OPEN_ARGS (a JSON array). A constant: the values travel in the
 * environment and are never interpolated. Each argument is quoted because `Start-Process`
 * joins `-ArgumentList` with plain spaces; the parentheses make PowerShell 5.1 enumerate the
 * parsed array. Exits 1 when the program cannot be started.
 */
export const OPEN_SCRIPT =
  "try { $a = @((ConvertFrom-Json $env:MEDIAFORGE_OPEN_ARGS) | ForEach-Object { '\"' + $_ + '\"' }); Start-Process -FilePath $env:MEDIAFORGE_OPEN_FILE -ArgumentList $a -ErrorAction Stop } catch { exit 1 }";

/** How long the Windows launch may take before it counts as failed. */
export const LAUNCH_TIMEOUT_MS = 10_000;

const LINUX_TERMINALS = [
  "x-terminal-emulator",
  "gnome-terminal",
  "konsole",
  "xfce4-terminal",
  "xterm",
];

const runningThroughNode = (execPath: string): boolean =>
  basename(execPath.replace(/\\/g, "/"))
    .toLowerCase()
    .replace(/\.exe$/, "") === "node";

/** The command that starts the manager: the packaged exe, or node plus the script in development. */
export function managerCommand(
  execPath: string,
  argv1: string | undefined,
): { command: string; args: string[] } {
  if (runningThroughNode(execPath) && argv1) {
    return { command: execPath, args: [argv1, "--manager"] };
  }
  return { command: execPath, args: ["--manager"] };
}

/** The arguments that make `terminal` run `command` in its window; each emulator has its own flag. */
export function linuxTerminalArgs(terminal: string, command: string, args: string[]): string[] {
  const name = basename(terminal);
  if (name === "gnome-terminal") return ["--", command, ...args];
  if (name === "xfce4-terminal") return ["-x", command, ...args];
  return ["-e", command, ...args];
}

const defaults = (): OpenTerminalDeps => ({
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
  argv1: process.argv[1],
  run: (command, args, env) =>
    new Promise<boolean>((resolve) => {
      if (process.platform === "win32") {
        // PowerShell opens the window itself; its exit code says whether that worked.
        const child = spawnChild(command, args, { stdio: "ignore", windowsHide: true, env });
        // A hung PowerShell (a blocking prompt) must not leave the launch pending forever.
        const timer = setTimeout(() => {
          child.kill();
          resolve(false);
        }, LAUNCH_TIMEOUT_MS);
        child.on("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
      } else {
        // The terminal outlives this process, so detach it.
        const child = spawnChild(command, args, { detached: true, stdio: "ignore", env });
        child.on("error", () => resolve(false));
        child.on("spawn", () => {
          child.unref();
          resolve(true);
        });
      }
    }),
});

/** Opens `mediaforge --manager` in a new terminal window. Best effort: never throws. */
export async function openManagerTerminal(
  overrides: Partial<OpenTerminalDeps> = {},
): Promise<OpenResult> {
  const deps = { ...defaults(), ...overrides };
  try {
    const { command, args } = managerCommand(deps.execPath, deps.argv1);
    if (deps.platform === "win32") {
      const launched = await deps.run(
        powershellPath(deps.env),
        ["-NoProfile", "-NonInteractive", "-Command", OPEN_SCRIPT],
        {
          ...deps.env,
          MEDIAFORGE_OPEN_FILE: command,
          MEDIAFORGE_OPEN_ARGS: JSON.stringify(args),
        },
      );
      return launched ? "launched" : "no-terminal";
    }
    if (deps.platform === "linux") {
      const candidates = [deps.env.TERMINAL, ...LINUX_TERMINALS].filter(
        (terminal): terminal is string => Boolean(terminal),
      );
      for (const terminal of candidates) {
        try {
          if (await deps.run(terminal, linuxTerminalArgs(terminal, command, args), deps.env)) {
            return "launched";
          }
        } catch {
          // This terminal failed to start; try the next one.
        }
      }
    }
  } catch {
    // Opening a window is a convenience; failing to open one changes nothing else.
  }
  return "no-terminal";
}
