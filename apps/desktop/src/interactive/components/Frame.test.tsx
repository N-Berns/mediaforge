import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { type AppDeps, DepsContext } from "../deps.ts";
import { Frame, type Hint } from "./Frame.tsx";

const deps = { version: "9.9.9" } as AppDeps;
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function frame(props: { hints?: Hint[]; ctrlC?: "Quit" | "Cancel" } = {}) {
  const app = render(
    <DepsContext.Provider value={deps}>
      <Frame crumbs={["Home"]} icon="*" title="Title" hints={props.hints ?? []} ctrlC={props.ctrlC}>
        <Text>body</Text>
      </Frame>
    </DepsContext.Provider>,
  );
  await tick();
  const text = app.lastFrame() ?? "";
  app.unmount();
  return text;
}

describe("Frame key hints", () => {
  it("always ends the hints with Ctrl+C Quit", async () => {
    expect(await frame({ hints: [["Esc", "Back"]] })).toMatch(/Esc Back\s+Ctrl\+C Quit/);
  });

  it("shows Ctrl+C even when the screen gives no hints", async () => {
    expect(await frame()).toContain("Ctrl+C Quit");
  });

  it("can say Cancel where Ctrl+C cancels a download", async () => {
    expect(await frame({ ctrlC: "Cancel" })).toContain("Ctrl+C Cancel");
  });

  it("shows Ctrl+C once when the screen already lists it", async () => {
    const text = await frame({ hints: [["Ctrl+C", "Quit"]] });
    expect(text.match(/Ctrl\+C/g)).toHaveLength(1);
  });
});
