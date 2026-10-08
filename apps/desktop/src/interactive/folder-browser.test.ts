import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  childPath,
  completeWith,
  folderError,
  folderNameError,
  folderOf,
  isHiddenFolder,
  parentOf,
  pasteTip,
  splitPath,
  startFolder,
  suggestions,
} from "./folder-browser.ts";
import { memoryFolderFs, realFolderFs } from "./folder-fs.ts";

describe("splitting a typed path", () => {
  it("separates the folder part from the part being typed", () => {
    expect(splitPath("linux", "/a/b/ne")).toEqual({ dir: "/a/b/", prefix: "ne" });
    expect(splitPath("linux", "/a/")).toEqual({ dir: "/a/", prefix: "" });
    expect(splitPath("linux", "/")).toEqual({ dir: "/", prefix: "" });
    expect(splitPath("linux", "ne")).toEqual({ dir: "", prefix: "ne" });
    expect(splitPath("win32", "C:\\Users\\ne")).toEqual({ dir: "C:\\Users\\", prefix: "ne" });
    expect(splitPath("win32", "C:/Users/ne")).toEqual({ dir: "C:/Users/", prefix: "ne" });
    expect(splitPath("win32", "D:")).toEqual({ dir: "", prefix: "D:" });
  });

  it("does not treat a backslash as a separator outside Windows", () => {
    expect(splitPath("linux", "/a\\b")).toEqual({ dir: "/", prefix: "a\\b" });
  });

  it("names the folder a path points at, without the trailing separator", () => {
    expect(folderOf("linux", "/a/b/")).toBe("/a/b");
    expect(folderOf("linux", "/a/b")).toBe("/a/b");
    expect(folderOf("linux", "/")).toBe("/");
    expect(folderOf("win32", "C:\\")).toBe("C:\\");
    expect(folderOf("win32", "C:\\a\\")).toBe("C:\\a");
  });

  it("completes a name into the typed path and moves into it", () => {
    expect(completeWith("linux", "/a/b/ne", "new")).toBe("/a/b/new/");
    expect(completeWith("win32", "C:\\Us", "Users")).toBe("C:\\Users\\");
    // The separator the user typed is kept.
    expect(completeWith("win32", "C:/Us", "Users")).toBe("C:/Users/");
    // A drive root already ends with its separator.
    expect(completeWith("win32", "D", "D:\\")).toBe("D:\\");
  });
});

describe("folder suggestions", () => {
  const fs = memoryFolderFs(
    {
      "/": ["downloads", "music", "secret"],
      "/downloads": ["Existing", "extra", "Other"],
      "/h": [".cache", "src", "$tmp"],
      "/secret": [],
    },
    { unreadable: ["/secret"] },
  );

  it("lists the subfolders of the folder part", async () => {
    expect(await suggestions(fs, "/downloads/")).toEqual({
      ok: true,
      names: ["Existing", "extra", "Other"],
    });
    expect(await suggestions(fs, "/")).toEqual({
      ok: true,
      names: ["downloads", "music", "secret"],
    });
  });

  it("filters by what is typed after it, ignoring case", async () => {
    expect(await suggestions(fs, "/downloads/ex")).toEqual({
      ok: true,
      names: ["Existing", "extra"],
    });
    expect(await suggestions(fs, "/downloads/zz")).toEqual({ ok: true, names: [] });
  });

  it("hides hidden folders unless the typed part starts with . or $", async () => {
    expect(await suggestions(fs, "/h/")).toEqual({ ok: true, names: ["src"] });
    expect(await suggestions(fs, "/h/.")).toEqual({ ok: true, names: [".cache"] });
    expect(await suggestions(fs, "/h/$")).toEqual({ ok: true, names: ["$tmp"] });
  });

  it("explains a folder that is missing or cannot be opened", async () => {
    expect(await suggestions(fs, "/nope/")).toEqual({
      ok: false,
      message: expect.stringContaining("no longer exists"),
    });
    expect(await suggestions(fs, "/secret/")).toEqual({
      ok: false,
      message: expect.stringContaining("Permission denied"),
    });
  });

  it("asks for a full path when there is no folder part outside Windows", async () => {
    expect(await suggestions(fs, "ne")).toEqual({
      ok: false,
      message: expect.stringContaining("Start with /"),
    });
    expect(await suggestions(fs, "")).toEqual({
      ok: false,
      message: expect.stringContaining("Start with /"),
    });
  });

  it("lists matching drives on Windows until there is a separator", async () => {
    const win = memoryFolderFs(
      { "C:\\": ["Users"], "D:\\": ["Games"] },
      { platform: "win32", drives: ["C:\\", "D:\\"] },
    );
    expect(await suggestions(win, "")).toEqual({ ok: true, names: ["C:\\", "D:\\"] });
    expect(await suggestions(win, "d")).toEqual({ ok: true, names: ["D:\\"] });
    expect(await suggestions(win, "D:\\")).toEqual({ ok: true, names: ["Games"] });
  });

  it("lists folders when the box ends in a separator at a drive root", async () => {
    const win = memoryFolderFs({ "C:\\": ["Users", "Windows"] }, { platform: "win32" });
    expect(await suggestions(win, "C:\\")).toEqual({ ok: true, names: ["Users", "Windows"] });
  });
});

describe("paths", () => {
  it("hides dot folders and Windows system folders", () => {
    expect(isHiddenFolder(".git")).toBe(true);
    expect(isHiddenFolder("$RECYCLE.BIN")).toBe(true);
    expect(isHiddenFolder("System Volume Information")).toBe(true);
    expect(isHiddenFolder("Music")).toBe(false);
  });

  it("finds the parent, and none at a root", () => {
    expect(parentOf("linux", "/a/b")).toBe("/a");
    expect(parentOf("linux", "/a")).toBe("/");
    expect(parentOf("linux", "/")).toBeUndefined();
    expect(parentOf("win32", "C:\\Users\\me")).toBe("C:\\Users");
    expect(parentOf("win32", "C:\\")).toBeUndefined();
  });

  it("starts at the nearest folder that exists", async () => {
    const fs = memoryFolderFs({ "/": ["a"], "/a": [] });
    expect(await startFolder(fs, "/a")).toBe("/a");
    expect(await startFolder(fs, "/a/gone/deeper")).toBe("/a");
    expect(await startFolder(memoryFolderFs({}), "/x/y")).toBe("/");
  });

  it("joins a child path for the platform", () => {
    expect(childPath("linux", "/a", " New ")).toBe("/a/New");
    expect(childPath("win32", "C:\\a", "New")).toBe("C:\\a\\New");
  });
});

describe("new folder names", () => {
  it("accepts ordinary names", () => {
    expect(folderNameError("linux", "Music 2")).toBeUndefined();
    expect(folderNameError("win32", "Music 2")).toBeUndefined();
  });

  it("rejects empty, dot, and path-like names", () => {
    for (const name of ["", "   ", ".", "..", "a/b", "a\\b"]) {
      expect(folderNameError("linux", name), JSON.stringify(name)).toEqual(expect.any(String));
    }
  });

  it("rejects what Windows does not allow, but only on Windows", () => {
    for (const name of ["a:b", "a?", "con", "NUL", "com1", "lpt9.txt", "name."]) {
      expect(folderNameError("win32", name), name).toEqual(expect.any(String));
    }
    expect(folderNameError("linux", "a:b")).toBeUndefined();
    expect(folderNameError("linux", "con")).toBeUndefined();
  });
});

describe("tips and validation", () => {
  it("explains how to copy a path on each system", () => {
    expect(pasteTip("win32")).toContain("Copy as path");
    expect(pasteTip("darwin")).toContain("Option");
    expect(pasteTip("linux")).toContain("location bar");
    expect(pasteTip("win32")).toContain("Ctrl+V");
  });

  it("requires a folder path to be typed", () => {
    expect(folderError("")).toBe("Enter a folder path.");
    expect(folderError("/x")).toBeUndefined();
  });
});

describe("memory fs", () => {
  it("creates a folder inside its parent and refuses duplicates", async () => {
    const fs = memoryFolderFs({ "/a": [] });
    await fs.mkdir("/a/new");
    expect(await fs.listDirs("/a")).toEqual(["new"]);
    expect(await fs.exists("/a/new")).toBe(true);
    await expect(fs.mkdir("/a/new")).rejects.toMatchObject({ code: "EEXIST" });
  });
});

describe("real fs", () => {
  it("lists only folders and can create one", async () => {
    const root = await mkdtemp(join(tmpdir(), "mf-folders-"));
    try {
      await mkdir(join(root, "sub"));
      await writeFile(join(root, "file.txt"), "x");
      const fs = realFolderFs();
      expect(await fs.listDirs(root)).toEqual(["sub"]);
      expect(await fs.exists(join(root, "sub"))).toBe(true);
      expect(await fs.exists(join(root, "file.txt"))).toBe(false);
      await fs.mkdir(join(root, "made"));
      expect((await fs.listDirs(root)).sort()).toEqual(["made", "sub"]);
      await expect(fs.listDirs(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.drives()).toEqual(process.platform === "win32" ? expect.any(Array) : []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
