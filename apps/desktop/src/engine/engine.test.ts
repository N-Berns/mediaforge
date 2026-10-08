import { BinaryNotFoundError, type Tool } from "@mediaforge/binary-resolver";
import type { MediaCandidate } from "@mediaforge/shared-types";
import { describe, expect, it } from "vitest";
import { ExitCode } from "../exit-codes.ts";
import { DownloadEngine, type EngineFs, type EngineJob } from "./engine.ts";
import type { LineHandlers, ProcessRunner } from "./process.ts";

const candidate: MediaCandidate = {
  id: "c",
  pageUrl: "https://example.com",
  url: "https://example.com/v",
  kind: "video",
  streamType: "progressive",
  source: "dom",
  variants: [],
  detectedAt: 0,
};

const found = async (tool: Tool) => ({ tool, path: `/bin/${tool}`, source: "path" as const });

function fakeFs(existing: string[] = []) {
  const files = new Set(existing);
  const calls = { mkdir: [] as string[], rename: [] as [string, string][], rm: [] as string[] };
  const fs: EngineFs = {
    mkdir: async (p) => void calls.mkdir.push(p),
    rename: async (a, b) => {
      calls.rename.push([a, b]);
      files.add(b);
    },
    rm: async (p) => void calls.rm.push(p),
    exists: async (p) => files.has(p),
    list: async () => [],
    readText: async () => "",
  };
  return { fs, calls };
}

type Script = (h: LineHandlers, signal: AbortSignal, args: string[]) => Promise<number | null>;

const runner =
  (script: Script): ProcessRunner =>
  async (_cmd, args, handlers, signal) => ({ exitCode: await script(handlers, signal, args) });

const request = (extra = {}) => ({ candidate, profileId: "best", outputDir: "/out", ...extra });

const waitForAbort = (signal: AbortSignal) =>
  new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null)));

describe("DownloadEngine", () => {
  it("downloads, reports progress and processing, then moves the file into place", async () => {
    const { fs, calls } = fakeFs();
    const seen: string[] = [];
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      onUpdate: (job) => seen.push(job.status),
      run: runner(async (h, _s, args) => {
        const workDir = args[args.indexOf("--paths") + 1];
        h.onStdoutLine("MFPROGRESS 50 100 NA 10 5");
        h.onStdoutLine("MFPOST started");
        h.onStdoutLine(`MFFILE ${workDir}/Title.mp4`);
        return 0;
      }),
    });

    const job = await engine.whenSettled(engine.submit(request()).id);
    expect(job?.status).toBe("completed");
    expect(job?.outputPath).toMatch(/Title\.mp4$/);
    expect(job?.outputPath).not.toContain(".mediaforge-");
    expect(seen).toEqual([
      "queued",
      "downloading",
      "downloading",
      "downloading",
      "processing",
      "completed",
    ]);
    expect(calls.rename).toHaveLength(1);
    expect(calls.rm[0]).toMatch(/\.mediaforge-/);
  });

  it("finds the finished file when the printed name is not on disk", async () => {
    const { fs, calls } = fakeFs();
    const engine = new DownloadEngine({
      resolve: found,
      fs: { ...fs, list: async () => ["Clip ｜ Cover.f137.mp4", "Clip ｜ Cover.mp4", "x.part"] },
      run: runner(async (h, _s, args) => {
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip | Cover.mp4`);
        return 0;
      }),
    });
    const job = await engine.whenSettled(engine.submit(request()).id);
    expect(job?.status).toBe("completed");
    expect(calls.rename[0]?.[0]).toMatch(/Clip ｜ Cover\.mp4$/);
    expect(job?.outputPath).toMatch(/Clip ｜ Cover\.mp4$/);
  });

  it("numbers the file when the name is taken", async () => {
    const { fs } = fakeFs();
    const engine = new DownloadEngine({
      resolve: found,
      fs: { ...fs, exists: async (p) => /Title\.mp4$/.test(p) },
      run: runner(async (h, _s, args) => {
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Title.mp4`);
        return 0;
      }),
    });
    const job = await engine.whenSettled(engine.submit(request()).id);
    expect(job?.outputPath).toMatch(/Title \(1\)\.mp4$/);
  });

  it("fails with a mapped exit code and cleans up", async () => {
    const { fs, calls } = fakeFs();
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      run: runner(async (h) => {
        h.onStderrLine("ERROR: Unsupported URL: https://example.com/v");
        return 1;
      }),
    });
    const job = await engine.whenSettled(engine.submit(request()).id);
    expect(job).toMatchObject({ status: "failed", errorKind: ExitCode.UnsupportedSite });
    expect(job?.error).toBe("Unsupported URL: https://example.com/v");
    expect(calls.rm).toHaveLength(1);
    expect(calls.rename).toHaveLength(0);
  });

  it("fails with MissingTool when a binary is not found, without starting a process", async () => {
    let started = false;
    const engine = new DownloadEngine({
      fs: fakeFs().fs,
      resolve: async (tool) => {
        throw new BinaryNotFoundError(tool, ["PATH"]);
      },
      run: runner(async () => {
        started = true;
        return 0;
      }),
    });
    const job = await engine.whenSettled(engine.submit(request()).id);
    expect(job).toMatchObject({ status: "failed", errorKind: ExitCode.MissingTool });
    expect(started).toBe(false);
  });

  it("rejects an unknown profile up front", () => {
    const engine = new DownloadEngine({ resolve: found, fs: fakeFs().fs });
    expect(() => engine.submit(request({ profileId: "nope" }))).toThrow(/Unknown profile/);
  });

  it("cancels a running job and removes its working folder", async () => {
    const { fs, calls } = fakeFs();
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      run: runner(async (_h, signal) => {
        started();
        return waitForAbort(signal);
      }),
    });
    const { id } = engine.submit(request());
    await running;
    expect(engine.cancel(id)).toBe(true);
    const job = await engine.whenSettled(id);
    expect(job?.status).toBe("cancelled");
    expect(calls.rm).toHaveLength(1);
    expect(engine.cancel(id)).toBe(false);
  });

  it("runs at most maxConcurrent jobs and cancels queued ones without running them", async () => {
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const engine = new DownloadEngine({
      resolve: found,
      fs: fakeFs().fs,
      maxConcurrent: 2,
      run: runner(async (h, _s, args) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => releases.push(r));
        active--;
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/a.mp4`);
        return 0;
      }),
    });

    const ids = [1, 2, 3, 4].map(() => engine.submit(request()).id);
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.list().map((j: EngineJob) => j.status)).toEqual([
      "downloading",
      "downloading",
      "queued",
      "queued",
    ]);

    expect(engine.cancel(ids[3] as string)).toBe(true);
    releases.splice(0).forEach((r) => {
      r();
    });
    await new Promise((r) => setTimeout(r, 0));
    releases.splice(0).forEach((r) => {
      r();
    });

    const results = await Promise.all(ids.map((id) => engine.whenSettled(id)));
    expect(results.map((j) => j?.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "cancelled",
    ]);
    expect(peak).toBe(2);
  });
});
