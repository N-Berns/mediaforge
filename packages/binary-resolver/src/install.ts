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
import { denoSource, ffmpegSource, type ToolsLock } from "./lock.ts";
import { repairManifest, writeManifest } from "./manifest.ts";
import { resolveYtDlpSource } from "./sources.ts";
import { binaryFileName, type Target } from "./target.ts";
import type { Tool } from "./version.ts";

export interface InstallDeps {
  fetch: FetchLike;
  fs: InstallFs;
  /** Unpack `archive` into the folder `dest`. The real one runs `tar`. */
  extract: (archive: string, dest: string, kind: ArchiveKind) => Promise<void>;
  now?: () => Date;
  lock?: ToolsLock;
  /** Where the newest yt-dlp nightly is looked up. Tests point this at a local server. */
  ytDlpRepoUrl?: string;
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
  const source =
    tool === "yt-dlp"
      ? await resolveYtDlpSource(target, deps.fetch, deps.ytDlpRepoUrl)
      : tool === "deno"
        ? denoSource(target, deps.lock)
        : ffmpegSource(target, deps.lock);

  const download = join(dir, `.${tool}.download`);
  const unpacked = join(dir, `.${tool}.unpacked`);
  const staged = join(dir, `.${tool}.staged`);
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
    await io(() => fs.chmod(staged, EXECUTABLE), staged);
    await io(() => fs.rename(staged, finalPath), finalPath);

    manifest[tool] = {
      version: source.version,
      url: source.url,
      sha256,
      installedAt: (deps.now ?? (() => new Date()))().toISOString(),
    };
    await io(() => writeManifest(fs, dir, manifest), dir);
    return { tool, version: source.version, path: finalPath, sha256, url: source.url };
  } finally {
    await Promise.all([download, unpacked, staged].map((path) => fs.rm(path).catch(() => {})));
  }
}
