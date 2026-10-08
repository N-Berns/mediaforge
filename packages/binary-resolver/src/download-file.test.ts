import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { downloadFile } from "./download-file.ts";
import { ToolInstallError } from "./errors.ts";
import { memoryInstallFs, routeFetch, streamResponse } from "./test-helpers.ts";

const URL = "https://example.test/yt-dlp";
const DEST = "/cache/bin/.yt-dlp.download";

describe("downloadFile", () => {
  it("writes the file, hashes it and reports progress", async () => {
    const mem = memoryInstallFs();
    const seen: [number, number | undefined][] = [];
    const result = await downloadFile({
      url: URL,
      dest: DEST,
      fetch: routeFetch({ [URL]: () => streamResponse("hello world", 4) }),
      fs: mem.fs,
      onProgress: (received, total) => seen.push([received, total]),
    });
    expect(result).toEqual({
      sha256: createHash("sha256").update("hello world").digest("hex"),
      bytes: 11,
    });
    expect(mem.text(DEST)).toBe("hello world");
    expect(seen.at(-1)).toEqual([11, 11]);
    expect(seen.map(([received]) => received)).toEqual(
      [...seen.map(([r]) => r)].sort((a, b) => a - b),
    );
  });

  it("turns HTTP errors into install errors and writes nothing", async () => {
    const mem = memoryInstallFs();
    const error = await downloadFile({
      url: URL,
      dest: DEST,
      fetch: routeFetch({}),
      fs: mem.fs,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("not-found");
    expect(mem.paths()).toEqual([]);
  });

  it("reports an unreachable host as offline", async () => {
    const mem = memoryInstallFs();
    const error = await downloadFile({
      url: URL,
      dest: DEST,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      fs: mem.fs,
    }).catch((e) => e);
    expect(error.kind).toBe("offline");
    expect(error.message).toContain("example.test");
  });

  it("removes the partial file when the connection drops mid-download", async () => {
    const mem = memoryInstallFs();
    const error = await downloadFile({
      url: URL,
      dest: DEST,
      fetch: routeFetch({ [URL]: () => streamResponse("0123456789abcdef", 4, 8) }),
      fs: mem.fs,
    }).catch((e) => e);
    expect(error.kind).toBe("offline");
    expect(mem.paths()).toEqual([]);
  });

  it("reports a full disk and removes the partial file", async () => {
    const mem = memoryInstallFs();
    mem.state.writeError = Object.assign(new Error("full"), { code: "ENOSPC" });
    const error = await downloadFile({
      url: URL,
      dest: DEST,
      fetch: routeFetch({ [URL]: () => streamResponse("data", 2) }),
      fs: mem.fs,
    }).catch((e) => e);
    expect(error.kind).toBe("disk-full");
    expect(mem.paths()).toEqual([]);
  });

  it("rethrows an abort as is", async () => {
    const mem = memoryInstallFs();
    const controller = new AbortController();
    controller.abort(new DOMException("Aborted", "AbortError"));
    await expect(
      downloadFile({
        url: URL,
        dest: DEST,
        signal: controller.signal,
        fetch: async (_url, init) => {
          throw init?.signal?.reason;
        },
        fs: mem.fs,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
