import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  type InstallProgress,
  resolveTarget,
  ToolInstallError,
  UnsupportedTargetError,
  ytDlpSource,
} from "@mediaforge/binary-resolver";
import { describe, expect, it, vi } from "vitest";
import { CliError, ExitCode } from "./exit-codes.ts";
import { makeRuntime } from "./test-runtime.ts";
import {
  acquireTool,
  asciiBar,
  askYesNo,
  createInstallPrinter,
  defaultToolRuntime,
  ensureTools,
  missingToolError,
  toCliError,
  tryResolve,
} from "./tool-runtime.ts";

const ignore = () => {};

describe("tryResolve", () => {
  it("returns undefined for a missing tool and rethrows anything else", async () => {
    const { rt } = makeRuntime();
    expect(await tryResolve("yt-dlp", rt.resolve)).toBeUndefined();
    await expect(
      tryResolve("yt-dlp", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("toCliError", () => {
  it.each([
    ["offline", ExitCode.Network],
    ["not-found", ExitCode.Network],
    ["rate-limit", ExitCode.Network],
    ["http", ExitCode.Network],
    ["checksum", ExitCode.Network],
    ["disk-full", ExitCode.FileSystem],
    ["permission", ExitCode.FileSystem],
    ["io", ExitCode.FileSystem],
    ["extract", ExitCode.FileSystem],
    ["unsupported", ExitCode.Failure],
    ["no-source", ExitCode.Failure],
  ] as const)("maps %s to exit code %i and keeps the hint", (kind, code) => {
    const mapped = toCliError(new ToolInstallError(kind, "It broke.", "Do this."));
    expect(mapped).toBeInstanceOf(CliError);
    expect((mapped as CliError).exitCode).toBe(code);
    expect((mapped as CliError).message).toBe("It broke.\nDo this.");
  });

  it("maps an unsupported platform to a plain failure and passes other errors through", () => {
    const mapped = toCliError(new UnsupportedTargetError("freebsd", "x64")) as CliError;
    expect(mapped.exitCode).toBe(ExitCode.Failure);
    const other = new Error("x");
    expect(toCliError(other)).toBe(other);
  });
});

describe("acquireTool", () => {
  const options = { onProgress: ignore };

  it("does nothing when the tool is already available", async () => {
    const { rt, log } = makeRuntime({ present: ["yt-dlp"] });
    expect(await acquireTool("yt-dlp", rt, options)).toMatchObject({ status: "present" });
    expect(log.installed).toEqual([]);
  });

  it("downloads a missing tool", async () => {
    const { rt, log } = makeRuntime();
    expect(await acquireTool("yt-dlp", rt, options)).toMatchObject({
      status: "installed",
      version: "2026.10.08",
    });
    expect(log.installed).toEqual(["yt-dlp"]);
  });

  it("turns a failed download into a CliError with the right exit code", async () => {
    const { rt } = makeRuntime({
      installError: new ToolInstallError("checksum", "Checksum mismatch.", "Try again."),
    });
    const error = await acquireTool("yt-dlp", rt, options).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(ExitCode.Network);
    expect(error.message).toContain("Try again.");
  });
});

describe("ensureTools", () => {
  it("is silent when everything is there", async () => {
    const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg"] });
    await ensureTools(["yt-dlp", "ffmpeg"], rt, ignore);
    expect(log.asked).toEqual([]);
  });

  it("exits 3 with the setup hint, without asking, when there is no terminal", async () => {
    const { rt, log } = makeRuntime({ interactive: false });
    const error = await ensureTools(["yt-dlp"], rt, ignore).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(ExitCode.MissingTool);
    expect(error.message).toBe("yt-dlp is missing.\nrun: mediaforge setup");
    expect(log.asked).toEqual([]);
    expect(log.installed).toEqual([]);
  });

  it("asks in a terminal and downloads on yes", async () => {
    const { rt, log } = makeRuntime({ answers: [true] });
    await ensureTools(["yt-dlp"], rt, ignore);
    expect(log.asked).toEqual(["yt-dlp is missing. Download it now? (Y/N)"]);
    expect(log.installed).toEqual(["yt-dlp"]);
  });

  it("stops with exit 3 when the answer is no, and downloads nothing", async () => {
    const { rt, log } = makeRuntime({ answers: [false] });
    const error = await ensureTools(["yt-dlp", "ffmpeg"], rt, ignore).catch((e) => e);
    expect(error.exitCode).toBe(ExitCode.MissingTool);
    expect(log.installed).toEqual([]);
  });

  it("offers deno, and downloads it on yes", async () => {
    const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg"], answers: [true] });
    await ensureTools(["yt-dlp", "ffmpeg", "deno"], rt, ignore);
    expect(log.asked).toEqual(["deno is missing. YouTube needs it. Download it now? (Y/N)"]);
    expect(log.installed).toEqual(["deno"]);
  });

  it("carries on when deno is declined, or when there is no terminal", async () => {
    const declined = makeRuntime({ present: ["yt-dlp", "ffmpeg"], answers: [false] });
    await ensureTools(["yt-dlp", "ffmpeg", "deno"], declined.rt, ignore);
    expect(declined.log.installed).toEqual([]);

    const piped = makeRuntime({ present: ["yt-dlp", "ffmpeg"], interactive: false });
    await ensureTools(["yt-dlp", "ffmpeg", "deno"], piped.rt, ignore);
    expect(piped.log.asked).toEqual([]);
  });

  it("builds the same error as missingToolError", () => {
    expect(missingToolError("ffmpeg").message).toBe("ffmpeg is missing.\nrun: mediaforge setup");
  });
});

describe("askYesNo", () => {
  /** Types the lines one at a time, like a person, then closes the input. */
  function prompt(lines: string[]) {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (chunk) => {
      shown += chunk.toString();
    });
    const answer = askYesNo("Download now? (Y/N)", input, output);
    void (async () => {
      for (const line of lines) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        input.write(`${line}\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      input.end();
    })();
    return { answer, shown: () => shown };
  }

  it("accepts y and yes, and n and no, in any case", async () => {
    expect(await prompt(["y"]).answer).toBe(true);
    expect(await prompt(["YES"]).answer).toBe(true);
    expect(await prompt(["n"]).answer).toBe(false);
    expect(await prompt(["No"]).answer).toBe(false);
  });

  it("asks again after an unclear answer", async () => {
    const p = prompt(["maybe", "yes"]);
    expect(await p.answer).toBe(true);
    expect(p.shown().match(/Download now/g)).toHaveLength(2);
  });

  it("gives up with no after three unclear answers", async () => {
    expect(await prompt(["a", "b", "c"]).answer).toBe(false);
  });

  it("answers no instead of hanging when stdin closes", async () => {
    expect(await prompt([]).answer).toBe(false);
  });
});

describe("createInstallPrinter", () => {
  const progress = (phase: InstallProgress["phase"], extra = {}): InstallProgress => ({
    tool: "yt-dlp",
    phase,
    ...extra,
  });

  it("prints one line per phase without a terminal", () => {
    const out: string[] = [];
    const print = createInstallPrinter((t) => out.push(t), false);
    print(progress("resolving"));
    print(progress("downloading", { received: 0 }));
    print(progress("downloading", { received: 1024, total: 2048 }));
    print(progress("verifying"));
    expect(out.join("")).toBe(
      [
        "yt-dlp: looking up the latest version",
        "yt-dlp: downloading",
        "yt-dlp: verifying checksum",
        "",
      ].join("\n"),
    );
  });

  it("updates one line in place on a terminal, then moves on", () => {
    const out: string[] = [];
    const print = createInstallPrinter((t) => out.push(t), true, false);
    print(progress("downloading", { received: 0 }));
    print(progress("downloading", { received: 1048576, total: 2097152 }));
    print(progress("verifying"));
    const text = out.join("");
    expect(text).toContain("\r  yt-dlp  [############------------]  50%  1.0 MB of 2.1 MB");
    expect(text.endsWith("\n  yt-dlp  verifying checksum\n")).toBe(true);
    expect(text).not.toContain("\x1b");
  });

  it("adds colour on a terminal unless it is turned off", () => {
    const out: string[] = [];
    const print = createInstallPrinter((t) => out.push(t), true, true);
    print(progress("downloading", { received: 1024, total: 2048 }));
    print(progress("verifying"));
    expect(out.join("")).toContain("\x1b[36m[############------------]\x1b[0m");
    expect(out.join("")).toContain("\x1b[2mverifying checksum\x1b[0m");
  });

  it("draws the bar from 0 to 100 percent", () => {
    expect(asciiBar(0, 4)).toBe("[----]");
    expect(asciiBar(50, 4)).toBe("[##--]");
    expect(asciiBar(150, 4)).toBe("[####]");
  });
});

describe("defaultToolRuntime channels", () => {
  /** A runtime whose network is a recorder that always fails, so only the first lookup matters. */
  function wired(saved: string | "unreadable" = "nightly") {
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      urls.push(url);
      throw new Error("offline");
    });
    const rt = defaultToolRuntime(
      { MEDIAFORGE_CACHE_DIR: "/nonexistent-mediaforge-test" },
      {
        deps: { fetch: fetch as never },
        loadChannel: async () => {
          if (saved === "unreadable") throw new Error("broken settings");
          return saved as never;
        },
      },
    );
    return { rt, urls };
  }
  const first = (urls: string[]) => urls[0] ?? "";

  it("install passes the saved channel to the yt-dlp resolver", async () => {
    const { rt, urls } = wired("master");
    await rt.install("yt-dlp", () => {}).catch(() => {});
    expect(first(urls)).toContain("yt-dlp-master-builds");
  });

  it("install falls back to stable when the setting cannot be read", async () => {
    const { rt, urls } = wired("unreadable");
    await rt.install("yt-dlp", () => {}).catch(() => {});
    expect(first(urls)).toContain("github.com/yt-dlp/yt-dlp/releases/download/");
  });

  it("an explicit channel beats the saved one", async () => {
    const { rt, urls } = wired("nightly");
    await rt.install("yt-dlp", () => {}, { channel: "master" }).catch(() => {});
    expect(first(urls)).toContain("yt-dlp-master-builds");
  });

  it("install with stable uses the lock", async () => {
    const { rt, urls } = wired("nightly");
    await rt.install("yt-dlp", () => {}, { channel: "stable" }).catch(() => {});
    expect(first(urls)).toContain("github.com/yt-dlp/yt-dlp/releases/download/");
  });

  it("deno and ffmpeg install from the lock unless live is set", async () => {
    const lockOnly = wired("master");
    await lockOnly.rt.install("deno", () => {}).catch(() => {});
    await lockOnly.rt.install("ffmpeg", () => {}).catch(() => {});
    expect(lockOnly.urls.some((u) => u.includes("api.github.com"))).toBe(false);

    const live = wired("master");
    await live.rt.install("ffmpeg", () => {}, { live: true }).catch(() => {});
    expect(first(live.urls)).toContain("api.github.com");
  });

  it("check resolves live for both tools and never downloads", async () => {
    const { rt, urls } = wired("nightly");
    const checks = await rt.check(["yt-dlp", "ffmpeg"]);
    expect(checks.map((c) => [c.tool, c.upToDate, Boolean(c.error)])).toEqual([
      ["yt-dlp", false, true],
      ["ffmpeg", false, true],
    ]);
    expect(urls.some((u) => u.includes("yt-dlp-nightly-builds"))).toBe(true);
    expect(urls.some((u) => u.includes("BtbN"))).toBe(true);
    expect(urls.every((u) => !/\.(exe|zip|xz)$|yt-dlp_/.test(u))).toBe(true);
  });

  it("check on stable looks nothing up for yt-dlp", async () => {
    const { rt, urls } = wired("nightly");
    await rt.check(["yt-dlp"], { channel: "stable" });
    expect(urls).toEqual([]);
  });
});

describe("test runtime fake", () => {
  it("records install options and answers check", async () => {
    const { rt, log } = makeRuntime();
    await rt.install("yt-dlp", ignore, { channel: "master", live: true });
    expect(log.installOptions).toEqual([{ channel: "master", live: true }]);
    expect(await rt.check(["yt-dlp"])).toEqual([
      { tool: "yt-dlp", latest: "2026.10.08", upToDate: true },
    ]);
  });
});

describe("defaultToolRuntime outdated", () => {
  const pinned = ytDlpSource(resolveTarget()).version;
  function withInstalled(version: string, initial: string) {
    const dir = mkdtempSync(join(tmpdir(), "mf-outdated-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        "yt-dlp": { version, url: "https://x.test/y", sha256: "a", installedAt: "t" },
      }),
    );
    let channel = initial;
    const rt = defaultToolRuntime(
      { MEDIAFORGE_CACHE_DIR: dir },
      { loadChannel: async () => channel as never },
    );
    return { rt, set: (c: string) => (channel = c) };
  }

  it("is true on a live channel when the cache is older than the pin", async () => {
    const { rt, set } = withInstalled("2000.01.01", "nightly");
    expect(await rt.outdated?.("yt-dlp")).toBe(true);
    set("master");
    expect(await rt.outdated?.("yt-dlp")).toBe(true);
  });

  it("is false on a live channel when the cache is newer than or equal to the pin", async () => {
    const { rt, set } = withInstalled("2099.01.01.99", "nightly");
    expect(await rt.outdated?.("yt-dlp")).toBe(false);
    set("master");
    expect(await rt.outdated?.("yt-dlp")).toBe(false);
    expect(await withInstalled(pinned, "nightly").rt.outdated?.("yt-dlp")).toBe(false);
  });

  it("is true on stable when the version differs, and false when it matches", async () => {
    expect(await withInstalled("2099.01.01.99", "stable").rt.outdated?.("yt-dlp")).toBe(true);
    expect(await withInstalled(pinned, "stable").rt.outdated?.("yt-dlp")).toBe(false);
  });

  it("becomes true again after switching the saved channel back to stable", async () => {
    const { rt, set } = withInstalled("2099.01.01.99", "nightly");
    expect(await rt.outdated?.("yt-dlp")).toBe(false);
    set("stable");
    expect(await rt.outdated?.("yt-dlp")).toBe(true);
  });
});

describe("acquireTool channel", () => {
  it("installs on the pinned stable build", async () => {
    const { rt, log } = makeRuntime();
    await acquireTool("yt-dlp", rt, { onProgress: ignore });
    expect(log.installOptions).toEqual([{ channel: "stable" }]);
  });
});
