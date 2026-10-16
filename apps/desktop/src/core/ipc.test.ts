import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecoder, encodeMessage, MAX_HOST_MESSAGE_BYTES } from "@mediaforge/shared-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Connection,
  connectCore,
  HANDSHAKE_MAX_BYTES,
  listenCore,
  newToken,
  pipePath,
  readToken,
  tokenPath,
  writeToken,
} from "./ipc.ts";

const servers: Server[] = [];
const sockets: Socket[] = [];
const clients: Connection[] = [];
const dirs: string[] = [];

const testPath = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\mediaforge-test-${randomUUID()}`
    : join(tmpdir(), `mediaforge-test-${randomUUID()}.sock`);

/** `connectCore`, with the connection closed after the test so the server can shut down. */
const connect = async (options: Parameters<typeof connectCore>[0]) => {
  const conn = await connectCore(options);
  clients.push(conn);
  return conn;
};

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const nextMessage = (conn: Connection) =>
  new Promise<unknown>((resolve) => conn.onMessage(resolve));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The handshake's MAC, written out independently of `ipc.ts` so the tests pin the wire format. */
const hmac = (token: string, data: string) =>
  createHmac("sha256", token).update(data).digest("hex");
const nonce = () => randomBytes(32).toString("hex");
const hex64 = /^[0-9a-f]{64}$/u;

/** One end of a bare socket that speaks the wire format by hand, so tests can break the protocol. */
interface Peer {
  socket: Socket;
  closed: Promise<void>;
  received: unknown[];
  /** Every byte that arrived, in order. */
  readonly raw: Buffer;
  /** Resolve once at least `count` frames have arrived. */
  frames(count: number): Promise<unknown[]>;
  send(message: unknown): void;
}

function peer(socket: Socket): Peer {
  sockets.push(socket);
  const decoder = createDecoder();
  const received: unknown[] = [];
  const chunks: Buffer[] = [];
  const waiters: (() => void)[] = [];
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    try {
      received.push(...decoder.push(chunk));
    } catch {
      // A test that sends garbage only looks at the raw bytes.
    }
    for (const wake of waiters.splice(0)) wake();
  });
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => {
      resolve();
      for (const wake of waiters.splice(0)) wake();
    }),
  );
  return {
    socket,
    closed,
    received,
    get raw() {
      return Buffer.concat(chunks);
    },
    async frames(count) {
      while (received.length < count) {
        if (socket.destroyed) throw new Error(`Closed after ${received.length} frames.`);
        await new Promise<void>((wake) => waiters.push(wake));
      }
      return received;
    },
    send(message) {
      socket.write(encodeMessage(message));
    },
  };
}

async function rawConnect(path: string): Promise<Peer> {
  const socket = net.connect(path);
  const p = peer(socket);
  await new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(undefined));
    socket.once("error", reject);
  });
  return p;
}

/** A server that hands every accepted socket to `onPeer`; a squatter or a hand-rolled core. */
async function rawServer(path: string, onPeer: (p: Peer) => void | Promise<void>): Promise<Peer[]> {
  const peers: Peer[] = [];
  const server = net.createServer((socket) => {
    const p = peer(socket);
    peers.push(p);
    // A peer that closes early makes `frames` throw; that just ends this fake.
    Promise.resolve(onPeer(p)).catch(() => socket.destroy());
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(path, () => resolve(undefined)));
  return peers;
}

/**
 * A hand-rolled core that knows `token`: it runs steps 2 and 4 of the handshake correctly, then
 * hands the socket to `afterProof` instead of sending `{ ok: true }` itself.
 */
const fakeCore = (path: string, token: string, afterProof: (p: Peer) => void) =>
  rawServer(path, async (p) => {
    const [hello] = await p.frames(1);
    const nonceC = (hello as { hello: string }).hello;
    const nonceS = nonce();
    p.send({ proof: hmac(token, `core|${nonceC}`), nonce: nonceS });
    const [, reply] = await p.frames(2);
    if ((reply as { proof?: unknown }).proof !== hmac(token, `client|${nonceS}|${nonceC}`)) {
      p.socket.destroy();
      return;
    }
    afterProof(p);
  });

/** Run the client side by hand: send a hello and return the core's step-2 reply. */
async function sayHello(client: Peer, nonceC = nonce()) {
  client.send({ hello: nonceC });
  const [reply] = await client.frames(1);
  return { nonceC, ...(reply as { proof: string; nonce: string }) };
}

/** A header that promises a frame of `length` bytes. */
const header = (length: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(length);
  return buffer;
};

describe("pipePath", () => {
  it("is a named pipe on Windows", () => {
    expect(pipePath("win32", {}, "neil")).toBe("\\\\.\\pipe\\mediaforge-neil");
  });

  it("is a socket file elsewhere, and percent-encodes unsafe characters in the user name", () => {
    expect(pipePath("linux", { XDG_RUNTIME_DIR: "/run/user/1" }, "a b")).toBe(
      join("/run/user/1", "mediaforge-a%20b.sock"),
    );
    expect(pipePath("win32", {}, "a\\b/c")).toBe("\\\\.\\pipe\\mediaforge-a%5Cb%2Fc");
  });

  it("gives different users different paths, even when they have no ASCII characters", () => {
    const names = ["张三", "李四", "a b", "a_b", "a%20b", "ab", "\ud800", "\ufffd", "😀", "😁"];
    const paths = names.map((name) => pipePath("win32", {}, name));
    expect(new Set(paths).size).toBe(names.length);
  });
});

describe("token file", () => {
  it("round-trips a token and reports a missing file as undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mf-token-"));
    dirs.push(dir);
    const path = join(dir, "sub", "core.token");
    expect(await readToken(path)).toBeUndefined();
    const token = newToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await writeToken(path, token);
    expect(await readToken(path)).toBe(token);
  });

  it("lives next to the settings file", () => {
    expect(tokenPath({ APPDATA: "C:\\Users\\n\\AppData\\Roaming" }, "win32")).toBe(
      join("C:\\Users\\n\\AppData\\Roaming", "MediaForge", "core.token"),
    );
  });

  it("is written atomically: no temp file is left, and a rewrite replaces the content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mf-token-"));
    dirs.push(dir);
    const path = join(dir, "core.token");
    const first = newToken();
    await writeToken(path, first);
    expect(await readdir(dir)).toEqual(["core.token"]);
    expect(await readFile(path, "utf8")).toBe(first);
    const second = newToken();
    await writeToken(path, second);
    expect(await readdir(dir)).toEqual(["core.token"]);
    expect(await readFile(path, "utf8")).toBe(second);
  });
});

describe("listenCore and connectCore", () => {
  it("exchanges framed messages after the handshake", async () => {
    const path = testPath();
    const token = newToken();
    servers.push(
      await listenCore({
        path,
        token,
        onConnection: (conn) => conn.onMessage((m) => conn.send({ echo: m })),
      }),
    );
    const client = await connect({ path, token });
    const reply = nextMessage(client);
    client.send({ hello: "core" });
    expect(await reply).toEqual({ echo: { hello: "core" } });
    client.close();
  });

  it("rejects a client with a different token at step 3, and never reports a connection", async () => {
    const path = testPath();
    const onConnection = vi.fn();
    servers.push(await listenCore({ path, token: newToken(), onConnection }));
    await expect(connectCore({ path, token: newToken() })).rejects.toThrow(
      "Core could not prove its identity.",
    );
    await sleep(50);
    expect(onConnection).not.toHaveBeenCalled();
  });

  it("refuses a second listener on the same path", async () => {
    const path = testPath();
    servers.push(await listenCore({ path, token: newToken(), onConnection: () => {} }));
    await expect(
      listenCore({ path, token: newToken(), onConnection: () => {} }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("rejects when nothing is listening", async () => {
    await expect(connectCore({ path: testPath(), token: "x" })).rejects.toThrow();
  });

  it("refuses to listen with an empty token", async () => {
    await expect(
      listenCore({ path: testPath(), token: "", onConnection: () => {} }),
    ).rejects.toThrow(/token/i);
  });

  it("serves only a bounded number of clients at once", async () => {
    const server = await listenCore({
      path: testPath(),
      token: newToken(),
      onConnection: () => {},
    });
    servers.push(server);
    expect(server.maxConnections).toBeGreaterThan(0);
    expect(server.maxConnections).toBeLessThanOrEqual(64);
  });

  describe("core side", () => {
    it("sends nothing before the client's hello", async () => {
      const path = testPath();
      servers.push(await listenCore({ path, token: newToken(), onConnection: () => {} }));
      const client = await rawConnect(path);
      await sleep(100);
      expect(client.raw.byteLength).toBe(0);
    });

    it("answers a hello with a proof of the token and a fresh nonce per connection", async () => {
      const path = testPath();
      const token = newToken();
      servers.push(await listenCore({ path, token, onConnection: () => {} }));
      const first = await sayHello(await rawConnect(path));
      expect(first.proof).toBe(hmac(token, `core|${first.nonceC}`));
      expect(first.nonce).toMatch(hex64);
      const second = await sayHello(await rawConnect(path), first.nonceC);
      expect(second.proof).toBe(first.proof);
      expect(second.nonce).toMatch(hex64);
      expect(second.nonce).not.toBe(first.nonce);
    });

    it("closes, without replying, a client that sends the old { token } frame", async () => {
      const path = testPath();
      const token = newToken();
      const onConnection = vi.fn();
      servers.push(await listenCore({ path, token, onConnection }));
      const client = await rawConnect(path);
      client.send({ token });
      await client.closed;
      expect(onConnection).not.toHaveBeenCalled();
      expect(client.raw.byteLength).toBe(0);
    });

    it.each([
      ["a short nonce", { hello: "abcd" }],
      ["a non-hex nonce", { hello: "z".repeat(64) }],
      ["an upper-case nonce", { hello: "A".repeat(64) }],
      ["a number", { hello: 5 }],
      ["an array", [nonce()]],
      ["null", null],
      ["an unrelated object", { nope: 1 }],
    ])("closes, without replying, a client whose hello is %s", async (_name, frame) => {
      const path = testPath();
      const onConnection = vi.fn();
      servers.push(await listenCore({ path, token: newToken(), onConnection }));
      const client = await rawConnect(path);
      client.send(frame);
      await client.closed;
      expect(onConnection).not.toHaveBeenCalled();
      expect(client.raw.byteLength).toBe(0);
    });

    it("does not answer a bad frame followed by a valid hello in one chunk", async () => {
      const path = testPath();
      servers.push(await listenCore({ path, token: newToken(), onConnection: () => {} }));
      const client = await rawConnect(path);
      client.socket.write(
        Buffer.concat([encodeMessage({ nope: 1 }), encodeMessage({ hello: nonce() })]),
      );
      await client.closed;
      expect(client.raw.byteLength).toBe(0);
    });

    it("does not answer a hello with more frames pipelined behind it", async () => {
      const path = testPath();
      servers.push(await listenCore({ path, token: newToken(), onConnection: () => {} }));
      const client = await rawConnect(path);
      client.socket.write(
        Buffer.concat([encodeMessage({ hello: nonce() }), encodeMessage({ early: 1 })]),
      );
      await client.closed;
      expect(client.raw.byteLength).toBe(0);
    });

    it("closes the socket for an oversized first frame", async () => {
      const path = testPath();
      const onConnection = vi.fn();
      servers.push(await listenCore({ path, token: newToken(), onConnection }));
      const client = await rawConnect(path);
      client.socket.write(header(HANDSHAKE_MAX_BYTES + 1));
      await client.closed;
      expect(onConnection).not.toHaveBeenCalled();
      expect(client.raw.byteLength).toBe(0);
    });

    it("closes the socket for an oversized proof frame", async () => {
      const path = testPath();
      const onConnection = vi.fn();
      servers.push(await listenCore({ path, token: newToken(), onConnection }));
      const client = await rawConnect(path);
      await sayHello(client);
      client.socket.write(header(HANDSHAKE_MAX_BYTES + 1));
      await client.closed;
      expect(onConnection).not.toHaveBeenCalled();
      expect(client.received).toHaveLength(1);
    });

    it.each([
      [
        "made with another token",
        (_t: string, s: string, c: string) => ({ proof: hmac(newToken(), `client|${s}|${c}`) }),
      ],
      [
        "the core's own proof echoed back",
        (t: string, _s: string, c: string) => ({ proof: hmac(t, `core|${c}`) }),
      ],
      ["missing", () => ({})],
      ["not hex", () => ({ proof: "z".repeat(64) })],
      [
        "too short",
        (t: string, s: string, c: string) => ({ proof: hmac(t, `client|${s}|${c}`).slice(0, 62) }),
      ],
      ["the old token frame", (t: string) => ({ token: t })],
    ])("closes, with no further reply, a client whose proof is %s", async (_name, makeProof) => {
      const path = testPath();
      const token = newToken();
      const onConnection = vi.fn();
      servers.push(await listenCore({ path, token, onConnection }));
      const client = await rawConnect(path);
      const { nonceC, nonce: nonceS } = await sayHello(client);
      client.send(makeProof(token, nonceS, nonceC));
      await client.closed;
      expect(onConnection).not.toHaveBeenCalled();
      expect(client.received).toHaveLength(1);
    });

    it("refuses a proof replayed on a new connection, since the nonce is fresh", async () => {
      const path = testPath();
      const token = newToken();
      const onConnection = vi.fn();
      servers.push(await listenCore({ path, token, onConnection }));

      const first = await rawConnect(path);
      const { nonceC, nonce: nonceS } = await sayHello(first);
      const captured = { proof: hmac(token, `client|${nonceS}|${nonceC}`) };
      first.send(captured);
      expect(await first.frames(2)).toEqual([expect.anything(), { ok: true }]);

      const second = await rawConnect(path);
      await sayHello(second, nonceC);
      second.send(captured);
      await second.closed;
      expect(second.received).toHaveLength(1);
      expect(onConnection).toHaveBeenCalledTimes(1);
    });

    it("does not authenticate a correct proof with more frames pipelined behind it", async () => {
      const path = testPath();
      const token = newToken();
      const onConnection = vi.fn();
      servers.push(await listenCore({ path, token, onConnection }));
      const client = await rawConnect(path);
      const { nonceC, nonce: nonceS } = await sayHello(client);
      client.socket.write(
        Buffer.concat([
          encodeMessage({ proof: hmac(token, `client|${nonceS}|${nonceC}`) }),
          encodeMessage({ early: 1 }),
        ]),
      );
      await client.closed;
      expect(onConnection).not.toHaveBeenCalled();
      expect(client.received).toHaveLength(1);
    });

    it("runs the handshake once: a repeated proof is an ordinary message", async () => {
      const path = testPath();
      const token = newToken();
      const received: unknown[] = [];
      const onConnection = vi.fn((conn: Connection) =>
        conn.onMessage((m) => {
          received.push(m);
          conn.send({ seen: received.length });
        }),
      );
      servers.push(await listenCore({ path, token, onConnection }));
      const client = await rawConnect(path);
      const { nonceC, nonce: nonceS } = await sayHello(client);
      const proof = { proof: hmac(token, `client|${nonceS}|${nonceC}`) };
      client.send(proof);
      expect((await client.frames(2))[1]).toEqual({ ok: true });
      client.send(proof);
      expect((await client.frames(3))[2]).toEqual({ seen: 1 });
      expect(onConnection).toHaveBeenCalledTimes(1);
      expect(received).toEqual([proof]);
    });

    it("keeps an authenticated connection open when a frame arrives before onMessage", async () => {
      const path = testPath();
      const token = newToken();
      const received: unknown[] = [];
      servers.push(
        await listenCore({
          path,
          token,
          // Registers its handler late, as a real consumer might after some async setup.
          onConnection: (conn) => {
            setTimeout(() => conn.onMessage((m) => received.push(m)), 30);
          },
        }),
      );
      const client = await connect({ path, token });
      client.send({ first: 1 });
      client.send({ second: 2 });
      await vi.waitFor(() => expect(received).toEqual([{ first: 1 }, { second: 2 }]));
    });

    it("reports a close that happened before the server registered onClose", async () => {
      const path = testPath();
      const token = newToken();
      const closed = vi.fn();
      servers.push(
        await listenCore({
          path,
          token,
          onConnection: (conn) => {
            setTimeout(() => conn.onClose(closed), 50);
          },
        }),
      );
      const client = await connect({ path, token });
      client.close();
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    });
  });

  describe("client side", () => {
    it("refuses a squatter that cannot prove the token, and sends it nothing but the hello", async () => {
      const path = testPath();
      const peers = await rawServer(path, async (p) => {
        const [hello] = await p.frames(1);
        const nonceC = (hello as { hello: string }).hello;
        p.send({ proof: hmac(newToken(), `core|${nonceC}`), nonce: nonce() });
      });
      await expect(connectCore({ path, token: newToken() })).rejects.toThrow(
        "Core could not prove its identity.",
      );
      const [squatter] = peers;
      await squatter?.closed;
      expect(squatter?.received).toEqual([{ hello: expect.stringMatching(hex64) }]);
    });

    it("never puts the token on the wire to a squatter", async () => {
      const path = testPath();
      const token = newToken();
      const peers = await rawServer(path, async (p) => {
        const [hello] = await p.frames(1);
        const nonceC = (hello as { hello: string }).hello;
        p.send({ proof: hmac(newToken(), `core|${nonceC}`), nonce: nonce() });
      });
      await expect(connectCore({ path, token })).rejects.toThrow(/prove/);
      const [squatter] = peers;
      await squatter?.closed;
      const raw = squatter?.raw ?? Buffer.alloc(0);
      expect(raw.byteLength).toBeGreaterThan(0);
      expect(raw.includes(Buffer.from(token))).toBe(false);
      expect(raw.includes(Buffer.from(token, "hex"))).toBe(false);
    });

    it("never puts the token on the wire to the real core either", async () => {
      const corePath = testPath();
      const proxyPath = testPath();
      const token = newToken();
      servers.push(
        await listenCore({
          path: corePath,
          token,
          onConnection: (conn) => conn.onMessage((m) => conn.send({ echo: m })),
        }),
      );
      const wire: Buffer[] = [];
      // A transparent relay that records both directions, as a sniffer on the pipe would.
      const proxy = net.createServer((inbound) => {
        const outbound = net.connect(corePath);
        sockets.push(inbound, outbound);
        inbound.on("data", (chunk: Buffer) => {
          wire.push(chunk);
          outbound.write(chunk);
        });
        outbound.on("data", (chunk: Buffer) => {
          wire.push(chunk);
          inbound.write(chunk);
        });
        inbound.on("close", () => outbound.destroy());
        outbound.on("close", () => inbound.destroy());
        inbound.on("error", () => inbound.destroy());
        outbound.on("error", () => outbound.destroy());
      });
      servers.push(proxy);
      await new Promise((resolve) => proxy.listen(proxyPath, () => resolve(undefined)));

      const client = await connect({ path: proxyPath, token });
      const reply = nextMessage(client);
      client.send({ n: 1 });
      expect(await reply).toEqual({ echo: { n: 1 } });
      const raw = Buffer.concat(wire);
      expect(raw.includes(Buffer.from(token))).toBe(false);
      expect(raw.includes(Buffer.from(token, "hex"))).toBe(false);
    });

    it("sends nothing but the hello to a silent squatter, then times out", async () => {
      const path = testPath();
      const peers = await rawServer(path, () => {});
      await expect(connectCore({ path, token: newToken(), timeoutMs: 100 })).rejects.toThrow(
        /timed out/i,
      );
      const [squatter] = peers;
      await squatter?.closed;
      expect(squatter?.received).toEqual([{ hello: expect.stringMatching(hex64) }]);
    });

    it.each([
      ["the old { ok: true } reply", () => ({ ok: true })],
      ["a reply with no nonce", (t: string, c: string) => ({ proof: hmac(t, `core|${c}`) })],
      [
        "a reply with a short nonce",
        (t: string, c: string) => ({ proof: hmac(t, `core|${c}`), nonce: "ab" }),
      ],
      [
        "a truncated proof",
        (t: string, c: string) => ({ proof: hmac(t, `core|${c}`).slice(0, 62), nonce: nonce() }),
      ],
      ["a non-object", () => "hello"],
    ])("refuses %s, sending nothing more", async (_name, makeReply) => {
      const path = testPath();
      const token = newToken();
      const peers = await rawServer(path, async (p) => {
        const [hello] = await p.frames(1);
        p.send(makeReply(token, (hello as { hello: string }).hello));
      });
      await expect(connectCore({ path, token })).rejects.toThrow(
        "Core could not prove its identity.",
      );
      const [squatter] = peers;
      await squatter?.closed;
      expect(squatter?.received).toHaveLength(1);
    });

    it("refuses a correct proof with another frame pipelined behind it", async () => {
      const path = testPath();
      const token = newToken();
      const peers = await rawServer(path, async (p) => {
        const [hello] = await p.frames(1);
        const nonceC = (hello as { hello: string }).hello;
        p.socket.write(
          Buffer.concat([
            encodeMessage({ proof: hmac(token, `core|${nonceC}`), nonce: nonce() }),
            encodeMessage({ ok: true }),
          ]),
        );
      });
      await expect(connectCore({ path, token })).rejects.toThrow();
      const [squatter] = peers;
      await squatter?.closed;
      expect(squatter?.received).toHaveLength(1);
    });

    it("refuses an oversized step-2 reply", async () => {
      const path = testPath();
      const peers = await rawServer(path, async (p) => {
        await p.frames(1);
        p.socket.write(header(HANDSHAKE_MAX_BYTES + 1));
      });
      await expect(connectCore({ path, token: newToken() })).rejects.toThrow();
      const [squatter] = peers;
      await squatter?.closed;
      expect(squatter?.received).toHaveLength(1);
    });

    it("refuses an oversized confirmation frame", async () => {
      const path = testPath();
      const token = newToken();
      await fakeCore(path, token, (p) => p.socket.write(header(HANDSHAKE_MAX_BYTES + 1)));
      await expect(connectCore({ path, token })).rejects.toThrow();
    });

    it("refuses a confirmation that is not { ok: true }", async () => {
      const path = testPath();
      const token = newToken();
      await fakeCore(path, token, (p) => p.send({ ok: false }));
      await expect(connectCore({ path, token })).rejects.toThrow(/refused/i);
    });

    it("times out against a server that accepts but never replies", async () => {
      const path = testPath();
      await rawServer(path, () => {});
      await expect(connectCore({ path, token: "x", timeoutMs: 100 })).rejects.toThrow(/timed out/i);
    });

    it("times out when the core proves itself but never confirms: the limit covers the whole handshake", async () => {
      const path = testPath();
      const token = newToken();
      await fakeCore(path, token, () => {});
      await expect(connectCore({ path, token, timeoutMs: 200 })).rejects.toThrow(/timed out/i);
    });

    it("rejects when the core closes instead of confirming", async () => {
      const path = testPath();
      const token = newToken();
      await fakeCore(path, token, (p) => p.socket.destroy());
      await expect(connectCore({ path, token })).rejects.toThrow();
    });

    it("keeps a frame pipelined behind { ok: true } in one chunk until onMessage is registered", async () => {
      const path = testPath();
      const token = newToken();
      await fakeCore(path, token, (p) =>
        p.socket.write(Buffer.concat([encodeMessage({ ok: true }), encodeMessage({ pushed: 1 })])),
      );
      const client = await connect({ path, token });
      await sleep(50);
      expect(await nextMessage(client)).toEqual({ pushed: 1 });
    });

    it("keeps a frame a real core sends on connection until onMessage is registered", async () => {
      const path = testPath();
      const token = newToken();
      servers.push(
        await listenCore({ path, token, onConnection: (conn) => conn.send({ pushed: 1 }) }),
      );
      const client = await connect({ path, token });
      await sleep(50);
      expect(await nextMessage(client)).toEqual({ pushed: 1 });
    });

    it("keeps a reply that arrives before onMessage is registered", async () => {
      const path = testPath();
      const token = newToken();
      servers.push(
        await listenCore({
          path,
          token,
          onConnection: (conn) => conn.onMessage((m) => conn.send({ echo: m })),
        }),
      );
      const client = await connect({ path, token });
      client.send({ n: 1 });
      await sleep(50);
      expect(await nextMessage(client)).toEqual({ echo: { n: 1 } });
    });

    it("reports a close that happened before onClose is registered", async () => {
      const path = testPath();
      const token = newToken();
      servers.push(
        await listenCore({
          path,
          token,
          onConnection: (conn) => conn.onMessage(() => conn.close()),
        }),
      );
      const client = await connect({ path, token });
      client.send({ bye: true });
      await sleep(100);
      const closed = vi.fn();
      client.onClose(closed);
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    });

    it("drops a core that sends a frame larger than a host message may be", async () => {
      const path = testPath();
      const token = newToken();
      await fakeCore(path, token, (p) => {
        p.send({ ok: true });
        setTimeout(() => p.socket.write(header(MAX_HOST_MESSAGE_BYTES + 1)), 20);
      });
      const client = await connect({ path, token });
      const closed = vi.fn();
      client.onClose(closed);
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    });
  });
});

describe("connection role", () => {
  const serve = async (token: string, roles: string[]) => {
    const path = testPath();
    const server = await listenCore({
      path,
      token,
      onConnection: (_conn, role) => roles.push(role),
    });
    servers.push(server);
    return path;
  };

  it("reports the role the client declared", async () => {
    const token = newToken();
    const roles: string[] = [];
    const path = await serve(token, roles);
    await connect({ path, token, role: "terminal" });
    await connect({ path, token, role: "relay" });
    await vi.waitFor(() => expect(roles).toEqual(["terminal", "relay"]));
  });

  /** Hand-build step 4 so the frame carries exactly `extra`, which `connectCore` never omits. */
  const roleFromFrame = async (extra: Record<string, unknown>) => {
    const token = newToken();
    const roles: string[] = [];
    const path = await serve(token, roles);
    const client = await rawConnect(path);
    const { nonceC, nonce: nonceS } = await sayHello(client);
    client.send({ proof: hmac(token, `client|${nonceS}|${nonceC}`), ...extra });
    await vi.waitFor(() => expect(roles).toHaveLength(1));
    return roles[0];
  };

  it("treats a client that declares no role as a relay", async () => {
    expect(await roleFromFrame({})).toBe("relay");
  });

  it("reads a hand-built terminal role", async () => {
    expect(await roleFromFrame({ role: "terminal" })).toBe("terminal");
  });

  it.each([
    ["true", true],
    ["null", null],
    ["an array", ["terminal"]],
    ["a case variant", "Terminal"],
  ])("treats a role of %s as a relay", async (_name, role) => {
    expect(await roleFromFrame({ role })).toBe("relay");
  });

  it("treats an unknown role as a relay", async () => {
    const token = newToken();
    const roles: string[] = [];
    const path = await serve(token, roles);
    await connect({ path, token, role: "admin" as never });
    await vi.waitFor(() => expect(roles).toEqual(["relay"]));
  });
});
