import { describe, expect, it, vi } from "vitest";
import { CoreUnavailableError, connectWithAutostart } from "./connect.ts";
import type { Connection } from "./ipc.ts";

const conn = {} as Connection;

describe("connectWithAutostart", () => {
  it("connects without starting a core when one answers", async () => {
    const spawnCore = vi.fn();
    const got = await connectWithAutostart({
      connect: async () => conn,
      spawnCore,
      timeoutMs: 1000,
      retryMs: 1,
    });
    expect(got).toBe(conn);
    expect(spawnCore).not.toHaveBeenCalled();
  });

  it("starts the core once and retries until it answers", async () => {
    const spawnCore = vi.fn();
    let attempts = 0;
    const got = await connectWithAutostart({
      connect: async () => {
        attempts += 1;
        if (attempts < 4) throw new Error("ENOENT");
        return conn;
      },
      spawnCore,
      timeoutMs: 1000,
      retryMs: 1,
    });
    expect(got).toBe(conn);
    expect(spawnCore).toHaveBeenCalledTimes(1);
  });

  it("gives up after the deadline with a clear error", async () => {
    await expect(
      connectWithAutostart({
        connect: async () => {
          throw new Error("ENOENT");
        },
        spawnCore: () => {},
        timeoutMs: 30,
        retryMs: 5,
      }),
    ).rejects.toBeInstanceOf(CoreUnavailableError);
  });
});
