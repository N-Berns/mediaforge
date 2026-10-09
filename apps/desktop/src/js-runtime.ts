import {
  execFileText,
  type FindOnPathOptions,
  findOnPath,
  type ResolvedBinary,
  type Tool,
} from "@mediaforge/binary-resolver";
import { resolveTool } from "./binaries.ts";

export type JsRuntimeName = "deno" | "node" | "quickjs" | "bun";

export interface JsRuntime {
  name: JsRuntimeName;
  path: string;
  version?: string;
}

interface Candidate {
  name: JsRuntimeName;
  exe: string;
  /** Arguments that print the version. Omitted when finding the file is enough. */
  versionArgs?: string[];
  accepts?: (output: string) => boolean;
}

const nodeMajor = (output: string): number => Number(/^v?(\d+)/.exec(output.trim())?.[1] ?? 0);

/** In yt-dlp's own priority order. Node must be 20 or newer. */
const CANDIDATES: Candidate[] = [
  { name: "deno", exe: "deno", versionArgs: ["--version"] },
  { name: "node", exe: "node", versionArgs: ["--version"], accepts: (v) => nodeMajor(v) >= 20 },
  { name: "quickjs", exe: "qjs" },
  { name: "bun", exe: "bun", versionArgs: ["--version"] },
];

const defaultRun = (path: string, args: string[]) => execFileText(path, args);

export interface DetectOptions extends FindOnPathOptions {
  /** Run `<path> <args>` and return stdout. Throws if it cannot run. */
  run?: (path: string, args: string[]) => Promise<string>;
  /** Looks up MediaForge's own Deno (env override, PATH, bundled, downloaded copy). */
  resolve?: (tool: Tool) => Promise<ResolvedBinary>;
}

/**
 * The JavaScript runtime yt-dlp should use, or undefined. A Deno that MediaForge can resolve
 * (including the downloaded copy, which is not on PATH) comes first, then whatever is on PATH.
 */
export async function detectJsRuntime(options: DetectOptions = {}): Promise<JsRuntime | undefined> {
  const managed = options.resolve
    ? await options.resolve("deno").catch(() => undefined)
    : undefined;
  if (managed) {
    return {
      name: "deno",
      path: managed.path,
      ...(managed.version && { version: `deno ${managed.version}` }),
    };
  }
  const run = options.run ?? defaultRun;
  for (const candidate of CANDIDATES) {
    const path = await findOnPath(candidate.exe, options);
    if (!path) continue;
    if (!candidate.versionArgs) return { name: candidate.name, path };
    let output: string;
    try {
      output = await run(path, candidate.versionArgs);
    } catch {
      continue;
    }
    if (candidate.accepts && !candidate.accepts(output)) continue;
    const version = output.trim().split(/\r?\n/)[0]?.trim();
    return { name: candidate.name, path, ...(version && { version }) };
  }
  return undefined;
}

/** Name the runtime and its path, so a Deno that is not on PATH (the downloaded one) is used. */
export function jsRuntimeArgs(runtime: JsRuntime | undefined): string[] {
  if (!runtime) return [];
  return ["--js-runtimes", `${runtime.name}:${runtime.path}`];
}

let cached: Promise<string[]> | undefined;

/** The flags for this machine, detected once per process once a runtime is found. */
export const detectJsRuntimeArgs = (): Promise<string[]> => {
  if (cached) return cached;
  const lookup = detectJsRuntime({ resolve: resolveTool }).then(jsRuntimeArgs);
  cached = lookup;
  // Nothing found yet: look again next time, in case setup has installed Deno since.
  void lookup.then((args) => {
    if (args.length === 0 && cached === lookup) cached = undefined;
  });
  return lookup;
};
