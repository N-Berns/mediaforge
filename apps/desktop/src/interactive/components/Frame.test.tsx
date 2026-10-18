import { Text, useInput } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { type AppDeps, DepsContext } from "../deps.ts";
import { InputHub } from "../mouse/input.ts";
import { MouseProvider } from "../mouse/MouseProvider.tsx";
import { attachTestStdin, clickAt } from "../mouse/testing.ts";
import { type NoticeApi, NoticeContext } from "../notice.tsx";
import { ICONS } from "../theme.ts";
import { Frame, type FrameProps, fitHints, type Hint } from "./Frame.tsx";

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

describe("Frame notice", () => {
  it("shows a paused notice with the paused icon", async () => {
    const notices: NoticeApi = {
      notice: { id: 1, kind: "paused", text: "Downloads paused" },
      notify: () => {},
      seen: () => {},
      clear: () => {},
    };
    const app = render(
      <DepsContext.Provider value={deps}>
        <NoticeContext.Provider value={notices}>
          <Frame crumbs={["Home"]} icon="*" title="Title" hints={[]}>
            <Text>body</Text>
          </Frame>
        </NoticeContext.Provider>
      </DepsContext.Provider>,
    );
    await tick();
    const text = app.lastFrame() ?? "";
    app.unmount();
    expect(text).toContain(`${ICONS.paused} Downloads paused`);
    expect(text).not.toContain(`${ICONS.warn} Downloads paused`);
  });
});

function KeySpy({ keys }: { keys: string[] }) {
  useInput((input, key) => {
    keys.push(key.escape ? "esc" : key.ctrl && input === "c" ? "ctrl+c" : input);
  });
  return null;
}

/**
 * The double-click clock moves 1 s on every read, so no two clicks are ever a double-click:
 * the hint tests do not depend on how fast the test machine runs.
 */
function hinted(keys: string[], props: Partial<FrameProps> = {}) {
  const hub = new InputHub();
  let time = 0;
  const now = () => {
    time += 1000;
    return time;
  };
  const app = render(
    <MouseProvider hub={hub} now={now}>
      <DepsContext.Provider value={deps}>
        <Frame
          crumbs={["Home"]}
          icon="*"
          title="T"
          hints={[
            ["Esc", "Back"],
            ["↑↓", "Move"],
          ]}
          {...props}
        >
          <KeySpy keys={keys} />
        </Frame>
      </DepsContext.Provider>
    </MouseProvider>,
  );
  attachTestStdin(hub, app.stdin);
  const hintLine = () => (app.lastFrame() ?? "").split("\n").at(-1) ?? "";
  const lineY = () => (app.lastFrame() ?? "").split("\n").length - 1;
  return { app, hintLine, lineY };
}

describe("Frame hints and the mouse", () => {
  it("a click on a hint types its key", async () => {
    const keys: string[] = [];
    const { app, hintLine, lineY } = hinted(keys);
    await tick();
    app.stdin.write(clickAt(hintLine().indexOf("Esc"), lineY()));
    await vi.waitFor(() => expect(keys).toEqual(["esc"]));
  });

  it("a hint for several keys does nothing", async () => {
    const keys: string[] = [];
    const { app, hintLine, lineY } = hinted(keys);
    await tick();
    app.stdin.write(clickAt(hintLine().indexOf("↑↓"), lineY()));
    await tick(80);
    expect(keys).toEqual([]);
  });

  it("the Ctrl+C hint asks first; n answers No and reaches no screen", async () => {
    const keys: string[] = [];
    const { app, hintLine, lineY } = hinted(keys);
    await tick();
    app.stdin.write(clickAt(hintLine().indexOf("Ctrl+C"), lineY()));
    await vi.waitFor(() => expect(hintLine()).toContain("y/N  Quit MediaForge?"));
    app.stdin.write("n");
    await vi.waitFor(() => expect(hintLine()).toContain("Esc"));
    expect(keys).toEqual([]);
  });

  it("y (key or click) sends Ctrl+C", async () => {
    const keys: string[] = [];
    const { app, hintLine, lineY } = hinted(keys, { ctrlC: "Cancel" });
    await tick();
    app.stdin.write(clickAt(hintLine().indexOf("Ctrl+C"), lineY()));
    await vi.waitFor(() => expect(hintLine()).toContain("y/N  Cancel the download?"));
    app.stdin.write(clickAt(hintLine().indexOf("y"), lineY()));
    await vi.waitFor(() => expect(keys).toEqual(["ctrl+c"]));
  });

  it("a click elsewhere answers No; Ctrl+C on the keyboard still goes through", async () => {
    const keys: string[] = [];
    const { app, hintLine, lineY } = hinted(keys, { ctrlCQuestion: "Cancel all downloads?" });
    await tick(80);
    app.stdin.write(clickAt(hintLine().indexOf("Ctrl+C"), lineY()));
    await vi.waitFor(() => expect(hintLine()).toContain("Cancel all downloads?"));
    app.stdin.write(clickAt(0, 0));
    await vi.waitFor(() => expect(hintLine()).toContain("Esc"));
    expect(keys).toEqual([]);
    app.stdin.write(clickAt(hintLine().indexOf("Ctrl+C"), lineY()));
    await vi.waitFor(() => expect(hintLine()).toContain("Cancel all downloads?"));
    app.stdin.write("\u0003");
    await vi.waitFor(() => expect(keys).toEqual(["ctrl+c"]));
  });
});

describe("fitHints", () => {
  const hints: Hint[] = [
    ["↑↓", "Move"],
    ["Enter", "Select"],
    ["Esc", "Back"],
  ];
  const last: Hint = ["Ctrl+C", "Quit"];

  it("keeps every hint when they fit", () => {
    expect(fitHints(hints, last, 80)).toEqual([...hints, last]);
  });

  it("drops hints from the end, never Ctrl+C, when the window is narrow", () => {
    expect(fitHints(hints, last, 35)).toEqual([hints[0], hints[1], last]);
    expect(fitHints(hints, last, 33)).toEqual([hints[0], last]);
    expect(fitHints(hints, last, 10)).toEqual([last]);
  });
});

describe("Frame logo", () => {
  const logoColumn = async (columns: number, rows?: number) => {
    const app = render(
      <DepsContext.Provider value={deps}>
        <Frame crumbs={["Home"]} icon="*" title="Title" hints={[]}>
          <Text>body</Text>
        </Frame>
      </DepsContext.Provider>,
    );
    // The test stdout reports a fixed size through getters; an own property overrides them.
    Object.defineProperty(app.stdout, "columns", { value: columns, configurable: true });
    if (rows !== undefined)
      Object.defineProperty(app.stdout, "rows", { value: rows, configurable: true });
    app.stdout.emit("resize");
    await tick(250);
    const lines = (app.lastFrame() ?? "").split("\n");
    app.unmount();
    return lines;
  };

  it("stays in the middle of a window wider than the frame", async () => {
    const lines = await logoColumn(160);
    const first = lines.find((line) => line.includes("█▀▄▀█")) ?? "";
    // 121 spare columns: 60 on one side, 61 on the other.
    expect(Math.abs(first.indexOf("█▀▄▀█") - 60.5)).toBeLessThanOrEqual(0.5);
  });

  it("falls back to the one-line name in a short window", async () => {
    const lines = await logoColumn(100, 20);
    expect(lines.some((line) => line.includes("█▀▄▀█"))).toBe(false);
    expect(lines.some((line) => line.includes("MediaForge"))).toBe(true);
  });
});
