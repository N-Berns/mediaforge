import { dirname, join } from "node:path";
import {
  checksumError,
  downloadFile,
  type FetchLike,
  fsError,
  httpError,
  type InstallFs,
  nodeFetch,
  parseSha256Sums,
  realInstallFs,
  request,
  resolveTarget,
  type Target,
  ToolInstallError,
  targetKey,
} from "@mediaforge/binary-resolver";
import type { Io } from "./commands.ts";
import { ExitCode } from "./exit-codes.ts";
import { parseCommandArgs } from "./parse.ts";
import { formatBytes } from "./progress-view.ts";
import { toCliError } from "./tool-runtime.ts";
import { VERSION } from "./version.ts";

export const DEFAULT_RELEASE_REPO = "https://github.com/N-Berns/mediaforge";

/** Points the update check at another release server. Used by tests and the release smoke test. */
export const RELEASE_REPO_ENV = "MEDIAFORGE_RELEASE_REPO_URL";

/** The release file for each target. Keep in sync with `tools/release/targets.mjs`. */
export const RELEASE_ASSETS: Record<string, string> = {
  "win32-x64": "mediaforge-win-x64.exe",
  "linux-x64": "mediaforge-linux-x64",
  "linux-arm64": "mediaforge-linux-arm64",
};

export interface UpdateInfo {
  current: string;
  latest: string;
  tag: string;
  /** True when `latest` is newer than `current`. */
  newer: boolean;
  /** False when MediaForge runs through Node (development) and has no program file to replace. */
  installable: boolean;
}

export interface UpdateProgress {
  phase: "downloading" | "verifying" | "installing";
  received?: number;
  total?: number;
}

export interface SelfUpdateDeps {
  fetch: FetchLike;
  fs: InstallFs;
  /** Path of the running program (`process.execPath`). */
  execPath: string;
  target: () => Target;
  version: string;
  repoUrl: string;
  platform: NodeJS.Platform;
}

export function defaultSelfUpdateDeps(
  env: Record<string, string | undefined> = process.env,
): SelfUpdateDeps {
  return {
    fetch: nodeFetch,
    fs: realInstallFs,
    execPath: process.execPath,
    target: () => resolveTarget(),
    version: VERSION,
    repoUrl: env[RELEASE_REPO_ENV] || DEFAULT_RELEASE_REPO,
    platform: process.platform,
  };
}

/** Numbers of `1.2.3` and its pre-release part (`rc.1`), if any. Build metadata is ignored. */
function parseVersion(version: string): { core: number[]; pre: string | undefined } {
  const [main = "", pre] = version.replace(/^v/, "").split("+")[0]?.split(/-(.*)/s) ?? [];
  return {
    core: main.split(".").map((part) => Number.parseInt(part, 10) || 0),
    pre: pre || undefined,
  };
}

/** Negative when `a` is older than `b`. A pre-release is older than its release. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre.localeCompare(right.pre, "en", { numeric: true });
}

/** True when the program is a packaged executable, not `node dist/main.js`. */
export function isPackaged(execPath: string): boolean {
  return (execPath.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "") !== "node";
}

/** The tag of the newest stable release, read from the redirect of `<repo>/releases/latest`. */
async function latestTag(deps: SelfUpdateDeps): Promise<string> {
  const url = `${deps.repoUrl}/releases/latest`;
  const response = await request(deps.fetch, url, { redirect: "manual" });
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location) {
    const tag = new URL(location, url).pathname.split("/").filter(Boolean).at(-1);
    if (tag) return decodeURIComponent(tag);
  }
  if (response.status >= 400) throw httpError(url, response.status);
  throw new ToolInstallError(
    "no-source",
    `Could not find the latest MediaForge release at ${url}.`,
    "Try again later.",
  );
}

/** Ask GitHub which release is newest and whether it is newer than this program. */
export async function checkForUpdate(
  deps: SelfUpdateDeps = defaultSelfUpdateDeps(),
): Promise<UpdateInfo> {
  const tag = await latestTag(deps);
  const latest = tag.replace(/^v/, "");
  return {
    current: deps.version,
    latest,
    tag,
    newer: compareVersions(latest, deps.version) > 0,
    installable: isPackaged(deps.execPath),
  };
}

const STAGED = ".mediaforge.update";
const permissionError = (path: string) =>
  new ToolInstallError(
    "permission",
    `Not allowed to replace ${path}.`,
    "Close other MediaForge windows, or move the program to a folder you can write to. The installer puts it in one.",
  );

async function io<T>(operation: () => Promise<T>, path: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    throw code === "EACCES" || code === "EPERM" || code === "EBUSY"
      ? permissionError(path)
      : fsError(error, path);
  }
}

/**
 * Replace the running program with the release's build for this machine. The download is hashed
 * while it arrives and compared with the release's `SHA256SUMS` before anything is replaced.
 * Windows will not overwrite a running program but allows renaming it, so the old one is moved
 * aside to `<name>.old` (removed by `cleanupAfterUpdate` on the next start).
 */
export async function installUpdate(
  info: UpdateInfo,
  deps: SelfUpdateDeps = defaultSelfUpdateDeps(),
  onProgress: (progress: UpdateProgress) => void = () => {},
): Promise<void> {
  if (!info.installable) {
    throw new ToolInstallError(
      "unsupported",
      "MediaForge is running through Node, so there is no program file to replace.",
      "Update the source checkout, or install the released program.",
    );
  }
  const asset = RELEASE_ASSETS[targetKey(deps.target())];
  if (!asset) {
    throw new ToolInstallError(
      "unsupported",
      `No MediaForge build for ${targetKey(deps.target())}.`,
      "Build it from source.",
    );
  }

  const base = `${deps.repoUrl}/releases/download/${info.tag}`;
  const sumsUrl = `${base}/SHA256SUMS`;
  const sums = await request(deps.fetch, sumsUrl);
  if (!sums.ok) throw httpError(sumsUrl, sums.status);
  const expected = parseSha256Sums(await sums.text()).get(asset);
  if (!expected) {
    throw new ToolInstallError(
      "no-source",
      `The checksum file for ${info.tag} has no entry for ${asset}.`,
      "Try again in a few minutes; the release may still be uploading.",
    );
  }

  const staged = join(dirname(deps.execPath), STAGED);
  const old = `${deps.execPath}.old`;
  try {
    onProgress({ phase: "downloading", received: 0 });
    // Created next to the program so the final rename stays on one disk.
    const { sha256 } = await io(
      () =>
        downloadFile({
          url: `${base}/${asset}`,
          dest: staged,
          fetch: deps.fetch,
          fs: deps.fs,
          onProgress: (received, total) =>
            onProgress({ phase: "downloading", received, ...(total !== undefined && { total }) }),
        }),
      staged,
    );
    onProgress({ phase: "verifying" });
    if (sha256 !== expected) throw checksumError(asset, expected, sha256);

    onProgress({ phase: "installing" });
    await io(() => deps.fs.chmod(staged, 0o755), staged);
    if (deps.platform === "win32") {
      await io(() => deps.fs.rm(old), old);
      await io(() => deps.fs.rename(deps.execPath, old), deps.execPath);
      try {
        await io(() => deps.fs.rename(staged, deps.execPath), deps.execPath);
      } catch (error) {
        await deps.fs.rename(old, deps.execPath).catch(() => {});
        throw error;
      }
    } else {
      await io(() => deps.fs.rename(staged, deps.execPath), deps.execPath);
    }
  } finally {
    await deps.fs.rm(staged).catch(() => {});
  }
}

/** Remove what an earlier update left beside the program. Never throws. */
export async function cleanupAfterUpdate(
  deps: Pick<SelfUpdateDeps, "fs" | "execPath"> = defaultSelfUpdateDeps(),
): Promise<void> {
  if (!isPackaged(deps.execPath)) return;
  await Promise.all(
    [`${deps.execPath}.old`, join(dirname(deps.execPath), STAGED)].map((path) =>
      deps.fs.rm(path).catch(() => {}),
    ),
  );
}

const USAGE = "Usage: mediaforge self-update";

export function selfUpdateUsage(): string {
  return [
    USAGE,
    "",
    "Replace this program with the newest MediaForge release, after checking its SHA-256.",
    "yt-dlp is not changed; use `mediaforge update` for that.",
    "",
    "Options:",
    "  -h, --help   Show this help",
    "",
  ].join("\n");
}

export async function runSelfUpdate(
  args: string[],
  io: Io,
  deps: SelfUpdateDeps = defaultSelfUpdateDeps(),
): Promise<ExitCode> {
  const { values, positionals } = parseCommandArgs(
    args,
    { help: { type: "boolean", short: "h" } },
    USAGE,
  );
  if (values.help) {
    io.stdout(selfUpdateUsage());
    return ExitCode.Ok;
  }
  if (positionals.length > 0) {
    io.stderr(`Unexpected argument: ${positionals[0]}\n${USAGE}\n`);
    return ExitCode.Usage;
  }

  try {
    const info = await checkForUpdate(deps);
    if (!info.newer) {
      io.stdout(`MediaForge ${info.current} is up to date.\n`);
      return ExitCode.Ok;
    }
    io.stderr(`Updating MediaForge ${info.current} to ${info.latest}\n`);
    let lastPhase: UpdateProgress["phase"] | undefined;
    await installUpdate(info, deps, (progress) => {
      if (progress.phase === lastPhase) return;
      lastPhase = progress.phase;
      io.stderr(
        `  ${progress.phase}${progress.total ? ` (${formatBytes(progress.total)})` : ""}\n`,
      );
    });
    io.stdout(`MediaForge updated to ${info.latest}. Run mediaforge again to use it.\n`);
    return ExitCode.Ok;
  } catch (error) {
    throw toCliError(error);
  }
}
