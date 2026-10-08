import type { Tool } from "@mediaforge/binary-resolver";
import { describe, expect, it } from "vitest";
import { type DownloadDeps, runDownload } from "./download.ts";
import type { EngineJob } from "./engine/index.ts";
import { DownloadEngine, type EngineFs } from "./engine/index.ts";
import type { ProcessRunner } from "./engine/process.ts";
import { ExitCode } from "./exit-codes.ts";
import { formatFormatsTable, runFormats } from "./formats.ts";
import {
  createProgressView,
  formatBytes,
  formatDuration,
  formatProgressLine,
} from "./progress-view.ts";
import { memorySettingsStore, type Settings } from "./settings.ts";

const found = async (tool: Tool) => ({ tool, path: `/bin/${tool}`, source: "path" as const });
const fs: EngineFs = {
  mkdir: async () => {},
  rename: async () => {},
  rm: async () => {},
  exists: async () => false,
  list: async () => [],
  readText: async () => "",
};

function setup(
  run: ProcessRunner,
  env: Record<string, string> = {},
  isTTY = false,
  saved: Partial<Settings> = {},
) {
  const seenArgs: string[][] = [];
  let interrupt: (() => void) | undefined;
  const deps: DownloadDeps = {
    env,
    isTTY,
    settings: memorySettingsStore(saved),
    onInterrupt: (h) => {
      interrupt = h;
      return () => {};
    },
    createEngine: (onUpdate) =>
      new DownloadEngine({
        resolve: found,
        fs,
        onUpdate,
        run: (cmd, args, h, s) => {
          seenArgs.push(args);
          return run(cmd, args, h, s);
        },
      }),
  };
  let out = "";
  let err = "";
  const io = {
    stdout: (t: string) => {
      out += t;
    },
    stderr: (t: string) => {
      err += t;
    },
  };
  return { deps, io, seenArgs, out: () => out, err: () => err, interrupt: () => interrupt?.() };
}

const succeed: ProcessRunner = async (_c, args, h) => {
  h.onStdoutLine("MFPROGRESS 50 100 NA 10 5");
  h.onStdoutLine("MFPOST started");
  h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip.mp4`);
  return { exitCode: 0 };
};

describe("runDownload", () => {
  it("prints the output path on stdout and progress lines on stderr", async () => {
    const t = setup(succeed);
    const code = await runDownload(["https://example.com/v"], t.io, t.deps);
    expect(code).toBe(ExitCode.Ok);
    expect(t.out().trim()).toMatch(/Clip\.mp4$/);
    expect(t.err()).toContain("downloading");
    expect(t.err()).toContain("processing");
    expect(t.err()).not.toContain("\x1b");
  });

  it("is silent on stderr with --quiet", async () => {
    const t = setup(succeed);
    await runDownload(["-q", "https://example.com/v"], t.io, t.deps);
    expect(t.err()).toBe("");
  });

  it("passes profile, output and filename through to yt-dlp", async () => {
    const t = setup(succeed);
    await runDownload(
      ["-p", "audio-m4a", "-o", "/music", "--filename", "song", "https://example.com/v"],
      t.io,
      t.deps,
    );
    const args = t.seenArgs[0] as string[];
    expect(args).toContain("-x");
    expect(args[args.indexOf("-o") + 1]).toBe("song.%(ext)s");
    expect(args.at(-1)).toBe("https://example.com/v");
  });

  it("falls back to env vars, with flags taking precedence", async () => {
    const t = setup(succeed, { MEDIAFORGE_PROFILE: "audio-m4a" });
    await runDownload(["https://example.com/v"], t.io, t.deps);
    expect(t.seenArgs[0]).toContain("-x");

    const t2 = setup(succeed, { MEDIAFORGE_PROFILE: "audio-m4a" });
    await runDownload(["-p", "best", "https://example.com/v"], t2.io, t2.deps);
    expect(t2.seenArgs[0]).not.toContain("-x");
  });

  it("uses saved settings below flags and env vars", async () => {
    const saved = { quality: "audio-m4a", folder: "/saved-folder" };

    const fromSaved = setup(succeed, {}, false, saved);
    await runDownload(["https://example.com/v"], fromSaved.io, fromSaved.deps);
    const savedArgs = fromSaved.seenArgs[0] as string[];
    expect(savedArgs).toContain("-x");
    expect(savedArgs[savedArgs.indexOf("--paths") + 1]).toContain("saved-folder");

    const fromEnv = setup(
      succeed,
      { MEDIAFORGE_PROFILE: "best", MEDIAFORGE_OUTPUT_DIR: "/env" },
      false,
      saved,
    );
    await runDownload(["https://example.com/v"], fromEnv.io, fromEnv.deps);
    const envArgs = fromEnv.seenArgs[0] as string[];
    expect(envArgs).not.toContain("-x");
    expect(envArgs[envArgs.indexOf("--paths") + 1]).toContain("env");

    const fromFlags = setup(succeed, { MEDIAFORGE_OUTPUT_DIR: "/env" }, false, saved);
    await runDownload(
      ["-p", "best", "-o", "/flag", "https://example.com/v"],
      fromFlags.io,
      fromFlags.deps,
    );
    const flagArgs = fromFlags.seenArgs[0] as string[];
    expect(flagArgs).not.toContain("-x");
    expect(flagArgs[flagArgs.indexOf("--paths") + 1]).toContain("flag");
  });

  it.each([
    [[], "Expected exactly one URL"],
    [["a", "b"], "Expected exactly one URL"],
    [["not a url"], "Not a valid URL"],
    [["ftp://example.com/x"], "Only http and https"],
    [["-p", "nope", "https://example.com/v"], "Unknown profile: nope"],
    [["--bogus", "https://example.com/v"], "Unknown option"],
  ])("rejects %j as a usage error", async (args, message) => {
    const t = setup(succeed);
    await expect(runDownload(args, t.io, t.deps)).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
      message: expect.stringContaining(message),
    });
  });

  it("shows help on --help without downloading", async () => {
    const t = setup(succeed);
    expect(await runDownload(["--help"], t.io, t.deps)).toBe(ExitCode.Ok);
    expect(t.out()).toContain("Profiles:");
    expect(t.seenArgs).toHaveLength(0);
  });

  it("maps a failed download to its exit code", async () => {
    const t = setup(async (_c, _a, h) => {
      h.onStderrLine("ERROR: Unsupported URL: https://example.com/v");
      return { exitCode: 1 };
    });
    await expect(runDownload(["https://example.com/v"], t.io, t.deps)).rejects.toMatchObject({
      exitCode: ExitCode.UnsupportedSite,
    });
  });

  it("cancels on interrupt and exits 130", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    const t = setup(async (_c, _a, _h, signal) => {
      started();
      await new Promise((r) => signal.addEventListener("abort", r));
      return { exitCode: null };
    });
    const result = runDownload(["https://example.com/v"], t.io, t.deps);
    await running;
    t.interrupt();
    expect(await result).toBe(ExitCode.Cancelled);
    expect(t.err()).toContain("Cancelled.");
  });
});

describe("progress view", () => {
  const job = (patch: Partial<EngineJob>): EngineJob =>
    ({ status: "downloading", progress: { bytesDownloaded: 0 }, ...patch }) as EngineJob;

  it("formats bytes and durations", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatDuration(12)).toBe("12s");
    expect(formatDuration(65)).toBe("1m 05s");
    expect(formatDuration(3720)).toBe("1h 02m");
  });

  it("describes downloading with whatever is known", () => {
    expect(
      formatProgressLine(
        job({ progress: { bytesDownloaded: 1, percent: 42.5, speed: 2048, etaSec: 12 } }),
      ),
    ).toBe("downloading  42.5%  2.0 KB/s  ETA 12s");
    expect(formatProgressLine(job({ progress: { bytesDownloaded: 2048 } }))).toBe(
      "downloading  2.0 KB",
    );
    expect(formatProgressLine(job({ status: "processing" }))).toBe("processing");
  });

  it("on a TTY rewrites one line and clears it at the end", () => {
    let out = "";
    const view = createProgressView({ write: (t) => (out += t), isTTY: true, quiet: false });
    view.update(job({}));
    view.update(job({ status: "completed" }));
    view.finish();
    expect(out.split("\r\x1b[K")).toHaveLength(3);
    expect(out).not.toContain("\n");
  });

  it("off a TTY prints only on status changes", () => {
    let out = "";
    const view = createProgressView({ write: (t) => (out += t), isTTY: false, quiet: false });
    view.update(job({ progress: { bytesDownloaded: 1, percent: 1 } }));
    view.update(job({ progress: { bytesDownloaded: 2, percent: 2 } }));
    view.update(job({ status: "processing" }));
    expect(out.split("\n").filter(Boolean)).toHaveLength(2);
  });
});

describe("formats", () => {
  const info = {
    title: "My Video",
    formats: [
      { format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none" },
      { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", filesize: 1048576 },
      {
        format_id: "137",
        ext: "mp4",
        width: 1920,
        height: 1080,
        fps: 30,
        vcodec: "avc1.640028",
        acodec: "none",
        filesize_approx: 5242880,
      },
    ],
  };

  it("renders an aligned table without storyboards", () => {
    const text = formatFormatsTable(info);
    expect(text).toContain("My Video");
    expect(text).not.toContain("sb0");
    expect(text).toMatch(/140\s+m4a\s+audio only\s+-\s+-\s+mp4a\s+1\.0 MB/);
    expect(text).toMatch(/137\s+mp4\s+1920x1080\s+30\s+avc1\s+-\s+~5\.0 MB/);
  });

  it("runs yt-dlp -J and prints the table", async () => {
    let out = "";
    let seen: string[] = [];
    const code = await runFormats(
      ["https://example.com/v"],
      { stdout: (t) => (out += t), stderr: () => {} },
      {
        resolve: found,
        run: async (_c, args, h) => {
          seen = args;
          for (const line of JSON.stringify(info, null, 2).split("\n")) h.onStdoutLine(line);
          return { exitCode: 0 };
        },
      },
    );
    expect(code).toBe(ExitCode.Ok);
    expect(seen).toEqual([
      "-J",
      "--no-playlist",
      "--no-warnings",
      "-S",
      "res,ext:mp4:m4a",
      "--",
      "https://example.com/v",
    ]);
    expect(out).toContain("137");
  });

  it("maps yt-dlp failure to an exit code", async () => {
    await expect(
      runFormats(
        ["https://example.com/v"],
        { stdout: () => {}, stderr: () => {} },
        {
          resolve: found,
          run: async (_c, _a, h) => {
            h.onStderrLine("ERROR: Unsupported URL: https://example.com/v");
            return { exitCode: 1 };
          },
        },
      ),
    ).rejects.toMatchObject({ exitCode: ExitCode.UnsupportedSite });
  });
});

describe("runDownload type folders", () => {
  const workDir = (args: string[]) =>
    (args[args.indexOf("--paths") + 1] as string).replaceAll("\\", "/");

  it("sorts into Video or Audio inside the chosen folder by default", async () => {
    const video = setup(succeed);
    await runDownload(["-o", "/out", "https://example.com/v"], video.io, video.deps);
    expect(workDir(video.seenArgs[0] as string[])).toMatch(/[/]out[/]Video[/]\.mediaforge-/);

    const audio = setup(succeed);
    await runDownload(
      ["-p", "audio-m4a", "-o", "/out", "https://example.com/v"],
      audio.io,
      audio.deps,
    );
    expect(workDir(audio.seenArgs[0] as string[])).toMatch(/[/]out[/]Audio[/]\.mediaforge-/);
  });

  it("sorts inside the built-in folder when none is set", async () => {
    const t = setup(succeed);
    await runDownload(["https://example.com/v"], t.io, t.deps);
    expect(workDir(t.seenArgs[0] as string[])).toMatch(/MediaForge[/]Video[/]\.mediaforge-/);
  });

  it("saves straight into the folder when sorting is off", async () => {
    const t = setup(succeed, {}, false, { sortByType: false });
    await runDownload(["-o", "/out", "https://example.com/v"], t.io, t.deps);
    expect(workDir(t.seenArgs[0] as string[])).toMatch(/[/]out[/]\.mediaforge-/);
  });
});
