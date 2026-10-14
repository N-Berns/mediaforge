import { randomUUID } from "node:crypto";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createDecoder,
  encodeMessage,
  MAX_EXTENSION_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from "@mediaforge/shared-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Connection, connectCore, listenCore, newToken } from "./ipc.ts";
import { runRelay } from "./relay.ts";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
});

const testPath = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\mediaforge-relay-${randomUUID()}`
    : join(tmpdir(), `mediaforge-relay-${randomUUID()}.sock`);

const frame = (message: unknown) => encodeMessage(message, MAX_EXTENSION_MESSAGE_BYTES);

const request = (id: string, type = "jobs.list") => ({
  v: PROTOCOL_VERSION,
  id,
  type,
  payload: {},
});

function collect(stream: PassThrough) {
  const decoder = createDecoder();
  const messages: unknown[] = [];
  stream.on("data", (chunk: Buffer) => messages.push(...decoder.push(chunk)));
  return messages;
}

const until = async (check: () => boolean, tries = 200) => {
  for (let i = 0; i < tries && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error("timed out");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A `Connection` that records how the relay uses it, and lets a test play the core's side. */
function fakeConnection(options: { sendThrows?: boolean; closeSilently?: boolean } = {}) {
  const calls: string[] = [];
  const sent: unknown[] = [];
  let messageHandler: ((message: unknown) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  const conn: Connection = {
    send(message) {
      if (options.sendThrows) throw new Error("socket is gone");
      sent.push(message);
    },
    onMessage(handler) {
      calls.push("onMessage");
      messageHandler = handler;
    },
    onClose(handler) {
      calls.push("onClose");
      closeHandler = handler;
    },
    // Like a socket: closing it is reported back, after the fact. `closeSilently` plays a core
    // that never finishes closing.
    close: vi.fn(() => {
      calls.push("close");
      if (!options.closeSilently) queueMicrotask(() => closeHandler?.());
    }),
  };
  return {
    conn,
    calls,
    sent,
    fromCore: (message: unknown) => messageHandler?.(message),
    coreCloses: () => closeHandler?.(),
  };
}

const echoServer = async (path: string, token: string) =>
  listenCore({
    path,
    token,
    onConnection: (conn) => conn.onMessage((m) => conn.send({ echo: m })),
  });

/** A core that records every frame it receives. */
async function recordingCore(path: string, token: string) {
  const received: unknown[] = [];
  let connected = false;
  const server = await listenCore({
    path,
    token,
    onConnection: (conn) => {
      connected = true;
      conn.onMessage((m) => received.push(m));
    },
  });
  servers.push(server);
  return { received, isConnected: () => connected };
}

describe("runRelay", () => {
  it("forwards frames both ways", async () => {
    const path = testPath();
    const token = newToken();
    servers.push(await echoServer(path, token));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = collect(stdout);
    const done = runRelay({
      stdin,
      stdout,
      connect: () => connectCore({ path, token }),
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    stdin.write(frame(request("1")));
    await until(() => out.length === 1);
    expect(out[0]).toEqual({ echo: request("1") });
    stdin.end();
    expect(await done).toBe(0);
  });

  describe("when stdin ends with requests not yet delivered", () => {
    it("still delivers a frame written just before stdin ended to a core that comes up later", async () => {
      const path = testPath();
      const token = newToken();
      let core: Awaited<ReturnType<typeof recordingCore>> | undefined;
      const stdin = new PassThrough();
      const done = runRelay({
        stdin,
        stdout: new PassThrough(),
        connect: () => connectCore({ path, token }),
        spawnCore: () => {
          setTimeout(() => {
            void recordingCore(path, token).then((c) => {
              core = c;
            });
          }, 50);
        },
        timeoutMs: 2000,
        retryMs: 10,
      });
      // An MV3 service worker posts a request and its port closes at once.
      stdin.write(frame(request("1", "download.start")));
      stdin.end();
      expect(await done).toBe(0);
      expect(core?.received).toEqual([request("1", "download.start")]);
    });

    it("exits only once the core has the whole of a large frame", async () => {
      const path = testPath();
      const token = newToken();
      const core = await recordingCore(path, token);
      const stdin = new PassThrough();
      const done = runRelay({
        stdin,
        stdout: new PassThrough(),
        connect: () => connectCore({ path, token }),
        spawnCore: () => {},
        timeoutMs: 2000,
        retryMs: 10,
      });
      await until(core.isConnected);
      const big = { ...request("big", "download.start"), payload: { blob: "x".repeat(8 << 20) } };
      stdin.write(frame(big));
      stdin.end();
      expect(await done).toBe(0);
      // Resolving means the caller may `process.exit`: the frame must already be across.
      expect(core.received).toHaveLength(1);
      expect(core.received[0]).toEqual(big);
    });

    it("answers core-unavailable and exits non-zero when the core never comes", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const out = collect(stdout);
      const spawnCore = vi.fn();
      const done = runRelay({
        stdin,
        stdout,
        connect: async () => {
          throw new Error("nothing listening");
        },
        spawnCore,
        timeoutMs: 100,
        retryMs: 10,
      });
      stdin.write(frame(request("5", "download.start")));
      stdin.end();
      expect(await done).toBe(1);
      expect(spawnCore).toHaveBeenCalledTimes(1);
      expect(out[0]).toMatchObject({ payload: { code: "core-unavailable", replyTo: "5" } });
    });

    it("still delivers when stdout breaks after stdin ended", async () => {
      const f = fakeConnection();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const done = runRelay({
        stdin,
        stdout,
        connect: async () => {
          await gate;
          return f.conn;
        },
        spawnCore: () => {},
        timeoutMs: 1000,
        retryMs: 10,
      });
      stdin.write(frame(request("1", "download.start")));
      stdin.end();
      await sleep(20);
      // The browser is gone, so its end of stdout is too.
      stdout.emit("error", new Error("write EPIPE"));
      release();
      expect(await done).toBe(0);
      expect(f.sent).toEqual([request("1", "download.start")]);
    });

    it("does not wait longer than the flush limit for a core that never closes", async () => {
      const f = fakeConnection({ closeSilently: true });
      const stdin = new PassThrough();
      const done = runRelay({
        stdin,
        stdout: new PassThrough(),
        connect: async () => f.conn,
        spawnCore: () => {},
        timeoutMs: 1000,
        retryMs: 10,
      });
      await until(() => f.calls.includes("onClose"));
      stdin.write(frame(request("1")));
      const started = Date.now();
      stdin.end();
      expect(await done).toBe(0);
      expect(f.sent).toEqual([request("1")]);
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(900);
      expect(waited).toBeLessThan(2000);
    });
  });

  it("spawns the core once and retries until it is reachable", async () => {
    const path = testPath();
    const token = newToken();
    let spawned = 0;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = collect(stdout);
    const done = runRelay({
      stdin,
      stdout,
      connect: () => connectCore({ path, token }),
      spawnCore: () => {
        spawned++;
        void echoServer(path, token).then((s) => servers.push(s));
      },
      timeoutMs: 2000,
      retryMs: 10,
    });
    stdin.write(frame(request("1")));
    await until(() => out.length === 1);
    expect(spawned).toBe(1);
    stdin.end();
    await done;
  });

  it("answers core-unavailable and exits non-zero when the core never appears", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = collect(stdout);
    const spawnCore = vi.fn();
    const done = runRelay({
      stdin,
      stdout,
      connect: async () => {
        throw new Error("nothing listening");
      },
      spawnCore,
      timeoutMs: 100,
      retryMs: 10,
    });
    stdin.write(frame(request("7", "hello")));
    expect(await done).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      v: PROTOCOL_VERSION,
      type: "error",
      payload: { code: "core-unavailable", replyTo: "7" },
    });
    expect(spawnCore).toHaveBeenCalledTimes(1);
  });

  it("leaves replyTo out of core-unavailable when no request id was seen", async () => {
    const stdout = new PassThrough();
    const out = collect(stdout);
    const done = runRelay({
      stdin: new PassThrough(),
      stdout,
      connect: async () => {
        throw new Error("nothing listening");
      },
      spawnCore: () => {},
      timeoutMs: 50,
      retryMs: 10,
    });
    expect(await done).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "error", payload: { code: "core-unavailable" } });
    expect(out[0]).not.toHaveProperty("payload.replyTo");
  });

  it("treats a connect that throws synchronously, or a spawn that throws, as a failed attempt", async () => {
    const f = fakeConnection();
    let attempts = 0;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const done = runRelay({
      stdin,
      stdout,
      connect: () => {
        attempts++;
        if (attempts < 3) throw new Error("not yet");
        return Promise.resolve(f.conn);
      },
      spawnCore: () => {
        throw new Error("spawn failed");
      },
      timeoutMs: 2000,
      retryMs: 5,
    });
    await until(() => f.calls.includes("onClose"));
    expect(attempts).toBe(3);
    stdin.end();
    expect(await done).toBe(0);
  });

  it("registers onMessage before onClose, so a queued frame is not reported after the close", async () => {
    const f = fakeConnection();
    const stdin = new PassThrough();
    const done = runRelay({
      stdin,
      stdout: new PassThrough(),
      connect: async () => f.conn,
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    await until(() => f.calls.length >= 2);
    expect(f.calls).toEqual(["onMessage", "onClose"]);
    stdin.end();
    await done;
  });

  it("delivers frames written before the core was reachable, in order", async () => {
    const f = fakeConnection();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stdin = new PassThrough();
    const done = runRelay({
      stdin,
      stdout: new PassThrough(),
      connect: async () => {
        await gate;
        return f.conn;
      },
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    stdin.write(frame(request("a")));
    stdin.write(frame(request("b")));
    await sleep(30);
    expect(f.sent).toEqual([]);
    release();
    await until(() => f.sent.length === 2);
    expect(f.sent).toEqual([request("a"), request("b")]);
    stdin.end();
    await done;
  });

  it("writes frames from the core to stdout", async () => {
    const f = fakeConnection();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = collect(stdout);
    const done = runRelay({
      stdin,
      stdout,
      connect: async () => f.conn,
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    await until(() => f.calls.includes("onClose"));
    f.fromCore({ v: PROTOCOL_VERSION, id: "x", type: "jobs.snapshot", payload: { jobs: [] } });
    await until(() => out.length === 1);
    expect(out[0]).toMatchObject({ type: "jobs.snapshot" });
    stdin.end();
    await done;
  });

  it("exits 0 and closes the core connection when the browser closes stdin", async () => {
    const f = fakeConnection();
    const stdin = new PassThrough();
    const done = runRelay({
      stdin,
      stdout: new PassThrough(),
      connect: async () => f.conn,
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    await until(() => f.calls.includes("onClose"));
    stdin.end();
    expect(await done).toBe(0);
    expect(f.conn.close).toHaveBeenCalled();
  });

  it("tells the browser the core stopped, then exits non-zero, when the core drops the connection", async () => {
    const f = fakeConnection();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = collect(stdout);
    const done = runRelay({
      stdin,
      stdout,
      connect: async () => f.conn,
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    await until(() => f.calls.includes("onClose"));
    stdin.write(frame(request("9")));
    await until(() => f.sent.length === 1);
    f.coreCloses();
    expect(await done).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      v: PROTOCOL_VERSION,
      type: "error",
      payload: { code: "core-disconnected", message: "MediaForge stopped.", replyTo: "9" },
    });
  });

  it("leaves replyTo out of core-disconnected when no request id was seen", async () => {
    const f = fakeConnection();
    const stdout = new PassThrough();
    const out = collect(stdout);
    const done = runRelay({
      stdin: new PassThrough(),
      stdout,
      connect: async () => f.conn,
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    await until(() => f.calls.includes("onClose"));
    f.coreCloses();
    expect(await done).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "error", payload: { code: "core-disconnected" } });
    expect(out[0]).not.toHaveProperty("payload.replyTo");
  });

  it("says nothing about a core that goes away after the browser closed stdin", async () => {
    const f = fakeConnection();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = collect(stdout);
    const done = runRelay({
      stdin,
      stdout,
      connect: async () => f.conn,
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    await until(() => f.calls.includes("onClose"));
    stdin.end();
    expect(await done).toBe(0);
    f.coreCloses();
    await sleep(30);
    expect(out).toEqual([]);
  });

  it("does not start a core once the relay has already finished", async () => {
    let fail: (error: Error) => void = () => {};
    const attempt = new Promise<Connection>((_resolve, reject) => {
      fail = reject;
    });
    const spawnCore = vi.fn();
    const stdin = new PassThrough();
    const done = runRelay({
      stdin,
      stdout: new PassThrough(),
      connect: () => attempt,
      spawnCore,
      timeoutMs: 1000,
      retryMs: 10,
    });
    stdin.end();
    expect(await done).toBe(0);
    fail(new Error("nothing listening"));
    await sleep(50);
    expect(spawnCore).not.toHaveBeenCalled();
  });

  it("closes a connection that is established only after stdin has ended", async () => {
    const f = fakeConnection();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stdin = new PassThrough();
    const done = runRelay({
      stdin,
      stdout: new PassThrough(),
      connect: async () => {
        await gate;
        return f.conn;
      },
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    stdin.end();
    expect(await done).toBe(0);
    release();
    await until(() => f.calls.includes("close"));
    expect(f.conn.close).toHaveBeenCalledTimes(1);
  });

  it("settles non-zero instead of throwing when sending to the core fails", async () => {
    const f = fakeConnection({ sendThrows: true });
    const stdin = new PassThrough();
    const done = runRelay({
      stdin,
      stdout: new PassThrough(),
      connect: async () => f.conn,
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    await until(() => f.calls.includes("onClose"));
    stdin.write(frame(request("1")));
    expect(await done).toBe(1);
    expect(f.conn.close).toHaveBeenCalled();
  });

  it("settles non-zero instead of throwing when a frame queued for the core cannot be sent", async () => {
    const f = fakeConnection({ sendThrows: true });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stdin = new PassThrough();
    const done = runRelay({
      stdin,
      stdout: new PassThrough(),
      connect: async () => {
        await gate;
        return f.conn;
      },
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    stdin.write(frame(request("1")));
    await sleep(30);
    release();
    expect(await done).toBe(1);
  });

  it("settles non-zero instead of throwing when stdout cannot be written", async () => {
    const f = fakeConnection();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.write = () => {
      throw new Error("write EPIPE");
    };
    const done = runRelay({
      stdin,
      stdout,
      connect: async () => f.conn,
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    await until(() => f.calls.includes("onClose"));
    f.fromCore({ v: PROTOCOL_VERSION, id: "x", type: "jobs.snapshot", payload: { jobs: [] } });
    expect(await done).toBe(1);
    expect(f.conn.close).toHaveBeenCalled();
  });

  it("settles non-zero when stdout reports an error", async () => {
    const f = fakeConnection();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const done = runRelay({
      stdin,
      stdout,
      connect: async () => f.conn,
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    await until(() => f.calls.includes("onClose"));
    stdout.emit("error", new Error("write EPIPE"));
    expect(await done).toBe(1);
  });

  it("exits non-zero and closes the core connection on a frame it cannot decode", async () => {
    const f = fakeConnection();
    const stdin = new PassThrough();
    const done = runRelay({
      stdin,
      stdout: new PassThrough(),
      connect: async () => f.conn,
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    await until(() => f.calls.includes("onClose"));
    // A length prefix far above the 64 MiB cap.
    stdin.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    expect(await done).toBe(1);
    expect(f.conn.close).toHaveBeenCalled();
  });
});
