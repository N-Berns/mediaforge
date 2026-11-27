import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { EngineJob } from "../../../engine/index.ts";
import { type AppDeps, DepsContext } from "../../deps.ts";
import { ICONS } from "../../theme.ts";
import { BatchResultScreen } from "./BatchResultScreen.tsx";

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const deps = { version: "9.9.9" } as AppDeps;

const job = (status: EngineJob["status"], outputPath?: string): EngineJob => ({
  id: status,
  request: {
    candidate: {
      id: "u",
      pageUrl: "https://e.com/v",
      url: "https://e.com/v",
      kind: "video",
      streamType: "progressive",
      source: "dom",
      variants: [],
      detectedAt: 0,
    },
    profileId: "best",
  },
  status,
  ...(outputPath && { outputPath }),
  progress: { bytesDownloaded: 0 },
  createdAt: 0,
  updatedAt: 0,
});

describe("BatchResultScreen", () => {
  it("shows a paused link as paused, not as a failure", async () => {
    const app = render(
      <DepsContext.Provider value={deps}>
        <BatchResultScreen
          plans={[
            {
              url: "https://a.com/1",
              title: "First",
              profileId: "best",
              kind: "video-audio",
              outputDir: "/dl",
            },
            {
              url: "https://a.com/2",
              title: "Second",
              profileId: "best",
              kind: "video-audio",
              outputDir: "/dl",
            },
          ]}
          jobs={[job("completed", "/dl/First.mp4"), job("paused")]}
          onAction={() => {}}
        />
      </DepsContext.Provider>,
    );
    await tick();
    const frame = app.lastFrame() ?? "";
    app.unmount();
    expect(frame).toContain("1 of 2 saved");
    expect(frame).toContain("paused");
    expect(frame).not.toContain("Something went wrong.");
  });

  it("marks a paused link with the paused icon and a cancelled one with the stop icon", async () => {
    const app = render(
      <DepsContext.Provider value={deps}>
        <BatchResultScreen
          plans={[
            {
              url: "https://a.com/1",
              title: "First",
              profileId: "best",
              kind: "video-audio",
              outputDir: "/dl",
            },
            {
              url: "https://a.com/2",
              title: "Second",
              profileId: "best",
              kind: "video-audio",
              outputDir: "/dl",
            },
          ]}
          jobs={[job("paused"), job("cancelled")]}
          onAction={() => {}}
        />
      </DepsContext.Provider>,
    );
    await tick();
    const frame = app.lastFrame() ?? "";
    app.unmount();
    expect(frame).toContain(`${ICONS.paused} First`);
    expect(frame).toContain(`${ICONS.stop} Second`);
    expect(frame).toMatch(/First\s+paused/);
    expect(frame).toMatch(/Second\s+cancelled/);
  });
});
