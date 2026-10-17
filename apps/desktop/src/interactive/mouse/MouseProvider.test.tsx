import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { InputHub } from "./input.ts";
import {
  Clickable,
  HoverText,
  type MouseClick,
  MouseProvider,
  useHovered,
} from "./MouseProvider.tsx";
import { attachTestStdin, clickAt, moveAt, pressAt, wheelAt } from "./testing.ts";

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

/** Shows whether the nearest Clickable is hovered, and counts its renders. */
function Probe({ name, renders }: { name: string; renders?: { count: number } }) {
  const hovered = useHovered();
  if (renders) renders.count += 1;
  return <Text>{`${name}:${hovered ? "on" : "off"}`}</Text>;
}

describe("MouseProvider hover", () => {
  const twoRows = (renders?: { count: number }) => (
    <Box flexDirection="column">
      <Clickable onClick={() => {}}>
        <Probe name="a" renders={renders} />
      </Clickable>
      <Clickable onClick={() => {}}>
        <Probe name="b" />
      </Clickable>
    </Box>
  );

  it("hovers the box under the pointer and clears it when the pointer leaves", async () => {
    const app = mount(twoRows());
    await tick();
    app.stdin.write(moveAt(0, 0));
    await vi.waitFor(() => expect(app.lastFrame()).toContain("a:on"));
    expect(app.lastFrame()).toContain("b:off");
    app.stdin.write(moveAt(0, 1));
    await vi.waitFor(() => expect(app.lastFrame()).toContain("b:on"));
    expect(app.lastFrame()).toContain("a:off");
    app.stdin.write(moveAt(40, 5));
    await vi.waitFor(() => expect(app.lastFrame()).toContain("b:off"));
  });

  it("only the boxes that change hover re-render", async () => {
    const renders = { count: 0 };
    const app = mount(twoRows(renders));
    await tick();
    app.stdin.write(moveAt(0, 0));
    await vi.waitFor(() => expect(app.lastFrame()).toContain("a:on"));
    const after = renders.count;
    for (let x = 1; x < 6; x++) app.stdin.write(moveAt(x, 0));
    await tick(60);
    expect(renders.count).toBe(after);
  });

  it("boxes without onClick never hover", async () => {
    const app = mount(
      <Clickable onWheel={() => {}}>
        <Probe name="w" />
      </Clickable>,
    );
    await tick();
    app.stdin.write(moveAt(0, 0));
    await tick(60);
    expect(app.lastFrame()).toContain("w:off");
  });

  it("only modal boxes hover while one is up", async () => {
    const app = mount(
      <Box flexDirection="column">
        <Clickable onClick={() => {}}>
          <Probe name="row" />
        </Clickable>
        <Clickable modal onClick={() => {}}>
          <Probe name="yes" />
        </Clickable>
      </Box>,
    );
    await tick();
    app.stdin.write(moveAt(0, 0));
    await tick(60);
    expect(app.lastFrame()).toContain("row:off");
    app.stdin.write(moveAt(0, 1));
    await vi.waitFor(() => expect(app.lastFrame()).toContain("yes:on"));
  });

  it("a box that appears under a still pointer waits for the next move", async () => {
    function Swap() {
      const [second, setSecond] = useState(false);
      return second ? (
        <Clickable key="new" onClick={() => {}}>
          <Probe name="new" />
        </Clickable>
      ) : (
        <Clickable key="old" onClick={() => setSecond(true)}>
          <Probe name="old" />
        </Clickable>
      );
    }
    const app = mount(<Swap />);
    await tick();
    app.stdin.write(moveAt(0, 0));
    await vi.waitFor(() => expect(app.lastFrame()).toContain("old:on"));
    app.stdin.write(clickAt(0, 0));
    await vi.waitFor(() => expect(app.lastFrame()).toContain("new:off"));
    await tick(60);
    expect(app.lastFrame()).toContain("new:off");
    app.stdin.write(moveAt(1, 0));
    await vi.waitFor(() => expect(app.lastFrame()).toContain("new:on"));
  });

  it("presses and the wheel do not change hover", async () => {
    const app = mount(
      <Box flexDirection="column">
        <Clickable onClick={() => {}} onWheel={() => {}}>
          <Probe name="a" />
        </Clickable>
        <Clickable onClick={() => {}}>
          <Probe name="b" />
        </Clickable>
      </Box>,
    );
    await tick();
    app.stdin.write(moveAt(0, 0));
    await vi.waitFor(() => expect(app.lastFrame()).toContain("a:on"));
    app.stdin.write(clickAt(0, 1));
    app.stdin.write(wheelAt(0, 1, 1));
    await tick(60);
    expect(app.lastFrame()).toContain("a:on");
    expect(app.lastFrame()).toContain("b:off");
  });

  it("HoverText renders the label either way", async () => {
    const app = mount(
      <Clickable onClick={() => {}}>
        <HoverText>label</HoverText>
      </Clickable>,
    );
    await tick();
    app.stdin.write(moveAt(0, 0));
    await tick(60);
    expect(app.lastFrame()).toContain("label");
  });
});
