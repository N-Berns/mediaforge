import { dirname, join, resolve } from "node:path";
import {
  BinaryNotFoundError,
  cacheDir,
  ENV_OVERRIDES,
  type ResolvedBinary,
  resolveBinary,
  type Tool,
} from "@mediaforge/binary-resolver";
import { CliError, ExitCode } from "./exit-codes.ts";

export const BIN_DIR_ENV = "MEDIAFORGE_BIN_DIR";

export interface BinDirInput {
  env: Record<string, string | undefined>;
  /** Path of the running executable (`process.execPath`). */
  execPath: string;
  /** Directory of this source file, used when running through Node in development. */
  moduleDir: string;
}

/**
 * Directory holding the bundled yt-dlp/ffmpeg: `MEDIAFORGE_BIN_DIR`, else
 * `bin/` next to a packaged executable, else the repo-root `bin/` when running
 * through Node during development.
 */
export function bundledBinDir({ env, execPath, moduleDir }: BinDirInput): string {
  const override = env[BIN_DIR_ENV];
  if (override) return override;
  // Split on both separators so a Windows path is read the same way on every host.
  const fileName = (execPath.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  const runningThroughNode = fileName === "node";
  return runningThroughNode
    ? join(moduleDir, "..", "..", "..", "bin")
    : join(dirname(execPath), "bin");
}

export const defaultBinDir = () =>
  bundledBinDir({ env: process.env, execPath: process.execPath, moduleDir: import.meta.dirname });

export type ResolveTool = (tool: Tool) => Promise<ResolvedBinary>;

/**
 * The bundled folder to search, or undefined when it is the managed cache folder. On Windows the
 * installed program sits in the folder whose `bin` is the cache, so the bundled step would claim
 * every downloaded tool. Leaving it out lets the cache step report them as `cache`.
 */
export function distinctBundledDir(
  bundledDir: string,
  cacheFolder: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const normalize = (dir: string) => {
    const full = resolve(dir);
    return platform === "win32" ? full.toLowerCase() : full;
  };
  return normalize(bundledDir) === normalize(cacheFolder) ? undefined : bundledDir;
}

/** Resolve a tool using the standard order: env override, PATH, bundled, managed cache. */
export const resolveTool: ResolveTool = (tool) => {
  const cache = cacheDir(process.env);
  return resolveBinary(tool, {
    bundledDir: distinctBundledDir(defaultBinDir(), cache),
    cacheDir: cache,
  });
};

/** How to fix a missing tool, for error messages. */
export function missingToolHint(tool: Tool, binDir: string): string {
  return [
    `Run: mediaforge setup (downloads ${tool}),`,
    `install ${tool} and add it to PATH,`,
    `set ${ENV_OVERRIDES[tool]} to its full path,`,
    `or place it in ${binDir}.`,
  ].join(" ");
}

/** Resolve a tool or fail with a friendly `MissingTool` error. */
export async function requireTool(tool: Tool, resolve: ResolveTool = resolveTool) {
  try {
    return await resolve(tool);
  } catch (error) {
    if (error instanceof BinaryNotFoundError) {
      throw new CliError(
        `${error.message}\n${missingToolHint(tool, defaultBinDir())}`,
        ExitCode.MissingTool,
      );
    }
    throw error;
  }
}
