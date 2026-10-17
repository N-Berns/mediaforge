import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { InputHub } from "./input.ts";
import { Clickable, type MouseClick, MouseProvider } from "./MouseProvider.tsx";
import { attachTestStdin, clickAt, pressAt, wheelAt } from "./testing.ts";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function mount(tree: ReactNode, now?: () => number) {
  const hub = new InputHub();
  const app = render(
    <MouseProvider hub={hub} {...(now && { now })}>
      {tree}
    </MouseProvider>,
  );
  attachTestStdin(hub, app.stdin);
  return app;
}

describe("MouseProvider", () => {
  it("sends a press to the smallest box under it, with local coordinates", async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const app = mount(
      <Clickable flexDirection="column" onClick={outer}>
        <Text>line one</Text>
        <Box paddingLeft={2}>
          <Clickable onClick={inner}>
            <Text>inner</Text>
          </Clickable>
        </Box>
      </Clickable>,
    );
    await tick();
    app.stdin.write(clickAt(3, 1));
    await vi.waitFor(() => expect(inner).toHaveBeenCalledTimes(1));
    expect(inner.mock.calls[0]?.[0]).toMatchObject({ x: 3, y: 1, localX: 1, localY: 0 });
    expect(outer).not.toHaveBeenCalled();
    app.stdin.write(clickAt(0, 0));
    await vi.waitFor(() => expect(outer).toHaveBeenCalledTimes(1));
  });

  it("ignores presses on no box, releases, and inactive boxes", async () => {
    const onClick = vi.fn();
    const app = mount(
      <Box flexDirection="column">
        <Clickable onClick={onClick} active={false}>
          <Text>off</Text>
        </Clickable>
        <Text>nothing</Text>
      </Box>,
    );
    await tick();
    app.stdin.write(clickAt(0, 0));
    app.stdin.write(clickAt(0, 1));
    await tick();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("marks the second press on the same cell within 400 ms as double", async () => {
    let time = 1000;
    const clicks: MouseClick[] = [];
    const app = mount(
      <Clickable onClick={(c) => clicks.push(c)}>
        <Text>target</Text>
      </Clickable>,
      () => time,
    );
    await tick();
    app.stdin.write(clickAt(1, 0));
    time += 300;
    app.stdin.write(clickAt(1, 0));
    time += 100;
    app.stdin.write(clickAt(1, 0));
    time += 500;
    app.stdin.write(clickAt(1, 0));
    await vi.waitFor(() =>
      expect(clicks.map((c) => c.double)).toEqual([false, true, false, false]),
    );
  });

  it("fast clicks on different cells are not a double-click", async () => {
    const clicks: MouseClick[] = [];
    const time = 1000;
    const app = mount(
      <Clickable flexDirection="column" onClick={(c) => clicks.push(c)}>
        <Text>row one</Text>
        <Text>row two</Text>
      </Clickable>,
      () => time,
    );
    await tick();
    app.stdin.write(clickAt(1, 0));
    app.stdin.write(clickAt(1, 1));
    await vi.waitFor(() => expect(clicks.map((c) => c.double)).toEqual([false, false]));
  });

  it("passes Ctrl on to the handler", async () => {
    const onClick = vi.fn();
    const app = mount(
      <Clickable onClick={onClick}>
        <Text>target</Text>
      </Clickable>,
    );
    await tick();
    app.stdin.write(pressAt(0, 0, { ctrl: true }));
    await vi.waitFor(() => expect(onClick.mock.calls[0]?.[0]).toMatchObject({ ctrl: true }));
  });

  it("sends the wheel to the smallest box that takes it", async () => {
    const onWheel = vi.fn();
    const onClick = vi.fn();
    const app = mount(
      <Clickable flexDirection="column" onWheel={onWheel}>
        <Clickable onClick={onClick}>
          <Text>row</Text>
        </Clickable>
      </Clickable>,
    );
    await tick();
    app.stdin.write(wheelAt(0, 0, 1));
    app.stdin.write(wheelAt(0, 0, -1));
    await vi.waitFor(() => expect(onWheel.mock.calls).toEqual([[1], [-1]]));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("while a modal box is up, only modal boxes take presses", async () => {
    const behind = vi.fn();
    const yes = vi.fn();
    const outside = vi.fn();
    const app = mount(
      <Box flexDirection="column">
        <Clickable onClick={behind} onWheel={behind}>
          <Text>list</Text>
        </Clickable>
        <Clickable modal onOutside={outside}>
          <Clickable modal onClick={yes}>
            <Text>y</Text>
          </Clickable>
        </Clickable>
      </Box>,
    );
    await tick();
    app.stdin.write(clickAt(0, 0));
    app.stdin.write(wheelAt(0, 0, 1));
    await vi.waitFor(() => expect(outside).toHaveBeenCalledTimes(1));
    await tick();
    expect(behind).not.toHaveBeenCalled();
    app.stdin.write(clickAt(0, 1));
    await vi.waitFor(() => expect(yes).toHaveBeenCalledTimes(1));
  });

  it("does nothing without a provider", async () => {
    const onClick = vi.fn();
    const app = render(
      <Clickable onClick={onClick}>
        <Text>target</Text>
      </Clickable>,
    );
    await tick();
    app.stdin.write(clickAt(0, 0));
    await tick();
    expect(onClick).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain("target");
  });
});
