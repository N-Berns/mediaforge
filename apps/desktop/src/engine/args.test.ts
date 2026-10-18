import { getProfile } from "@mediaforge/media-profiles";
import { describe, expect, it } from "vitest";
import {
  buildYtDlpArgs,
  contextArgs,
  contextError,
  contextSecrets,
  redactSecrets,
} from "./args.ts";

describe("request context", () => {
  it("builds yt-dlp flags without a shell", () => {
    expect(
      contextArgs({
        referer: "https://example.com/watch",
        userAgent: "UA/1.0",
        cookies: "a=1; b=2",
        headers: { Origin: "https://example.com" },
      }),
    ).toEqual([
      "--referer",
      "https://example.com/watch",
      "--user-agent",
      "UA/1.0",
      "--add-header",
      "Cookie:a=1; b=2",
      "--add-header",
      "Origin:https://example.com",
    ]);
    expect(contextArgs(undefined)).toEqual([]);
  });

  it("rejects line breaks, NUL, oversized values and bad or forbidden header names", () => {
    expect(contextError({ cookies: "a=1\r\nX-Evil: 1" })).toMatch(/line break/);
    expect(contextError({ userAgent: "a\0b" })).toMatch(/line break/);
    expect(contextError({ referer: `https://x/${"a".repeat(9000)}` })).toMatch(/too long/);
    expect(contextError({ headers: { "bad name": "x" } })).toMatch(/Invalid header name/);
    expect(contextError({ headers: { Host: "evil" } })).toMatch(/not allowed/);
    expect(contextError({ referer: "https://x/", cookies: "a=1" })).toBeUndefined();
  });

  it("lists secrets and redacts them", () => {
    const secrets = contextSecrets({
      cookies: "session=abc123",
      headers: { Authorization: "Bearer tok-999" },
    });
    expect(secrets).toEqual(["session=abc123", "Bearer tok-999"]);
    expect(redactSecrets("failed with session=abc123 and Bearer tok-999", secrets)).toBe(
      "failed with [redacted] and [redacted]",
    );
    expect(redactSecrets("short", ["abc"])).toBe("short");
  });

  it("redacts cookie pairs, cookie values and auth tokens echoed on their own", () => {
    const secrets = contextSecrets({
      cookies: "session=SECRETVALUE; flag=1; other=true",
      headers: { Authorization: "Bearer tok-abcdef123" },
    });
    expect(redactSecrets("saw session=SECRETVALUE only", secrets)).toBe("saw [redacted] only");
    expect(redactSecrets("saw SECRETVALUE only", secrets)).toBe("saw [redacted] only");
    expect(redactSecrets("saw tok-abcdef123 only", secrets)).toBe("saw [redacted] only");
    expect(redactSecrets("flag 1 and true", secrets)).toBe("flag 1 and true");
  });

  it("redacts longest secrets first", () => {
    const out = redactSecrets("xx session=SECRETVALUE yy", ["SECRETVALUE", "session=SECRETVALUE"]);
    expect(out).toBe("xx [redacted] yy");
  });

  it("enforces size limits without echoing long names", () => {
    const longName = "a".repeat(300);
    const message = contextError({ headers: { [longName]: "x" } });
    expect(message).toMatch(/too long/);
    expect(message).not.toContain(longName);
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`X-${i}`, "v"]));
    expect(contextError({ headers: many })).toMatch(/Too many/);
    const big = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`X-${i}`, "a".repeat(8000)]),
    );
    expect(contextError({ headers: big })).toMatch(/too large/);
  });

  it("rejects control characters and more forbidden headers", () => {
    expect(contextError({ userAgent: "a\u0001b" })).toMatch(/line break|control/);
    expect(contextError({ userAgent: "a\u007fb" })).toMatch(/line break|control/);
    expect(contextError({ headers: { "X-A": "v\r\nX-B: 1" } })).toBeDefined();
    expect(contextError({ userAgent: "a\tb" })).toBeUndefined();
    for (const name of [
      "cookie",
      "COOKIE",
      "Proxy-Authorization",
      "TE",
      "Upgrade",
      "Expect",
      "Keep-Alive",
      "Trailer",
    ]) {
      expect(contextError({ headers: { [name]: "x" } })).toMatch(/not allowed/);
    }
  });
});

describe("subtitle downloads", () => {
  const candidate = {
    id: "c",
    pageUrl: "https://e.test/w",
    url: "https://e.test/w",
    kind: "video" as const,
    streamType: "progressive" as const,
    source: "dom" as const,
    variants: [],
    detectedAt: 0,
  };
  const args = (subtitle: { lang: string; auto: boolean; format: "srt" | "vtt" }) =>
    buildYtDlpArgs({
      request: { candidate, profileId: "best", subtitle },
      profile: getProfile("best") as never,
      workDir: "/w",
      ffmpegPath: "ffmpeg",
    });

  it("saves only the subtitle, converted to the chosen format", () => {
    const a = args({ lang: "pt-BR", auto: false, format: "srt" });
    expect(a).toContain("--skip-download");
    expect(a).toContain("--write-subs");
    expect(a).not.toContain("-f");
    expect(a.slice(a.indexOf("--sub-langs"), a.indexOf("--sub-langs") + 4)).toEqual([
      "--sub-langs",
      "pt\\-BR",
      "--convert-subs",
      "srt",
    ]);
  });

  it("asks for auto-generated captions when marked auto", () => {
    expect(args({ lang: "en", auto: true, format: "vtt" })).toContain("--write-auto-subs");
  });

  it("always continues partial files", () => {
    expect(args({ lang: "en", auto: false, format: "srt" })).toContain("--continue");
  });
});

describe("speed cap", () => {
  const candidate = {
    id: "c",
    pageUrl: "https://e.test/w",
    url: "https://e.test/w",
    kind: "video" as const,
    streamType: "progressive" as const,
    source: "dom" as const,
    variants: [],
    detectedAt: 0,
  };
  const input = {
    request: { candidate, profileId: "best" },
    profile: getProfile("best") as never,
    workDir: "/w",
    ffmpegPath: "/bin/ffmpeg",
  };

  it("caps the speed with --limit-rate in whole bytes per second", () => {
    const args = buildYtDlpArgs({ ...input, limitRate: 2_500_000.9 });
    expect(args[args.indexOf("--limit-rate") + 1]).toBe("2500000");
    expect(buildYtDlpArgs(input)).not.toContain("--limit-rate");
  });
});
