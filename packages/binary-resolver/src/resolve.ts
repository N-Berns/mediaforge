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
  /** The managed tool folder (see `cacheDir`). Searched last, or right after the env override with `preferCache`. */
  cacheDir?: string;
  /**
   * Search the cache folder before PATH and the bundled folder, so a downloaded copy wins over
   * older ones. A cache copy that is missing or does not run falls through to the usual order.
   */
  preferCache?: boolean;
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
  deno: "MEDIAFORGE_DENO_PATH",
};

const VERSION_ARGS: Record<Tool, string[]> = {
  "yt-dlp": ["--version"],
  ffmpeg: ["-version"],
  deno: ["--version"],
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
 * ffmpeg), bundled copy, managed cache. With `preferCache` the cache comes right
 * after the env override: env, cache, PATH, bundled. An env override that does not work is an error, not a
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

  const fromPath = async () => {
    let triedAny = false;
    for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
      for (const name of names) {
        const path = join(dir, name);
        if (!(await isExecutable(path))) continue;
        const output = await works(path);
        triedAny = true;
        if (output === undefined) {
          tried.push(`${path} (not runnable)`);
        } else if (tool === "ffmpeg" && !isFfmpegVersionOk(output)) {
          tried.push(`${path} (older than supported ffmpeg)`);
        } else {
          return found(path, "path", output);
        }
      }
    }
    if (!triedAny) tried.push("PATH");
    return undefined;
  };

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

  const steps = [
    fromPath,
    () => fromDir(options.bundledDir, "bundled"),
    () => fromDir(options.cacheDir, "cache"),
  ];
  // The downloaded copy goes first when asked: the user updated it on purpose.
  if (options.preferCache) steps.unshift(steps.pop() as (typeof steps)[number]);
  for (const step of steps) {
    const hit = await step();
    if (hit) return hit;
  }

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
