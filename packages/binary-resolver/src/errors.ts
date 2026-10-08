export type InstallErrorKind =
  | "offline"
  | "not-found"
  | "rate-limit"
  | "http"
  | "checksum"
  | "disk-full"
  | "permission"
  | "io"
  | "extract"
  | "unsupported"
  | "no-source";

export const ISSUES_URL = "https://github.com/N-Berns/mediaforge/issues";

/** A failed tool download or install. `hint` says what the user can do about it. */
export class ToolInstallError extends Error {
  readonly kind: InstallErrorKind;
  readonly hint: string;

  constructor(kind: InstallErrorKind, message: string, hint: string) {
    super(message);
    this.name = "ToolInstallError";
    this.kind = kind;
    this.hint = hint;
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const offlineError = (url: string): ToolInstallError =>
  new ToolInstallError(
    "offline",
    `Could not reach ${hostOf(url)}.`,
    "Check your internet connection, then try again.",
  );

export function httpError(url: string, status: number): ToolInstallError {
  if (status === 404) {
    return new ToolInstallError(
      "not-found",
      `Not found: ${url} (HTTP 404).`,
      "The file moved or was removed upstream. Update MediaForge, or install the tool yourself and add it to PATH.",
    );
  }
  if (status === 403 || status === 429) {
    return new ToolInstallError(
      "rate-limit",
      `${hostOf(url)} refused the request (HTTP ${status}).`,
      "GitHub may be rate limiting this network. Wait a few minutes, then try again.",
    );
  }
  return new ToolInstallError(
    "http",
    `Download failed: HTTP ${status} from ${url}.`,
    "Try again later.",
  );
}

export const checksumError = (name: string, expected: string, actual: string): ToolInstallError =>
  new ToolInstallError(
    "checksum",
    `Checksum mismatch for ${name}: expected ${expected}, got ${actual}. The download was discarded.`,
    `Try again. If it keeps happening, do not install this file; report it at ${ISSUES_URL}.`,
  );

const FS_ERROR_CODES = new Set([
  "ENOSPC",
  "EDQUOT",
  "EACCES",
  "EPERM",
  "EROFS",
  "EBUSY",
  "EMFILE",
  "ENOENT",
  "EEXIST",
  "EISDIR",
  "ENOTDIR",
  "EIO",
]);

/** True for errors raised by the file system (as opposed to the network). */
export function isFsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && FS_ERROR_CODES.has(code);
}

/** Turn a file system error into an install error that names the path. */
export function fsError(error: unknown, path: string): ToolInstallError {
  if (error instanceof ToolInstallError) return error;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") {
    return new ToolInstallError(
      "disk-full",
      `No space left to write ${path}.`,
      "Free up disk space, then try again.",
    );
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "EBUSY") {
    return new ToolInstallError(
      "permission",
      `Not allowed to write ${path}.`,
      "Close any running MediaForge or yt-dlp windows and check the folder's permissions, or set MEDIAFORGE_CACHE_DIR to a folder you can write to.",
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ToolInstallError(
    "io",
    `Could not write ${path}: ${detail}`,
    "Check the folder, then try again.",
  );
}
