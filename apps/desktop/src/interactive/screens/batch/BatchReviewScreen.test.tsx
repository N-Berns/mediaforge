import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { type BatchItem, presetChoice } from "../../batch.ts";
import { type AppDeps, DepsContext } from "../../deps.ts";
import { BatchReviewScreen } from "./BatchReviewScreen.tsx";

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const deps = { version: "9.9.9" } as AppDeps;

const INFO = {
  title: "Clip",
  formats: [{ format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a" }],
};
const mp3 = presetChoice("audio", "mp3");

async function frameOf(items: BatchItem[]) {
  const app = render(
    <DepsContext.Provider value={deps}>
      <BatchReviewScreen items={items} onSelect={() => {}} />
    </DepsContext.Provider>,
  );
  await tick();
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("BatchReviewScreen", () => {
  it("offers to change the type for all when some links could be asked again", async () => {
    const frame = await frameOf([
      { url: "https://a.com/1", info: INFO, choice: mp3 },
      { url: "https://a.com/2", info: INFO, choice: mp3 },
    ]);
    expect(frame).toContain("Change the type and quality for all");
  });

  it("does not offer it when every link was changed on its own, so there is nothing to ask", async () => {
    const frame = await frameOf([
      { url: "https://a.com/1", info: INFO, override: mp3 },
      { url: "https://a.com/2", info: INFO, override: mp3 },
    ]);
    expect(frame).not.toContain("Change the type and quality for all");
    expect(frame).toContain("Start downloading 2 links");
  });
});
