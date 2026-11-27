import { describe, expect, it } from "vitest";
import { appDiagnostics, appReport, lastFailure, NOT_FROM_BROWSER, osLabel } from "./report.ts";

describe("osLabel", () => {
  it("names Windows 10 and 11 by build, and Linux by kernel", () => {
    expect(osLabel("win32", "10.0.19044")).toBe("Windows 10");
    expect(osLabel("win32", "10.0.22631")).toBe("Windows 11");
    expect(osLabel("win32", "6.1.7601")).toBe("Windows 6.1.7601");
    expect(osLabel("linux", "6.8.0-45-generic")).toBe("Linux 6.8.0-45-generic");
  });
});

describe("lastFailure", () => {
  const job = (id: string, status: string, updatedAt: number, extra = {}) => ({
    id,
    status,
    updatedAt,
    request: { candidate: { url: `https://x.test/${id}`, pageTitle: `Page ${id}` } },
    ...extra,
  });

  it("picks the newest failed download with its error", () => {
    const text = JSON.stringify({
      jobs: [
        job("a", "failed", 1, { error: "old" }),
        job("b", "failed", 3, { error: "HTTP Error 403" }),
        job("c", "completed", 9),
        job("d", "cancelled", 8, { error: "Cancelled" }),
      ],
    });
    expect(lastFailure(text)).toEqual({ title: "Page b", error: "HTTP Error 403" });
  });

  it("is undefined without failures or for a broken file", () => {
    expect(lastFailure(JSON.stringify({ jobs: [job("c", "completed", 1)] }))).toBeUndefined();
    expect(lastFailure("{not json")).toBeUndefined();
    expect(lastFailure("{}")).toBeUndefined();
  });
});

describe("appDiagnostics", () => {
  it("lists versions, tools, setup and the last failure", () => {
    const text = appDiagnostics({
      version: "0.3.0",
      target: "win32-x64",
      os: "Windows 10",
      tools: [
        { tool: "yt-dlp", found: true, version: "2026.09.01", source: "managed" },
        { tool: "ffmpeg", found: false },
        { tool: "deno", found: false },
      ],
      failure: { title: "Page b", error: "HTTP Error 403" },
    });
    expect(text.split("\n")).toEqual([
      "app: 0.3.0 (win32-x64)",
      "os: Windows 10",
      "yt-dlp: 2026.09.01 (managed)",
      "ffmpeg: not found",
      "deno: not found",
      "setup: missing ffmpeg",
      "last failed download: Page b",
      "HTTP Error 403",
    ]);
  });

  it("says setup is complete when only optional tools are missing", () => {
    const text = appDiagnostics({
      version: "1",
      target: "linux-x64",
      os: "Linux 6",
      tools: [{ tool: "deno", found: false }],
    });
    expect(text).toContain("setup: complete");
    expect(text).toContain("last failed download: none");
  });
});

describe("appReport", () => {
  it("fills the browser fields with n/a", () => {
    expect(
      appReport({ description: "d", type: "App", version: "1", os: "Linux 6", details: "x" }),
    ).toEqual({
      description: "d",
      type: "App",
      extensionVersion: NOT_FROM_BROWSER,
      appVersion: "1",
      os: "Linux 6",
      browser: NOT_FROM_BROWSER,
      details: "x",
    });
  });
});
