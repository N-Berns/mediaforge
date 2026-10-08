import { describe, expect, it } from "vitest";
import { aboutRows, DEVELOPER, developerRows, NOTICES } from "./about.ts";

describe("about page data", () => {
  it("describes the app, its build target and its config file", () => {
    expect(aboutRows({ version: "1.2.3", target: "win32-x64", configPath: "C:\\c.json" })).toEqual([
      ["Version", "1.2.3"],
      ["Build", "win32-x64"],
      ["Settings file", "C:\\c.json"],
    ]);
  });

  it("names the developer and hides the repository row until there is a link", () => {
    expect(developerRows(undefined)).toEqual([["Developer", DEVELOPER]]);
    expect(developerRows("https://example.com/repo")).toEqual([
      ["Developer", DEVELOPER],
      ["Repository", "https://example.com/repo"],
    ]);
  });

  it("credits the tools it downloads with their licenses", () => {
    expect(NOTICES.map((n) => n.name)).toEqual(["yt-dlp", "ffmpeg"]);
    for (const notice of NOTICES) {
      expect(notice.license).toBeTruthy();
      expect(notice.url).toMatch(/^https:\/\//);
    }
  });
});
