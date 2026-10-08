import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  BinaryNotFoundError,
  cacheDir,
  defaultInstallDeps,
  findOnPath,
  type InstallProgress,
  type InstallResult,
  installTool,
  type ResolvedBinary,
  resolveTarget,
  type Tool,
  ToolInstallError,
  UnsupportedTargetError,
} from "@mediaforge/binary-resolver";
import { type ResolveTool, resolveTool } from "./binaries.ts";
import { CliError, ExitCode } from "./exit-codes.ts";
import { formatBytes } from "./progress-view.ts";

/** Points the yt-dlp lookup at another release server. Used by the release smoke test. */
export const YTDLP_REPO_ENV = "MEDIAFORGE_YTDLP_REPO_URL";

/** Everything the tool commands need from the outside world. Tests replace all of it. */
export interface ToolRuntime {
  resolve: ResolveTool;
  install: (tool: Tool, onProgress: (progress: InstallProgress) => void) => Promise<InstallResult>;
  platform: NodeJS.Platform;
  /** True when a person can answer: stdin and stderr are terminals. */
  interactive: boolean;
  ask: (question: string) => Promise<boolean>;
  brew: { available: () => Promise<boolean>; install: () => Promise<void> };
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
  | { tool: Tool; status: "installed"; path: string; version: string }
  | { tool: Tool; status: "homebrew"; path: string; version?: string };

export interface AcquireOptions {
  /** `--yes`: never ask, never run Homebrew. */
  yes: boolean;
  onProgress: (progress: InstallProgress) => void;
}

/** Make one tool available: use what is there, else (macOS ffmpeg) offer Homebrew, else download. */
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

  const offerHomebrew =
    tool === "ffmpeg" &&
    rt.platform === "darwin" &&
    !options.yes &&
    rt.interactive &&
    (await rt.brew.available());
  if (offerHomebrew) {
    const useBrew = await rt.ask(
      "ffmpeg is missing. Install it with Homebrew (brew install ffmpeg)? (Y = Homebrew, N = download a pinned build)",
    );
    if (useBrew) {
      await rt.brew.install();
      const found = await tryResolve("ffmpeg", rt.resolve);
      if (!found) {
        throw new CliError(
          "Homebrew finished, but ffmpeg is still not on PATH.\nOpen a new terminal, or run: mediaforge setup",
          ExitCode.MissingTool,
        );
      }
      return {
        tool,
        status: "homebrew",
        path: found.path,
        ...(found.version !== undefined && { version: found.version }),
      };
    }
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
 */
export async function ensureTools(
  tools: Tool[],
  rt: ToolRuntime,
  onProgress: (progress: InstallProgress) => void,
): Promise<void> {
  for (const tool of tools) {
    if (await tryResolve(tool, rt.resolve)) continue;
    if (!rt.interactive) throw missingToolError(tool);
    if (!(await rt.ask(`${tool} is missing. Download it now? (Y/N)`))) {
      throw missingToolError(tool);
    }
    await acquireTool(tool, rt, { yes: false, onProgress });
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

/**
 * Prints install progress: one line per phase, plus (with `inline`) a download counter that
 * updates in place. Without a terminal there are no control characters, so logs stay readable.
 */
export function createInstallPrinter(write: (text: string) => void, inline: boolean) {
  let counterOpen = false;
  return (progress: InstallProgress): void => {
    if (progress.phase === "downloading" && progress.received) {
      if (!inline) return;
      const total = progress.total ? ` of ${formatBytes(progress.total)}` : "";
      write(`\r${progress.tool}: downloading ${formatBytes(progress.received)}${total}   `);
      counterOpen = true;
      return;
    }
    if (counterOpen) {
      write("\n");
      counterOpen = false;
    }
    write(`${progress.tool}: ${PHASE_LABELS[progress.phase]}\n`);
  };
}

const brewAvailable = async () => (await findOnPath("brew")) !== undefined;

const brewInstallFfmpeg = () =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("brew", ["install", "ffmpeg"], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new CliError(`brew install ffmpeg failed (exit code ${code}).`, ExitCode.Failure)),
    );
  });

export function defaultToolRuntime(
  env: Record<string, string | undefined> = process.env,
): ToolRuntime {
  const dir = cacheDir(env);
  const repo = env[YTDLP_REPO_ENV];
  const deps = { ...defaultInstallDeps(), ...(repo && { ytDlpRepoUrl: repo }) };
  return {
    resolve: resolveTool,
    install: (tool, onProgress) =>
      installTool({ tool, target: resolveTarget(), dir, onProgress }, deps),
    platform: process.platform,
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    ask: (question) => askYesNo(question),
    brew: { available: brewAvailable, install: brewInstallFfmpeg },
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
