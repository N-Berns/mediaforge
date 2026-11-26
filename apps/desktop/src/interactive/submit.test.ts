import { describe, expect, it, vi } from "vitest";
import { inProcessCore } from "../core/in-process.ts";
import { DownloadEngine, type EngineFs } from "../engine/index.ts";
import type { Plan } from "./flow.ts";
import { startPayload, submitPlans } from "./submit.ts";

const URL = "https://example.com/watch?v=abc";
const fs: EngineFs = {
  mkdir: async () => {},
  rename: async () => {},
  rm: async () => {},
  exists: async () => false,
  list: async () => [],
  readText: async () => "",
  writePrivate: async () => {},
};

const plan = (patch: Partial<Plan> = {}): Plan => ({
  url: URL,
  profileId: "mp4-720p",
  kind: "video-audio",
  outputDir: "/dl/Video",
  ...patch,
});

describe("startPayload", () => {
  it("startPayload carries origin, folder, selector, kind, steps and the title", () => {
    const steps = [{ kind: "download" }] as NonNullable<Plan["steps"]>;
    const payload = startPayload(
      plan({ title: "My Video", formatSelector: "137+140", kind: "video", steps }),
      "manager",
    );
    expect(payload).toMatchObject({
      profileId: "mp4-720p",
      outputDir: "/dl/Video",
      origin: "manager",
      kind: "video",
      formatSelector: "137+140",
      plan: steps,
      candidate: { url: URL, pageUrl: URL, pageTitle: "My Video", kind: "video" },
    });
  });

  it("startPayload leaves out a title equal to the URL", () => {
    expect(startPayload(plan({ title: URL }), "menu").candidate.pageTitle).toBeUndefined();
    expect(startPayload(plan(), "menu").candidate.pageTitle).toBeUndefined();
  });
});

describe("submitPlans", () => {
  it("submitPlans returns ids in order and closes the client", async () => {
    const core = inProcessCore({
      createEngine: (onUpdate) =>
        new DownloadEngine({
          resolve: async (tool) => ({ tool, path: `/bin/${tool}`, source: "path" as const }),
          fs,
          onUpdate,
          run: () => new Promise(() => {}),
        }),
    });
    const closes = vi.fn();
    const connect = async () => {
      const client = await core.connectAs("manager")();
      const close = () => {
        closes();
        client.close();
      };
      return { ...client, ack: client.ack, close };
    };
    const result = await submitPlans(
      connect,
      [plan({ title: "One" }), plan({ title: "Two" })],
      "manager",
    );
    expect(result.errors).toEqual([]);
    expect(result.ids).toHaveLength(2);
    expect((await core.service).hasActiveJobs).toBe(true);
    expect(closes).toHaveBeenCalledTimes(1);
  });
});
