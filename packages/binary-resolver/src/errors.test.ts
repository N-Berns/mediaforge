import { describe, expect, it } from "vitest";
import {
  checksumError,
  fsError,
  httpError,
  isFsError,
  offlineError,
  ToolInstallError,
} from "./errors.ts";

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("install errors", () => {
  it("names the host when offline", () => {
    const error = offlineError("https://github.com/yt-dlp/yt-dlp/releases/latest");
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("offline");
    expect(error.message).toContain("github.com");
    expect(error.hint).toContain("internet connection");
  });

  it("tells 404, rate limits and other HTTP failures apart", () => {
    expect(httpError("https://x.test/a", 404).kind).toBe("not-found");
    expect(httpError("https://x.test/a", 403).kind).toBe("rate-limit");
    expect(httpError("https://x.test/a", 429).kind).toBe("rate-limit");
    const other = httpError("https://x.test/a", 500);
    expect(other.kind).toBe("http");
    expect(other.message).toContain("500");
  });

  it("reports both hashes on a checksum mismatch and says the file was discarded", () => {
    const error = checksumError("yt-dlp", "aaa", "bbb");
    expect(error.kind).toBe("checksum");
    expect(error.message).toContain("aaa");
    expect(error.message).toContain("bbb");
    expect(error.message).toContain("discarded");
  });

  it("maps file system errors to disk-full, permission or io", () => {
    expect(fsError(errno("ENOSPC"), "/c/yt-dlp").kind).toBe("disk-full");
    expect(fsError(errno("EACCES"), "/c/yt-dlp").kind).toBe("permission");
    expect(fsError(errno("EPERM"), "/c/yt-dlp").kind).toBe("permission");
    expect(fsError(errno("EIO"), "/c/yt-dlp").kind).toBe("io");
    expect(fsError(errno("ENOSPC"), "/c/yt-dlp").message).toContain("/c/yt-dlp");
  });

  it("passes an existing install error through unchanged", () => {
    const original = checksumError("ffmpeg", "a", "b");
    expect(fsError(original, "/x")).toBe(original);
  });

  it("recognises file system error codes but not network ones", () => {
    expect(isFsError(errno("ENOSPC"))).toBe(true);
    expect(isFsError(errno("ECONNRESET"))).toBe(false);
    expect(isFsError(new TypeError("terminated"))).toBe(false);
    expect(isFsError(undefined)).toBe(false);
  });
});
