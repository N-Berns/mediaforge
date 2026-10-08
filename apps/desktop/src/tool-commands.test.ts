import { BinaryNotFoundError, type Tool, ToolInstallError } from "@mediaforge/binary-resolver";
import { describe, expect, it } from "vitest";
import { ExitCode } from "./exit-codes.ts";
import { makeRuntime } from "./test-runtime.ts";
import { parseToolList, runSetup, runUpdate } from "./tool-commands.ts";
import type { ToolRuntime } from "./tool-runtime.ts";

function capture() {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (t: string) => {
        out += t;
      },
      stderr: (t: string) => {
        err += t;
      },
    },
    out: () => out,
    err: () => err,
  };
}

describe("parseToolList", () => {
  it("defaults to every tool", () => {
    expect(parseToolList(undefined)).toEqual(["yt-dlp", "ffmpeg"]);
  });

  it("reads a comma list, trims it and drops duplicates", () => {
    expect(parseToolList(" ffmpeg , ffmpeg ")).toEqual(["ffmpeg"]);
  });

  it("rejects unknown names and empty lists as usage errors", () => {
    expect(() => parseToolList("deno")).toThrow(/Unknown tool: deno/);
    expect(() => parseToolList(",")).toThrow(/Choose from/);
    try {
      parseToolList("deno");
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(ExitCode.Usage);
    }
  });
});

describe("runSetup", () => {
  it("changes nothing and says so when every tool is already available", async () => {
    const c = capture();
    const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg"] });
    expect(await runSetup(["--yes"], c.io, rt)).toBe(ExitCode.Ok);
    expect(log.installed).toEqual([]);
    expect(c.out()).toContain("already available");
    expect(c.out()).toContain("/bin/yt-dlp");
  });

  it("downloads what is missing, with progress on stderr and the summary on stdout", async () => {
    const c = capture();
    const { rt, log } = makeRuntime({ present: ["ffmpeg"] });
    expect(await runSetup(["--yes"], c.io, rt)).toBe(ExitCode.Ok);
    expect(log.installed).toEqual(["yt-dlp"]);
    expect(c.out()).toContain("yt-dlp  downloaded  2026.10.08  /cache/yt-dlp");
    expect(c.out()).toContain("ffmpeg  already available");
    expect(c.err()).toContain("yt-dlp: downloading");
    expect(c.out()).not.toContain("downloading");
  });

  it("limits the work to --tools", async () => {
    const c = capture();
    const { rt, log } = makeRuntime();
    await runSetup(["--yes", "--tools", "ffmpeg"], c.io, rt);
    expect(log.installed).toEqual(["ffmpeg"]);
  });

  it("goes straight to the pinned download on macOS with --yes", async () => {
    const c = capture();
    const { rt, log } = makeRuntime({ platform: "darwin", brew: true, answers: [true] });
    await runSetup(["--yes", "--tools", "ffmpeg"], c.io, rt);
    expect(log.asked).toEqual([]);
    expect(log.brewRuns).toBe(0);
    expect(log.installed).toEqual(["ffmpeg"]);
  });

  it("offers Homebrew on macOS without --yes and reports it", async () => {
    const c = capture();
    const { rt, log } = makeRuntime({ platform: "darwin", brew: true, answers: [true] });
    await runSetup(["--tools", "ffmpeg"], c.io, rt);
    expect(log.brewRuns).toBe(1);
    expect(c.out()).toContain("installed with Homebrew");
  });

  it("fails with the download's exit code and hint", async () => {
    const c = capture();
    const { rt } = makeRuntime({
      installError: new ToolInstallError(
        "offline",
        "Could not reach github.com.",
        "Check your internet.",
      ),
    });
    const error = await runSetup(["--yes"], c.io, rt).catch((e) => e);
    expect(error.exitCode).toBe(ExitCode.Network);
    expect(error.message).toBe("Could not reach github.com.\nCheck your internet.");
  });

  it("prints help, and rejects unknown options and extra arguments", async () => {
    const c = capture();
    const { rt } = makeRuntime();
    expect(await runSetup(["--help"], c.io, rt)).toBe(ExitCode.Ok);
    expect(c.out()).toContain("Usage: mediaforge setup");
    await expect(runSetup(["--nope"], c.io, rt)).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    });
    await expect(runSetup(["extra"], c.io, rt)).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    });
  });
});

/** A runtime where yt-dlp's version and source change when `install` runs. */
function updatingRuntime(before: { version: string; source: "cache" | "path" } | undefined) {
  const state = { current: before, installed: [] as Tool[] };
  const base = makeRuntime();
  const rt: ToolRuntime = {
    ...base.rt,
    resolve: async (tool) => {
      if (tool === "yt-dlp" && state.current) {
        return {
          tool,
          path: state.current.source === "cache" ? "/cache/yt-dlp" : "/usr/bin/yt-dlp",
          source: state.current.source,
          version: state.current.version,
        };
      }
      throw new BinaryNotFoundError(tool, ["PATH"]);
    },
    install: async (tool) => {
      state.installed.push(tool);
      // A cache install only becomes the active copy if nothing earlier on the lookup order wins.
      if (state.current?.source !== "path")
        state.current = { version: "2026.10.08", source: "cache" };
      return { tool, version: "2026.10.08", path: "/cache/yt-dlp", sha256: "s", url: "u" };
    },
  };
  return { rt, state };
}

describe("runUpdate", () => {
  it("downloads the latest yt-dlp and prints the old and new versions", async () => {
    const c = capture();
    const { rt, state } = updatingRuntime({ version: "2026.01.01", source: "cache" });
    expect(await runUpdate([], c.io, rt)).toBe(ExitCode.Ok);
    expect(state.installed).toEqual(["yt-dlp"]);
    expect(c.out()).toBe("yt-dlp updated: 2026.01.01 to 2026.10.08\n");
    expect(c.err()).not.toContain("Note:");
  });

  it("works when yt-dlp was not there before", async () => {
    const c = capture();
    const { rt } = updatingRuntime(undefined);
    await runUpdate([], c.io, rt);
    expect(c.out()).toBe("yt-dlp updated: not installed to 2026.10.08\n");
  });

  it("says when the cached copy is already the latest", async () => {
    const c = capture();
    const { rt } = updatingRuntime({ version: "2026.10.08", source: "cache" });
    await runUpdate([], c.io, rt);
    expect(c.out()).toBe("yt-dlp is already up to date (2026.10.08)\n");
  });

  it("warns when a PATH yt-dlp is used before the downloaded copy", async () => {
    const c = capture();
    const { rt } = updatingRuntime({ version: "2025.01.01", source: "path" });
    expect(await runUpdate([], c.io, rt)).toBe(ExitCode.Ok);
    expect(c.err()).toContain("Note: the yt-dlp on your PATH (/usr/bin/yt-dlp)");
    expect(c.err()).toContain("no effect");
  });

  it("never touches ffmpeg", async () => {
    const c = capture();
    const { rt, state } = updatingRuntime(undefined);
    await runUpdate([], c.io, rt);
    expect(state.installed).not.toContain("ffmpeg");
  });

  it("fails with the download's exit code", async () => {
    const c = capture();
    const { rt } = makeRuntime({
      installError: new ToolInstallError("checksum", "Checksum mismatch.", "Try again."),
    });
    await expect(runUpdate([], c.io, rt)).rejects.toMatchObject({ exitCode: ExitCode.Network });
  });

  it("prints help and rejects arguments", async () => {
    const c = capture();
    const { rt } = makeRuntime();
    expect(await runUpdate(["--help"], c.io, rt)).toBe(ExitCode.Ok);
    expect(c.out()).toContain("Usage: mediaforge update");
    await expect(runUpdate(["x"], c.io, rt)).rejects.toMatchObject({ exitCode: ExitCode.Usage });
  });
});
