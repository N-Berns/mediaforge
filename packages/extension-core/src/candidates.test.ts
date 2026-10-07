import { describe, expect, it } from "vitest";
import { candidateKey, createCandidate, dedupeCandidates } from "./candidates.ts";
import { type Classification, classifyByUrl } from "./classify.ts";

const classify = (url: string): Classification => {
  const result = classifyByUrl(url);
  if (!result) throw new Error(`unclassified ${url}`);
  return result;
};

const make = (url: string, source: "dom" | "network" | "manifest", detectedAt: number) =>
  createCandidate({
    url,
    pageUrl: "https://example.com/watch",
    source,
    classification: classify(url),
    detectedAt,
  });

describe("candidateKey", () => {
  it("ignores hashes, volatile params and param order", () => {
    expect(candidateKey("https://cdn.example.com/v.mp4?b=2&a=1&_=123#t=10")).toBe(
      candidateKey("https://cdn.example.com/v.mp4?a=1&b=2"),
    );
  });

  it("keeps meaningful params distinct", () => {
    expect(candidateKey("https://cdn.example.com/v.mp4?id=1")).not.toBe(
      candidateKey("https://cdn.example.com/v.mp4?id=2"),
    );
  });
});

describe("createCandidate", () => {
  it("gives progressive files a single default variant", () => {
    const candidate = make("https://cdn.example.com/song.mp3", "network", 5);
    expect(candidate).toMatchObject({
      kind: "audio",
      streamType: "progressive",
      detectedAt: 5,
      variants: [{ id: "default", container: "mp3", hasVideo: false, hasAudio: true }],
    });
  });

  it("leaves manifest variants empty until parsed", () => {
    expect(make("https://cdn.example.com/master.m3u8", "network", 0).variants).toEqual([]);
  });
});

describe("dedupeCandidates", () => {
  it("merges duplicates, keeping the earliest time and the richer source", () => {
    const dom = { ...make("https://cdn.example.com/v.mp4", "dom", 10), pageTitle: "Clip" };
    const network = make("https://cdn.example.com/v.mp4?_=999", "network", 20);
    const result = dedupeCandidates([dom, network]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ source: "network", detectedAt: 10, pageTitle: "Clip" });
  });

  it("keeps distinct media separate and preserves order", () => {
    const a = make("https://cdn.example.com/a.mp4", "network", 1);
    const b = make("https://cdn.example.com/b.mp4", "network", 2);
    expect(dedupeCandidates([a, b, a]).map((c) => c.url)).toEqual([a.url, b.url]);
  });
});
