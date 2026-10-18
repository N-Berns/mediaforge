import { describe, expect, it } from "vitest";
import { browserFromUserAgent, osFromUserAgent } from "./about.ts";

describe("report", () => {
  it("reads the browser and system out of a user agent", () => {
    const firefox =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
    expect(browserFromUserAgent(firefox)).toBe("Firefox 128.0");
    expect(osFromUserAgent(firefox)).toBe("Windows 10/11");
    const edge =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.81";
    expect(browserFromUserAgent(edge)).toBe("Edge 126.0.2592.81");
    expect(osFromUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:128.0)")).toBe("Linux");
    expect(browserFromUserAgent("")).toBe("unknown");
  });
});
