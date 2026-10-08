import { execFileText, type FindOnPathOptions, findOnPath } from "@mediaforge/binary-resolver";

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
}

/** The first JavaScript runtime on PATH that yt-dlp can use, or undefined. */
export async function detectJsRuntime(options: DetectOptions = {}): Promise<JsRuntime | undefined> {
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

/** yt-dlp enables Deno by itself; every other runtime has to be switched on by name and path. */
export function jsRuntimeArgs(runtime: JsRuntime | undefined): string[] {
  if (!runtime || runtime.name === "deno") return [];
  return ["--js-runtimes", `${runtime.name}:${runtime.path}`];
}

let cached: Promise<string[]> | undefined;

/** The flags for this machine, detected once per process. */
export const detectJsRuntimeArgs = (): Promise<string[]> => {
  cached ??= detectJsRuntime().then(jsRuntimeArgs);
  return cached;
};
