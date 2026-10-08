import { basename, dirname, join } from "node:path";
import {
  BinaryNotFoundError,
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
  const runningThroughNode =
    basename(execPath)
      .toLowerCase()
      .replace(/\.exe$/, "") === "node";
  return runningThroughNode
    ? join(moduleDir, "..", "..", "..", "bin")
    : join(dirname(execPath), "bin");
}

export const defaultBinDir = () =>
  bundledBinDir({ env: process.env, execPath: process.execPath, moduleDir: import.meta.dirname });

export type ResolveTool = (tool: Tool) => Promise<ResolvedBinary>;

/** Resolve a tool using the standard order: env override, PATH, bundled. */
export const resolveTool: ResolveTool = (tool) =>
  resolveBinary(tool, { bundledDir: defaultBinDir() });

/** How to fix a missing tool, for error messages. */
export function missingToolHint(tool: Tool, binDir: string): string {
  return [
    `Install ${tool} and add it to PATH,`,
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
