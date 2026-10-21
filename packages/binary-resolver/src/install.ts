import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { downloadFile } from "./download-file.ts";
import { checksumError, fsError, ISSUES_URL, ToolInstallError } from "./errors.ts";
import type {
  ArchiveKind,
  FetchLike,
  InstallFs,
  InstallProgress,
  InstallResult,
} from "./install-types.ts";
import { pinnedSource, type ToolsLock } from "./lock.ts";
import { readManifest, repairManifest, writeManifest } from "./manifest.ts";
import { compareVersions, isSecureUrl, type ToolSource } from "./sources.ts";
import { binaryFileName, type Target } from "./target.ts";
import type { Tool } from "./version.ts";

export interface InstallDeps {
  fetch: FetchLike;
  fs: InstallFs;
  /** Unpack `archive` into the folder `dest`. The real one runs `tar`. */
  extract: (archive: string, dest: string, kind: ArchiveKind) => Promise<void>;
  now?: () => Date;
  /** The pinned builds. Default: the lock compiled into the app. */
  lock?: ToolsLock;
  /** Find the build to install. Default: the pinned build from the lock. */
  resolveSource?: (tool: Tool, target: Target) => Promise<ToolSource>;
}

/** What `checkTool` found out about one tool. */
export interface ToolCheck {
  tool: Tool;
  /** The version in the cache manifest; absent when MediaForge has not installed the tool. */
  installed?: string;
  /** The version the resolver offers; absent when it could not be resolved. */
  latest?: string;
  /** The cached build is byte-identical (same SHA-256) to the resolved one. */
  upToDate: boolean;
  /** Why the check could not finish. */
  error?: string;
}

export interface InstallRequest {
  tool: Tool;
  target: Target;
  /** The cache folder. */
  dir: string;
  onProgress?: (progress: InstallProgress) => void;
  signal?: AbortSignal;
}

const EXECUTABLE = 0o755;

/** A looked-up build must come over https (plain http only to this machine, for tests). */
function requireSecureUrl(source: ToolSource): ToolSource {
  if (!isSecureUrl(source.url)) {
    const url = new URL(source.url);
    throw new ToolInstallError(
      "http",
      `Refusing to download from ${url.protocol}//${url.host}: it is not https.`,
      "Report this at the MediaForge issue tracker.",
    );
  }
  return source;
}

const sourceFor = (
  tool: Tool,
  target: Target,
  deps: Pick<InstallDeps, "lock" | "resolveSource">,
): Promise<ToolSource> =>
  deps.resolveSource
    ? deps.resolveSource(tool, target).then(requireSecureUrl)
    : Promise.resolve().then(() => pinnedSource(tool, target, deps.lock));

/**
 * Compare the cached build with the one the resolver offers. Builds are compared by SHA-256, since
 * two different builds can share a version string. Never throws: a failure lands in `error`.
 */
export async function checkTool(
  tool: Tool,
  target: Target,
  dir: string,
  deps: Pick<InstallDeps, "fs" | "lock" | "resolveSource">,
): Promise<ToolCheck> {
  const entry = (await readManifest(deps.fs, dir))[tool];
  const installed = entry?.version;
  try {
    const source = await sourceFor(tool, target, deps);
    return {
      tool,
      ...(installed !== undefined && { installed }),
      latest: source.version,
      upToDate: entry !== undefined && entry.sha256 === source.sha256,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { tool, ...(installed !== undefined && { installed }), upToDate: false, error: message };
  }
}

/**
 * True when MediaForge installed `tool` into the cache and the build there is not the pinned one,
 * so an update of the app also updates the tool. A tool it never installed is not its to replace.
 */
export async function isOutdated(
  tool: Tool,
  target: Target,
  dir: string,
  deps: Pick<InstallDeps, "fs" | "lock">,
  /** `differs` (default): any other version counts. `older`: only a cached build older than the pin. */
  mode: "differs" | "older" = "differs",
): Promise<boolean> {
  const installed = (await readManifest(deps.fs, dir))[tool];
  if (installed === undefined) return false;
  const pinned = pinnedSource(tool, target, deps.lock).version;
  return mode === "older"
    ? compareVersions(installed.version, pinned) < 0
    : installed.version !== pinned;
}

/** Run a file system step; any failure becomes an install error that names the path. */
async function io<T>(operation: () => Promise<T>, path: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw fsError(error, path);
  }
}

/**
 * Download a tool into the cache. The bytes are hashed while they arrive and compared with the
 * published SHA-256 before anything else happens: nothing is unpacked, marked executable or moved
 * into place unless the hash matches. Temp files are removed whether or not it works.
 */
export async function installTool(
  request: InstallRequest,
  deps: InstallDeps,
): Promise<InstallResult> {
  const { tool, target, dir } = request;
  const { fs } = deps;
  const report = (progress: Omit<InstallProgress, "tool">) =>
    request.onProgress?.({ tool, ...progress });

  report({ phase: "resolving" });
  const source = await sourceFor(tool, target, deps);

  // Unique per call, so two installs of one tool never write, hash or move each other's files.
  const id = randomUUID();
  const download = join(dir, `.${tool}.${id}.download`);
  const unpacked = join(dir, `.${tool}.${id}.unpacked`);
  const staged = join(dir, `.${tool}.${id}.staged`);
  const finalPath = join(dir, binaryFileName(tool, target.os));

  try {
    await io(() => fs.mkdir(dir), dir);

    report({ phase: "downloading", received: 0 });
    const { sha256 } = await downloadFile({
      url: source.url,
      dest: download,
      fetch: deps.fetch,
      fs,
      signal: request.signal,
      onProgress: (received, total) =>
        report({ phase: "downloading", received, ...(total !== undefined && { total }) }),
    });

    report({ phase: "verifying" });
    if (sha256 !== source.sha256) throw checksumError(tool, source.sha256, sha256);

    if (source.archive === "none") {
      await io(() => fs.rename(download, staged), staged);
    } else {
      report({ phase: "extracting" });
      await io(async () => {
        await fs.rm(unpacked);
        await fs.mkdir(unpacked);
      }, unpacked);
      try {
        await deps.extract(download, unpacked, source.archive);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ToolInstallError(
          "extract",
          `Could not unpack the ${tool} download: ${detail}`,
          "Make sure `tar` is installed (on Linux it needs xz support, and `unzip` is needed for zip files), then try again.",
        );
      }
      const wanted = source.member ?? binaryFileName(tool, target.os);
      const files = await io(() => fs.listFiles(unpacked), unpacked);
      const member = files.find((file) => file === wanted || file.endsWith(`/${wanted}`));
      if (!member) {
        throw new ToolInstallError(
          "extract",
          `${wanted} was not found in the ${tool} download.`,
          `The upstream build changed. Please report it at ${ISSUES_URL}.`,
        );
      }
      await io(() => fs.rename(join(unpacked, member), staged), staged);
    }

    report({ phase: "installing" });
    // Bring the manifest in line with the files already in the cache (a corrupt one is rebuilt)
    // before this tool is added to it.
    const manifest = await repairManifest(fs, dir, target.os, deps.now);
    const previous = manifest[tool]?.version;
    await io(() => fs.chmod(staged, EXECUTABLE), staged);
    await io(() => fs.rename(staged, finalPath), finalPath);

    manifest[tool] = {
      version: source.version,
      url: source.url,
      sha256,
      installedAt: (deps.now ?? (() => new Date()))().toISOString(),
    };
    await io(() => writeManifest(fs, dir, manifest), dir);
    return {
      tool,
      version: source.version,
      path: finalPath,
      sha256,
      url: source.url,
      ...(previous !== undefined && { previous }),
    };
  } finally {
    await Promise.all([download, unpacked, staged].map((path) => fs.rm(path).catch(() => {})));
  }
}
