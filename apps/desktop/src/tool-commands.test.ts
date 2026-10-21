import {
  BinaryNotFoundError,
  type Tool,
  type ToolCheck,
  ToolInstallError,
} from "@mediaforge/binary-resolver";
import { describe, expect, it } from "vitest";
import { ExitCode } from "./exit-codes.ts";
import { memorySettingsStore } from "./settings.ts";
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
    expect(parseToolList(undefined)).toEqual(["yt-dlp", "ffmpeg", "deno"]);
  });

  it("reads a comma list, trims it and drops duplicates", () => {
    expect(parseToolList(" ffmpeg , ffmpeg ")).toEqual(["ffmpeg"]);
  });

  it("rejects unknown names and empty lists as usage errors", () => {
    expect(() => parseToolList("node")).toThrow(/Unknown tool: node/);
    expect(() => parseToolList(",")).toThrow(/Choose from/);
    try {
      parseToolList("node");
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(ExitCode.Usage);
    }
  });
});

describe("runSetup", () => {
  it("changes nothing and says so when every tool is already available", async () => {
    const c = capture();
    const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
    expect(await runSetup(["--yes"], c.io, rt)).toBe(ExitCode.Ok);
    expect(log.installed).toEqual([]);
    expect(c.out()).toContain("already available");
    expect(c.out()).toContain("/bin/yt-dlp");
  });

  it("downloads what is missing, with progress on stderr and the summary on stdout", async () => {
    const c = capture();
    const { rt, log } = makeRuntime({ present: ["ffmpeg"] });
    expect(await runSetup(["--yes"], c.io, rt)).toBe(ExitCode.Ok);
    expect(log.installed).toEqual(["yt-dlp", "deno"]);
    expect(c.out()).toContain("yt-dlp  downloaded  2026.10.08  /cache/yt-dlp");
    expect(c.out()).toContain("ffmpeg  already available");
    // The fake terminal gets the styled progress line, which has colour codes around the name.
    expect(c.err()).toMatch(/yt-dlp.*1 B/);
    expect(c.out()).not.toContain("downloading");
  });

  it("limits the work to --tools", async () => {
    const c = capture();
    const { rt, log } = makeRuntime();
    await runSetup(["--yes", "--tools", "ffmpeg"], c.io, rt);
    expect(log.installed).toEqual(["ffmpeg"]);
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
function updatingRuntime(
  before: { version: string; source: "cache" | "env" } | undefined,
  cached: string | undefined = before?.source === "cache" ? before.version : undefined,
) {
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
      if (state.current?.source !== "env")
        state.current = { version: "2026.10.08", source: "cache" };
      return {
        tool,
        version: "2026.10.08",
        path: "/cache/yt-dlp",
        sha256: "s",
        url: "u",
        ...(cached !== undefined && { previous: cached }),
      };
    },
  };
  return { rt, state };
}

describe("runUpdate", () => {
  it("downloads the latest yt-dlp and prints the old and new versions", async () => {
    const c = capture();
    const { rt, state } = updatingRuntime({ version: "2026.01.01", source: "cache" });
    expect(await runUpdate([], c.io, rt, memorySettingsStore())).toBe(ExitCode.Ok);
    expect(state.installed).toEqual(["yt-dlp"]);
    expect(c.out()).toBe("yt-dlp updated: 2026.01.01 to 2026.10.08 (stable)\n");
    expect(c.err()).not.toContain("Note:");
  });

  it("works when yt-dlp was not there before", async () => {
    const c = capture();
    const { rt } = updatingRuntime(undefined);
    await runUpdate([], c.io, rt, memorySettingsStore());
    expect(c.out()).toBe("yt-dlp updated: not installed to 2026.10.08 (stable)\n");
  });

  it("says when the cached copy is already the latest", async () => {
    const c = capture();
    const { rt } = updatingRuntime({ version: "2026.10.08", source: "cache" });
    await runUpdate([], c.io, rt, memorySettingsStore());
    expect(c.out()).toBe("yt-dlp is already up to date (2026.10.08, stable)\n");
  });

  it("reports the cache's previous version, not an override's", async () => {
    const c = capture();
    const { rt } = updatingRuntime({ version: "2025.01.01", source: "env" });
    await runUpdate([], c.io, rt, memorySettingsStore());
    expect(c.out()).toBe("yt-dlp updated: not installed to 2026.10.08 (stable)\n");
  });

  it("says up to date when the cache already held this version, even if the env override shadows it", async () => {
    const c = capture();
    const { rt } = updatingRuntime({ version: "2025.01.01", source: "env" }, "2026.10.08");
    await runUpdate([], c.io, rt, memorySettingsStore());
    expect(c.out()).toBe("yt-dlp is already up to date (2026.10.08, stable)\n");
    expect(c.err()).toContain("Note:");
  });

  it("warns when the env override is used before the downloaded copy", async () => {
    const c = capture();
    const { rt } = updatingRuntime({ version: "2025.01.01", source: "env" });
    expect(await runUpdate([], c.io, rt, memorySettingsStore())).toBe(ExitCode.Ok);
    expect(c.err()).toContain("Note: MEDIAFORGE_YTDLP_PATH (/usr/bin/yt-dlp)");
    expect(c.err()).toContain("no effect");
  });

  it("never touches ffmpeg", async () => {
    const c = capture();
    const { rt, state } = updatingRuntime(undefined);
    await runUpdate([], c.io, rt, memorySettingsStore());
    expect(state.installed).not.toContain("ffmpeg");
  });

  it("fails with the download's exit code", async () => {
    const c = capture();
    const { rt } = makeRuntime({
      installError: new ToolInstallError("checksum", "Checksum mismatch.", "Try again."),
    });
    await expect(runUpdate([], c.io, rt, memorySettingsStore())).rejects.toMatchObject({
      exitCode: ExitCode.Network,
    });
  });

  it("prints help and rejects arguments", async () => {
    const c = capture();
    const { rt } = makeRuntime();
    expect(await runUpdate(["--help"], c.io, rt, memorySettingsStore())).toBe(ExitCode.Ok);
    expect(c.out()).toContain("Usage: mediaforge update");
    expect(c.out()).toContain("--channel");
    expect(c.out()).toContain("--check");
    await expect(runUpdate(["x"], c.io, rt, memorySettingsStore())).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    });
  });

  it("update --channel master installs from master and saves the setting", async () => {
    const c = capture();
    const { rt, log } = makeRuntime();
    const store = memorySettingsStore({ askFolder: false, ytDlpChannel: "nightly" });
    expect(await runUpdate(["--channel", "master"], c.io, rt, store)).toBe(ExitCode.Ok);
    expect(log.installOptions[0]).toMatchObject({ channel: "master" });
    expect(c.out()).toContain("(master)");
    const saved = await store.load();
    expect(saved.ytDlpChannel).toBe("master");
    expect(saved.askFolder).toBe(false);
  });

  it("uses the saved channel when none is given", async () => {
    const c = capture();
    const { rt, log } = makeRuntime();
    const store = memorySettingsStore({ ytDlpChannel: "stable" });
    await runUpdate([], c.io, rt, store);
    expect(log.installOptions[0]).toMatchObject({ channel: "stable" });
    expect(c.out()).toContain("(stable)");
    expect((await store.load()).ytDlpChannel).toBe("stable");
  });

  it("does not save the channel when the install fails", async () => {
    const c = capture();
    const { rt } = makeRuntime({
      installError: new ToolInstallError("checksum", "Checksum mismatch.", "Try again."),
    });
    const store = memorySettingsStore({ ytDlpChannel: "nightly" });
    await expect(runUpdate(["--channel", "master"], c.io, rt, store)).rejects.toBeDefined();
    expect((await store.load()).ytDlpChannel).toBe("nightly");
  });

  it("keeps a setting changed during the download when saving the channel", async () => {
    const c = capture();
    const base = makeRuntime();
    const store = memorySettingsStore({ ytDlpChannel: "nightly", askFolder: true });
    const rt: ToolRuntime = {
      ...base.rt,
      install: async (...args) => {
        await store.save({ ...(await store.load()), askFolder: false });
        return base.rt.install(...args);
      },
    };
    await runUpdate(["--channel", "master"], c.io, rt, store);
    const saved = await store.load();
    expect(saved.ytDlpChannel).toBe("master");
    expect(saved.askFolder).toBe(false);
  });

  it("update --channel bogus exits with usage", async () => {
    const c = capture();
    const { rt, log } = makeRuntime();
    const store = memorySettingsStore();
    const error = await runUpdate(["--channel", "bogus"], c.io, rt, store).catch((e) => e);
    expect(error).toMatchObject({ exitCode: ExitCode.Usage });
    expect(error.message).toMatch(/stable, nightly, master/);
    expect(log.installed).toEqual([]);
  });
});

describe("runUpdate --check", () => {
  function checkRuntime(
    results: Partial<Record<Tool, ToolCheck>>,
    resolved?: { version: string; source: "cache" | "env" },
  ) {
    const base = makeRuntime();
    const checkCalls: { tools: Tool[]; channel?: string }[] = [];
    const installs: Tool[] = [];
    const rt: ToolRuntime = {
      ...base.rt,
      resolve: async (tool) => {
        if (tool === "yt-dlp" && resolved) {
          return {
            tool,
            path: resolved.source === "cache" ? "/cache/yt-dlp" : "/usr/bin/yt-dlp",
            source: resolved.source,
            version: resolved.version,
          };
        }
        throw new BinaryNotFoundError(tool, ["PATH"]);
      },
      install: async (tool) => {
        installs.push(tool);
        throw new Error("install must not run");
      },
      check: async (tools, opts) => {
        checkCalls.push({ tools, channel: opts?.channel });
        return tools.map((tool) => results[tool] ?? { tool, upToDate: true });
      },
    };
    return { rt, checkCalls, installs };
  }

  it("lists versions and installs nothing", async () => {
    const c = capture();
    const { rt, checkCalls, installs } = checkRuntime({
      "yt-dlp": {
        tool: "yt-dlp",
        installed: "2026.08.19",
        latest: "2026.10.20.123",
        upToDate: false,
      },
      ffmpeg: { tool: "ffmpeg", installed: "9.0.2", latest: "9.0.2", upToDate: true },
    });
    const store = memorySettingsStore({ ytDlpChannel: "nightly" });
    expect(await runUpdate(["--check"], c.io, rt, store)).toBe(ExitCode.Ok);
    expect(installs).toEqual([]);
    expect(checkCalls).toEqual([{ tools: ["yt-dlp", "ffmpeg"], channel: "nightly" }]);
    expect(c.out()).toBe(
      "yt-dlp  2026.08.19 -> 2026.10.20.123 (nightly)  update available\nffmpeg  9.0.2 up to date\n",
    );
  });

  it("reports a tool that is not installed", async () => {
    const c = capture();
    const { rt } = checkRuntime({
      "yt-dlp": { tool: "yt-dlp", latest: "2026.10.20.123", upToDate: false },
      ffmpeg: { tool: "ffmpeg", installed: "9.0.2", latest: "9.0.2", upToDate: true },
    });
    await runUpdate(["--check"], c.io, rt, memorySettingsStore());
    expect(c.out()).toBe(
      "yt-dlp  not installed -> 2026.10.20.123 (stable)  update available\nffmpeg  9.0.2 up to date\n",
    );
  });

  it("reports an error for a tool that is not installed", async () => {
    const c = capture();
    const { rt } = checkRuntime({
      "yt-dlp": { tool: "yt-dlp", upToDate: false, error: "offline" },
      ffmpeg: { tool: "ffmpeg", installed: "9.0.2", upToDate: false, error: "offline" },
    });
    await runUpdate(["--check"], c.io, rt, memorySettingsStore());
    expect(c.out()).toBe(
      "yt-dlp  not installed  could not check: offline\nffmpeg  9.0.2  could not check: offline\n",
    );
  });
  it("survives an offline resolver", async () => {
    const c = capture();
    const { rt } = checkRuntime({
      "yt-dlp": { tool: "yt-dlp", installed: "2026.08.19", upToDate: false, error: "offline" },
      ffmpeg: { tool: "ffmpeg", installed: "9.0.2", upToDate: false, error: "offline" },
    });
    expect(await runUpdate(["--check"], c.io, rt, memorySettingsStore())).toBe(ExitCode.Ok);
    expect(c.out()).toBe(
      "yt-dlp  2026.08.19  could not check: offline\nffmpeg  9.0.2  could not check: offline\n",
    );
  });

  it("notes a shadowing env override", async () => {
    const c = capture();
    const { rt } = checkRuntime({}, { version: "2025.01.01", source: "env" });
    expect(await runUpdate(["--check"], c.io, rt, memorySettingsStore())).toBe(ExitCode.Ok);
    expect(c.err()).toContain("Note: MEDIAFORGE_YTDLP_PATH (/usr/bin/yt-dlp)");
    expect(c.err()).toContain("the downloaded copy is not the one in use");
    expect(c.err()).not.toContain("this update has no effect");
  });

  it("checks against --channel without saving it", async () => {
    const c = capture();
    const { rt, checkCalls } = checkRuntime({});
    const store = memorySettingsStore({ ytDlpChannel: "nightly" });
    await runUpdate(["--check", "--channel", "master"], c.io, rt, store);
    expect(checkCalls[0]?.channel).toBe("master");
    expect((await store.load()).ytDlpChannel).toBe("nightly");
  });
});
