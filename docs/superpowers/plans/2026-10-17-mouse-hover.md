# Mouse Hover Highlight — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every clickable item in the interactive app is underlined while the mouse pointer is over it, so the user can see what a click would hit.

**Architecture:** The terminal is asked for motion reports too (`ESC[?1003h`). The input hub turns them into `move` reports. `MouseProvider` remembers the pointer cell and keeps one hovered box: the box a click there would hit (smallest box with `onClick`, modal boxes only while one is up). `useClickable` returns whether its box is hovered, `<Clickable>` puts that in a `HoverContext`, and a new `<HoverText>` (Ink `Text` that reads the context) underlines itself. Components swap the `Text` of their clickable labels for `HoverText`.

**Tech Stack:** TypeScript (Node 24, ESM), Ink 8 + React 19, ink-testing-library 4, vitest, Biome, pnpm workspaces.

**Spec:** [docs/superpowers/specs/2026-10-15-downloads-manager-design.md](../specs/2026-10-15-downloads-manager-design.md), Mouse input. Builds on [2026-10-17-downloads-manager-phase-3c.md](2026-10-17-downloads-manager-phase-3c.md) (committed as 7c34460).

## Spike result

`.superpowers/hover-spike.mjs` (the 3c console-mode spike with `?1003h`) in the VS Code terminal: 137 pointer-move reports out of 139 events. The classic console was not measured; if it sends no motion, hover simply does not show there and clicks work as before.

## Decisions

| # | Question | This plan does | Status |
| --- | --- | --- | --- |
| V1 | Which items | Everything clickable: menu rows, folder rows, text field, Frame hints, y/N prompts, manager rows and headers, key-bar words, filter groups and options, detail URL/Path lines. | Confirmed 2026-10-17 |
| V2 | Look | Underline only. The keyboard highlight (`►`) does not move; Enter still acts on what the arrows chose. | Confirmed 2026-10-17 |
| V3 | Which box is "hovered" | The one a left click at the pointer would reach: smallest active box with `onClick`, modal boxes only while a modal box is registered. Boxes with only `onWheel` (menu frame, manager screen) never hover. | Confirmed 2026-10-17 |
| V4 | When hover updates | Only on pointer moves (motion reports): moving onto a box underlines it, moving off every box clears it. Presses, the wheel, a list scrolling under a still pointer or a new screen change nothing until the pointer moves again. A hovered box that unmounts simply stops being hovered (nothing else takes over). | Confirmed 2026-10-17 |
| V5 | Disabled menu rows | Not clickable at all (`active` false), so they never hover. | Confirmed 2026-10-17 |
| V6 | Motion mode | `ESC[?1000h ESC[?1003h ESC[?1006h` on; `ESC[?1003l ESC[?1000l ESC[?1006l` off. A terminal without 1003 keeps clicks from 1000. | Confirmed 2026-10-17 |

## Global Constraints

- Every key action stays exactly as it is; hover changes no state other than the underline.
- Motion reports must not reach Ink as keys (the hub already strips every SGR report).
- Hover never moves the menu highlight, the manager cursor or the filter panel highlight.
- Hovered state is only re-rendered when the hovered box changes, not on every motion report.
- No new dependency.

## Review Focus

1. **A flood of motion reports** (fast pointer moves) must not re-render boxes that did not change hover. Test: Task 2 `only the boxes that change hover re-render`.
2. **A hovered box that unmounts** (screen change) must not stay "hovered" in the provider, and per V4 the box mounted under the still pointer must not hover until the pointer moves. Test: Task 2 `a box that appears under a still pointer waits for the next move`.
3. **Modal prompts**: while a y/N prompt is up, rows behind it must not hover. Test: Task 2 `only modal boxes hover while one is up`.
4. **Wheel-only boxes** never hover. Test: Task 2 `boxes without onClick never hover`.
5. **Keyboard users**: menu Enter still selects the arrow-highlighted row after hovering another. Test: Task 3 `hover does not move the highlight`.

---

### Task 1: Motion reports

**Files:**
- Modify: `apps/desktop/src/interactive/mouse/input.ts`, `apps/desktop/src/interactive/mouse/testing.ts`, `apps/desktop/src/interactive/start.tsx`
- Test: `apps/desktop/src/interactive/mouse/input.test.ts`, `apps/desktop/src/interactive/start.test.ts`

**Interfaces:**
- Produces: `MouseReport.kind` gains `"move"` (`button` is `code & 3`; 3 means no button held). `moveAt(x: number, y: number): string` in `testing.ts`. `MOUSE_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h"`, `MOUSE_OFF = "\x1b[?1003l\x1b[?1000l\x1b[?1006l"`.

- [ ] **Step 1: Change the tests first**

In `input.test.ts`, replace the test `drops motion reports` with:

```ts
  it("reads motion as a move report", () => {
    expect(splitInput(`${ESC}[<35;4;4M`)).toEqual({
      text: "",
      reports: [{ kind: "move", button: 3, x: 3, y: 3, shift: false, alt: false, ctrl: false }],
      rest: "",
    });
  });
```

and add to the `InputHub` describe:

```ts
  it("builds move reports for tests", () => {
    expect(splitInput(moveAt(5, 6)).reports[0]).toMatchObject({ kind: "move", x: 5, y: 6 });
  });
```

(import `moveAt` from `./testing.ts`). Keep the tests that drop horizontal wheels and extra buttons.

In `start.test.ts`, change the expected constants to:

```ts
    expect(MOUSE_ON).toBe("\u001b[?1000h\u001b[?1003h\u001b[?1006h");
    expect(MOUSE_OFF).toBe("\u001b[?1003l\u001b[?1000l\u001b[?1006l");
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/desktop/src/interactive/mouse/input.test.ts apps/desktop/src/interactive/start.test.ts`
Expected: the three changed tests FAIL.

- [ ] **Step 3: Implement**

`input.ts`: `kind: "press" | "release" | "wheel" | "move"` (update the doc comment of `button`: "for a move, 3 when no button is held"). In `wanted`, stop dropping `MOTION` (keep dropping `code >= EXTRA` and horizontal wheels) and update its comment. In `report`, return `kind: "move", button: code & 3` when `code & MOTION` (check motion before wheel).

`testing.ts`:

```ts
/** The pointer moving onto cell (x, y) with no button held. */
export const moveAt = (x: number, y: number) => `${ESC}[<35;${x + 1};${y + 1}M`;
```

`start.tsx`: the two constants as in Interfaces; update their comment to "presses, releases, the wheel and pointer motion".

- [ ] **Step 4: Run the tests to pass**

Run: `pnpm exec vitest run apps/desktop/src/interactive/mouse apps/desktop/src/interactive/start.test.ts`
Expected: PASS. `MouseProvider` ignores `move` reports (it returns early for anything but presses and wheels), so nothing else changes yet.

- [ ] **Step 5: Commit message (the user commits)**

```markdown
✨ desktop: read pointer motion from the terminal

## Description

Hover highlighting needs to know where the pointer is without a click.
The app now asks for motion reports too and the input hub passes them
on as move reports.

## Test

pnpm exec vitest run apps/desktop/src/interactive/mouse
```

---

### Task 2: Hover tracking in the provider

**Files:**
- Modify: `apps/desktop/src/interactive/mouse/MouseProvider.tsx`
- Test: `apps/desktop/src/interactive/mouse/MouseProvider.test.tsx`

**Interfaces:**
- Consumes: `move` reports and `moveAt` (Task 1).
- Produces: `useClickable(...)` now returns `boolean` (hovered). `HoverContext` (React context, default `false`), `useHovered(): boolean`, `HoverText(props: TextProps)` (Ink `Text` with `underline` when hovered or when `props.underline`). `<Clickable>` wraps its children in `HoverContext.Provider`.

- [ ] **Step 1: Write the failing tests** (append to `MouseProvider.test.tsx`; add `moveAt` to the testing import, `useHovered` and `HoverText` to the provider import, `useRef` from react)

```tsx
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
        <Clickable onClick={() => {}}>
          <Probe name="new" />
        </Clickable>
      ) : (
        <Clickable onClick={() => setSecond(true)}>
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
```

(`useState` from react. Frames in tests carry no ANSI codes, so the underline itself is checked by hand, Task 3 checklist.)

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run apps/desktop/src/interactive/mouse/MouseProvider.test.tsx`
Expected: FAIL, `useHovered` not exported.

- [ ] **Step 3: Implement** (`MouseProvider.tsx`)

1. `Entry` gains `hover: (on: boolean) => void`. `MouseApi.register` takes it with the rest.
2. Move `hits` out of the effect into a stable function inside the component (it reads only refs: `entries`), with a point parameter `{ x, y }`.
3. Add refs `pointer = useRef<{ x: number; y: number }>()` and `hovered = useRef<Entry>()`, and

```ts
  /** The box a click at the pointer would reach shows as hovered; only changes re-render. */
  const rehover = useCallback(() => {
    const at = pointer.current;
    const next = at ? hits(at, "onClick")[0]?.entry : undefined;
    if (hovered.current === next) return;
    hovered.current?.hover(false);
    hovered.current = next;
    next?.hover(true);
  }, [hits]);
```

4. In the mouse listener, for `move` only: `pointer.current = { x: r.x, y: r.y }; rehover(); return;`. Presses and the wheel keep their handling and do not touch hover (V4).
5. In `register`: the returned cleanup deletes the entry and sets `hovered.current = undefined` if it was that entry (without calling its `hover`, the component is going away). No re-hover on register or unregister (V4).
6. Contexts and the hook:

```tsx
/** True inside a `Clickable` while the pointer is over it. */
export const HoverContext = createContext(false);

export function useHovered(): boolean {
  return useContext(HoverContext);
}

/** Ink `Text`, underlined while its `Clickable` is hovered. */
export function HoverText(props: TextProps) {
  const hovered = useHovered();
  return <Text {...props} underline={props.underline || hovered} />;
}
```

7. `useClickable` keeps a `const [hovered, setHovered] = useState(false)`, registers `hover: setHovered`, calls `setHovered(false)` in its cleanup, and returns `hovered`. When `active` is false it returns `false`.
8. `Clickable` takes the returned value and renders `<Box ref={ref} {...box}><HoverContext.Provider value={hovered}>{children}</HoverContext.Provider></Box>`.

Imports: `Text, type TextProps` from "ink"; `useCallback, useState` from react.

- [ ] **Step 4: Run the tests to pass**

Run: `pnpm exec vitest run apps/desktop/src/interactive/mouse apps/desktop/src/interactive/components apps/desktop/src/interactive/screens/ManagerScreen.test.tsx`
Expected: PASS (old tests unchanged: no `move` reports there, and hover state renders nothing yet).

- [ ] **Step 5: Commit message (the user commits)**

```markdown
✨ desktop: track which clickable box the pointer is over

## Description

The mouse provider keeps one hovered box, the one a click at the
pointer would reach, and tells only the boxes whose state changes.
HoverText underlines itself inside a hovered box.

## Test

pnpm exec vitest run apps/desktop/src/interactive/mouse
```

---

### Task 3: Underline every clickable label

**Files (all under `apps/desktop/src/interactive`):**
- Modify: `components/Menu.tsx`, `components/TextField.tsx`, `components/Frame.tsx`, `screens/PathPickerScreen.tsx`, `manager/Table.tsx`, `manager/FilterPanel.tsx`, `manager/DetailPanel.tsx`, `screens/ManagerScreen.tsx`
- Modify: `docs/desktop-cli-checklist.md` (repo root)
- Test: `components/Menu.test.tsx`

**Interfaces:**
- Consumes: `HoverText` (Task 2), `moveAt` (Task 1).

- [ ] **Step 1: Write the failing test** (append to the `Menu mouse` describe in `Menu.test.tsx`; add `moveAt` to the testing import)

```tsx
  it("hover does not move the highlight", async () => {
    const onSelect = vi.fn();
    const app = withMouse(<Menu items={four} onSelect={onSelect} />);
    await tick();
    app.stdin.write(moveAt(4, 3));
    await tick(60);
    expect(app.lastFrame()).toMatch(/► 1 Alpha/);
    app.stdin.write(ENTER);
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("a"));
  });

  it("disabled rows take no clicks", async () => {
    const app = withMouse(<Menu items={four} onSelect={() => {}} />);
    await tick();
    app.stdin.write(clickAt(4, 2));
    app.stdin.write(clickAt(4, 2));
    await tick(60);
    expect(app.lastFrame()).toMatch(/► 1 Alpha/);
  });
```

Run: `pnpm exec vitest run apps/desktop/src/interactive/components/Menu.test.tsx`. The first may already pass (hover changes nothing yet); that is expected: it guards against hover moving the highlight once labels react to it.

- [ ] **Step 2: Swap the labels** — in each place, replace the `Text` that shows the clickable item's label with `HoverText` (same props), importing it from `../mouse/MouseProvider.tsx`:

| File | What becomes `HoverText` |
| --- | --- |
| `components/Menu.tsx` | The row's label `Text` (icon + label). Also set the row `Clickable`'s `active` to `isActive && !item.disabled` (V5) and drop the now-unneeded `if (item.disabled) return;` only if the click handler no longer needs it (keep it if in doubt). |
| `screens/PathPickerScreen.tsx` | The folder row's inner `Text` (icon + name). |
| `components/TextField.tsx` | The one-line field's value `Text` (before / cursor / after) and the placeholder `Text`. |
| `components/Frame.tsx` | Each hint's outer `Text` (key + label); the `y` and `N` `Text` of the Ctrl+C question. |
| `manager/Table.tsx` | The `Text` inside `Cell` (header cells and row cells); in rows also the cursor mark and the `[ ]` box `Text`, so the whole row underlines. |
| `screens/ManagerScreen.tsx` | Each key-bar word `Text`; the `y` and `N` `Text` of the prompt. |
| `manager/FilterPanel.tsx` | The group-name `Text` and each option `Text`. |
| `manager/DetailPanel.tsx` | The value `Text` of each line (only URL and Path lines have `onClick`, so only they ever hover). |

Nested `Text` inside these keeps working: `HoverText` is an Ink `Text`.

- [ ] **Step 3: Checklist** — in `docs/desktop-cli-checklist.md`, section "Mouse (phase 3c)", add:

```markdown
- [ ] Hover: moving the pointer over a menu row, a folder, a key hint, a manager row, a header, a key-bar word, a filter option or the detail URL/Path underlines it; moving away removes the underline; the `►` highlight and the cursor do not move. The classic console may show no hover (clicks still work).
```

- [ ] **Step 4: Run everything**

Run: `pnpm exec vitest run apps/desktop`, `pnpm typecheck`, `rtk proxy pnpm lint`
Expected: all PASS, lint clean.

- [ ] **Step 5: Commit message (the user commits)**

```markdown
💄 desktop: underline clickable items under the mouse pointer

## Description

Clicks worked but nothing showed what was clickable. Every clickable
label now underlines while the pointer is over it, without moving the
keyboard highlight, so Enter still acts on what the arrows chose.

## Test

pnpm exec vitest run apps/desktop
Manual: docs/desktop-cli-checklist.md, Mouse (phase 3c), Hover
```
