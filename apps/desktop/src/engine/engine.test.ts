import { BinaryNotFoundError, type Tool } from "@mediaforge/binary-resolver";
import type { MediaCandidate } from "@mediaforge/shared-types";
import { describe, expect, it, vi } from "vitest";
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
  const calls = {
    mkdir: [] as string[],
    rename: [] as [string, string][],
    rm: [] as string[],
    private: [] as [string, string][],
  };
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
    writePrivate: async (p, text) => void calls.private.push([p, text]),
  };
  return { fs, calls, removed: calls.rm };
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

  it("fails with a mapped exit code and keeps the work folder", async () => {
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
    expect(calls.rm).toHaveLength(0);
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

  it("passes the detected JS runtime flags to yt-dlp", async () => {
    const { fs } = fakeFs();
    let seen: string[] = [];
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      jsRuntimeArgs: async () => ["--js-runtimes", "node:/usr/bin/node"],
      run: runner(async (h, _s, args) => {
        seen = args;
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/T.mp4`);
        return 0;
      }),
    });
    await engine.whenSettled(engine.submit(request()).id);
    expect(seen[seen.indexOf("--js-runtimes") + 1]).toBe("node:/usr/bin/node");
  });

  it("hands the request context to yt-dlp in a private file, not on its command line", async () => {
    const { fs, calls } = fakeFs();
    let seen: string[] = [];
    const updates: string[] = [];
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      onUpdate: (job) => updates.push(JSON.stringify(job)),
      run: runner(async (h, _s, args) => {
        seen = args;
        h.onStderrLine("ERROR: 403 for Cookie: session=abc123def");
        return 1;
      }),
    });
    const submitted = engine.submit(request(), { context: { cookies: "session=abc123def" } });
    const job = await engine.whenSettled(submitted.id);
    expect(job?.status).toBe("failed");
    expect(job?.error).not.toContain("abc123def");
    expect(job?.error).toContain("[redacted]");
    expect(seen.join(" ")).not.toContain("abc123def");
    const at = seen.indexOf("--config-locations");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(seen.indexOf("--"));
    expect(calls.private).toEqual([[seen[at + 1], '--add-header "Cookie:session=abc123def"\n']]);
    expect(calls.rm).toContain(seen[at + 1]);
    const stored = engine.get(submitted.id);
    expect(stored).not.toHaveProperty("context");
    expect(JSON.stringify(stored)).not.toContain("abc123def");
    expect(updates.join("|")).not.toContain("abc123def");
  });

  it("keeps redacting after earlier jobs with a context have finished", async () => {
    const { fs, calls } = fakeFs();
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      maxConcurrent: 1,
      run: runner(async (h, _s, args) => {
        // yt-dlp reads the cookie from the private config file, so the fake does the same.
        const file = args[args.indexOf("--config-locations") + 1];
        const config = calls.private.find(([path]) => path === file)?.[1] ?? "";
        const cookie = /Cookie:([^"]*)/.exec(config)?.[1] ?? "";
        h.onStderrLine(`ERROR: denied ${cookie}`);
        return 1;
      }),
    });
    const a = engine.submit(request(), { context: { cookies: "session=firstsecret" } });
    const b = engine.submit(request(), { context: { cookies: "session=secondsecret" } });
    const [ja, jb] = await Promise.all([engine.whenSettled(a.id), engine.whenSettled(b.id)]);
    expect(ja?.error).toBe("denied [redacted]");
    expect(jb?.error).toBe("denied [redacted]");
  });
});

describe("setMaxConcurrent", () => {
  it("starts more queued jobs when raised, and never stops running ones when lowered", async () => {
    const releases: (() => void)[] = [];
    const engine = new DownloadEngine({
      resolve: found,
      fs: fakeFs().fs,
      maxConcurrent: 1,
      run: () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ exitCode: 1 }));
        }),
    });
    const ids = [1, 2, 3].map(() => engine.submit(request()).id);
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    engine.setMaxConcurrent(3);
    await vi.waitFor(() => expect(releases).toHaveLength(3));

    engine.setMaxConcurrent(1);
    expect(ids.map((id) => engine.get(id)?.status)).toEqual([
      "downloading",
      "downloading",
      "downloading",
    ]);
    for (const release of releases) release();
    await Promise.all(ids.map((id) => engine.whenSettled(id)));
  });

  it("treats values below 1 as 1", async () => {
    const releases: (() => void)[] = [];
    const engine = new DownloadEngine({
      resolve: found,
      fs: fakeFs().fs,
      maxConcurrent: 2,
      run: () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ exitCode: 1 }));
        }),
    });
    engine.setMaxConcurrent(0);
    const ids = [1, 2].map(() => engine.submit(request()).id);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // Give a second job time to start if the limit were 0 or 2; it must stay queued.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(releases).toHaveLength(1);

    releases[0]?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]?.();
    await Promise.all(ids.map((id) => engine.whenSettled(id)));
  });
});

describe("pause and resume", () => {
  /** A runner that waits for `finish(code)` or an abort, and records every call's args. */
  function gatedRunner() {
    const calls: { args: string[]; finish: (exitCode: number) => void }[] = [];
    const run: ProcessRunner = (_cmd, args, handlers, signal) =>
      new Promise((resolve) => {
        const finish = (exitCode: number) => resolve({ exitCode });
        calls.push({ args, finish });
        if (signal.aborted) return finish(1);
        signal.addEventListener("abort", () => finish(1));
        handlers.onStdoutLine("MFPROGRESS 50 100 NA 10 5");
      });
    return { run, calls };
  }

  it("pauses a running job, keeps its work folder, and resumes it under the same id", async () => {
    const { fs, removed } = fakeFs();
    const { run, calls } = gatedRunner();
    const engine = new DownloadEngine({ resolve: found, fs, run });
    const { id } = engine.submit(request());
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(engine.pause(id)).toBe(true);
    await vi.waitFor(() => expect(engine.get(id)?.status).toBe("paused"));
    expect(engine.get(id)?.progress.percent).toBe(50);
    expect(removed).toEqual([]);
    expect(engine.get(id)?.workDir?.endsWith(`.mediaforge-${id}`)).toBe(true);

    expect(engine.resume(id)).toBe(true);
    expect(engine.get(id)?.status).not.toBe("paused");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.args).toContain("--continue");
    expect(calls[1]?.args[calls[1].args.indexOf("--paths") + 1]).toBe(engine.get(id)?.workDir);
    engine.cancel(id);
    await engine.whenSettled(id);
  });

  it("does not let a pause override a cancel that is still stopping the process", async () => {
    const { fs } = fakeFs();
    const { run, calls } = gatedRunner();
    const engine = new DownloadEngine({ resolve: found, fs, run });
    const { id } = engine.submit(request());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(engine.cancel(id)).toBe(true);
    expect(engine.pause(id)).toBe(false);
    expect((await engine.whenSettled(id))?.status).toBe("cancelled");
  });

  it("remove of a running job resolves even when pause is called right after", async () => {
    const { fs } = fakeFs();
    const { run, calls } = gatedRunner();
    const engine = new DownloadEngine({ resolve: found, fs, run });
    const { id } = engine.submit(request());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const removal = engine.remove(id);
    expect(engine.pause(id)).toBe(false);
    await removal;
    expect(engine.get(id)).toBeUndefined();
  });

  it("pauses a queued job without running it", () => {
    const { fs } = fakeFs();
    const { run } = gatedRunner();
    const engine = new DownloadEngine({ resolve: found, fs, run, maxConcurrent: 1 });
    engine.submit(request());
    const second = engine.submit(request()).id;
    expect(engine.pause(second)).toBe(true);
    expect(engine.get(second)?.status).toBe("paused");
    expect(engine.pause(second)).toBe(false);
  });

  it("does not turn a download that already finished into a paused one", async () => {
    const { fs } = fakeFs();
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      run: async (_c, args, h) => {
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip.mp4`);
        return { exitCode: 0 };
      },
    });
    const { id } = engine.submit(request());
    const final = await engine.whenSettled(id);
    expect(final?.status).toBe("completed");
    expect(engine.pause(id)).toBe(false);
  });

  it("keeps a failed job's work folder and retries it with a fresh settle", async () => {
    const { fs, removed } = fakeFs();
    let attempt = 0;
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      run: async (_c, args, h) => {
        attempt += 1;
        if (attempt === 1) {
          h.onStderrLine("ERROR: Unable to download: HTTP Error 503");
          return { exitCode: 1 };
        }
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip.mp4`);
        return { exitCode: 0 };
      },
    });
    const { id } = engine.submit(request());
    expect((await engine.whenSettled(id))?.status).toBe("failed");
    expect(removed).toEqual([]);

    expect(engine.resume(id)).toBe(true);
    expect(engine.get(id)?.error).toBeUndefined();
    expect((await engine.whenSettled(id))?.status).toBe("completed");
  });

  it("cancelling a paused job removes its partial files", async () => {
    const { fs, removed } = fakeFs();
    const { run, calls } = gatedRunner();
    const engine = new DownloadEngine({ resolve: found, fs, run });
    const { id } = engine.submit(request());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    engine.pause(id);
    await vi.waitFor(() => expect(engine.get(id)?.status).toBe("paused"));
    const workDir = engine.get(id)?.workDir;

    expect(engine.cancel(id)).toBe(true);
    expect((await engine.whenSettled(id))?.status).toBe("cancelled");
    await vi.waitFor(() => expect(removed).toContain(workDir));
  });

  it("remove of a paused job cannot be resumed while its folder is going away", async () => {
    const { fs } = fakeFs();
    let release: () => void = () => {};
    const rmGate = new Promise<void>((r) => {
      release = r;
    });
    const { run, calls } = gatedRunner();
    const engine = new DownloadEngine({ resolve: found, fs: { ...fs, rm: () => rmGate }, run });
    const { id } = engine.submit(request());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    engine.pause(id);
    await vi.waitFor(() => expect(engine.get(id)?.status).toBe("paused"));

    const removal = engine.remove(id);
    expect(engine.resume(id)).toBe(false);
    release();
    await removal;
    expect(engine.get(id)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("restores a paused job from an earlier session and resumes it with its format", async () => {
    const { fs } = fakeFs();
    const { run, calls } = gatedRunner();
    const engine = new DownloadEngine({ resolve: found, fs, run });
    const now = Date.now();
    engine.restore(
      {
        id: "old",
        request: request(),
        status: "paused",
        progress: { bytesDownloaded: 5, percent: 40 },
        createdAt: now,
        updatedAt: now,
      },
      { formatSelector: "137+ba/137" },
    );
    expect(engine.get("old")?.status).toBe("paused");
    expect(calls).toHaveLength(0);

    expect(engine.resume("old")).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.args.join(" ")).toContain("137+ba/137");
    expect(calls[0]?.args[calls[0].args.indexOf("--paths") + 1]).toMatch(/\.mediaforge-old$/);
    engine.cancel("old");
    await engine.whenSettled("old");
  });

  it("ignores restore for running statuses and for known ids", () => {
    const engine = new DownloadEngine({ resolve: found, fs: fakeFs().fs });
    const now = Date.now();
    const base = {
      request: request(),
      progress: { bytesDownloaded: 0 },
      createdAt: now,
      updatedAt: now,
    };
    engine.restore({ ...base, id: "q", status: "queued" });
    expect(engine.get("q")).toBeUndefined();
    engine.restore({ ...base, id: "p", status: "paused" });
    engine.restore({ ...base, id: "p", status: "failed" });
    expect(engine.get("p")?.status).toBe("paused");
  });

  it("removes jobs: cancels active ones, deletes dormant partials, forgets them", async () => {
    const { fs, removed } = fakeFs();
    const { run, calls } = gatedRunner();
    const engine = new DownloadEngine({ resolve: found, fs, run });
    const running = engine.submit(request()).id;
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await engine.remove(running);
    expect(engine.get(running)).toBeUndefined();

    const now = Date.now();
    engine.restore({
      id: "gone",
      request: request(),
      status: "failed",
      progress: { bytesDownloaded: 0 },
      createdAt: now,
      updatedAt: now,
    });
    await engine.remove("gone");
    expect(engine.get("gone")).toBeUndefined();
    expect(removed.some((p) => p.endsWith(".mediaforge-gone"))).toBe(true);
    await expect(engine.remove("unknown")).resolves.toBeUndefined();
  });
});

describe("speed caps", () => {
  const rateOf = (args: string[]) =>
    args.includes("--limit-rate") ? args[args.indexOf("--limit-rate") + 1] : undefined;

  it("passes the rate set before the job starts", async () => {
    const { fs } = fakeFs();
    const seen: (string | undefined)[] = [];
    const engine: DownloadEngine = new DownloadEngine({
      resolve: found,
      fs,
      // A cap set while the job reports "downloading" is in place before yt-dlp starts.
      onUpdate: (job) => job.status === "downloading" && engine.setRate(job.id, 1_000_000),
      run: runner(async (h, _s, args) => {
        seen.push(rateOf(args));
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/T.mp4`);
        return 0;
      }),
    });
    await engine.whenSettled(engine.submit(request()).id);
    expect(seen).toEqual(["1000000"]);
  });

  it("restarts a downloading job with its new rate, unseen by clients", async () => {
    const { fs, removed } = fakeFs();
    const statuses: string[] = [];
    const runs: (string | undefined)[] = [];
    let first = true;
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      onUpdate: (job) => statuses.push(job.status),
      run: runner(async (h, signal, args) => {
        runs.push(rateOf(args));
        if (first) {
          first = false;
          return waitForAbort(signal);
        }
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/T.mp4`);
        return 0;
      }),
    });
    const { id } = engine.submit(request());
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(engine.applyRate(id)).toBe(false); // same rate: nothing to do
    engine.setRate(id, 500_000);
    expect(engine.applyRate(id)).toBe(true);
    const job = await engine.whenSettled(id);
    expect(job?.status).toBe("completed");
    expect(job?.id).toBe(id);
    expect(runs).toEqual([undefined, "500000"]);
    // Clients only ever see it downloading, then completed: never paused or queued again.
    const afterStart = statuses.slice(statuses.indexOf("downloading"));
    expect(new Set(afterStart)).toEqual(new Set(["downloading", "completed"]));
    // Only the final cleanup removes the work folder, never the restart.
    expect(removed).toHaveLength(1);
  });

  it("does not restart a queued or processing job", async () => {
    const { fs } = fakeFs();
    let release: () => void = () => {};
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      maxConcurrent: 1,
      run: runner(async (h) => {
        h.onStdoutLine("MFPOST started");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return 1;
      }),
    });
    const a = engine.submit(request()).id;
    const b = engine.submit(request()).id;
    await vi.waitFor(() => expect(engine.get(a)?.status).toBe("processing"));
    engine.setRate(a, 1);
    engine.setRate(b, 1);
    expect(engine.applyRate(a)).toBe(false);
    expect(engine.applyRate(b)).toBe(false);
    // Cancel b while it still waits, so it never runs the held script.
    engine.cancel(b);
    release();
    await engine.whenSettled(a);
  });

  it("lets a pause during a restart win", async () => {
    const { fs } = fakeFs();
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      run: runner(async (_h, signal) => waitForAbort(signal)),
    });
    const { id } = engine.submit(request());
    await vi.waitFor(() => expect(engine.get(id)?.status).toBe("downloading"));
    // A new rate on every try: a rate set before yt-dlp spawns is already the one it runs with.
    let rate = 1000;
    await vi.waitFor(() => {
      engine.setRate(id, rate++);
      expect(engine.applyRate(id)).toBe(true);
    });
    expect(engine.pause(id)).toBe(true);
    await vi.waitFor(() => expect(engine.get(id)?.status).toBe("paused"));
  });

  it("completes a job whose restart landed after yt-dlp exited 0", async () => {
    const { fs } = fakeFs();
    let runs = 0;
    const engine: DownloadEngine = new DownloadEngine({
      resolve: found,
      fs,
      run: runner(async (h, _s, args) => {
        runs += 1;
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/T.mp4`);
        // The cap changes in the moment between the last line and the exit.
        engine.setRate(engine.list()[0]?.id ?? "", 1000);
        engine.applyRate(engine.list()[0]?.id ?? "");
        return 0;
      }),
    });
    const job = await engine.whenSettled(engine.submit(request()).id);
    expect(job?.status).toBe("completed");
    expect(runs).toBe(1);
  });
});

describe("speed cap restarts and progress", () => {
  it("never moves progress backwards while restarting", async () => {
    const { fs } = fakeFs();
    const percents: number[] = [];
    let first = true;
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      onUpdate: (job) => {
        if (job.overallPercent !== undefined) percents.push(job.overallPercent);
      },
      run: runner(async (h, signal, args) => {
        if (first) {
          first = false;
          h.onStdoutLine("MFPROGRESS 500 1000 NA 100 5");
          return waitForAbort(signal);
        }
        h.onStdoutLine("MFPROGRESS 600 1000 NA 100 4");
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/T.mp4`);
        return 0;
      }),
    });
    const { id } = engine.submit(request());
    await vi.waitFor(() => expect(Math.max(0, ...percents)).toBeGreaterThan(0));
    let rate = 1000;
    await vi.waitFor(() => {
      engine.setRate(id, rate++);
      expect(engine.applyRate(id)).toBe(true);
    });
    await engine.whenSettled(id);
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1] as number);
    }
  });
});
