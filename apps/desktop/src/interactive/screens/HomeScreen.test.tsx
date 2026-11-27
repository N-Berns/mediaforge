import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { type AppDeps, DepsContext } from "../deps.ts";
import { HomeScreen } from "./HomeScreen.tsx";

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const deps = { version: "9.9.9" } as AppDeps;

function mount(onPick: (choice: string) => void) {
  return render(
    <DepsContext.Provider value={deps}>
      <HomeScreen onPick={onPick} />
    </DepsContext.Provider>,
  );
}

describe("HomeScreen quit confirmation", () => {
  it("quits on Y after Esc", async () => {
    const onPick = vi.fn();
    const app = mount(onPick);
    await tick();
    app.stdin.write("\u001B");
    await tick();
    expect(app.lastFrame()).toContain("Quit MediaForge?");
    app.stdin.write("y");
    await tick();
    expect(onPick).toHaveBeenCalledWith("quit");
    app.unmount();
  });

  it("stays on Esc, N or Enter", async () => {
    for (const key of ["n", "\u001B", "\r"]) {
      const onPick = vi.fn();
      const app = mount(onPick);
      await tick();
      app.stdin.write("\u001B");
      await tick();
      app.stdin.write(key);
      await tick();
      expect(onPick).not.toHaveBeenCalled();
      expect(app.lastFrame()).toContain("What would you like to do?");
      app.unmount();
    }
  });
});

describe("HomeScreen items", () => {
  it("lists Downloads second", async () => {
    const onPick = vi.fn();
    const app = mount(onPick);
    await tick();
    const frame = app.lastFrame() ?? "";
    const download = frame.indexOf("Download media");
    const downloads = frame.indexOf("Downloads");
    const settings = frame.indexOf("Settings");
    expect(download).toBeGreaterThan(-1);
    expect(downloads).toBeGreaterThan(download);
    expect(settings).toBeGreaterThan(downloads);
    app.stdin.write("\u001B[B");
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(onPick).toHaveBeenCalledWith("downloads");
    app.unmount();
  });
});
