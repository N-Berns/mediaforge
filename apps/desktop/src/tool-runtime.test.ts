import { PassThrough } from "node:stream";
import {
  type InstallProgress,
  ToolInstallError,
  UnsupportedTargetError,
} from "@mediaforge/binary-resolver";
import { describe, expect, it } from "vitest";
import { CliError, ExitCode } from "./exit-codes.ts";
import { makeRuntime } from "./test-runtime.ts";
import {
  acquireTool,
  askYesNo,
  createInstallPrinter,
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
  const options = { yes: false, onProgress: ignore };

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

  it("asks about Homebrew for ffmpeg on macOS and runs it only on yes", async () => {
    const yes = makeRuntime({ platform: "darwin", brew: true, answers: [true] });
    expect(await acquireTool("ffmpeg", yes.rt, options)).toMatchObject({ status: "homebrew" });
    expect(yes.log.brewRuns).toBe(1);
    expect(yes.log.installed).toEqual([]);

    const no = makeRuntime({ platform: "darwin", brew: true, answers: [false] });
    expect(await acquireTool("ffmpeg", no.rt, options)).toMatchObject({ status: "installed" });
    expect(no.log.brewRuns).toBe(0);
  });

  it("never asks or runs Homebrew with --yes or without a terminal", async () => {
    const yes = makeRuntime({ platform: "darwin", brew: true, answers: [true] });
    await acquireTool("ffmpeg", yes.rt, { yes: true, onProgress: ignore });
    expect(yes.log.asked).toEqual([]);
    expect(yes.log.brewRuns).toBe(0);

    const quiet = makeRuntime({ platform: "darwin", brew: true, interactive: false });
    await acquireTool("ffmpeg", quiet.rt, options);
    expect(quiet.log.asked).toEqual([]);
    expect(quiet.log.brewRuns).toBe(0);
  });

  it("does not offer Homebrew for yt-dlp, on Linux, or when brew is absent", async () => {
    for (const [tool, platform, brew] of [
      ["yt-dlp", "darwin", true],
      ["ffmpeg", "linux", true],
      ["ffmpeg", "darwin", false],
    ] as const) {
      const t = makeRuntime({ platform, brew });
      await acquireTool(tool, t.rt, options);
      expect(t.log.asked).toEqual([]);
    }
  });

  it("explains it when Homebrew finishes but ffmpeg is still not found", async () => {
    const { rt } = makeRuntime({
      platform: "darwin",
      brew: true,
      answers: [true],
      brewLeavesNothing: true,
    });
    const error = await acquireTool("ffmpeg", rt, options).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(ExitCode.MissingTool);
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
    const print = createInstallPrinter((t) => out.push(t), true);
    print(progress("downloading", { received: 0 }));
    print(progress("downloading", { received: 1048576, total: 2097152 }));
    print(progress("verifying"));
    const text = out.join("");
    expect(text).toContain("\ryt-dlp: downloading 1.0 MB of 2.0 MB");
    expect(text.endsWith("\nyt-dlp: verifying checksum\n")).toBe(true);
  });
});
