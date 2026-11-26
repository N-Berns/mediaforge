import { ToolInstallError } from "@mediaforge/binary-resolver";
import { describe, expect, it } from "vitest";
import { makeRuntime } from "../test-runtime.ts";
import type { ToolRuntime } from "../tool-runtime.ts";
import { REFRESH_RETRY_MS, startProvisioning } from "./provisioner.ts";

describe("startProvisioning", () => {
  it("is ready at once when every tool is present", async () => {
    const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
    const result = await startProvisioning(rt).ready();
    expect(result.state).toBe("ready");
    expect(log.installed).toEqual([]);
  });

  it("downloads missing tools without asking, and reports progress", async () => {
    const { rt, log } = makeRuntime({ present: ["deno"], interactive: false });
    const provisioner = startProvisioning(rt);
    const seen: string[] = [];
    provisioner.onChange((s) => seen.push(`${s.state}:${s.tool ?? ""}`));
    const result = await provisioner.ready();
    expect(result.state).toBe("ready");
    expect(log.installed.sort()).toEqual(["ffmpeg", "yt-dlp"]);
    expect(log.asked).toEqual([]);
    expect(seen).toContain("installing:yt-dlp");
  });

  it("fails when a required tool cannot be installed", async () => {
    const { rt } = makeRuntime({
      present: ["deno"],
      installError: new ToolInstallError("offline", "Could not reach github.com.", "Check it."),
    });
    const result = await startProvisioning(rt).ready();
    expect(result.state).toBe("failed");
    expect(result.error).toContain("Could not reach github.com.");
  });

  it("reports failed instead of rejecting when the lookup itself breaks", async () => {
    const { rt } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
    const broken = {
      ...rt,
      resolve: async () => {
        throw new Error("disk went away");
      },
    };
    const provisioner = startProvisioning(broken);
    const result = await provisioner.ready();
    expect(result.state).toBe("failed");
    expect(result.error).toContain("disk went away");
    expect(provisioner.status()).toEqual(result);
  });

  it("ignores a failed optional tool", async () => {
    const { rt, present } = makeRuntime({
      present: ["yt-dlp", "ffmpeg"],
      installError: new ToolInstallError("offline", "no", "no"),
    });
    expect(present.has("deno")).toBe(false);
    const result = await startProvisioning(rt).ready();
    expect(result.state).toBe("ready");
  });

  it("refreshes yt-dlp when the stamp is stale, and stamps it", async () => {
    const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
    let stamped = false;
    await startProvisioning(rt, {
      refresh: {
        stale: async () => true,
        stamp: async () => {
          stamped = true;
        },
      },
    }).ready();
    expect(log.installed).toEqual(["yt-dlp"]);
    expect(log.installOptions).toEqual([{ channel: "stable" }]);
    expect(stamped).toBe(true);
  });

  it("does not refresh when the stamp is fresh, and survives a failed refresh", async () => {
    const fresh = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
    await startProvisioning(fresh.rt, {
      refresh: { stale: async () => false, stamp: async () => {} },
    }).ready();
    expect(fresh.log.installed).toEqual([]);

    const broken = makeRuntime({
      present: ["yt-dlp", "ffmpeg", "deno"],
      installError: new ToolInstallError("offline", "no", "no"),
    });
    const result = await startProvisioning(broken.rt, {
      refresh: { stale: async () => true, stamp: async () => {} },
    }).ready();
    expect(result.state).toBe("ready");
  });

  it("does not download yt-dlp a second time right after installing it", async () => {
    const { rt, log } = makeRuntime({ present: [] });
    let stamps = 0;
    const result = await startProvisioning(rt, {
      // A missing stamp counts as stale, which is exactly the first-run case.
      refresh: {
        stale: async () => true,
        stamp: async () => {
          stamps += 1;
        },
      },
    }).ready();
    expect(result.state).toBe("ready");
    expect(log.installed.filter((tool) => tool === "yt-dlp")).toEqual(["yt-dlp"]);
    expect(stamps).toBe(1);
  });

  it("survives a failed stamp after a fresh install", async () => {
    const { rt, log } = makeRuntime({ present: ["ffmpeg", "deno"] });
    const result = await startProvisioning(rt, {
      refresh: {
        stale: async () => true,
        stamp: async () => {
          throw new Error("settings file is read-only");
        },
      },
    }).ready();
    expect(result.state).toBe("ready");
    expect(log.installed).toEqual(["yt-dlp"]);
  });

  it("still refreshes yt-dlp when only another tool was installed", async () => {
    const { rt, log } = makeRuntime({ present: ["yt-dlp", "deno"] });
    let stamps = 0;
    await startProvisioning(rt, {
      refresh: {
        stale: async () => true,
        stamp: async () => {
          stamps += 1;
        },
      },
    }).ready();
    expect(log.installed).toEqual(["ffmpeg", "yt-dlp"]);
    expect(stamps).toBe(1);
  });

  describe("refreshIfStale", () => {
    /** A refresh option whose staleness the test sets, counting stamps. */
    const refreshOption = (stale: boolean) => {
      const state = { stale, stamps: 0 };
      return {
        state,
        refresh: {
          stale: async () => state.stale,
          stamp: async () => {
            state.stamps += 1;
          },
        },
      };
    };

    it("does nothing without a refresh option", async () => {
      const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
      const provisioner = startProvisioning(rt);
      await provisioner.ready();
      await provisioner.refreshIfStale();
      expect(log.installed).toEqual([]);
    });

    it("does nothing while the stamp is fresh", async () => {
      const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
      const { refresh } = refreshOption(false);
      const provisioner = startProvisioning(rt, { refresh });
      await provisioner.ready();
      await provisioner.refreshIfStale();
      expect(log.installed).toEqual([]);
    });

    it("downloads yt-dlp again once the stamp is stale, stamps it, and is ready again", async () => {
      const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
      const option = refreshOption(false);
      const provisioner = startProvisioning(rt, { refresh: option.refresh });
      await provisioner.ready();
      option.state.stale = true;
      const seen: string[] = [];
      provisioner.onChange((s) => seen.push(`${s.state}:${s.phase ?? ""}`));
      await provisioner.refreshIfStale();
      expect(log.installed).toEqual(["yt-dlp"]);
      expect(log.installOptions).toEqual([{ channel: "stable" }]);
      expect(option.state.stamps).toBe(1);
      expect(seen).toEqual(["installing:refreshing", "ready:"]);
      expect(provisioner.status()).toEqual({ state: "ready" });
    });

    it("never rejects, keeps the copy it has, and goes back to its last status on failure", async () => {
      const { rt } = makeRuntime({
        present: ["yt-dlp", "ffmpeg", "deno"],
        installError: new ToolInstallError("offline", "no", "no"),
      });
      const option = refreshOption(false);
      const provisioner = startProvisioning(rt, { refresh: option.refresh });
      await provisioner.ready();
      option.state.stale = true;
      await expect(provisioner.refreshIfStale()).resolves.toBeUndefined();
      expect(option.state.stamps).toBe(0);
      expect(provisioner.status()).toEqual({ state: "ready" });
    });

    it("never rejects when the staleness check itself throws", async () => {
      const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
      let calls = 0;
      const provisioner = startProvisioning(rt, {
        refresh: {
          stale: async () => {
            calls += 1;
            if (calls > 1) throw new Error("EACCES");
            return false;
          },
          stamp: async () => {},
        },
      });
      await provisioner.ready();
      await expect(provisioner.refreshIfStale()).resolves.toBeUndefined();
      expect(log.installed).toEqual([]);
    });

    it("does nothing while setup is still installing", async () => {
      const { rt, log } = makeRuntime({ present: ["ffmpeg", "deno"] });
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow: ToolRuntime = {
        ...rt,
        install: async (tool, onProgress) => {
          await gate;
          return rt.install(tool, onProgress);
        },
      };
      const { refresh } = refreshOption(true);
      const provisioner = startProvisioning(slow, { refresh });
      expect(provisioner.status().state).toBe("installing");
      await provisioner.refreshIfStale();
      release();
      await provisioner.ready();
      // Only the first-run install: the refresh during it did nothing.
      expect(log.installed).toEqual(["yt-dlp"]);
    });

    /** A runtime whose yt-dlp install counts attempts and fails while `state.failing` is set. */
    const flaky = (present: ("yt-dlp" | "ffmpeg" | "deno")[], failing: boolean) => {
      const { rt } = makeRuntime({ present });
      const state = { failing, attempts: 0 };
      const wrapped: ToolRuntime = {
        ...rt,
        install: async (tool, onProgress) => {
          if (tool === "yt-dlp") state.attempts += 1;
          if (tool === "yt-dlp" && state.failing) {
            throw new ToolInstallError("offline", "no", "no");
          }
          return rt.install(tool, onProgress);
        },
      };
      return { rt: wrapped, state };
    };

    it("does not retry a failed refresh within an hour, then retries", async () => {
      const { rt, state } = flaky(["yt-dlp", "ffmpeg", "deno"], true);
      let clock = 1_000_000;
      const option = refreshOption(false);
      const provisioner = startProvisioning(rt, { refresh: option.refresh, now: () => clock });
      await provisioner.ready();
      option.state.stale = true;
      await provisioner.refreshIfStale();
      expect(state.attempts).toBe(1);
      clock += REFRESH_RETRY_MS - 1;
      await provisioner.refreshIfStale();
      expect(state.attempts).toBe(1);
      clock += 1;
      await provisioner.refreshIfStale();
      expect(state.attempts).toBe(2);
    });

    it("ends ready after a successful refresh", async () => {
      const { rt, state } = flaky(["yt-dlp", "ffmpeg", "deno"], false);
      const option = refreshOption(false);
      const provisioner = startProvisioning(rt, { refresh: option.refresh });
      await provisioner.ready();
      option.state.stale = true;
      await provisioner.refreshIfStale();
      expect(state.attempts).toBe(1);
      expect(option.state.stamps).toBe(1);
      expect(provisioner.status()).toEqual({ state: "ready" });
    });

    it("does not hide a failed setup behind a successful refresh", async () => {
      const { rt, state } = flaky(["ffmpeg", "deno"], true);
      const option = refreshOption(true);
      const provisioner = startProvisioning(rt, { refresh: option.refresh });
      const failed = await provisioner.ready();
      expect(failed.state).toBe("failed");
      state.failing = false;
      await provisioner.refreshIfStale();
      expect(option.state.stamps).toBe(1);
      expect(provisioner.status()).toEqual(failed);
    });

    it("runs one refresh at a time", async () => {
      const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
      const option = refreshOption(false);
      const provisioner = startProvisioning(rt, { refresh: option.refresh });
      await provisioner.ready();
      option.state.stale = true;
      await Promise.all([provisioner.refreshIfStale(), provisioner.refreshIfStale()]);
      expect(log.installed).toEqual(["yt-dlp"]);
    });
  });

  describe("listeners", () => {
    it("keeps going when a listener throws, and still reaches the others", async () => {
      const { rt } = makeRuntime({ present: ["ffmpeg", "deno"] });
      const provisioner = startProvisioning(rt);
      provisioner.onChange(() => {
        throw new Error("listener bug");
      });
      const seen: string[] = [];
      const currentWhenCalled: boolean[] = [];
      provisioner.onChange((status) => {
        // Listener errors are swallowed, so record this and assert after the run.
        currentWhenCalled.push(provisioner.status() === status);
        seen.push(status.state);
      });
      const result = await provisioner.ready();
      expect(result.state).toBe("ready");
      expect(seen.at(-1)).toBe("ready");
      expect(seen).toContain("installing");
      expect(currentWhenCalled.every(Boolean)).toBe(true);
    });

    it("reports the real failure even when a listener throws", async () => {
      const { rt } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
      const broken: ToolRuntime = {
        ...rt,
        resolve: async () => {
          throw new Error("disk went away");
        },
      };
      const provisioner = startProvisioning(broken);
      provisioner.onChange(() => {
        throw new Error("listener bug");
      });
      const result = await provisioner.ready();
      expect(result.state).toBe("failed");
      expect(result.error).toContain("disk went away");
    });

    it("stops delivering after the listener unsubscribes", async () => {
      const { rt } = makeRuntime({ present: ["ffmpeg", "deno"] });
      const provisioner = startProvisioning(rt);
      const first: string[] = [];
      const second: string[] = [];
      const stop = provisioner.onChange((status) => {
        first.push(status.state);
        stop();
      });
      provisioner.onChange((status) => second.push(status.state));
      await provisioner.ready();
      expect(first).toEqual(["installing"]);
      expect(second.length).toBeGreaterThan(1);
      expect(second.at(-1)).toBe("ready");
    });
  });
});
