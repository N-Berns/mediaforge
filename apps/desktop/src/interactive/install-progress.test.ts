import { ToolInstallError } from "@mediaforge/binary-resolver";
import { describe, expect, it } from "vitest";
import {
  describeInstallFailure,
  describeInstallProgress,
  installPercent,
} from "./install-progress.ts";

describe("installPercent", () => {
  it("is the share downloaded, and unknown without a total or outside the download", () => {
    expect(installPercent({ tool: "yt-dlp", phase: "downloading", received: 50, total: 200 })).toBe(
      25,
    );
    expect(installPercent({ tool: "yt-dlp", phase: "downloading", received: 50 })).toBeUndefined();
    expect(installPercent({ tool: "yt-dlp", phase: "verifying" })).toBeUndefined();
  });
});

describe("describeInstallProgress", () => {
  it("shows bytes while downloading and the phase otherwise", () => {
    expect(
      describeInstallProgress({
        tool: "ffmpeg",
        phase: "downloading",
        received: 1048576,
        total: 2097152,
      }),
    ).toBe("ffmpeg: downloading 1.0 MB of 2.0 MB");
    expect(describeInstallProgress({ tool: "ffmpeg", phase: "downloading", received: 0 })).toBe(
      "ffmpeg: downloading",
    );
    expect(describeInstallProgress({ tool: "yt-dlp", phase: "verifying" })).toBe(
      "yt-dlp: verifying checksum",
    );
  });
});

describe("describeInstallFailure", () => {
  it("joins an install error's message and hint, and falls back to any error's message", () => {
    expect(
      describeInstallFailure(new ToolInstallError("offline", "Could not reach x.", "Try again.")),
    ).toBe("Could not reach x. Try again.");
    expect(describeInstallFailure(new Error("boom"))).toBe("boom");
    expect(describeInstallFailure("odd")).toBe("odd");
  });
});
