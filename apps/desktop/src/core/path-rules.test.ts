import { describe, expect, it } from "vitest";
import { filenameError, folderSettingError, outputDirError } from "./path-rules.ts";

describe("outputDirError", () => {
  it("accepts the base folder itself and folders inside it", () => {
    expect(outputDirError("win32", "C:\\Saved", "C:\\Saved")).toBeUndefined();
    expect(outputDirError("win32", "C:\\Saved\\Music", "C:\\Saved")).toBeUndefined();
    expect(outputDirError("linux", "/home/u/Saved/Music/", "/home/u/Saved")).toBeUndefined();
  });

  it("compares ignoring case on Windows only", () => {
    expect(outputDirError("win32", "c:\\saved\\music", "C:\\Saved")).toBeUndefined();
    expect(outputDirError("linux", "/home/u/saved/music", "/home/u/Saved")).toBeDefined();
  });

  it("compares after normalizing the path", () => {
    expect(outputDirError("win32", "C:\\Saved\\a\\..\\b", "C:\\Saved")).toBeUndefined();
    expect(outputDirError("win32", "C:\\Saved\\..\\Windows", "C:\\Saved")).toBeDefined();
    expect(outputDirError("linux", "/home/u/Saved/../.ssh", "/home/u/Saved")).toBeDefined();
  });

  it("rejects a relative path, another drive, a sibling with the same prefix and a parent", () => {
    expect(outputDirError("win32", "Saved\\Music", "C:\\Saved")).toBeDefined();
    expect(outputDirError("win32", "C:Music", "C:\\Saved")).toBeDefined();
    expect(outputDirError("win32", "\\Saved\\Music", "C:\\Saved")).toBeDefined();
    expect(outputDirError("win32", "D:\\Saved", "C:\\Saved")).toBeDefined();
    expect(outputDirError("win32", "C:\\Saved2", "C:\\Saved")).toBeDefined();
    expect(outputDirError("win32", "C:\\", "C:\\Saved")).toBeDefined();
    expect(outputDirError("linux", "music", "/home/u/Saved")).toBeDefined();
    expect(outputDirError("linux", "/home/u", "/home/u/Saved")).toBeDefined();
  });

  it("rejects control characters and folder names Windows does not allow", () => {
    expect(outputDirError("linux", "/home/u/Saved/a\u0000b", "/home/u/Saved")).toBeDefined();
    expect(outputDirError("win32", "C:\\Saved\\a:stream", "C:\\Saved")).toBeDefined();
    expect(outputDirError("win32", "C:\\Saved\\con", "C:\\Saved")).toBeDefined();
  });
});

describe("filenameError", () => {
  it("accepts a plain file name, dots inside it included", () => {
    expect(filenameError("My clip.mp4")).toBeUndefined();
    expect(filenameError("Wait... what")).toBeUndefined();
    expect(filenameError("x".repeat(200))).toBeUndefined();
  });

  it("rejects separators, dot names, drive prefixes, control characters and long names", () => {
    for (const name of [
      "a/b",
      "a\\b",
      "..\\evil",
      "../evil",
      "..",
      ".",
      ". .",
      "C:evil",
      "c:\\evil",
      "a\u0000b",
      "a\nb",
      "a\u007fb",
      "x".repeat(201),
    ]) {
      expect(filenameError(name), name).toBeDefined();
    }
  });
});

describe("folderSettingError", () => {
  it("accepts a full path", () => {
    expect(folderSettingError("win32", "D:\\Videos\\Saved")).toBeUndefined();
    expect(folderSettingError("win32", "D:\\")).toBeUndefined();
    expect(folderSettingError("win32", "\\\\nas\\share\\Videos")).toBeUndefined();
    expect(folderSettingError("linux", "/home/u/Videos")).toBeUndefined();
  });

  it("rejects relative and drive-relative paths", () => {
    for (const folder of ["Videos", ".\\Videos", "D:Videos", "\\Videos"]) {
      expect(folderSettingError("win32", folder), folder).toBeDefined();
    }
    expect(folderSettingError("linux", "Videos")).toBeDefined();
    expect(folderSettingError("linux", "./Videos")).toBeDefined();
  });

  it("applies the folder-name rules the folder picker uses", () => {
    expect(folderSettingError("win32", "D:\\Videos\\..\\Windows")).toBeDefined();
    expect(folderSettingError("win32", "D:\\Vid|eos")).toBeDefined();
    expect(folderSettingError("win32", "D:\\aux")).toBeDefined();
    expect(folderSettingError("linux", "/home/u/../root")).toBeDefined();
    expect(folderSettingError("linux", "/home/u/a\u0001b")).toBeDefined();
  });
});
