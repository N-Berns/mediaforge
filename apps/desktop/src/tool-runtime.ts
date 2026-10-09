import { createInterface } from "node:readline/promises";
import {
  BinaryNotFoundError,
  cacheDir,
  defaultInstallDeps,
  type InstallProgress,
  type InstallResult,
  installTool,
  type ResolvedBinary,
  resolveTarget,
  type Tool,
  ToolInstallError,
  UnsupportedTargetError,
} from "@mediaforge/binary-resolver";
import { forgetResolvedTools, type ResolveTool, resolveTool } from "./binaries.ts";
import { isRequired } from "./doctor.ts";
import { CliError, ExitCode } from "./exit-codes.ts";
import { formatBytes } from "./progress-view.ts";

/** Points the yt-dlp lookup at another release server. Used by the release smoke test. */
export const YTDLP_REPO_ENV = "MEDIAFORGE_YTDLP_REPO_URL";

/** Everything the tool commands need from the outside world. Tests replace all of it. */
export interface ToolRuntime {
  resolve: ResolveTool;
  install: (tool: Tool, onProgress: (progress: InstallProgress) => void) => Promise<InstallResult>;
  /** True when a person can answer: stdin and stderr are terminals. */
  interactive: boolean;
  ask: (question: string) => Promise<boolean>;
}

export async function tryResolve(
  tool: Tool,
  resolve: ResolveTool,
): Promise<ResolvedBinary | undefined> {
  try {
    return await resolve(tool);
  } catch (error) {
    if (error instanceof BinaryNotFoundError) return undefined;
    throw error;
  }
}

const NETWORK_KINDS = new Set(["offline", "not-found", "rate-limit", "http", "checksum"]);
const FILE_KINDS = new Set(["disk-full", "permission", "io", "extract"]);

/** Give a failed download the exit code and message the CLI prints. Other errors pass through. */
export function toCliError(error: unknown): unknown {
  if (error instanceof ToolInstallError) {
    const code = NETWORK_KINDS.has(error.kind)
      ? ExitCode.Network
      : FILE_KINDS.has(error.kind)
        ? ExitCode.FileSystem
        : ExitCode.Failure;
    return new CliError(`${error.message}\n${error.hint}`, code);
  }
  if (error instanceof UnsupportedTargetError) {
    return new CliError(error.message, ExitCode.Failure);
  }
  return error;
}

export const missingToolError = (tool: Tool): CliError =>
  new CliError(`${tool} is missing.\nrun: mediaforge setup`, ExitCode.MissingTool);

export type AcquireOutcome =
  | { tool: Tool; status: "present"; path: string; source: string; version?: string }
  | { tool: Tool; status: "installed"; path: string; version: string };

export interface AcquireOptions {
  onProgress: (progress: InstallProgress) => void;
}

/** Make one tool available: use what is there, else download. */
export async function acquireTool(
  tool: Tool,
  rt: ToolRuntime,
  options: AcquireOptions,
): Promise<AcquireOutcome> {
  const existing = await tryResolve(tool, rt.resolve);
  if (existing) {
    return {
      tool,
      status: "present",
      path: existing.path,
      source: existing.source,
      ...(existing.version !== undefined && { version: existing.version }),
    };
  }

  try {
    const result = await rt.install(tool, options.onProgress);
    return { tool, status: "installed", path: result.path, version: result.version };
  } catch (error) {
    throw toCliError(error);
  }
}

/**
 * Before work that needs tools: in a terminal, offer to download what is missing; otherwise stop
 * with exit 3 and `run: mediaforge setup`. Nothing downloads without a yes.
 * Optional tools (deno) are offered the same way, but a no, a failure or a missing terminal just
 * skips them: downloads from sites that do not need them still work.
 */
export async function ensureTools(
  tools: Tool[],
  rt: ToolRuntime,
  onProgress: (progress: InstallProgress) => void,
): Promise<void> {
  for (const tool of tools) {
    if (await tryResolve(tool, rt.resolve)) continue;
    const required = isRequired(tool);
    if (!rt.interactive) {
      if (required) throw missingToolError(tool);
      continue;
    }
    const question = required
      ? `${tool} is missing. Download it now? (Y/N)`
      : `${tool} is missing. YouTube needs it. Download it now? (Y/N)`;
    if (!(await rt.ask(question))) {
      if (required) throw missingToolError(tool);
      continue;
    }
    try {
      await acquireTool(tool, rt, { onProgress });
    } catch (error) {
      if (required) throw error;
    }
  }
}

/** Ask a yes or no question. Unclear answers are asked again (three tries); closed input is no. */
export async function askYesNo(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<boolean> {
  const rl = createInterface({ input, output });
  const closed = new Promise<undefined>((resolve) => rl.once("close", () => resolve(undefined)));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const asked = rl.question(`${question} `).catch(() => undefined);
      const answer = await Promise.race([asked, closed]);
      if (answer === undefined) return false;
      const text = answer.trim().toLowerCase();
      if (text === "y" || text === "yes") return true;
      if (text === "n" || text === "no") return false;
    }
    return false;
  } finally {
    rl.close();
  }
}

export const PHASE_LABELS = {
  resolving: "looking up the latest version",
  downloading: "downloading",
  verifying: "verifying checksum",
  extracting: "unpacking",
  installing: "installing",
} as const;

/** An ASCII progress bar such as `[########----------------]`. */
export function asciiBar(percent: number, width = 24): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

const paint = (on: boolean, code: string, text: string) =>
  on ? `\x1b[${code}m${text}\x1b[0m` : text;

/**
 * Prints install progress. Without a terminal it prints one plain line per phase, with no control
 * characters, so logs stay readable. With `inline` (a terminal) the lines are indented, the download
 * shows a bar that updates in place, and `color` (on unless NO_COLOR is set) adds colour.
 */
export function createInstallPrinter(
  write: (text: string) => void,
  inline: boolean,
  color = inline && !process.env.NO_COLOR,
) {
  let counterOpen = false;
  return (progress: InstallProgress): void => {
    const name = paint(color, "1;36", progress.tool.padEnd(6));
    if (progress.phase === "downloading" && progress.received) {
      if (!inline) return;
      const { received, total } = progress;
      const percent = total ? Math.min(100, (received / total) * 100) : undefined;
      const bar =
        percent === undefined
          ? ""
          : `${paint(color, "36", asciiBar(percent))} ${String(Math.floor(percent)).padStart(3)}%  `;
      const amount = `${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : ""}`;
      write(`\r  ${name}  ${bar}${amount}${color ? "\x1b[K" : "   "}`);
      counterOpen = true;
      return;
    }
    if (counterOpen) {
      write("\n");
      counterOpen = false;
    }
    if (!inline) {
      write(`${progress.tool}: ${PHASE_LABELS[progress.phase]}\n`);
      return;
    }
    write(`  ${name}  ${paint(color, "2", PHASE_LABELS[progress.phase])}\n`);
  };
}

export function defaultToolRuntime(
  env: Record<string, string | undefined> = process.env,
): ToolRuntime {
  const dir = cacheDir(env);
  const repo = env[YTDLP_REPO_ENV];
  const deps = { ...defaultInstallDeps(), ...(repo && { ytDlpRepoUrl: repo }) };
  return {
    resolve: resolveTool,
    install: async (tool, onProgress) => {
      try {
        return await installTool({ tool, target: resolveTarget(), dir, onProgress }, deps);
      } finally {
        forgetResolvedTools();
      }
    },
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    ask: (question) => askYesNo(question),
  };
}

/** `ensureTools` wired to the real machine, printing progress on stderr. */
export function defaultEnsureTools(): (tools: Tool[]) => Promise<void> {
  return (tools) => {
    const rt = defaultToolRuntime();
    return ensureTools(
      tools,
      rt,
      createInstallPrinter((text) => process.stderr.write(text), rt.interactive),
    );
  };
}
