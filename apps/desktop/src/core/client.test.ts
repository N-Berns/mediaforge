import { PROTOCOL_VERSION } from "@mediaforge/shared-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CoreLostError, CoreRequestError, CoreVersionError, openCoreClient } from "./client.ts";
import type { Connection } from "./ipc.ts";

/** A connection whose far end is a scripted core. */
function scripted(reply: (message: { id: string; type: string }) => unknown[]) {
  let onMessage: (m: unknown) => void = () => {};
  let onClose: () => void = () => {};
  const conn: Connection = {
    send: (m) => {
      for (const r of reply(m as { id: string; type: string })) queueMicrotask(() => onMessage(r));
    },
    onMessage: (h) => {
      onMessage = h;
    },
    onClose: (h) => {
      onClose = h;
    },
    close: () => onClose(),
  };
  return { conn, push: (m: unknown) => onMessage(m), drop: () => onClose() };
}

const ack = (id: string) => ({
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
});

describe("openCoreClient", () => {
  it("says hello as the given client and exposes the ack", async () => {
    const seen: unknown[] = [];
    const { conn } = scripted((m) => {
      seen.push(m);
      return m.type === "hello" ? [ack(m.id)] : [];
    });
    const client = await openCoreClient(conn, { client: "cli" });
    expect(client.ack.hostVersion).toBe("1");
    expect(seen[0]).toMatchObject({ type: "hello", payload: { client: "cli" } });
  });

  it("explains a version mismatch instead of passing on the parser text", async () => {
    const { conn } = scripted((m) => [
      {
        v: PROTOCOL_VERSION,
        id: "e",
        type: "error",
        payload: { code: "invalid-message", message: "v: Invalid input", replyTo: m.id },
      },
    ]);
    await expect(openCoreClient(conn, { client: "cli" })).rejects.toBeInstanceOf(CoreVersionError);
  });

  it("treats a frame with another protocol version as a version mismatch", async () => {
    const { conn } = scripted((m) => [{ ...ack(m.id), v: PROTOCOL_VERSION - 1 }]);
    await expect(openCoreClient(conn, { client: "cli" })).rejects.toBeInstanceOf(CoreVersionError);
  });

  it("rejects a request with the core's error code", async () => {
    const { conn } = scripted((m) =>
      m.type === "hello"
        ? [ack(m.id)]
        : [
            {
              v: PROTOCOL_VERSION,
              id: "e",
              type: "error",
              payload: { code: "forbidden", message: "no", replyTo: m.id },
            },
          ],
    );
    const client = await openCoreClient(conn, { client: "cli" });
    await expect(client.request("settings.reload", {})).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(client.request("settings.reload", {})).rejects.toBeInstanceOf(CoreRequestError);
  });

  it("rejects pending requests with CoreLostError when the connection drops", async () => {
    const s = scripted((m) => (m.type === "hello" ? [ack(m.id)] : []));
    const client = await openCoreClient(s.conn, { client: "cli" });
    const pending = client.request("jobs.list", {});
    s.drop();
    await expect(pending).rejects.toBeInstanceOf(CoreLostError);
  });

  it("reports invalid-message after hello as a request error, not a version mismatch", async () => {
    const { conn } = scripted((m) =>
      m.type === "hello"
        ? [ack(m.id)]
        : [
            {
              v: PROTOCOL_VERSION,
              id: "e",
              type: "error",
              payload: { code: "invalid-message", message: "payload: bad", replyTo: m.id },
            },
          ],
    );
    const client = await openCoreClient(conn, { client: "cli" });
    const failure = await client.request("settings.reload", {}).catch((e) => e);
    expect(failure).toBeInstanceOf(CoreRequestError);
    expect(failure).toMatchObject({ code: "invalid-message" });
  });

  it("closes the connection when hello fails", async () => {
    const { conn } = scripted((m) => [{ ...ack(m.id), v: PROTOCOL_VERSION - 1 }]);
    let closes = 0;
    const close = conn.close;
    conn.close = () => {
      closes += 1;
      close();
    };
    await expect(openCoreClient(conn, { client: "cli" })).rejects.toBeInstanceOf(CoreVersionError);
    expect(closes).toBeGreaterThan(0);
  });

  it("hangs up on a frame with another protocol version and notifies close listeners", async () => {
    const s = scripted((m) => (m.type === "hello" ? [ack(m.id)] : []));
    const client = await openCoreClient(s.conn, { client: "cli" });
    let closed = 0;
    client.onClose(() => {
      closed += 1;
    });
    const pending = client.request("jobs.list", {});
    s.push({ v: PROTOCOL_VERSION - 1, id: "x", type: "download.progress", payload: {} });
    await expect(pending).rejects.toBeInstanceOf(CoreVersionError);
    expect(closed).toBe(1);
  });
});

describe("CoreVersionError", () => {
  const platform = process.platform;
  afterEach(() => Object.defineProperty(process, "platform", { value: platform }));

  it.each([
    ["win32", /Task Manager/],
    ["linux", /Stop the mediaforge process/],
  ])("gives %s advice", (name, advice) => {
    Object.defineProperty(process, "platform", { value: name });
    const { message } = new CoreVersionError();
    expect(message).toMatch(/different version/);
    expect(message).toMatch(advice);
  });
});
