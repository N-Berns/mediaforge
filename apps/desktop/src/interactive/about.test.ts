import { describe, expect, it } from "vitest";
import { aboutRows, DEVELOPER, developerRows, NOTICES, REPO_URL } from "./about.ts";

describe("about page data", () => {
  it("describes the app, its build target and its config file", () => {
    expect(aboutRows({ version: "1.2.3", target: "win32-x64", configPath: "C:\\c.json" })).toEqual([
      ["Version", "1.2.3"],
      ["Build", "win32-x64"],
      ["Settings file", "C:\\c.json"],
    ]);
  });

  it("names the developer and hides the repository row when there is no link", () => {
    expect(developerRows("")).toEqual([["Developer", DEVELOPER]]);
    expect(developerRows("https://example.com/repo")).toEqual([
      ["Developer", DEVELOPER],
      ["Repository", "https://example.com/repo"],
    ]);
  });

  it("shows the project repository by default", () => {
    expect(developerRows()).toContainEqual(["Repository", REPO_URL]);
  });

  it("credits the tools it downloads with their licenses", () => {
    expect(NOTICES.map((n) => n.name)).toEqual(["yt-dlp", "ffmpeg", "deno"]);
    for (const notice of NOTICES) {
      expect(notice.license).toBeTruthy();
      expect(notice.url).toMatch(/^https:\/\//);
    }
  });
});
