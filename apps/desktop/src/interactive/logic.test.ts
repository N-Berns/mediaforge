import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../cli.ts";
import type { EngineJob } from "../engine/index.ts";
import { ExitCode } from "../exit-codes.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";
import { clipboardCommands, readClipboard } from "./clipboard.ts";
import { clipboardHint, shorten } from "./clipboard-hint.ts";
import { stepIndex, visibleWindow } from "./components/Menu.tsx";
import { renderBar } from "./components/ProgressBar.tsx";
import { cleanPaste, splitUrls, visibleSlice } from "./components/TextField.tsx";
import { draftSubfolder, effectiveFolder, nextStep, toPlan } from "./flow.ts";
import { availableKinds, formatChoices } from "./format-choices.ts";
import { describeProgress, failureHint, formatClock, mediaRows } from "./hints.ts";
import { describeSites, findLinks, parseLinks, siteOf } from "./links.ts";
import { openCommand } from "./open-folder.ts";
import { activeDetail, stageLabel } from "./screens/DownloadScreen.tsx";
import { validateLinks } from "./screens/LinkScreen.tsx";

describe("menu helpers", () => {
  it("keeps the selected row inside the visible window", () => {
    expect(visibleWindow(0, 5, 10)).toEqual({ start: 0, end: 5 });
    expect(visibleWindow(0, 30, 10)).toEqual({ start: 0, end: 10 });
    expect(visibleWindow(15, 30, 10)).toEqual({ start: 10, end: 20 });
    expect(visibleWindow(29, 30, 10)).toEqual({ start: 20, end: 30 });
  });

  it("steps over disabled rows and wraps around", () => {
    const items = [{}, { disabled: true }, {}, { disabled: true }];
    expect(stepIndex(items, 0, 1)).toBe(2);
    expect(stepIndex(items, 2, 1)).toBe(0);
    expect(stepIndex(items, 0, -1)).toBe(2);
    expect(stepIndex([{ disabled: true }], 0, 1)).toBe(0);
  });
});

describe("text field helpers", () => {
  it("flattens pasted text onto one line", () => {
    expect(cleanPaste("https://a.b/c\r\n")).toBe("https://a.b/c");
    // Line breaks and tabs inside a paste separate links instead of gluing them together.
    expect(cleanPaste("https://a.b/1\r\nhttps://a.b/2\n")).toBe("https://a.b/1 https://a.b/2");
    expect(cleanPaste("a\tb\u0000c")).toBe("a bc");
    // A single typed space is kept.
    expect(cleanPaste(" ")).toBe(" ");
  });

  it("splits on URL boundaries, leaving the first URL at position 0", () => {
    expect(splitUrls("https://a.b/1 https://a.b/2")).toBe("https://a.b/1\nhttps://a.b/2");
    expect(splitUrls("text https://a.b/1")).toBe("text\nhttps://a.b/1");
    expect(splitUrls("https://a.b/1")).toBe("https://a.b/1");
    // Already split: no double newlines.
    expect(splitUrls("https://a.b/1\nhttps://a.b/2")).toBe("https://a.b/1\nhttps://a.b/2");
    // www. also triggers a split.
    expect(splitUrls("https://a.b/1 www.b.com")).toBe("https://a.b/1\nwww.b.com");
    // http:// works too.
    expect(splitUrls("http://a.b/1 http://a.b/2")).toBe("http://a.b/1\nhttp://a.b/2");
  });

  it("scrolls a long value so the cursor stays visible", () => {
    expect(visibleSlice("abcdef", 2, 10)).toEqual({ text: "abcdef", cursor: 2 });
    const slice = visibleSlice("abcdefghij", 10, 5);
    expect(slice.text.length).toBeLessThanOrEqual(5);
    expect(slice.cursor).toBeLessThanOrEqual(5);
  });
});

describe("progress bar", () => {
  it("fills proportionally and clamps", () => {
    expect(renderBar(50, 10)).toBe("█████░░░░░");
    expect(renderBar(0, 4)).toBe("░░░░");
    expect(renderBar(100, 4)).toBe("████");
    expect(renderBar(250, 4)).toBe("████");
    expect(renderBar(undefined, 4)).toBe("░░░░");
  });
});

describe("clipboard", () => {
  it("picks the right tool per platform", () => {
    expect(clipboardCommands("win32", {})[0]?.command).toBe("powershell.exe");
    expect(clipboardCommands("linux", { WAYLAND_DISPLAY: "w" })[0]?.command).toBe("wl-paste");
    expect(clipboardCommands("linux", {})[0]?.command).toBe("xclip");
  });

  it("falls through to the next tool and treats empty text as nothing", async () => {
    const calls: string[] = [];
    const text = await readClipboard(
      async (command) => {
        calls.push(command);
        if (command === "xclip") throw new Error("missing");
        return "https://example.com/v\n";
      },
      "linux",
      {},
    );
    expect(calls).toEqual(["xclip", "xsel"]);
    expect(text).toBe("https://example.com/v\n");
    expect(await readClipboard(async () => "  \n", "linux", {})).toBeUndefined();
    expect(
      await readClipboard(
        async () => {
          throw new Error("x");
        },
        "linux",
        {},
      ),
    ).toBeUndefined();
  });

  it("finds every link in clipboard text, ignoring prose and punctuation", () => {
    expect(findLinks("watch this: https://example.com/v?x=1, thanks")).toEqual([
      "https://example.com/v?x=1",
    ]);
    expect(findLinks("(https://example.com/a) and https://twitch.tv/videos/1.")).toEqual([
      "https://example.com/a",
      "https://twitch.tv/videos/1",
    ]);
    expect(findLinks("no link here")).toEqual([]);
    expect(findLinks("ftp://example.com/x")).toEqual([]);
    expect(findLinks(undefined)).toEqual([]);
  });

  it("describes the clipboard state for the menu", () => {
    expect(clipboardHint({ state: "checking" })).toBe("checking…");
    expect(clipboardHint({ state: "none" })).toBe("no link found");
    expect(clipboardHint({ state: "links", links: ["https://e.com/x"] })).toBe("https://e.com/x");
    expect(
      clipboardHint({
        state: "links",
        links: ["https://www.youtube.com/a", "https://twitch.tv/b", "https://youtube.com/c"],
      }),
    ).toBe("youtube.com, twitch.tv");
    expect(shorten("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("links", () => {
  it("splits pasted text into links by spaces, new lines or commas, without repeats", () => {
    expect(
      parseLinks("https://a.com/1\nhttps://b.tv/2, https://a.com/1  not-a-link (https://c.org/3)"),
    ).toEqual({
      links: ["https://a.com/1", "https://b.tv/2", "https://c.org/3"],
      rejected: ["not-a-link"],
    });
    expect(parseLinks("")).toEqual({ links: [], rejected: [] });
  });

  it("names the site of each link", () => {
    expect(siteOf("https://www.youtube.com/watch?v=1")).toBe("youtube.com");
    expect(siteOf("https://m.twitch.tv/x")).toBe("twitch.tv");
    expect(
      describeSites(["https://a.com/1", "https://b.com/2", "https://c.com/3", "https://d.com/4"]),
    ).toBe("a.com, b.com and 2 more");
  });

  it("asks for at least one link and explains what a link looks like", () => {
    expect(validateLinks("https://a.com/x junk")).toBeUndefined();
    expect(validateLinks("")).toContain("at least one link");
    expect(validateLinks("junk")).toContain("http://");
  });
});

describe("flow", () => {
  const draft = { url: "https://e.com/v" };

  it("asks for quality, then folder, then downloads", () => {
    const first = nextStep(draft, DEFAULT_SETTINGS, "/d");
    expect(first.step).toBe("quality");
    const second = nextStep({ ...first.draft, profileId: "best" }, DEFAULT_SETTINGS, "/d");
    expect(second.step).toBe("folder");
    const third = nextStep({ ...second.draft, outputDir: "/o" }, DEFAULT_SETTINGS, "/d");
    expect(third.step).toBe("download");
  });

  it("fills in saved defaults instead of asking when asking is off", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      askQuality: false,
      askFolder: false,
      quality: "mp4-720p",
    };
    const next = nextStep(draft, settings, "/saved");
    expect(next.step).toBe("download");
    expect(next.draft).toMatchObject({ profileId: "mp4-720p", outputDir: "/saved" });
  });

  it("uses the built-in profile when asking is off and nothing is saved", () => {
    const settings = { ...DEFAULT_SETTINGS, askQuality: false };
    expect(nextStep(draft, settings, "/d").draft.profileId).toBe("best");
  });

  it("resolves the folder: env var, then saved setting, then built-in", () => {
    const saved = { ...DEFAULT_SETTINGS, folder: "/saved" };
    expect(effectiveFolder({ MEDIAFORGE_OUTPUT_DIR: "/env" }, saved, "/b")).toBe("/env");
    expect(effectiveFolder({}, saved, "/b")).toBe("/saved");
    expect(effectiveFolder({}, DEFAULT_SETTINGS, "/b")).toBe("/b");
  });

  it("builds a plan only from a complete draft", () => {
    expect(() => toPlan(draft, false)).toThrow();
    expect(
      toPlan(
        {
          ...draft,
          info: { title: "T" },
          profileId: "best",
          outputDir: "/o",
          formatSelector: "18",
        },
        false,
      ),
    ).toEqual({
      url: draft.url,
      title: "T",
      profileId: "best",
      outputDir: "/o",
      formatSelector: "18",
    });
  });
});

describe("type folders", () => {
  const draft = { url: "https://e.com/v", profileId: "best", outputDir: "/o" };

  it("sorts into a subfolder per kind, following the profile when no kind was picked", () => {
    expect(toPlan(draft, true).outputDir).toBe(join("/o", "Video"));
    expect(toPlan({ ...draft, kind: "video" }, true).outputDir).toBe(join("/o", "Video only"));
    expect(toPlan({ ...draft, profileId: "audio-m4a" }, true).outputDir).toBe(join("/o", "Audio"));
    expect(toPlan({ ...draft, kind: "audio" }, false).outputDir).toBe("/o");
  });

  it("names the subfolder only while sorting is on", () => {
    expect(draftSubfolder({ ...draft, kind: "video" }, true)).toBe("Video only");
    expect(draftSubfolder(draft, false)).toBeUndefined();
  });
});

describe("hints", () => {
  it("gives a useful next step per failure kind", () => {
    expect(failureHint(ExitCode.MissingTool, "")).toContain("Check setup");
    expect(failureHint(ExitCode.UnsupportedSite, "")).toContain("not supported");
    expect(failureHint(ExitCode.UnsupportedSite, "")).toContain(
      "https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md",
    );
    expect(failureHint(ExitCode.FileSystem, "")).toContain("another folder");
    expect(failureHint(ExitCode.Network, "HTTP Error 403: Forbidden")).toContain("Updating yt-dlp");
    expect(failureHint(ExitCode.Network, "timed out")).toContain("internet connection");
    expect(failureHint(undefined, "")).toContain("Try again");
  });

  it("formats clock times and media details", () => {
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(3723)).toBe("1:02:03");
    expect(mediaRows({ title: "T", channel: "C", uploader: "U", duration: 125 })).toEqual([
      ["Title", "T"],
      ["From", "C"],
      ["Length", "2:05"],
    ]);
    expect(mediaRows({})).toEqual([]);
  });

  it("summarises progress with whatever is known", () => {
    expect(describeProgress({ bytesDownloaded: 1024 })).toBe("1.0 KB");
    expect(
      describeProgress({ bytesDownloaded: 1024, totalBytes: 2048, speed: 512, etaSec: 2 }),
    ).toBe("1.0 KB of 2.0 KB · 512 B/s · ETA 2s");
  });

  it("labels the download stage from the running step", () => {
    const job = (status: EngineJob["status"], steps?: EngineJob["steps"]) =>
      ({ status, steps, progress: { bytesDownloaded: 0 } }) as EngineJob;
    expect(stageLabel(undefined)).toBe("Starting");
    expect(stageLabel(job("queued"))).toBe("Starting");
    expect(stageLabel(job("downloading"))).toBe("Downloading");
    expect(stageLabel(job("downloading", [{ kind: "audio", state: "active" }]))).toBe(
      "Downloading audio",
    );
    expect(stageLabel(job("processing", [{ kind: "merge", state: "active" }]))).toBe(
      "Merging video and audio",
    );
    expect(stageLabel(job("processing"))).toBe("Finishing");
  });

  it("shows bytes and speed under the overall bar while downloading", () => {
    const steps: EngineJob["steps"] = [
      { kind: "video", state: "done", percent: 100 },
      { kind: "audio", state: "active", progress: { bytesDownloaded: 1024, totalBytes: 2048 } },
    ];
    expect(
      activeDetail({ status: "downloading", steps, progress: { bytesDownloaded: 0 } } as EngineJob),
    ).toBe("1.0 KB of 2.0 KB");
    expect(
      activeDetail({
        status: "processing",
        steps: [{ kind: "merge", state: "active" }],
        progress: { bytesDownloaded: 0 },
      } as EngineJob),
    ).toBe("Merging video and audio…");
  });
});

describe("formatChoices", () => {
  const info = {
    formats: [
      { format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none" },
      { format_id: "233", ext: "mp4", vcodec: "none" },
      { format_id: "139-drc", ext: "m4a", vcodec: "none", acodec: "mp4a.40.5" },
      { format_id: "251", ext: "webm", vcodec: "none", acodec: "opus", abr: 130.4 },
      { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", filesize: 1048576 },
      { format_id: "18", ext: "mp4", height: 360, vcodec: "avc1.42", acodec: "mp4a.40.2" },
      { format_id: "299", ext: "mp4", height: 1080, fps: 60, vcodec: "avc1.64", acodec: "none" },
    ],
  };

  it("video with audio: the top row is the best pick, silent video gets audio added", () => {
    const choices = formatChoices(info, "video-audio");
    expect(choices.map((c) => c.label)).toEqual(["Auto  1080p60  mp4", "      360p     mp4"]);
    expect(choices[0]?.value).toEqual({ profileId: "best" });
    expect(choices[0]?.hint).toContain("avc1  audio added");
    expect(choices[1]?.value).toEqual({ selector: "18", profileId: "best" });
  });

  it("video only: lists streams without sound and never adds audio", () => {
    const choices = formatChoices(info, "video");
    expect(choices.map((c) => c.label)).toEqual(["Auto  1080p60  mp4"]);
    expect(choices[0]?.value).toEqual({ selector: "bv", profileId: "best" });
    expect(choices[0]?.hint).toContain("avc1  no sound");
  });

  it("audio only: best m4a first, then MP3, then the streams, noting conversions", () => {
    const choices = formatChoices(info, "audio");
    expect(choices.map((c) => c.label)).toEqual([
      "Auto  Audio  m4a ",
      "      MP3    mp3 ",
      "      Audio  webm",
    ]);
    expect(choices[0]?.value).toEqual({ profileId: "audio-m4a" });
    expect(choices[0]?.hint).toContain("mp4a");
    expect(choices[0]?.hint).toContain("1.0 MB");
    expect(choices[1]?.value).toEqual({ profileId: "audio-mp3-320" });
    expect(choices[1]?.hint).toMatch(/320 kbps {2}converted/);
    expect(choices[2]?.value).toEqual({ selector: "251", profileId: "audio-m4a" });
    expect(choices[2]?.hint).toMatch(/130 kbps {2}saved as m4a/);
  });

  it("puts every column at the same place on every row", () => {
    const rows = formatChoices(
      {
        duration: 100,
        formats: [
          { format_id: "1", ext: "webm", height: 360, vcodec: "vp9", acodec: "none", tbr: 80 },
          { format_id: "2", ext: "mp4", height: 360, vcodec: "avc1.42", acodec: "none", tbr: 90 },
          { format_id: "3", ext: "mp4", height: 1080, fps: 60, vcodec: "av01.0", acodec: "none" },
          {
            format_id: "140",
            ext: "m4a",
            acodec: "mp4a.40.2",
            vcodec: "none",
            filesize: 1_000_000,
          },
        ],
      },
      "video-audio",
    ).map((c) => `${c.label}  ${c.hint}`);
    // Where the codec starts, where "audio added" starts, and where the size ends must agree.
    const at = (find: RegExp) => rows.map((r) => r.search(find));
    expect(new Set(at(/\b(vp9|avc1|av01)\b/)).size).toBe(1);
    expect(new Set(at(/audio added/)).size).toBe(1);
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
  });

  it("marks HLS streams, which are bigger but ranked below the direct file", () => {
    const rows = formatChoices(
      {
        formats: [
          {
            format_id: "270",
            ext: "mp4",
            height: 1080,
            vcodec: "avc1",
            acodec: "none",
            protocol: "m3u8_native",
            tbr: 4688,
          },
          {
            format_id: "137",
            ext: "mp4",
            height: 1080,
            vcodec: "avc1",
            acodec: "none",
            protocol: "https",
            tbr: 3038,
          },
        ],
      },
      "video-audio",
    );
    expect(rows[0]?.value).toEqual({ profileId: "best" });
    expect(rows[0]?.hint).not.toContain("HLS");
    expect(rows[1]?.value).toEqual({ selector: "270+ba/270", profileId: "best" });
    expect(rows[1]?.hint).toContain("HLS stream");
  });

  it("right-aligns bitrates and left-aligns notes in audio lists", () => {
    const rows = formatChoices(
      {
        duration: 100,
        formats: [
          { format_id: "1", ext: "webm", vcodec: "none", acodec: "opus", abr: 50 },
          { format_id: "2", ext: "webm", vcodec: "none", acodec: "opus", abr: 131 },
          { format_id: "3", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 130 },
        ],
      },
      "audio",
    ).map((c) => `${c.label}  ${c.hint}`);
    // "kbps" ends at the same column on every row, and every note starts at the same column.
    const ends = rows.map((r) => r.indexOf("kbps"));
    expect(new Set(ends).size).toBe(1);
    const notes = rows.map((r) => r.search(/converted|saved as m4a/)).filter((i) => i >= 0);
    expect(new Set(notes).size).toBe(1);
  });

  it("estimates sizes from the bitrate and marks them as a guess", () => {
    const rows = formatChoices(
      {
        duration: 100,
        formats: [
          { format_id: "a", ext: "mp4", height: 144, vcodec: "av01", acodec: "none", tbr: 80 },
          { format_id: "b", ext: "mp4", height: 720, vcodec: "vp09", acodec: "none" },
          {
            format_id: "c",
            ext: "mp4",
            height: 1080,
            vcodec: "avc1",
            acodec: "none",
            filesize: 50_000_000,
          },
        ],
      },
      "video",
    );
    expect(rows[0]?.hint).toMatch(/47\.7 MB$/);
    expect(rows[1]?.hint).toMatch(/ -$/);
    expect(rows[2]?.hint).toMatch(/~\d/);
  });

  it("only offers kinds the link has", () => {
    expect(availableKinds(info)).toEqual({ "video-audio": true, video: true, audio: true });
    expect(
      availableKinds({ formats: [{ format_id: "18", vcodec: "avc1", acodec: "aac" }] }),
    ).toEqual({ "video-audio": true, video: false, audio: false });
    expect(availableKinds({})).toEqual({ "video-audio": false, video: false, audio: false });
  });
});

describe("openCommand", () => {
  it("picks the right file manager per platform", () => {
    expect(openCommand("C:\\a b\\c.mp4", "win32")).toEqual({
      command: "explorer.exe",
      args: ['/select,"C:\\a b\\c.mp4"'],
      verbatim: true,
    });
    expect(openCommand("/a/c.mp4", "linux")).toMatchObject({ command: "xdg-open" });
  });
});

describe("run with an interactive hook", () => {
  const io = { stdout: () => {}, stderr: () => {} };

  it("opens the interactive app when there are no arguments", async () => {
    let opened = false;
    const code = await run([], io, {
      interactive: async () => {
        opened = true;
        return 0;
      },
    });
    expect(opened).toBe(true);
    expect(code).toBe(0);
  });

  it("still runs help and unknown commands normally when interactive is available", async () => {
    let opened = false;
    const interactive = async () => {
      opened = true;
      return 0;
    };
    expect(await run(["--help"], io, { interactive })).toBe(0);
    expect(await run(["nope"], io, { interactive })).toBe(ExitCode.Usage);
    expect(opened).toBe(false);
  });

  it("reports an error from the interactive app instead of throwing", async () => {
    const errors: string[] = [];
    const code = await run(
      [],
      { stdout: () => {}, stderr: (t) => errors.push(t) },
      {
        interactive: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(code).toBe(ExitCode.Failure);
    expect(errors.join("")).toContain("boom");
  });
});
