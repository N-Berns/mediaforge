import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import type { InstallDeps } from "./install.ts";
import type { FetchLike, InstallFs } from "./install-types.ts";

export const realInstallFs: InstallFs = {
  mkdir: async (path) => void (await mkdir(path, { recursive: true })),
  openWrite: async (path) => {
    const handle = await open(path, "w");
    return {
      write: async (chunk) => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          offset += bytesWritten;
        }
      },
      close: () => handle.close(),
    };
  },
  rename,
  rm: (path) => rm(path, { recursive: true, force: true }),
  chmod,
  readText: (path) => readFile(path, "utf8"),
  writeText: (path, data) => writeFile(path, data, "utf8"),
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  listFiles: async (dir) => {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
  },
  sha256File: (path) =>
    new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      createReadStream(path)
        .on("data", (chunk) => hash.update(chunk))
        .on("error", reject)
        .on("end", () => resolve(hash.digest("hex")));
    }),
};

export const nodeFetch: FetchLike = (url, init) => fetch(url, init);

/** On Windows use the system bsdtar: it reads zip. Git for Windows' GNU tar does not. */
const tarCommand = (): string =>
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

/** GNU tar on Linux cannot read zip, so use `unzip` there. Windows and macOS bsdtar read zip. */
const extractCommand = (kind: string, archive: string, dest: string): [string, string[]] =>
  kind === "zip" && process.platform === "linux"
    ? ["unzip", ["-q", "-o", archive, "-d", dest]]
    : [tarCommand(), ["-xf", archive, "-C", dest]];

export const tarExtract: InstallDeps["extract"] = (archive, dest, kind) =>
  new Promise((resolve, reject) => {
    const [command, args] = extractCommand(kind, archive, dest);
    execFile(command, args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve();
    });
  });

export const defaultInstallDeps = (): Pick<InstallDeps, "fetch" | "fs" | "extract"> => ({
  fetch: nodeFetch,
  fs: realInstallFs,
  extract: tarExtract,
});
