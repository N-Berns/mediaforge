import { describe, expect, it } from "vitest";
import { isStaleExtractorError, UPDATE_HINT, withUpdateHint } from "./stale-extractor.ts";

describe("isStaleExtractorError", () => {
  it.each([
    "[youtube] abc: Unable to extract initial data; please report this issue on https://github.com/yt-dlp/yt-dlp/issues",
    "Confirm you are on the latest version using yt-dlp -U",
    "nsig extraction failed: Some formats may be missing",
    "Signature extraction failed: Some formats may be missing",
    "unable to download video data: HTTP Error 403: Forbidden",
  ])("recognises %s", (message) => {
    expect(isStaleExtractorError(message)).toBe(true);
  });

  it.each([
    "Unsupported URL: https://example.com",
    "[Errno 28] No space left on device",
    "unable to download video data: HTTP Error 404: Not Found",
    "Video unavailable",
    "",
  ])("ignores %s", (message) => {
    expect(isStaleExtractorError(message)).toBe(false);
  });

  it("ignores a missing message", () => {
    expect(isStaleExtractorError(undefined)).toBe(false);
  });
});

describe("withUpdateHint", () => {
  it("appends the hint on its own line for stale-looking errors only", () => {
    expect(withUpdateHint("Unable to extract title")).toBe(
      `Unable to extract title\n${UPDATE_HINT}`,
    );
    expect(withUpdateHint("Video unavailable")).toBe("Video unavailable");
    expect(UPDATE_HINT).toBe("run: mediaforge update");
  });
});
