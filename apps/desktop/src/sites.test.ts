import { describe, expect, it } from "vitest";
import { ExitCode } from "./exit-codes.ts";
import { errorTip, SUPPORTED_SITES_URL, sitesTip } from "./sites.ts";

describe("supported sites hint", () => {
  it("points at yt-dlp's list", () => {
    expect(SUPPORTED_SITES_URL).toBe(
      "https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md",
    );
    expect(sitesTip).toContain(SUPPORTED_SITES_URL);
  });

  it("adds the list to unsupported-site errors only", () => {
    expect(errorTip(ExitCode.UnsupportedSite)).toBe(`Supported sites: ${SUPPORTED_SITES_URL}\n`);
    expect(errorTip(ExitCode.Network)).toBe("");
    expect(errorTip(ExitCode.Failure)).toBe("");
  });
});
