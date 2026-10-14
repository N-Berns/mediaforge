import { PROTOCOL_VERSION } from "@mediaforge/shared-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeClient, type NativePort } from "./native-client.ts";

function fakePort() {
  const messageListeners: Array<(m: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const sent: Array<{ id: string; type: string; payload?: unknown }> = [];
  const port: NativePort = {
    postMessage: (m) => void sent.push(m as (typeof sent)[number]),
    onMessage: { addListener: (cb) => void messageListeners.push(cb) },
    onDisconnect: { addListener: (cb) => void disconnectListeners.push(cb) },
    disconnect: () => {
      for (const cb of disconnectListeners) cb();
    },
  };
  return {
    port,
    sent,
    receive: (m: unknown) => {
      for (const cb of messageListeners) cb(m);
    },
    drop: () => {
      for (const cb of disconnectListeners) cb();
    },
  };
}

const frame = (id: string, type: string, payload: unknown) => ({
  v: PROTOCOL_VERSION,
  id,
  type,
  payload,
});

const ack = (id: string, setup = "ready") =>
  frame(id, "hello.ack", {
    hostVersion: "0.3.0",
    ytDlp: { available: true },
    ffmpeg: { available: true },
    setup,
    keepRunning: false,
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(options: { connect?: () => NativePort } = {}) {
  const ports: ReturnType<typeof fakePort>[] = [];
  const client = createNativeClient({
    connect:
      options.connect ??
      (() => {
        const p = fakePort();
        ports.push(p);
        return p.port;
      }),
    extensionVersion: "0.1.0",
    browser: "firefox",
    retryDelaysMs: [0, 1000, 2000],
  });
  return { client, ports };
}

describe("native client", () => {
  it("says hello, becomes ready on ack, then subscribes and lists jobs", () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    expect(client.state().kind).toBe("connecting");
    expect(p.sent[0]).toMatchObject({ type: "hello", payload: { browser: "firefox" } });
    p.receive(ack(p.sent[0]?.id ?? ""));
    expect(client.state().kind).toBe("ready");
    expect(p.sent.map((m) => m.type)).toEqual(["hello", "jobs.subscribe", "jobs.list"]);
  });

  it("is not-installed when connect throws or the port drops before any reply", () => {
    const thrown = setup({
      connect: () => {
        throw new Error("No such native application");
      },
    });
    thrown.client.start();
    expect(thrown.client.state().kind).toBe("not-installed");

    const dropped = setup();
    dropped.client.start();
    (dropped.ports[0] as ReturnType<typeof fakePort>).drop();
    expect(dropped.client.state().kind).toBe("not-installed");
  });

  it("shows setting-up from hello.ack and setup.progress, then ready", () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive(ack(p.sent[0]?.id ?? "", "installing"));
    expect(client.state().kind).toBe("setting-up");
    p.receive(frame("x", "setup.progress", { state: "installing", tool: "ffmpeg", percent: 40 }));
    expect(client.state()).toEqual({ kind: "setting-up", tool: "ffmpeg", percent: 40 });
    p.receive(frame("y", "setup.progress", { state: "ready" }));
    expect(client.state().kind).toBe("ready");
  });

  it("correlates replies by id and rejects error replies with their code", async () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive(ack(p.sent[0]?.id ?? ""));
    const ok = client.request("settings.get", {});
    const settingsId = p.sent.at(-1)?.id ?? "";
    p.receive(
      frame(settingsId, "settings.value", {
        extensionUi: "overlay",
        keepRunning: false,
        askQuality: true,
      }),
    );
    await expect(ok).resolves.toMatchObject({ type: "settings.value" });

    const bad = client.request("media.probe", { url: "https://x.test/" });
    const badId = p.sent.at(-1)?.id ?? "";
    p.receive(frame("e", "error", { code: "unsupported-site", message: "no", replyTo: badId }));
    await expect(bad).rejects.toMatchObject({ code: "unsupported-site" });
  });

  it("times out a request with no reply", async () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive(ack(p.sent[0]?.id ?? ""));
    const pending = client.request("jobs.list", {}, { timeoutMs: 100 });
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
  });

  it("reconnects after a drop, resyncs jobs, and rejects in-flight requests", async () => {
    const { client, ports } = setup();
    client.start();
    const first = ports[0] as ReturnType<typeof fakePort>;
    first.receive(ack(first.sent[0]?.id ?? ""));
    const inflight = client.request("jobs.list", {});
    const assertion = expect(inflight).rejects.toMatchObject({ code: "disconnected" });
    first.drop();
    await assertion;
    expect(client.state().kind).toBe("connecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(ports).toHaveLength(2);
    const second = ports[1] as ReturnType<typeof fakePort>;
    second.receive(ack(second.sent[0]?.id ?? ""));
    expect(client.state().kind).toBe("ready");
    expect(second.sent.map((m) => m.type)).toEqual(["hello", "jobs.subscribe", "jobs.list"]);
  });

  it("marks an older core incompatible when it rejects hello (v1 envelope)", () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive({
      v: 1,
      id: "e",
      type: "error",
      payload: { code: "invalid-message", message: "v", replyTo: p.sent[0]?.id ?? "" },
    });
    expect(client.state().kind).toBe("incompatible");
  });

  it("treats a v1 hello.ack as incompatible", () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive({ ...ack(p.sent[0]?.id ?? ""), v: 1 });
    expect(client.state().kind).toBe("incompatible");
  });

  it("keeps incompatible sticky and retries only every 5 minutes", async () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive({
      v: 1,
      id: "e",
      type: "error",
      payload: { code: "invalid-message", message: "v", replyTo: p.sent[0]?.id ?? "" },
    });
    p.drop();
    expect(client.state().kind).toBe("incompatible");
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(ports).toHaveLength(1);
    expect(client.state().kind).toBe("incompatible");
    await vi.advanceTimersByTimeAsync(1);
    expect(ports).toHaveLength(2);
    expect(client.state().kind).toBe("incompatible");
    const second = ports[1] as ReturnType<typeof fakePort>;
    second.receive(ack(second.sent[0]?.id ?? ""));
    expect(client.state().kind).toBe("ready");
  });

  it("start() retries immediately while incompatible", () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive({
      v: 1,
      id: "e",
      type: "error",
      payload: { code: "invalid-message", message: "v", replyTo: p.sent[0]?.id ?? "" },
    });
    client.start();
    expect(ports).toHaveLength(2);
  });

  it("times out a hello with no ack, goes unavailable and reconnects", async () => {
    const { client, ports } = setup();
    client.start();
    await vi.advanceTimersByTimeAsync(15000);
    expect(client.state()).toMatchObject({
      kind: "unavailable",
      message: "MediaForge did not answer.",
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(ports).toHaveLength(2);
    const second = ports[1] as ReturnType<typeof fakePort>;
    second.receive(ack(second.sent[0]?.id ?? ""));
    expect(client.state().kind).toBe("ready");
    await vi.advanceTimersByTimeAsync(20000);
    expect(ports).toHaveLength(2);
  });

  it("does not reset back-off on ack alone, only after 30 s of stability", async () => {
    const { client, ports } = setup();
    client.start();
    const ackAndDrop = (i: number) => {
      const p = ports[i] as ReturnType<typeof fakePort>;
      p.receive(ack(p.sent[0]?.id ?? ""));
      p.drop();
    };
    ackAndDrop(0); // delay 0
    await vi.advanceTimersByTimeAsync(0);
    expect(ports).toHaveLength(2);
    ackAndDrop(1); // delay 1000
    await vi.advanceTimersByTimeAsync(999);
    expect(ports).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(ports).toHaveLength(3);
    const third = ports[2] as ReturnType<typeof fakePort>;
    third.receive(ack(third.sent[0]?.id ?? ""));
    await vi.advanceTimersByTimeAsync(30_000);
    third.drop(); // stable -> delay 0
    await vi.advanceTimersByTimeAsync(0);
    expect(ports).toHaveLength(4);
  });

  it("rejects a request whose postMessage throws, without aborting push", async () => {
    const ports: ReturnType<typeof fakePort>[] = [];
    let breakSend = false;
    const client = createNativeClient({
      connect: () => {
        const p = fakePort();
        ports.push(p);
        const real = p.port.postMessage;
        p.port.postMessage = (m) => {
          if (breakSend) throw new Error("port closed");
          real(m);
        };
        return p.port;
      },
      extensionVersion: "0.1.0",
      browser: "firefox",
    });
    const seen: string[] = [];
    client.onPush((m) => seen.push(m.type));
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    breakSend = true;
    p.receive(ack(p.sent[0]?.id ?? "")); // subscribe/list sends throw
    expect(client.state().kind).toBe("ready");
    expect(seen).toEqual(["hello.ack"]);
    await expect(client.request("jobs.list", {})).rejects.toMatchObject({ code: "disconnected" });
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2); // hello timer cleared; stable timer only
  });

  it("reports unavailable when the relay says the core could not start", () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive(frame("r", "error", { code: "core-unavailable", message: "could not start" }));
    expect(client.state()).toMatchObject({ kind: "unavailable" });
  });

  it("forwards every valid frame to push listeners and ignores invalid ones", () => {
    const { client, ports } = setup();
    const seen: string[] = [];
    client.onPush((m) => seen.push(m.type));
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive({ nonsense: true });
    p.receive(
      frame("a", "download.progress", {
        jobId: "j",
        status: "downloading",
        progress: { bytesDownloaded: 1 },
      }),
    );
    expect(seen).toEqual(["download.progress"]);
  });

  it("ignores late frames and disconnects from a stale port", async () => {
    const { client, ports } = setup();
    const seen: string[] = [];
    client.onPush((m) => seen.push(m.type));
    client.start();
    const first = ports[0] as ReturnType<typeof fakePort>;
    first.drop();
    await vi.advanceTimersByTimeAsync(0);
    const second = ports[1] as ReturnType<typeof fakePort>;
    expect(client.state().kind).toBe("connecting");
    first.receive(ack(second.sent[0]?.id ?? "")); // stale port, same id as the new hello
    expect(client.state().kind).toBe("connecting");
    expect(seen).toEqual([]);
    first.drop(); // stale disconnect must not schedule another reconnect
    await vi.advanceTimersByTimeAsync(5000);
    expect(ports).toHaveLength(2);
  });

  it("backs off between attempts", async () => {
    const { client, ports } = setup();
    client.start();
    (ports[0] as ReturnType<typeof fakePort>).drop(); // delay 0
    await vi.advanceTimersByTimeAsync(0);
    expect(ports).toHaveLength(2);
    (ports[1] as ReturnType<typeof fakePort>).drop(); // delay 1000
    await vi.advanceTimersByTimeAsync(999);
    expect(ports).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(ports).toHaveLength(3);
    const third = ports[2] as ReturnType<typeof fakePort>;
    third.drop(); // delay 2000
    await vi.advanceTimersByTimeAsync(1999);
    expect(ports).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(ports).toHaveLength(4);
  });

  it("rejects each pending request once and clears timers on disconnect and stop", async () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive(ack(p.sent[0]?.id ?? ""));
    const onReject = vi.fn();
    client.request("jobs.list", {}, { timeoutMs: 100 }).catch(onReject);
    p.drop();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0]?.[0]).toMatchObject({ code: "disconnected" });

    const second = ports[1] as ReturnType<typeof fakePort>;
    second.receive(ack(second.sent[0]?.id ?? ""));
    const b = client.request("jobs.list", {}, { timeoutMs: 100 });
    const bAssert = expect(b).rejects.toMatchObject({ code: "stopped" });
    client.stop();
    await bAssert;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reconnect after stop", async () => {
    const { client, ports } = setup();
    client.start();
    (ports[0] as ReturnType<typeof fakePort>).drop(); // schedules reconnect
    client.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(ports).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves a download.start request with the progress frame of the same id", async () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive(ack(p.sent[0]?.id ?? ""));
    const r = client.request("download.start", { url: "https://x.test/", format: "mp4" });
    const id = p.sent.at(-1)?.id ?? "";
    p.receive(
      frame(id, "download.progress", {
        jobId: "j",
        status: "queued",
        progress: { bytesDownloaded: 0 },
      }),
    );
    await expect(r).resolves.toMatchObject({ type: "download.progress" });
  });
});
