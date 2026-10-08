import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { execFileText } from "./exec.ts";
import { extractVersion, isFfmpegVersionOk, type Tool } from "./version.ts";

export type BinarySource = "env" | "path" | "bundled" | "cache";

export interface ResolvedBinary {
  tool: Tool;
  path: string;
  source: BinarySource;
  version?: string;
}

export interface ResolveOptions {
  /** Directory holding the bundled binaries (the release package's `bin/`). */
  bundledDir?: string;
  /** The managed tool folder (see `cacheDir`). Searched last. */
  cacheDir?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Run `<path> <args>` and return stdout. Throws if the binary cannot run. */
  run?: (path: string, args: string[]) => Promise<string>;
  /** True when the file exists and is executable. */
  isExecutable?: (path: string) => Promise<boolean>;
}

export const ENV_OVERRIDES: Record<Tool, string> = {
  "yt-dlp": "MEDIAFORGE_YTDLP_PATH",
  ffmpeg: "MEDIAFORGE_FFMPEG_PATH",
};

const VERSION_ARGS: Record<Tool, string[]> = {
  "yt-dlp": ["--version"],
  ffmpeg: ["-version"],
};

export class BinaryNotFoundError extends Error {
  readonly tool: Tool;
  readonly tried: string[];

  constructor(tool: Tool, tried: string[]) {
    super(`${tool} not found. Tried: ${tried.join("; ")}`);
    this.name = "BinaryNotFoundError";
    this.tool = tool;
    this.tried = tried;
  }
}

const defaultRun = (path: string, args: string[]) => execFileText(path, args);

const defaultIsExecutable = async (path: string) => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

function fileNames(name: string, env: ResolveOptions["env"], platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [name];
  const exts = (env?.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
  return exts.map((ext) => `${name}${ext.toLowerCase()}`);
}

/**
 * Resolve a tool in priority order: env override, PATH (version-checked for
 * ffmpeg), bundled copy. An env override that does not work is an error, not a
 * reason to fall through: the user asked for that exact binary.
 */
export async function resolveBinary(
  tool: Tool,
  options: ResolveOptions = {},
): Promise<ResolvedBinary> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const tried: string[] = [];

  const works = async (path: string) => {
    try {
      return await run(path, VERSION_ARGS[tool]);
    } catch {
      return undefined;
    }
  };

  const found = (path: string, source: BinarySource, output: string): ResolvedBinary => ({
    tool,
    path,
    source,
    version: extractVersion(tool, output),
  });

  const override = env[ENV_OVERRIDES[tool]];
  if (override) {
    const output = await works(override);
    if (output !== undefined) return found(override, "env", output);
    throw new BinaryNotFoundError(tool, [`${ENV_OVERRIDES[tool]}=${override} (not runnable)`]);
  }

  const names = fileNames(tool, env, platform);
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const path = join(dir, name);
      if (!(await isExecutable(path))) continue;
      const output = await works(path);
      if (output === undefined) {
        tried.push(`${path} (not runnable)`);
      } else if (tool === "ffmpeg" && !isFfmpegVersionOk(output)) {
        tried.push(`${path} (older than supported ffmpeg)`);
      } else {
        return found(path, "path", output);
      }
    }
  }
  if (!tried.length) tried.push("PATH");

  const fromDir = async (dir: string | undefined, source: BinarySource) => {
    if (!dir) return undefined;
    for (const name of names) {
      const path = join(dir, name);
      if (!(await isExecutable(path))) continue;
      const output = await works(path);
      if (output !== undefined) return found(path, source, output);
    }
    tried.push(`${source} in ${dir}`);
    return undefined;
  };

  const bundled = await fromDir(options.bundledDir, "bundled");
  if (bundled) return bundled;
  const cached = await fromDir(options.cacheDir, "cache");
  if (cached) return cached;

  throw new BinaryNotFoundError(tool, tried);
}

export interface FindOnPathOptions {
  env?: ResolveOptions["env"];
  platform?: NodeJS.Platform;
  isExecutable?: (path: string) => Promise<boolean>;
}

/** The first executable called `name` on PATH, or undefined. Does not run it. */
export async function findOnPath(
  name: string,
  options: FindOnPathOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const file of fileNames(name, env, platform)) {
      const path = join(dir, file);
      if (await isExecutable(path)) return path;
    }
  }
  return undefined;
}
