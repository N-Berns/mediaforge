// End to end without a browser: the extension's native client talks through the REAL relay to a
// REAL core pipe (listenCore + connectCore with the token handshake). Only the core's service is a
// small fake, and the browser's native port is a pair of in-memory streams around the relay.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { connectCore, listenCore, newToken } from "../../apps/desktop/src/core/ipc.ts";
import { runRelay } from "../../apps/desktop/src/core/relay.ts";
import { createNativeClient } from "../../apps/extension/src/background/native-client.ts";
import {
  createDecoder,
  encodeMessage,
  MAX_EXTENSION_MESSAGE_BYTES,
  MAX_HOST_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from "../../packages/shared-protocol/src/index.ts";

const pipe = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\mediaforge-it-${randomUUID()}`
    : join(tmpdir(), `mediaforge-it-${randomUUID()}.sock`);

const SETTINGS = { extensionUi: "overlay", keepRunning: false, askQuality: true };
const MEDIA = {
  url: "https://example.com/watch",
  title: "Clip",
  formats: [{ id: "18", label: "360p", hasVideo: true, hasAudio: true }],
};

/** A real core server with a tiny fake service behind it. */
async function startCore(path, token) {
  const conns = new Set();
  const server = await listenCore({
    path,
    token,
    onConnection: (conn) => {
      conns.add(conn);
      conn.onClose(() => conns.delete(conn));
      conn.onMessage((message) => {
        const reply = (type, payload) =>
          conn.send({ v: PROTOCOL_VERSION, id: message.id, type, payload });
        if (message.type === "hello") {
          reply("hello.ack", {
            hostVersion: "0.0.0-test",
            ytDlp: { available: true },
            ffmpeg: { available: true },
            setup: "ready",
            keepRunning: false,
          });
        } else if (message.type === "settings.get") reply("settings.value", SETTINGS);
        else if (message.type === "media.probe") {
          reply("media.info", { ...MEDIA, url: message.payload.url });
        }
      });
    },
  });
  return {
    async stop() {
      for (const conn of conns) conn.close();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/** What `runtime.connectNative` returns, backed by the real relay over in-memory stdio. */
function relayPort(path, token, relays) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const messageListeners = [];
  const disconnectListeners = [];
  const decoder = createDecoder(MAX_HOST_MESSAGE_BYTES);
  let open = true;
  stdout.on("data", (chunk) => {
    for (const message of decoder.push(chunk)) for (const l of messageListeners) l(message);
  });
  const exit = runRelay({
    stdin,
    stdout,
    connect: () => connectCore({ path, token, timeoutMs: 1000 }),
    spawnCore: () => {},
    timeoutMs: 300,
    retryMs: 25,
  }).then(() => {
    // The browser reports a disconnect when the host process exits.
    if (!open) return;
    open = false;
    for (const l of disconnectListeners) l();
  });
  relays.push({ stdin, exit });
  return {
    postMessage(message) {
      stdin.write(encodeMessage(message, MAX_EXTENSION_MESSAGE_BYTES));
    },
    onMessage: { addListener: (cb) => messageListeners.push(cb) },
    onDisconnect: { addListener: (cb) => disconnectListeners.push(cb) },
    disconnect() {
      open = false;
      stdin.end();
    },
  };
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("native client against the real relay and core pipe", () => {
  it("connects, round-trips requests, and reconnects after the core restarts", async () => {
    const path = pipe();
    const token = newToken();
    const relays = [];
    let core = await startCore(path, token);
    cleanups.push(async () => {
      for (const relay of relays) relay.stdin.end();
      await Promise.all(relays.map((relay) => relay.exit));
    });
    cleanups.push(() => core.stop());

    const client = createNativeClient({
      connect: () => relayPort(path, token, relays),
      extensionVersion: "0.0.0-test",
      browser: "firefox",
      retryDelaysMs: [50],
      defaultTimeoutMs: 3000,
    });
    cleanups.push(() => client.stop());
    const states = [];
    client.onState((state) => states.push(state.kind));
    client.start();

    await waitFor(() => client.state().kind === "ready");

    const settings = await client.request("settings.get", {});
    expect(settings).toMatchObject({ type: "settings.value", payload: SETTINGS });

    const info = await client.request("media.probe", { url: "https://example.com/watch" });
    expect(info).toMatchObject({
      type: "media.info",
      payload: { url: "https://example.com/watch", title: "Clip" },
    });

    // The core goes away: the relay reports it and exits, and the client keeps trying.
    await core.stop();
    await waitFor(() => client.state().kind !== "ready");
    expect(relays.length).toBeGreaterThanOrEqual(1);

    core = await startCore(path, token);
    await waitFor(() => client.state().kind === "ready");
    expect(relays.length).toBeGreaterThanOrEqual(2);
    expect(await client.request("settings.get", {})).toMatchObject({ type: "settings.value" });
    expect(states.filter((kind) => kind === "ready").length).toBeGreaterThanOrEqual(2);
  });
});
