import { access, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type FolderFs, pathFor } from "./folder-browser.ts";

/** The real file system. Symbolic links to folders count as folders. */
export function realFolderFs(platform: NodeJS.Platform = process.platform): FolderFs {
  return {
    platform,
    async listDirs(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      const names: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) names.push(entry.name);
        else if (entry.isSymbolicLink()) {
          try {
            if ((await stat(join(dir, entry.name))).isDirectory()) names.push(entry.name);
          } catch {
            // A broken link is not a folder.
          }
        }
      }
      return names;
    },
    async exists(dir) {
      try {
        return (await stat(dir)).isDirectory();
      } catch {
        return false;
      }
    },
    async mkdir(dir) {
      await mkdir(dir);
    },
    async drives() {
      if (platform !== "win32") return [];
      const found: string[] = [];
      for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        const root = `${letter}:\\`;
        try {
          await access(root);
          found.push(root);
        } catch {
          // No such drive.
        }
      }
      return found;
    },
  };
}

export interface MemoryFolderOptions {
  platform?: NodeJS.Platform;
  drives?: string[];
  /** Folders whose listing fails with a permission error. */
  unreadable?: string[];
}

/** In-memory folders for tests: a map from each folder to the names of its subfolders. */
export function memoryFolderFs(
  tree: Record<string, string[]>,
  options: MemoryFolderOptions = {},
): FolderFs {
  const platform = options.platform ?? "linux";
  const path = pathFor(platform);
  const dirs = new Map<string, string[]>(
    Object.entries(tree).map(([dir, names]) => [dir, [...names]]),
  );
  const fail = (code: string) => Object.assign(new Error(code), { code });
  return {
    platform,
    exists: async (dir) => dirs.has(dir),
    listDirs: async (dir) => {
      if (options.unreadable?.includes(dir)) throw fail("EACCES");
      const names = dirs.get(dir);
      if (!names) throw fail("ENOENT");
      return [...names];
    },
    mkdir: async (dir) => {
      if (dirs.has(dir)) throw fail("EEXIST");
      dirs.set(dir, []);
      dirs.get(path.dirname(dir))?.push(path.basename(dir));
    },
    drives: async () => options.drives ?? [],
  };
}
