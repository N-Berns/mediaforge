import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { InputHub } from "../mouse/input.ts";
import { MouseProvider } from "../mouse/MouseProvider.tsx";
import { attachTestStdin, clickAt, moveAt, wheelAt } from "../mouse/testing.ts";
import { dividerItem, Menu, type MenuItem } from "./Menu.tsx";
import { TextField } from "./TextField.tsx";
import { ENTER_LOCK_MS } from "./use-enter-lock.ts";

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = "\r";

const items: MenuItem<string>[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Bravo" },
  { value: "c", label: "Charlie", disabled: true },
];

describe("Menu number labels", () => {
  it("reports the highlighted value as it moves", async () => {
    const seen: string[] = [];
    const app = render(
      <Menu<string>
        items={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
        onSelect={() => {}}
        onHighlight={(value) => seen.push(value)}
      />,
    );
    await tick();
    app.stdin.write("\u001B[B");
    await tick();
    expect(seen).toEqual(["a", "b"]);
    app.unmount();
  });

  it("numbers each selectable row and leaves disabled rows blank", () => {
    const app = render(<Menu items={items} onSelect={() => {}} />);
    const frame = app.lastFrame() ?? "";
    expect(frame).toMatch(/> 1 Alpha/);
    expect(frame).toMatch(/ {2}2 Bravo/);
    expect(frame).not.toMatch(/3 Charlie/);
    app.unmount();
  });

  it("shows no numbers when the menu is too long for number keys", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ value: `v${i}`, label: `Row ${i}` }));
    const app = render(<Menu items={many} onSelect={() => {}} />);
    expect(app.lastFrame()).not.toMatch(/1 Row 0/);
    expect(app.lastFrame()).toContain("Row 0");
    app.unmount();
  });
});

describe("Menu divider", () => {
  const grouped: MenuItem<string>[] = [
    { value: "go", label: "Go" },
    dividerItem("-"),
    { value: "a", label: "Alpha" },
    { value: "b", label: "Bravo" },
  ];

  it("draws a line between groups and numbers the rows without a gap", () => {
    const app = render(<Menu items={grouped} onSelect={() => {}} />);
    const lines = (app.lastFrame() ?? "").split("\n");
    expect(lines.findIndex((l) => l.includes("Go"))).toBe(
      lines.findIndex((l) => l.includes("─")) - 1,
    );
    expect(app.lastFrame()).toMatch(/ {2}2 Alpha/);
    expect(app.lastFrame()).toMatch(/ {2}3 Bravo/);
    app.unmount();
  });

  it("skips the divider with the arrow keys and the number keys", async () => {
    const onSelect = vi.fn();
    const app = render(<Menu items={grouped} onSelect={onSelect} />);
    await tick();
    app.stdin.write("\u001B[B");
    await tick();
    app.stdin.write(ENTER);
    await tick(20);
    expect(onSelect).toHaveBeenCalledWith("a");
    await tick(ENTER_LOCK_MS + 60);
    app.stdin.write("3");
    await tick(20);
    expect(onSelect).toHaveBeenLastCalledWith("b");
    app.unmount();
  });
});

describe("double Enter", () => {
  it("selects a menu row once", async () => {
    const onSelect = vi.fn();
    const app = render(<Menu items={items} onSelect={onSelect} />);
    await tick();
    app.stdin.write(ENTER);
    await tick(20);
    app.stdin.write(ENTER);
    await tick(20);
    expect(onSelect).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it("counts a number key and an Enter as one choice", async () => {
    const onSelect = vi.fn();
    const app = render(<Menu items={items} onSelect={onSelect} />);
    await tick();
    app.stdin.write("2");
    await tick(20);
    app.stdin.write(ENTER);
    await tick(20);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("b");
    app.unmount();
  });

  it("accepts another choice once the lock has passed", async () => {
    const onSelect = vi.fn();
    const app = render(<Menu items={items} onSelect={onSelect} />);
    await tick();
    app.stdin.write(ENTER);
    await tick(ENTER_LOCK_MS + 60);
    app.stdin.write(ENTER);
    await tick(20);
    expect(onSelect).toHaveBeenCalledTimes(2);
    app.unmount();
  });

  it("does not start the lock for a disabled row", async () => {
    const onSelect = vi.fn();
    const app = render(<Menu items={items} onSelect={onSelect} />);
    await tick();
    app.stdin.write("3");
    await tick(20);
    app.stdin.write("1");
    await tick(20);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("a");
    app.unmount();
  });

  it("submits a text field once", async () => {
    const onSubmit = vi.fn();
    const app = render(<TextField initial="hello" onSubmit={onSubmit} onCancel={() => {}} />);
    await tick();
    app.stdin.write(ENTER);
    await tick(90);
    app.stdin.write(ENTER);
    await tick(90);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("hello");
    app.unmount();
  });
});

/** `now` is the clock the double-click check reads; tests move it by hand. */
function withMouse(tree: ReactElement, now: () => number = () => 0) {
  const hub = new InputHub();
  const app = render(
    <MouseProvider hub={hub} now={now}>
      {tree}
    </MouseProvider>,
  );
  attachTestStdin(hub, app.stdin);
  return app;
}

describe("Menu mouse", () => {
  const four: MenuItem<string>[] = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Bravo" },
    { value: "c", label: "Charlie", disabled: true },
    { value: "d", label: "Delta" },
  ];

  it("a click highlights, a double-click picks", async () => {
    const onSelect = vi.fn();
    const app = withMouse(<Menu items={four} onSelect={onSelect} />);
    await tick();
    app.stdin.write(clickAt(4, 1));
    await vi.waitFor(() => expect(app.lastFrame()).toMatch(/> 2 Bravo/));
    expect(onSelect).not.toHaveBeenCalled();
    app.stdin.write(clickAt(4, 1));
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("b"));
  });

  it("two slow clicks are two single clicks", async () => {
    let clock = 0;
    const onSelect = vi.fn();
    const app = withMouse(<Menu items={four} onSelect={onSelect} />, () => clock);
    await tick();
    app.stdin.write(clickAt(4, 1));
    await vi.waitFor(() => expect(app.lastFrame()).toMatch(/> 2 Bravo/));
    clock = 1000;
    app.stdin.write(clickAt(4, 1));
    await tick();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a double-click that scrolls the list picks nothing it did not first highlight", async () => {
    const ten: MenuItem<string>[] = [..."abcdefghij"].map((value) => ({
      value,
      label: value.toUpperCase(),
    }));
    const onSelect = vi.fn();
    const app = withMouse(<Menu items={ten} onSelect={onSelect} maxVisible={5} />);
    await tick();
    // Rows 0-4 show a-e. The first click highlights e and scrolls the window, so the second
    // press of the double-click lands on f.
    app.stdin.write(clickAt(2, 4));
    await vi.waitFor(() => expect(app.lastFrame()).toMatch(/more above[\s\S]*> E/));
    app.stdin.write(clickAt(2, 4));
    await vi.waitFor(() => expect(app.lastFrame()).toMatch(/> F/));
    await tick();
    expect(onSelect).not.toHaveBeenCalled();
    // A double-click on the row that is already highlighted picks it.
    const at = (app.lastFrame() ?? "").split("\n").findIndex((line) => line.includes("> F"));
    app.stdin.write(clickAt(2, at));
    app.stdin.write(clickAt(2, at));
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("f"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks on disabled rows", async () => {
    const app = withMouse(<Menu items={four} onSelect={() => {}} />);
    await tick();
    app.stdin.write(clickAt(4, 2));
    await tick();
    expect(app.lastFrame()).toMatch(/> 1 Alpha/);
  });

  it("hover does not move the highlight", async () => {
    const onSelect = vi.fn();
    const app = withMouse(<Menu items={four} onSelect={onSelect} />);
    await tick();
    app.stdin.write(moveAt(4, 3));
    await tick(60);
    expect(app.lastFrame()).toMatch(/> 1 Alpha/);
    app.stdin.write(ENTER);
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("a"));
  });

  it("disabled rows take no clicks", async () => {
    const app = withMouse(<Menu items={four} onSelect={() => {}} />);
    await tick();
    app.stdin.write(clickAt(4, 2));
    app.stdin.write(clickAt(4, 2));
    await tick(60);
    expect(app.lastFrame()).toMatch(/> 1 Alpha/);
  });

  it("the wheel moves the highlight, skipping disabled rows", async () => {
    const app = withMouse(<Menu items={four} onSelect={() => {}} />);
    await tick();
    app.stdin.write(wheelAt(4, 0, 1));
    app.stdin.write(wheelAt(4, 0, 1));
    await vi.waitFor(() => expect(app.lastFrame()).toMatch(/> 4 Delta/));
  });
});

describe("TextField mouse", () => {
  it("a click puts the cursor on the clicked character", async () => {
    const onSubmit = vi.fn();
    const app = withMouse(<TextField initial="abcdef" onSubmit={onSubmit} onCancel={() => {}} />);
    await tick();
    // Border (1) + padding (1) + "> " (2): the text starts at column 4. Column 6 is "c".
    app.stdin.write(clickAt(6, 1));
    await tick();
    app.stdin.write("X");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("abXcdef"));
  });
});
