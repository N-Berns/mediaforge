import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface LineHandlers {
  onStdoutLine: (line: string) => void;
  onStderrLine: (line: string) => void;
}

/** Runs a command, streams its output by line, and resolves with its exit code. */
export type ProcessRunner = (
  command: string,
  args: string[],
  handlers: LineHandlers,
  signal: AbortSignal,
) => Promise<{ exitCode: number | null }>;

function killTree(pid: number | undefined, fallback: () => void): void {
  if (process.platform === "win32" && pid !== undefined) {
    // yt-dlp spawns ffmpeg; /T takes the whole tree down so nothing keeps writing.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    fallback();
  }
}

export const runProcess: ProcessRunner = (command, args, handlers, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Without these, Python may write output in the console code page and mangle file names.
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });

    createInterface({ input: child.stdout }).on("line", handlers.onStdoutLine);
    createInterface({ input: child.stderr }).on("line", handlers.onStderrLine);

    const abort = () => killTree(child.pid, () => child.kill("SIGTERM"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });

    child.once("error", reject);
    child.once("close", (exitCode) => {
      signal.removeEventListener("abort", abort);
      resolve({ exitCode });
    });
  });
