import { describe, expect, it } from "vitest";
import { allowReport, browserFromUserAgent, osFromUserAgent } from "./about.ts";

const ff = (version: number) =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`;
const chrome =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36";

function permissions(answer: boolean | Error) {
  const asked: unknown[] = [];
  return {
    asked,
    api: {
      request: async (p: { data_collection: string[] }) => {
        asked.push(p);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

describe("allowReport", () => {
  it("asks Firefox 140+ for the report's data categories and follows the answer", async () => {
    const yes = permissions(true);
    expect(await allowReport(yes.api, ff(140))).toBe(true);
    expect(yes.asked).toEqual([
      { data_collection: ["technicalAndInteraction", "browsingActivity"] },
    ]);
    expect(await allowReport(permissions(false).api, ff(145))).toBe(false);
  });

  it("does not send when asking fails", async () => {
    expect(await allowReport(permissions(new Error("no")).api, ff(140))).toBe(false);
  });

  it("asks nothing in Chromium browsers or older Firefox, which have no such consent", async () => {
    const p = permissions(false);
    expect(await allowReport(p.api, chrome)).toBe(true);
    expect(await allowReport(p.api, ff(128))).toBe(true);
    expect(p.asked).toEqual([]);
  });
});

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
