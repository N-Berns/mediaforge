import type { Tool } from "./version.ts";

/** How a download is packed. `none` is a bare executable. */
export type ArchiveKind = "none" | "zip" | "tar.xz" | "tar";

export interface WritableFile {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** The file system operations an install needs. Tests use an in-memory copy. */
export interface InstallFs {
  mkdir(path: string): Promise<void>;
  openWrite(path: string): Promise<WritableFile>;
  rename(from: string, to: string): Promise<void>;
  /** Remove a file or folder tree. A missing path is not an error. */
  rm(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Every file under `dir`, as paths relative to it, always with `/` separators. */
  listFiles(dir: string): Promise<string[]>;
  sha256File(path: string): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: { redirect?: "follow" | "manual"; signal?: AbortSignal },
) => Promise<Response>;

export type InstallPhase = "resolving" | "downloading" | "verifying" | "extracting" | "installing";

export interface InstallProgress {
  tool: Tool;
  phase: InstallPhase;
  /** Bytes received so far (downloading only). */
  received?: number;
  /** Total bytes, when the server said. */
  total?: number;
}

export interface InstallResult {
  tool: Tool;
  version: string;
  path: string;
  sha256: string;
  url: string;
}
