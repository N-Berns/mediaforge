import { PROTOCOL_VERSION } from "@mediaforge/shared-protocol";
import type { DownloadJob } from "@mediaforge/shared-types";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { CoreLostError } from "../../core/client.ts";
import { inProcessCore } from "../../core/in-process.ts";
import { DownloadEngine, type EngineFs } from "../../engine/index.ts";
import type { ProcessRunner } from "../../engine/process.ts";
import { type CoreSession, foldPush, type Jobs, useCoreSession } from "./session.ts";

const URL = "https://example.com/watch?v=abc";
const fs: EngineFs = {
  mkdir: async () => {},
  rename: async () => {},
  rm: async () => {},
  exists: async () => false,
  list: async () => [],
  readText: async () => "",
};

const job = (id: string, patch: Partial<DownloadJob> = {}): DownloadJob => ({
  id,
  request: {
    candidate: {
      id: URL,
      pageUrl: URL,
      url: URL,
      kind: "video",
      streamType: "progressive",
      source: "dom",
      variants: [],
      detectedAt: 0,
    },
    profileId: "best",
  },
  status: "queued",
  progress: { bytesDownloaded: 0 },
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

const frame = (type: string, payload: unknown) =>
  ({ v: PROTOCOL_VERSION, id: "p", type, payload }) as never;

describe("foldPush", () => {
  it("foldPush replaces the map on a snapshot", () => {
    const before: Jobs = new Map([["old", job("old")]]);
    const after = foldPush(before, frame("jobs.snapshot", { jobs: [job("a"), job("b")] }));
    expect([...after.keys()]).toEqual(["a", "b"]);
  });

  it("foldPush applies progress to a known job and ignores unknown ids", () => {
    const before: Jobs = new Map([["a", job("a")]]);
    const progress = {
      status: "downloading",
      progress: { bytesDownloaded: 5, percent: 50 },
    };
    const after = foldPush(before, frame("download.progress", { jobId: "a", ...progress }));
    expect(after.get("a")?.status).toBe("downloading");
    const same = foldPush(after, frame("download.progress", { jobId: "zzz", ...progress }));
    expect(same).toBe(after);
  });

  it("foldPush returns the same map for unrelated frames", () => {
    const before: Jobs = new Map([["a", job("a")]]);
    expect(foldPush(before, frame("app.attention", {}))).toBe(before);
  });
});

/** A download that reports progress, then waits until released. */
function slowRunner() {
  let release: () => void = () => {};
  const runner: ProcessRunner = async (_c, args, h) => {
    h.onStdoutLine("MFPROGRESS 50 100 NA 10 5");
    await new Promise<void>((r) => {
      release = r;
    });
    h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip.mp4`);
    return { exitCode: 0 };
  };
  return { runner, release: () => release() };
}

function makeCore(runner: ProcessRunner) {
  return inProcessCore({
    createEngine: (onUpdate) =>
      new DownloadEngine({
        resolve: async (tool) => ({ tool, path: `/bin/${tool}`, source: "path" as const }),
        fs,
        onUpdate,
        run: runner,
      }),
  });
}

async function startDownload(core: ReturnType<typeof makeCore>): Promise<string> {
  const client = await core.connect();
  const reply = await client.request("download.start", {
    candidate: job("x").request.candidate,
    profileId: "mp4-720p",
    outputDir: "/dl",
  });
  client.close();
  return (reply.payload as { jobId: string }).jobId;
}

function harness(
  connect: () => Promise<import("../../core/client.ts").CoreClient>,
  options: Parameters<typeof useCoreSession>[1] = {},
) {
  const seen: { current?: CoreSession; renders: number } = { renders: 0 };
  function Probe() {
    const session = useCoreSession(connect, { retryMs: 20, renderMs: 10, ...options });
    seen.current = session;
    seen.renders += 1;
    return <Text>{`${session.state} ${session.jobs.size}`}</Text>;
  }
  const app = render(<Probe />);
  return { app, seen };
}

describe("useCoreSession", () => {
  it("loads jobs, settings and the notice on connect", async () => {
    const slow = slowRunner();
    const core = makeCore(slow.runner);
    const { app, seen } = harness(core.connectAs("manager"));
    await vi.waitFor(() => expect(seen.current?.state).toBe("ready"));
    expect(seen.current?.settings?.limitPreset).toBe("high");
    const id = await startDownload(core);
    await vi.waitFor(() => expect(seen.current?.jobs.get(id)?.status).toBe("downloading"));
    slow.release();
    await vi.waitFor(() => expect(seen.current?.jobs.get(id)?.status).toBe("completed"));
    app.unmount();
  });

  it("renders at most every renderMs", async () => {
    const slow = slowRunner();
    const core = makeCore(slow.runner);
    const { app, seen } = harness(core.connectAs("manager"), { renderMs: 300 });
    await vi.waitFor(() => expect(seen.current?.state).toBe("ready"));
    await new Promise((r) => setTimeout(r, 400));
    const before = seen.renders;
    // Each start pushes several frames (queued, downloading, progress): about six in all.
    await Promise.all([startDownload(core), startDownload(core)]);
    await new Promise((r) => setTimeout(r, 700));
    expect(seen.current?.jobs.size).toBe(2);
    expect(seen.renders - before).toBeLessThanOrEqual(3);
    slow.release();
    app.unmount();
  });

  it("reconnects after the core drops", async () => {
    const slow = slowRunner();
    const core = makeCore(slow.runner);
    const { app, seen } = harness(core.connectAs("manager"), { retryMs: 300 });
    const id = await startDownload(core);
    await vi.waitFor(() => expect(seen.current?.jobs.has(id)).toBe(true));
    core.dropAll();
    await vi.waitFor(() => expect(seen.current?.state).toBe("reconnecting"));
    expect(seen.current?.jobs.has(id)).toBe(true);
    await vi.waitFor(() => expect(seen.current?.state).toBe("ready"));
    expect(seen.current?.jobs.has(id)).toBe(true);
    slow.release();
    app.unmount();
  });

  it("request rejects while reconnecting", async () => {
    let calls = 0;
    const core = makeCore(slowRunner().runner);
    const connect = async () => {
      calls += 1;
      if (calls > 1) throw new Error("no core");
      return core.connectAs("manager")();
    };
    const { app, seen } = harness(connect);
    await vi.waitFor(() => expect(seen.current?.state).toBe("ready"));
    core.dropAll();
    await vi.waitFor(() => expect(seen.current?.state).toBe("reconnecting"));
    await expect(seen.current?.request("jobs.list", {})).rejects.toBeInstanceOf(CoreLostError);
    app.unmount();
  });

  it("calls onAttention on app.attention", async () => {
    const core = makeCore(slowRunner().runner);
    const onAttention = vi.fn();
    const { app, seen } = harness(core.connectAs("manager"), { onAttention });
    await vi.waitFor(() => expect(seen.current?.state).toBe("ready"));
    const other = await core.connectAs("extension")();
    await other.request("app.open", {});
    await vi.waitFor(() => expect(onAttention).toHaveBeenCalledTimes(1));
    other.close();
    app.unmount();
  });
});

describe("useCoreSession cleanup", () => {
  it("closes a connection that is still loading when the screen goes away", async () => {
    const core = makeCore(slowRunner().runner);
    let asked: () => void = () => {};
    const listing = new Promise<void>((r) => {
      asked = r;
    });
    const connect = async () => {
      const client = await core.connectAs("manager")();
      const request: typeof client.request = async (type, payload) => {
        if (type === "jobs.list") {
          asked();
          await new Promise((r) => setTimeout(r, 100));
        }
        return client.request(type, payload);
      };
      return { ...client, ack: client.ack, request };
    };
    const { app } = harness(connect);
    await listing;
    app.unmount();
    const service = await core.service;
    await vi.waitFor(() => expect(service.isIdle).toBe(true), { timeout: 1000 });
  });
});

describe("useCoreSession refresh", () => {
  it("lists a job that started while a refresh was in flight", async () => {
    const slow = slowRunner();
    const core = makeCore(slow.runner);
    const connect = async () => {
      const client = await core.connectAs("manager")();
      // The core builds the list at once; the answer arrives late, as on a busy pipe.
      const request: typeof client.request = async (type, payload) => {
        const reply = await client.request(type, payload);
        if (type === "jobs.list") await new Promise((r) => setTimeout(r, 150));
        return reply;
      };
      return { ...client, ack: client.ack, request };
    };
    const { app, seen } = harness(connect);
    await vi.waitFor(() => expect(seen.current?.state).toBe("ready"));
    const first = await startDownload(core);
    await new Promise((r) => setTimeout(r, 30));
    const second = await startDownload(core);
    await vi.waitFor(() => expect(seen.current?.jobs.has(first)).toBe(true));
    await vi.waitFor(() => expect(seen.current?.jobs.has(second)).toBe(true), { timeout: 1500 });
    slow.release();
    app.unmount();
  });
});
