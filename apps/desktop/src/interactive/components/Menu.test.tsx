import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
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
  it("numbers each selectable row and leaves disabled rows blank", () => {
    const app = render(<Menu items={items} onSelect={() => {}} />);
    const frame = app.lastFrame() ?? "";
    expect(frame).toMatch(/► 1 Alpha/);
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
