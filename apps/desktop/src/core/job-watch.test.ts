import { resolve } from "node:path";
import type { Tool } from "@mediaforge/binary-resolver";
import { PROTOCOL_VERSION } from "@mediaforge/shared-protocol";
import { describe, expect, it, vi } from "vitest";
import { candidateFor } from "../download.ts";
import { DownloadEngine, type EngineFs } from "../engine/index.ts";
import type { ProcessRunner } from "../engine/process.ts";
import { type CoreClient, CoreLostError, CoreRequestError, openCoreClient } from "./client.ts";
import { HistoryStore, memoryHistoryFs } from "./history.ts";
import { inProcessCore } from "./in-process.ts";
import type { Connection } from "./ipc.ts";
import { startJob } from "./job-watch.ts";

const found = async (tool: Tool) => ({ tool, path: `/bin/${tool}`, source: "path" as const });
const fs: EngineFs = {
  mkdir: async () => {},
  rename: async () => {},
  rm: async () => {},
  exists: async () => false,
  list: async () => [],
  readText: async () => "",
};

const core = (run: ProcessRunner) =>
  inProcessCore({
    createEngine: (onUpdate) => new DownloadEngine({ resolve: found, fs, onUpdate, run }),
  });

const payload = () => ({
  candidate: candidateFor("https://example.com/v", "video"),
  profileId: "best",
  origin: "cli" as const,
  outputDir: resolve("/dl"),
});

describe("startJob", () => {
  it("follows a job to completion", async () => {
    const { connect } = core(async (_c, args, h) => {
      h.onStdoutLine("MFPROGRESS 50 100 NA 10 5");
      h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip.mp4`);
      return { exitCode: 0 };
    });
    const client = await connect();
    const statuses: string[] = [];
    const watched = await startJob(client, payload(), (job) => statuses.push(job.status));
    const final = await watched.settled;
    expect(final.status).toBe("completed");
    expect(final.outputPath).toMatch(/Clip\.mp4$/);
    expect(statuses).toContain("downloading");
  });

  it("reports the exit code of a failure", async () => {
    const { connect } = core(async (_c, _a, h) => {
      h.onStderrLine("ERROR: Unsupported URL: https://example.com/v");
      return { exitCode: 1 };
    });
    const final = await (await startJob(await connect(), payload(), () => {})).settled;
    expect(final.status).toBe("failed");
    expect(final.errorKind).toBeTypeOf("number");
  });

  it("cancels", async () => {
    const { connect } = core(
      (_c, _a, _h, signal) =>
        new Promise((resolve) => {
          // The cancel can land before the engine starts the runner, as with a real process.
          if (signal.aborted) resolve({ exitCode: 1 });
          else signal.addEventListener("abort", () => resolve({ exitCode: 1 }));
        }),
    );
    const watched = await startJob(await connect(), payload(), () => {});
    await watched.cancel();
    expect((await watched.settled).status).toBe("cancelled");
  });

  it("ends the watch when another client pauses the job", async () => {
    const { connect } = core(
      (_c, _a, _h, signal) =>
        new Promise((resolve) => {
          if (signal.aborted) resolve({ exitCode: 1 });
          else signal.addEventListener("abort", () => resolve({ exitCode: 1 }));
        }),
    );
    const watched = await startJob(await connect(), payload(), () => {});
    const other = await connect();
    await vi.waitFor(async () => {
      const reply = await other.request("download.pause", { jobIds: [watched.id] });
      expect(reply).toMatchObject({ payload: { failed: [] } });
    });
    expect((await watched.settled).status).toBe("paused");
  });

  it("rejects settled with CoreLostError when the core goes away", async () => {
    const { connect } = core(() => new Promise(() => {}));
    const client = await connect();
    const watched = await startJob(client, payload(), () => {});
    client.close();
    await expect(watched.settled).rejects.toMatchObject({ name: "CoreLostError" });
  });

  it("leaves no listener behind when the start is refused", async () => {
    const { connect } = core(() => new Promise(() => {}));
    const real = await connect();
    let pushListeners = 0;
    let closeListeners = 0;
    const client: CoreClient = {
      ack: real.ack,
      request: () => Promise.reject(new CoreRequestError("forbidden", "no")),
      notify: () => {},
      onPush: (l) => {
        pushListeners += 1;
        const off = real.onPush(l);
        return () => {
          pushListeners -= 1;
          off();
        };
      },
      onClose: (l) => {
        closeListeners += 1;
        const off = real.onClose(l);
        return () => {
          closeListeners -= 1;
          off();
        };
      },
      close: () => real.close(),
    };
    await expect(startJob(client, payload(), () => {})).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(pushListeners).toBe(0);
    expect(closeListeners).toBe(0);
  });

  it("rejects settled with CoreLostError when a frame of another protocol version arrives", async () => {
    let push: (m: unknown) => void = () => {};
    let drop: () => void = () => {};
    const conn: Connection = {
      send: (m) => {
        const { id, type } = m as { id: string; type: string };
        const reply =
          type === "hello"
            ? {
                v: PROTOCOL_VERSION,
                id,
                type: "hello.ack",
                payload: {
                  hostVersion: "1",
                  ytDlp: { available: true },
                  ffmpeg: { available: true },
                  setup: "ready",
                  keepRunning: false,
                },
              }
            : {
                v: PROTOCOL_VERSION,
                id,
                type: "download.progress",
                payload: {
                  jobId: "j1",
                  status: "queued",
                  progress: { bytesDownloaded: 0 },
                },
              };
        queueMicrotask(() => push(reply));
      },
      onMessage: (h) => {
        push = h;
      },
      onClose: (h) => {
        drop = h;
      },
      close: () => drop(),
    };
    const client = await openCoreClient(conn, { client: "cli" });
    const watched = await startJob(client, payload(), () => {});
    push({ v: PROTOCOL_VERSION - 1, id: "x", type: "download.progress", payload: {} });
    // The watcher reports every hang-up as CoreLostError; the client itself says why.
    await expect(watched.settled).rejects.toBeInstanceOf(CoreLostError);
  });

  it("resumes a job paused in an earlier core session with its id, folder and format", async () => {
    const historyFs = memoryHistoryFs();
    const history = () =>
      HistoryStore.open({ path: "/h/history.json", fs: historyFs, debounceMs: 0 });
    const seen: string[][] = [];
    const hang: ProcessRunner = (_c, args, _h, signal) =>
      new Promise((resolve) => {
        seen.push(args);
        signal.addEventListener("abort", () => resolve({ exitCode: 1 }));
      });

    // Session 1: start with an exact format, then the core goes away mid-download.
    const first = inProcessCore({
      history: await history(),
      createEngine: (onUpdate) => new DownloadEngine({ resolve: found, fs, onUpdate, run: hang }),
    });
    const firstClient = await first.connect();
    const watched = await startJob(
      firstClient,
      { ...payload(), formatSelector: "137+ba/137" },
      () => {},
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await (await first.service).shutdown(); // the job is still "downloading" in the file

    // Session 2: the row comes back paused and resumes under the same id.
    const second = inProcessCore({
      history: await history(),
      createEngine: (onUpdate) => new DownloadEngine({ resolve: found, fs, onUpdate, run: hang }),
    });
    const client = await second.connect();
    const reply = await client.request("download.resume", { jobIds: [watched.id] });
    expect(reply).toMatchObject({ type: "jobs.result", payload: { failed: [] } });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]?.join(" ")).toContain("137+ba/137");
    expect(seen[1]?.[seen[1].indexOf("--paths") + 1]).toBe(
      seen[0]?.[seen[0].indexOf("--paths") + 1],
    );
    // Both sessions' hanging runs end here, so none leaks past the test. Session 1 cannot be
    // stopped earlier: that would rewrite the row session 2 has to find paused.
    client.notify("download.cancel", { jobId: watched.id });
    firstClient.notify("download.cancel", { jobId: watched.id });
  });
});
