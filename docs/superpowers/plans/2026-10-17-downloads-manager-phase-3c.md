# Downloads Manager, Phase 3c: Mouse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The whole interactive app accepts the mouse: click, double-click, Ctrl+click and the wheel in menus, the folder picker, text fields, Frame key hints and every part of the downloads manager, on Linux terminals, Windows Terminal, the VS Code terminal and the classic Windows console. The manager detail panel copies the link (`y`) and the path (`Y`).

**Architecture:** An `InputHub` sits between the terminal and Ink. It takes SGR mouse reports out of the input and hands them to a `MouseProvider`; key text goes on to Ink unchanged. Components register a box with `useClickable` (or wrap it in `<Clickable>`), and the provider hit-tests each press with Ink's `measureElement` at event time: the smallest box under the pointer wins, and while a modal box is registered only modal boxes take clicks. Clicking a key hint injects that key's bytes into Ink's input, so every hint does exactly what its key does. On Windows a short PowerShell child turns on `ENABLE_VIRTUAL_TERMINAL_INPUT` for the console, so the console sends mouse reports as text.

**Tech Stack:** TypeScript (Node 24, ESM), Ink 8 + React 19, ink-testing-library 4, vitest, Biome, pnpm workspaces.

**Spec:** [docs/superpowers/specs/2026-10-15-downloads-manager-design.md](../specs/2026-10-15-downloads-manager-design.md), sections Manager TUI → Mouse, Mouse input (whole interactive app), and the `y`/`Y` copy keys. Phase 3 is split in three plans: 3a (done), 3b (done), **3c** (this one). `open-terminal.ts` and the popup are phase 4.

## Spike result (done before this plan)

`tools/dev/mouse-spike.mjs` (plain SGR) and `tools/dev/mouse-spike-vt.mjs` (with the console mode) were run by the user on 2026-10-17:

| Terminal | Plain SGR | With `ENABLE_VIRTUAL_TERMINAL_INPUT` | Modifiers that arrive |
| --- | --- | --- | --- |
| Classic console (cmd, conhost) | No events | Works (mode `8` → `208`) | not measured |
| VS Code terminal (pwsh) | No events | Works (mode `8` → `208`) | Alt, Ctrl; **never Shift** |

- Node's raw mode on Windows (libuv) drops console `MOUSE_EVENT` records. With bit `0x200` set on the console input handle, the console sends SGR text, which Node reads like any key.
- Terminals keep Shift+click and Shift+drag for their own text selection while mouse reporting is on. The spec's "Shift+click a box" is therefore replaced by Ctrl+click (H3).
- The spike scripts stay out of the commits (H20).

## Decisions taken in this plan

H1 to H9 were confirmed by the user on 2026-10-17. H10 to H20 are this plan's recommended answers; change any of them before execution starts.

| # | Question | This plan does | Why |
| --- | --- | --- | --- |
| H1 (confirmed) | Mouse on Windows | On every Windows start, a PowerShell child that shares the console sets `ENABLE_VIRTUAL_TERMINAL_INPUT` (`0x200`) on the console input handle, right after Ink turns raw mode on. Classic console, Windows Terminal and VS Code all get the mouse. | Spike: works in conhost and VS Code. |
| H2 (confirmed) | `y` / `Y` copy tools | Windows: `powershell.exe Set-Clipboard`, text on stdin. Linux: `wl-copy`, then `xclip -selection clipboard`, then `xsel --clipboard --input`, the first that exits 0. | User's choice; no new dependency. |
| H3 (confirmed) | Range tick (Shift+click cannot arrive) | **Ctrl+click anywhere on a row** ticks every visible row from the anchor to the clicked row and moves the cursor there. Anchor: the most recently ticked visible row; with none, the cursor row. | User's choice; Shift is the terminal's. |
| H4 (confirmed) | Clicks behind a panel or prompt | Ignored. While the manager shows a panel (filter, detail, limit, keys), the table, header and key bar take no clicks; while a y/N prompt shows, only `y` and `N` take clicks. | User's choice. |
| H5 (confirmed) | Detail panel click | A click on any line of the URL or Path field copies it, same as `y` / `Y`. | User's choice. |
| H6 (confirmed) | Click on a row's `[ ]` box | Ticks or unticks it **and** moves the cursor to that row. | User's choice. |
| H7 (confirmed) | Manager wheel | Moves the cursor 3 rows per notch; the view follows the cursor. | User's choice. |
| H8 (confirmed) | Clicking a key hint | Runs exactly what the key does (Frame hints, manager key bar, Home's `Y Quit` / `N / Esc Stay`). Clicking the `Ctrl+C` hint first asks in the hint line: `y/N  Quit MediaForge?` (`ctrlC="Quit"`), `y/N  Cancel the download?` (download screen), `y/N  Cancel all downloads?` (batch screen). `y` (key or click) runs it; any other key or click answers No. Pressing Ctrl+C on the keyboard stays immediate. | User's choice. |
| H9 (confirmed) | Shift+drag note | Stays as specified: the `?` key list and About say `Shift+drag selects text in Windows Terminal and most Linux terminals.` | Spec. |
| H10 | `TextField` click | Fields are always focused, so a click in a one-line field puts the text cursor on the clicked character (after the end: at the end). A click in a multi-line field does nothing. | "Focus" alone would do nothing visible. |
| H11 | `Menu` wheel | One highlight step per notch, skipping disabled rows, wrapping like the arrow keys. | Matches ↑↓. |
| H12 | Double-click | The second press of the left button on the same cell within 400 ms. A third quick press starts a new click. Right and middle buttons and releases are ignored. | Spec: 400 ms. |
| H13 | Windows start-up delay | Keys work at once; the mouse starts working when the PowerShell child finishes (about 1 s, it compiles a small C# type). Nothing is shown meanwhile. | No native helper to ship. |
| H14 | Restoring the terminal | Mouse reporting off (`ESC[?1000l ESC[?1006l`) before leaving the alternate screen, on normal exit and from a `process.on("exit")` handler (crash). The Windows console bit goes when raw mode turns off: libuv sets the whole input mode then (`ENABLE_ECHO_INPUT \| ENABLE_LINE_INPUT \| ENABLE_PROCESSED_INPUT`), so no second PowerShell runs on exit. The checklist verifies it. No child process gets the terminal today, so there is no hand-over path to cover. | Quitting stays instant. |
| H15 | Copy messages (status line) | `Copied the link.` · `Copied the path.` · `No file yet.` (no output path) · `Could not copy to the clipboard.` | Same style as the other status texts. |
| H16 | Mouse help | The `?` list gains two rows (`y, Y` copy; `Mouse` summary) and the Shift+drag line; About gains the Shift+drag line under the licences. | Keeps the list short. |
| H17 | Clickable parts not in the spec | Not clickable: the header `[ ]`, banners, the "N more above/below" lines, the summary line. | YAGNI. |
| H18 | Filter panel click | A click on an option moves the panel's highlight there and toggles it (radio for Last try); a click on a group name moves the highlight to that group. | Spec: "focuses or toggles it". |
| H19 | `PathPickerScreen` double-click | Opens the folder: same as highlighting it and pressing Tab. | Spec: "double-click opens it". |
| H20 | Spike scripts | `tools/dev/mouse-spike.mjs` and `tools/dev/mouse-spike-vt.mjs` are deleted in Task 9. | One-off tools; the plan records the result. |

## Global Constraints

- Platforms: Windows and Linux. No macOS-specific code.
- Mouse reporting: `ESC[?1000h ESC[?1006h` on (press, release, wheel; SGR encoding), `ESC[?1000l ESC[?1006l` off. No motion reporting (`?1002`/`?1003`).
- SGR report: `ESC [ < code ; column ; row M` (press, wheel) or `m` (release). Column and row are 1-based. Code bits: 0–1 button (0 left, 1 middle, 2 right), 4 Shift, 8 Alt, 16 Ctrl, 32 motion, 64 wheel (64 up, 65 down).
- Coordinates: the app draws from the top-left of the alternate screen, so report column/row minus 1 equals Ink's `measureElement` x/y.
- Every key action stays; the mouse is an extra way in. No screen may need the mouse.
- Hit testing: the smallest box under the pointer that has the needed handler wins; ties go to the box registered last. While any modal box is registered, only modal boxes are tested; a press on none of them calls each modal box's `onOutside`.
- Double-click: second left press on the same cell within 400 ms (`DOUBLE_CLICK_MS`).
- Manager wheel: 3 rows per notch (`WHEEL_ROWS`).
- PowerShell scripts are constants passed with `-EncodedCommand`; nothing is interpolated into them. Clipboard text goes over stdin, never into arguments.
- Copy texts: H15. Ctrl+C prompt texts: H8. Prompts start with `y/N  ` like the 3b prompts.
- Components without a `MouseProvider` above them work as before (the context default is inert), so screens and tests that do not care about the mouse need no change.

## Review Focus

1. **A mouse report split across two input chunks** (slow pipes, ConPTY): no stray `[<0;12;5M` may reach a text field or the search line. Test: Task 1 `holds a cut-off report until the rest arrives`.
2. **A plain Esc press** must reach the screens at once, never held as a possible mouse report. Test: Task 1 `passes a lone Esc straight through`.
3. **Clicks while a y/N prompt is open** must not move the cursor, tick rows or run key-bar words behind it. Test: Task 7 `ignores clicks behind a prompt`.
4. **Two fast clicks on different rows** are two single clicks, not a double-click that opens the details of the second row. Test: Task 2 `fast clicks on different cells are not a double-click`.
5. **A crash while the mouse is on** must leave the terminal without mouse reporting, or every later click prints escape codes into the shell. Test: Task 3 `the exit hook turns the mouse off`.

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `apps/desktop/src/interactive/mouse/input.ts` | Create | `MouseReport`, `splitInput`, `keySequence`, `InputHub` (feed, capture, inject). Pure apart from one timer. |
| `apps/desktop/src/interactive/mouse/input.test.ts` | Create | Tests for the above. |
| `apps/desktop/src/interactive/mouse/testing.ts` | Create | Test helpers: `attachTestStdin`, `clickAt`, `pressAt`, `wheelAt`. |
| `apps/desktop/src/interactive/mouse/MouseProvider.tsx` | Create | `MouseProvider`, `MouseContext`, `useMouse`, `useClickable`, `<Clickable>`, `MouseClick`, `DOUBLE_CLICK_MS`. |
| `apps/desktop/src/interactive/mouse/MouseProvider.test.tsx` | Create | Hit testing, modal, double-click, wheel. |
| `apps/desktop/src/interactive/mouse/terminal-stdin.ts` | Create | `terminalStdin(hub, source, onRaw)`: the stream Ink reads. |
| `apps/desktop/src/interactive/mouse/terminal-stdin.test.ts` | Create | |
| `apps/desktop/src/console-mode.ts` | Create | `VT_INPUT_SCRIPT`, `enableVtInput()` (Windows). |
| `apps/desktop/src/console-mode.test.ts` | Create | |
| `apps/desktop/src/interactive/start.tsx` | Modify | Mouse on/off, the exit hook, `MouseProvider`, `writeClipboard` in `realDeps`. |
| `apps/desktop/src/interactive/start.test.ts` | Create | `mouseExitHook`. |
| `apps/desktop/src/interactive/clipboard.ts` | Modify | `copyCommands`, `writeClipboard`. |
| `apps/desktop/src/interactive/deps.ts` | Modify | `writeClipboard` in `AppDeps`. |
| `apps/desktop/src/interactive/logic.test.ts` | Modify | Clipboard write tests. |
| `apps/desktop/src/interactive/components/Menu.tsx` (+ `Menu.test.tsx`) | Modify | Click, double-click, wheel. |
| `apps/desktop/src/interactive/components/TextField.tsx` (+ test in `Menu.test.tsx`) | Modify | Click places the cursor. |
| `apps/desktop/src/interactive/screens/PathPickerScreen.tsx` | Modify | Click, double-click, wheel on folders. |
| `apps/desktop/src/interactive/components/Frame.tsx` (+ `Frame.test.tsx`) | Modify | Clickable hints, Ctrl+C prompt, `ctrlCQuestion`. |
| `apps/desktop/src/interactive/screens/DownloadScreen.tsx`, `screens/batch/BatchDownloadScreen.tsx` | Modify | `ctrlCQuestion`. |
| `apps/desktop/src/interactive/manager/Table.tsx` | Modify | `TableRow`, clickable rows and headers. |
| `apps/desktop/src/interactive/manager/model.ts` (+ `model.test.ts`) | Modify | `tickRange`. |
| `apps/desktop/src/interactive/manager/FilterPanel.tsx` | Modify | Clickable options and groups. |
| `apps/desktop/src/interactive/manager/DetailPanel.tsx` | Modify | `y`/`Y`, clickable URL/Path, wheel. |
| `apps/desktop/src/interactive/manager/KeyList.tsx` | Modify | Mouse rows, Shift+drag line. |
| `apps/desktop/src/interactive/screens/ManagerScreen.tsx` (+ test) | Modify | Row, header, wheel, key bar, prompt clicks, copy. |
| `apps/desktop/src/interactive/about.ts`, `screens/AboutScreen.tsx` | Modify | `SELECT_TIP`. |
| `apps/desktop/src/interactive/App.test.tsx` | Modify | `writeClipboard` in the test deps. |
| `docs/desktop-cli-checklist.md` | Modify | "Mouse (phase 3c)" section. |

---

### Task 1: Input hub — mouse reports out, keys on

**Files:**
- Create: `apps/desktop/src/interactive/mouse/input.ts`
- Create: `apps/desktop/src/interactive/mouse/testing.ts`
- Test: `apps/desktop/src/interactive/mouse/input.test.ts`

**Interfaces:**
- Produces:
  - `interface MouseReport { kind: "press" | "release" | "wheel"; button: number; x: number; y: number; shift: boolean; alt: boolean; ctrl: boolean }` (x, y 0-based; for a wheel, `button` is -1 up or 1 down).
  - `splitInput(chunk: string): { text: string; reports: MouseReport[]; rest: string }`
  - `keySequence(label: string): string | undefined`
  - `class InputHub { deliver: (text: string) => void; feed(chunk: string): void; onMouse(listener: (r: MouseReport) => void): () => void; capture(handler: (text: string) => void): () => void; inject(text: string): void }`
  - `testing.ts`: `attachTestStdin(hub: InputHub, stdin: { write: (data: string) => void }): void`, `pressAt(x: number, y: number, mods?: { ctrl?: boolean }): string`, `clickAt(x, y, mods?): string`, `wheelAt(x: number, y: number, step: -1 | 1): string` (x, y 0-based).

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/interactive/mouse/input.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputHub, keySequence, splitInput } from "./input.ts";
import { clickAt, pressAt, wheelAt } from "./testing.ts";

const ESC = "\u001b";

describe("splitInput", () => {
  it("leaves plain keys alone", () => {
    expect(splitInput("abc")).toEqual({ text: "abc", reports: [], rest: "" });
  });

  it("takes out a press and a release, keeping the keys around them", () => {
    const out = splitInput(`a${ESC}[<0;10;5Mb${ESC}[<0;10;5m`);
    expect(out.text).toBe("ab");
    expect(out.rest).toBe("");
    expect(out.reports).toEqual([
      { kind: "press", button: 0, x: 9, y: 4, shift: false, alt: false, ctrl: false },
      { kind: "release", button: 0, x: 9, y: 4, shift: false, alt: false, ctrl: false },
    ]);
  });

  it("reads the wheel and the modifiers", () => {
    const { reports } = splitInput(`${ESC}[<64;1;1M${ESC}[<65;1;1M${ESC}[<16;3;2M${ESC}[<8;3;2M`);
    expect(reports.map((r) => [r.kind, r.button, r.ctrl, r.alt])).toEqual([
      ["wheel", -1, false, false],
      ["wheel", 1, false, false],
      ["press", 0, true, false],
      ["press", 0, false, true],
    ]);
  });

  it("drops motion reports", () => {
    expect(splitInput(`${ESC}[<32;4;4M`)).toEqual({ text: "", reports: [], rest: "" });
  });

  it("keeps a report cut off at the end as rest", () => {
    expect(splitInput(`x${ESC}[<0;1`)).toEqual({ text: "x", reports: [], rest: `${ESC}[<0;1` });
  });

  it("passes a lone Esc straight through", () => {
    expect(splitInput(ESC)).toEqual({ text: ESC, reports: [], rest: "" });
    expect(splitInput(`${ESC}[A`)).toEqual({ text: `${ESC}[A`, reports: [], rest: "" });
  });
});

describe("keySequence", () => {
  it("maps hint keys to the bytes the key sends", () => {
    expect(keySequence("Esc")).toBe(ESC);
    expect(keySequence("Enter")).toBe("\r");
    expect(keySequence("Tab")).toBe("\t");
    expect(keySequence("Del")).toBe(`${ESC}[3~`);
    expect(keySequence("Ctrl+N")).toBe("\u000e");
    expect(keySequence("Ctrl+C")).toBe("\u0003");
    expect(keySequence("p")).toBe("p");
    expect(keySequence("?")).toBe("?");
    expect(keySequence("N / Esc")).toBe("N");
  });

  it("has no bytes for hints that name several keys", () => {
    expect(keySequence("↑↓")).toBeUndefined();
    expect(keySequence("1-6")).toBeUndefined();
  });
});

describe("InputHub", () => {
  afterEach(() => vi.useRealTimers());

  const hub = () => {
    const h = new InputHub();
    const keys: string[] = [];
    const reports: unknown[] = [];
    h.deliver = (text) => keys.push(text);
    h.onMouse((r) => reports.push(r));
    return { h, keys, reports };
  };

  it("sends keys on and reports to the listeners", () => {
    const { h, keys, reports } = hub();
    h.feed(`q${clickAt(2, 3)}`);
    expect(keys).toEqual(["q"]);
    expect(reports).toHaveLength(2);
  });

  it("holds a cut-off report until the rest arrives", () => {
    const { h, keys, reports } = hub();
    const press = pressAt(2, 3);
    h.feed(press.slice(0, 5));
    h.feed(press.slice(5));
    expect(keys).toEqual([]);
    expect(reports).toHaveLength(1);
  });

  it("lets a held prefix go as keys when nothing follows", () => {
    vi.useFakeTimers();
    const { h, keys } = hub();
    h.feed(`${ESC}[<1`);
    expect(keys).toEqual([]);
    vi.advanceTimersByTime(60);
    expect(keys).toEqual([`${ESC}[<1`]);
  });

  it("routes keys to a capture until it is released; injected keys skip it", () => {
    const { h, keys } = hub();
    const caught: string[] = [];
    const release = h.capture((text) => caught.push(text));
    h.feed("n");
    h.inject("\u0003");
    release();
    h.feed("z");
    expect(caught).toEqual(["n"]);
    expect(keys).toEqual(["\u0003", "z"]);
  });

  it("builds wheel reports for tests", () => {
    expect(splitInput(wheelAt(0, 0, 1)).reports[0]?.kind).toBe("wheel");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/mouse/input.test.ts`
Expected: FAIL, `Failed to resolve import "./input.ts"`.

- [ ] **Step 3: Write the implementation**

`apps/desktop/src/interactive/mouse/input.ts`:

```ts
/** One mouse report from the terminal. Cells count from 0, top-left. */
export interface MouseReport {
  kind: "press" | "release" | "wheel";
  /** 0 left, 1 middle, 2 right; for a wheel, -1 up and 1 down. */
  button: number;
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

const ESC = String.fromCharCode(27);
/** SGR encoding: ESC [ < code ; column ; row, then M (press) or m (release). */
const SGR = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "g");
/** The start of a report whose end is still on the way. */
const PARTIAL = new RegExp(`${ESC}\\[<[\\d;]*$`);
const MOTION = 32;
const WHEEL = 64;

function report(code: number, column: number, row: number, final: string): MouseReport {
  const wheel = (code & WHEEL) !== 0;
  return {
    kind: wheel ? "wheel" : final === "M" ? "press" : "release",
    button: wheel ? (code & 1 ? 1 : -1) : code & 3,
    x: column - 1,
    y: row - 1,
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
}

/** Pull the SGR mouse reports out of terminal input. `rest` is a report cut off at the end. */
export function splitInput(chunk: string): { text: string; reports: MouseReport[]; rest: string } {
  const reports: MouseReport[] = [];
  let text = chunk.replace(SGR, (_match, code: string, column: string, row: string, final: string) => {
    // Motion is never switched on; a terminal that sends it anyway is ignored.
    if ((Number(code) & MOTION) === 0) {
      reports.push(report(Number(code), Number(column), Number(row), final));
    }
    return "";
  });
  const rest = PARTIAL.exec(text)?.[0] ?? "";
  if (rest) text = text.slice(0, -rest.length);
  return { text, reports, rest };
}

const NAMED: Record<string, string> = {
  Esc: ESC,
  Enter: "\r",
  Tab: "\t",
  Del: `${ESC}[3~`,
  Space: " ",
};

/**
 * The bytes a hint's key sends, so a click on the hint can type it. Undefined for hints that
 * name more than one key ("↑↓", "1-6"). "N / Esc" types its first key.
 */
export function keySequence(label: string): string | undefined {
  const key = (label.split(" / ")[0] ?? "").trim();
  const named = NAMED[key];
  if (named) return named;
  const ctrl = /^Ctrl\+([A-Z])$/.exec(key)?.[1];
  if (ctrl) return String.fromCharCode(ctrl.charCodeAt(0) - 64);
  return [...key].length === 1 ? key : undefined;
}

/** How long a cut-off report may wait for its end before it counts as typed text. */
const PARTIAL_WAIT_MS = 50;

/**
 * Sits between the terminal and Ink: mouse reports go to the listeners, keys go on to Ink
 * (`deliver`), or to a capture while one is set.
 */
export class InputHub {
  /** Where keys go: Ink's input stream. Set by `terminalStdin` or `attachTestStdin`. */
  deliver: (text: string) => void = () => {};
  private readonly listeners = new Set<(report: MouseReport) => void>();
  private captor: ((text: string) => void) | undefined;
  private held = "";
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Raw input from the terminal. */
  feed(chunk: string): void {
    clearTimeout(this.timer);
    const { text, reports, rest } = splitInput(this.held + chunk);
    this.held = rest;
    if (rest) {
      this.timer = setTimeout(() => {
        const late = this.held;
        this.held = "";
        this.keys(late);
      }, PARTIAL_WAIT_MS);
    }
    if (text) this.keys(text);
    for (const r of reports) for (const listener of [...this.listeners]) listener(r);
  }

  onMouse(listener: (report: MouseReport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Keys go to `handler` instead of the screens until the returned function is called. */
  capture(handler: (text: string) => void): () => void {
    this.captor = handler;
    return () => {
      if (this.captor === handler) this.captor = undefined;
    };
  }

  /** Types `text` for the user (a clicked hint). It skips any capture. */
  inject(text: string): void {
    this.deliver(text);
  }

  private keys(text: string): void {
    if (this.captor) this.captor(text);
    else this.deliver(text);
  }
}
```

`apps/desktop/src/interactive/mouse/testing.ts`:

```ts
import type { InputHub } from "./input.ts";

const ESC = String.fromCharCode(27);

/** Routes an ink-testing-library stdin through the hub, so tests write mouse reports to it. */
export function attachTestStdin(hub: InputHub, stdin: { write: (data: string) => void }): void {
  const original = stdin.write;
  hub.deliver = (text) => original(text);
  stdin.write = (data: string) => hub.feed(data);
}

/** A left-button press at cell (x, y), counted from 0. */
export const pressAt = (x: number, y: number, mods: { ctrl?: boolean } = {}) =>
  `${ESC}[<${mods.ctrl ? 16 : 0};${x + 1};${y + 1}M`;

/** A press and its release. */
export const clickAt = (x: number, y: number, mods: { ctrl?: boolean } = {}) =>
  `${pressAt(x, y, mods)}${ESC}[<${mods.ctrl ? 16 : 0};${x + 1};${y + 1}m`;

/** One wheel notch: -1 up, 1 down. */
export const wheelAt = (x: number, y: number, step: -1 | 1) =>
  `${ESC}[<${step === 1 ? 65 : 64};${x + 1};${y + 1}M`;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/mouse/input.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit message (the user commits)**

```markdown
✨ desktop: split mouse reports out of terminal input

## Description

The mouse layer needs SGR reports without letting their escape codes
reach Ink's key handlers. An input hub takes them out, holds a report
cut across two chunks, and can capture or type keys for a screen.

## Test

pnpm --filter @mediaforge/desktop exec vitest run src/interactive/mouse
```

---

### Task 2: Mouse provider and clickable boxes

**Files:**
- Create: `apps/desktop/src/interactive/mouse/MouseProvider.tsx`
- Test: `apps/desktop/src/interactive/mouse/MouseProvider.test.tsx`

**Interfaces:**
- Consumes: `InputHub`, `MouseReport` (Task 1); `attachTestStdin`, `clickAt`, `pressAt`, `wheelAt` (Task 1).
- Produces:
  - `interface MouseClick { x: number; y: number; localX: number; localY: number; ctrl: boolean; alt: boolean; shift: boolean; double: boolean }`
  - `interface ClickHandlers { onClick?: (click: MouseClick) => void; onWheel?: (step: -1 | 1) => void; onOutside?: () => void }`
  - `const DOUBLE_CLICK_MS = 400`
  - `MouseProvider({ hub, now?, children })` (`now` defaults to `Date.now`, for tests)
  - `useMouse(): { inject(text: string): void; capture(handler: (text: string) => void): () => void }`
  - `useClickable(ref: RefObject<DOMElement | null>, handlers: ClickHandlers, options?: { active?: boolean; modal?: boolean }): void`
  - `Clickable(props: BoxProps & ClickHandlers & { active?: boolean; modal?: boolean; children?: ReactNode })`

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/interactive/mouse/MouseProvider.test.tsx`:

```tsx
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
    await tick();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0]?.[0]).toMatchObject({ x: 3, y: 1, localX: 1, localY: 0 });
    expect(outer).not.toHaveBeenCalled();
    app.stdin.write(clickAt(0, 0));
    await tick();
    expect(outer).toHaveBeenCalledTimes(1);
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
    await tick();
    expect(clicks.map((c) => c.double)).toEqual([false, true, false, false]);
  });

  it("fast clicks on different cells are not a double-click", async () => {
    const clicks: MouseClick[] = [];
    const app = mount(
      <Clickable flexDirection="column" onClick={(c) => clicks.push(c)}>
        <Text>row one</Text>
        <Text>row two</Text>
      </Clickable>,
    );
    await tick();
    app.stdin.write(clickAt(1, 0));
    app.stdin.write(clickAt(1, 1));
    await tick();
    expect(clicks.map((c) => c.double)).toEqual([false, false]);
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
    await tick();
    expect(onClick.mock.calls[0]?.[0]).toMatchObject({ ctrl: true });
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
    await tick();
    expect(onWheel.mock.calls).toEqual([[1], [-1]]);
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
    await tick();
    expect(behind).not.toHaveBeenCalled();
    expect(outside).toHaveBeenCalledTimes(1);
    app.stdin.write(clickAt(0, 1));
    await tick();
    expect(yes).toHaveBeenCalledTimes(1);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/mouse/MouseProvider.test.tsx`
Expected: FAIL, `Failed to resolve import "./MouseProvider.tsx"`.

- [ ] **Step 3: Write the implementation**

`apps/desktop/src/interactive/mouse/MouseProvider.tsx`:

```tsx
import { Box, type BoxProps, type DOMElement, measureElement } from "ink";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { InputHub, MouseReport } from "./input.ts";

/** A left-button press on a registered box. */
export interface MouseClick {
  x: number;
  y: number;
  /** The cell within the box, from its top-left. */
  localX: number;
  localY: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The second press on the same cell within `DOUBLE_CLICK_MS`. */
  double: boolean;
}

export interface ClickHandlers {
  onClick?: (click: MouseClick) => void;
  /** -1 up, 1 down: one call per wheel notch. */
  onWheel?: (step: -1 | 1) => void;
  /** Modal boxes only: a press that hit no modal box. */
  onOutside?: () => void;
}

export const DOUBLE_CLICK_MS = 400;

interface Entry {
  ref: RefObject<DOMElement | null>;
  handlers: RefObject<ClickHandlers>;
  modal: boolean;
  order: number;
}

interface MouseApi {
  register: (entry: Omit<Entry, "order">) => () => void;
  inject: (text: string) => void;
  capture: (handler: (text: string) => void) => () => void;
}

const INERT: MouseApi = {
  register: () => () => {},
  inject: () => {},
  capture: () => () => {},
};

const MouseContext = createContext<MouseApi>(INERT);

/** Types keys for the user, or takes the keys away from the screens for a moment. */
export function useMouse(): Pick<MouseApi, "inject" | "capture"> {
  return useContext(MouseContext);
}

export function MouseProvider({
  hub,
  now = Date.now,
  children,
}: {
  hub: InputHub;
  now?: () => number;
  children: ReactNode;
}) {
  const entries = useRef(new Set<Entry>());
  const order = useRef(0);
  const last = useRef<{ x: number; y: number; at: number }>(undefined);

  useEffect(() => {
    /** Registered boxes under the point that have `need`, smallest first, then newest. */
    const hits = (r: MouseReport, need: keyof ClickHandlers) => {
      const all = [...entries.current];
      const modal = all.filter((e) => e.modal);
      const scope = modal.length > 0 ? modal : all;
      return scope
        .flatMap((entry) => {
          const node = entry.ref.current;
          if (!node?.yogaNode || !entry.handlers.current[need]) return [];
          const box = measureElement(node);
          const inside =
            r.x >= box.x && r.x < box.x + box.width && r.y >= box.y && r.y < box.y + box.height;
          return inside ? [{ entry, box }] : [];
        })
        .sort(
          (a, b) =>
            a.box.width * a.box.height - b.box.width * b.box.height ||
            b.entry.order - a.entry.order,
        );
    };

    return hub.onMouse((r) => {
      if (r.kind === "wheel") {
        hits(r, "onWheel")[0]?.entry.handlers.current.onWheel?.(r.button < 0 ? -1 : 1);
        return;
      }
      if (r.kind !== "press" || r.button !== 0) return;
      const at = now();
      const previous = last.current;
      const double =
        previous !== undefined &&
        previous.x === r.x &&
        previous.y === r.y &&
        at - previous.at <= DOUBLE_CLICK_MS;
      // A double-click ends the run: a third quick press starts a new click.
      last.current = double ? undefined : { x: r.x, y: r.y, at };
      const hit = hits(r, "onClick")[0];
      if (!hit) {
        for (const entry of entries.current) {
          if (entry.modal) entry.handlers.current.onOutside?.();
        }
        return;
      }
      hit.entry.handlers.current.onClick?.({
        x: r.x,
        y: r.y,
        localX: r.x - hit.box.x,
        localY: r.y - hit.box.y,
        ctrl: r.ctrl,
        alt: r.alt,
        shift: r.shift,
        double,
      });
    });
  }, [hub, now]);

  const api = useMemo<MouseApi>(
    () => ({
      register: (entry) => {
        order.current += 1;
        const full = { ...entry, order: order.current };
        entries.current.add(full);
        return () => entries.current.delete(full);
      },
      inject: (text) => hub.inject(text),
      capture: (handler) => hub.capture(handler),
    }),
    [hub],
  );

  return <MouseContext.Provider value={api}>{children}</MouseContext.Provider>;
}

/** Makes the box behind `ref` take clicks and the wheel while `active`. */
export function useClickable(
  ref: RefObject<DOMElement | null>,
  handlers: ClickHandlers,
  { active = true, modal = false }: { active?: boolean; modal?: boolean } = {},
): void {
  const { register } = useContext(MouseContext);
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!active) return;
    return register({ ref, handlers: latest, modal });
  }, [register, ref, active, modal]);
}

export type ClickableProps = BoxProps &
  ClickHandlers & { active?: boolean; modal?: boolean; children?: ReactNode };

/** A `Box` that takes clicks. */
export function Clickable({
  onClick,
  onWheel,
  onOutside,
  active,
  modal,
  children,
  ...box
}: ClickableProps) {
  const ref = useRef<DOMElement>(null);
  useClickable(ref, { onClick, onWheel, onOutside }, { active, modal });
  return (
    <Box ref={ref} {...box}>
      {children}
    </Box>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/mouse`
Expected: PASS. If `measureElement` reports zero sizes for the first press, the test's `await tick()` after mount is too short: raise it to 50 ms, as in the 3b settle fix.

- [ ] **Step 5: Commit message (the user commits)**

```markdown
✨ desktop: route mouse clicks to the box under the pointer

## Description

Components register a box and get clicks, double-clicks and wheel
notches inside it. The smallest box under the pointer wins, measured
from Ink's layout when the press arrives, and modal boxes shut out
everything behind them, as prompts need.

## Test

pnpm --filter @mediaforge/desktop exec vitest run src/interactive/mouse
```

---

### Task 3: Terminal wiring — input stream, Windows console mode, on/off

**Files:**
- Create: `apps/desktop/src/interactive/mouse/terminal-stdin.ts`
- Create: `apps/desktop/src/console-mode.ts`
- Modify: `apps/desktop/src/interactive/start.tsx`
- Test: `apps/desktop/src/interactive/mouse/terminal-stdin.test.ts`, `apps/desktop/src/console-mode.test.ts`, `apps/desktop/src/interactive/start.test.ts`

**Interfaces:**
- Consumes: `InputHub` (Task 1), `MouseProvider` (Task 2).
- Produces:
  - `terminalStdin(hub: InputHub, source: TerminalSource, onRaw: () => void): { stream: NodeJS.ReadStream; close: () => void }`
  - `interface TerminalSource { setEncoding(encoding: "utf8"): unknown; setRawMode(on: boolean): unknown; on(event: "data", listener: (chunk: string | Buffer) => void): unknown; off(event: "data", listener: (chunk: string | Buffer) => void): unknown; resume(): unknown; pause(): unknown; ref(): unknown; unref(): unknown }`
  - `console-mode.ts`: `VT_INPUT_SCRIPT: string`, `enableVtInput(overrides?: Partial<{ platform: NodeJS.Platform; spawn: (command: string, args: string[]) => void }>): void`
  - `start.tsx`: `MOUSE_ON`, `MOUSE_OFF`, `mouseExitHook(write: (text: string) => void, stdin: { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }): () => void`

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/interactive/mouse/terminal-stdin.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { InputHub } from "./input.ts";
import { type TerminalSource, terminalStdin } from "./terminal-stdin.ts";
import { clickAt } from "./testing.ts";

function fakeSource() {
  const emitter = new EventEmitter();
  const source = Object.assign(emitter, {
    setEncoding: vi.fn(),
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  });
  return source as unknown as TerminalSource & EventEmitter & Record<string, ReturnType<typeof vi.fn>>;
}

describe("terminalStdin", () => {
  it("gives Ink the keys without the mouse reports", async () => {
    const source = fakeSource();
    const hub = new InputHub();
    const clicks = vi.fn();
    hub.onMouse(clicks);
    const { stream } = terminalStdin(hub, source, () => {});
    stream.setEncoding("utf8");
    source.emit("data", `a${clickAt(0, 0)}b`);
    await new Promise((r) => setImmediate(r));
    expect(stream.read()).toBe("ab");
    expect(clicks).toHaveBeenCalledTimes(2);
  });

  it("is a TTY whose raw mode switches the terminal's, then runs onRaw", () => {
    const source = fakeSource();
    const onRaw = vi.fn();
    const { stream } = terminalStdin(new InputHub(), source, onRaw);
    expect(stream.isTTY).toBe(true);
    stream.setRawMode(true);
    expect(source.setRawMode).toHaveBeenCalledWith(true);
    expect(onRaw).toHaveBeenCalledTimes(1);
    stream.setRawMode(false);
    expect(source.setRawMode).toHaveBeenLastCalledWith(false);
    expect(onRaw).toHaveBeenCalledTimes(1);
  });

  it("close stops reading the terminal", () => {
    const source = fakeSource();
    const { close } = terminalStdin(new InputHub(), source, () => {});
    close();
    expect(source.listenerCount("data")).toBe(0);
    expect(source.pause).toHaveBeenCalled();
  });
});
```

`apps/desktop/src/console-mode.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { enableVtInput, VT_INPUT_SCRIPT } from "./console-mode.ts";

describe("enableVtInput", () => {
  it("does nothing off Windows", () => {
    const spawn = vi.fn();
    enableVtInput({ platform: "linux", spawn });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs the constant script, encoded, on Windows", () => {
    const spawn = vi.fn();
    enableVtInput({ platform: "win32", spawn });
    const [command, args] = spawn.mock.calls[0] ?? [];
    expect(command).toBe("powershell");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(args[3], "base64").toString("utf16le")).toBe(VT_INPUT_SCRIPT);
  });

  it("sets 0x200 on the console input handle", () => {
    expect(VT_INPUT_SCRIPT).toContain("GetStdHandle(-10)");
    expect(VT_INPUT_SCRIPT).toContain("-bor 0x200");
  });

  it("never throws", () => {
    expect(() =>
      enableVtInput({
        platform: "win32",
        spawn: () => {
          throw new Error("no powershell");
        },
      }),
    ).not.toThrow();
  });
});
```

`apps/desktop/src/interactive/start.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { MOUSE_OFF, MOUSE_ON, mouseExitHook } from "./start.tsx";

describe("mouse switches", () => {
  it("are the SGR press/release/wheel modes", () => {
    expect(MOUSE_ON).toBe("\u001b[?1000h\u001b[?1006h");
    expect(MOUSE_OFF).toBe("\u001b[?1000l\u001b[?1006l");
  });

  it("the exit hook turns the mouse off and leaves raw mode", () => {
    const write = vi.fn();
    const setRawMode = vi.fn();
    mouseExitHook(write, { isTTY: true, setRawMode })();
    expect(write.mock.calls[0]?.[0]).toContain(MOUSE_OFF);
    expect(setRawMode).toHaveBeenCalledWith(false);
  });

  it("the exit hook skips raw mode on a non-TTY", () => {
    const setRawMode = vi.fn();
    mouseExitHook(vi.fn(), { isTTY: false, setRawMode })();
    expect(setRawMode).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/console-mode.test.ts src/interactive/start.test.ts src/interactive/mouse/terminal-stdin.test.ts`
Expected: FAIL (missing modules, missing exports).

- [ ] **Step 3: Write `terminal-stdin.ts`**

```ts
import { PassThrough } from "node:stream";
import type { InputHub } from "./input.ts";

/** The parts of `process.stdin` this uses. */
export interface TerminalSource {
  setEncoding(encoding: "utf8"): unknown;
  setRawMode(on: boolean): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  off(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  ref(): unknown;
  unref(): unknown;
}

/**
 * The input stream Ink reads: the terminal's keys with the mouse reports taken out by `hub`.
 * Raw mode passes through to the terminal; `onRaw` runs after each switch into raw mode (on
 * Windows, raw mode resets the console input mode, so the mouse bit goes back on there).
 */
export function terminalStdin(
  hub: InputHub,
  source: TerminalSource,
  onRaw: () => void,
): { stream: NodeJS.ReadStream; close: () => void } {
  const stream = new PassThrough();
  hub.deliver = (text) => stream.write(text);
  const onData = (chunk: string | Buffer) => hub.feed(String(chunk));
  source.setEncoding("utf8");
  source.on("data", onData);
  const tty = Object.assign(stream, {
    isTTY: true,
    setRawMode(on: boolean) {
      source.setRawMode(on);
      if (on) {
        source.resume();
        onRaw();
      }
      return tty;
    },
    ref() {
      source.ref();
      return tty;
    },
    unref() {
      source.unref();
      return tty;
    },
  });
  return {
    stream: tty as unknown as NodeJS.ReadStream,
    close: () => {
      source.off("data", onData);
      source.pause();
    },
  };
}
```

- [ ] **Step 4: Write `console-mode.ts`**

```ts
import { spawn as spawnChild } from "node:child_process";

/**
 * Turns on ENABLE_VIRTUAL_TERMINAL_INPUT (0x200) for the console input this process shares,
 * so the console sends mouse reports as text (Node's raw mode drops mouse records). A
 * constant: nothing is ever interpolated into it.
 */
export const VT_INPUT_SCRIPT = [
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;",
  "public static class MediaForgeConsole {",
  '[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int which);',
  '[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint mode);',
  '[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint mode); }';",
  "$h = [MediaForgeConsole]::GetStdHandle(-10); $m = 0;",
  "if ([MediaForgeConsole]::GetConsoleMode($h, [ref]$m)) {",
  "[void][MediaForgeConsole]::SetConsoleMode($h, $m -bor 0x200) }",
].join(" ");

interface ConsoleModeDeps {
  platform: NodeJS.Platform;
  /** Starts a process whose stdin is this console; must not throw. */
  spawn: (command: string, args: string[]) => void;
}

const defaults = (): ConsoleModeDeps => ({
  platform: process.platform,
  // stdin is inherited: GetStdHandle(-10) in the child is this console's input buffer.
  spawn: (command, args) => {
    const child = spawnChild(command, args, { stdio: ["inherit", "ignore", "ignore"] });
    child.on("error", () => {});
    child.unref();
  },
});

/** Lets the Windows console send mouse reports. Best effort: never throws; a no-op elsewhere. */
export function enableVtInput(overrides: Partial<ConsoleModeDeps> = {}): void {
  const deps = { ...defaults(), ...overrides };
  if (deps.platform !== "win32") return;
  try {
    // Encoded, so Windows argument quoting cannot touch the quotes in the C# source.
    const encoded = Buffer.from(VT_INPUT_SCRIPT, "utf16le").toString("base64");
    deps.spawn("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);
  } catch {
    // Without it the mouse does not work in this console; the keys still do.
  }
}
```

- [ ] **Step 5: Wire `start.tsx`**

Add imports:

```ts
import { enableVtInput } from "../console-mode.ts";
import { InputHub } from "./mouse/input.ts";
import { MouseProvider } from "./mouse/MouseProvider.tsx";
import { terminalStdin } from "./mouse/terminal-stdin.ts";
```

Below `LEAVE_SCREEN`:

```ts
/** Mouse reporting: presses, releases and the wheel, in SGR encoding. */
export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";

/**
 * Leaves the terminal usable if the process ends without unmounting (a crash): mouse off,
 * normal screen, raw mode off. Raw mode off also resets the Windows console input mode.
 */
export function mouseExitHook(
  write: (text: string) => void,
  stdin: { isTTY?: boolean; setRawMode?: (on: boolean) => unknown },
): () => void {
  return () => {
    write(MOUSE_OFF + LEAVE_SCREEN);
    if (stdin.isTTY) stdin.setRawMode?.(false);
  };
}
```

Replace `startInteractive`:

```tsx
export async function startInteractive(options: { manager?: boolean } = {}): Promise<ExitCode> {
  const hub = new InputHub();
  const input = terminalStdin(hub, process.stdin, () => enableVtInput());
  const onExit = mouseExitHook((text) => void process.stdout.write(text), process.stdin);
  process.once("exit", onExit);
  process.stdout.write(ENTER_SCREEN + MOUSE_ON);
  try {
    const app = render(
      <MouseProvider hub={hub}>
        <App deps={realDeps()} {...(options.manager && { start: "manager" as const })} />
      </MouseProvider>,
      { exitOnCtrlC: false, stdin: input.stream },
    );
    await app.waitUntilExit();
  } finally {
    process.stdout.write(MOUSE_OFF + LEAVE_SCREEN);
    process.removeListener("exit", onExit);
    input.close();
  }
  return ExitCode.Ok;
}
```

- [ ] **Step 6: Run the tests and the type check**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/console-mode.test.ts src/interactive/start.test.ts src/interactive/mouse && pnpm --filter @mediaforge/desktop exec tsc --noEmit`
Expected: PASS, no type errors. If importing `start.tsx` in the test pulls in too much (slow, or a side effect), move `MOUSE_ON`, `MOUSE_OFF` and `mouseExitHook` to `mouse/switches.ts`, import them in `start.tsx`, and point the test there.

- [ ] **Step 7: Commit message (the user commits)**

```markdown
✨ desktop: turn the mouse on in the interactive app

## Description

The app switches SGR mouse reporting on with the alternate screen and
reads input through the hub. On Windows a PowerShell child sets the
console's virtual terminal input bit, without which Node never sees a
click. Reporting goes off on every exit, also after a crash.

## Test

pnpm --filter @mediaforge/desktop exec vitest run src/console-mode.test.ts src/interactive/start.test.ts src/interactive/mouse
```

---

### Task 4: Clipboard write

**Files:**
- Modify: `apps/desktop/src/interactive/clipboard.ts`
- Modify: `apps/desktop/src/interactive/deps.ts`
- Modify: `apps/desktop/src/interactive/start.tsx` (`realDeps`)
- Modify: `apps/desktop/src/interactive/App.test.tsx` (test deps)
- Test: `apps/desktop/src/interactive/logic.test.ts`

**Interfaces:**
- Produces:
  - `copyCommands(platform: NodeJS.Platform): ClipboardCommand[]`
  - `type RunWithInput = (command: string, args: string[], input: string) => Promise<void>`
  - `writeClipboard(text: string, run?: RunWithInput, platform?: NodeJS.Platform): Promise<boolean>`
  - `AppDeps.writeClipboard: (text: string) => Promise<boolean>`

- [ ] **Step 1: Write the failing tests** (append to the clipboard `describe` in `logic.test.ts`; add `copyCommands, writeClipboard` to its import from `./clipboard.ts`)

```ts
  it("copies with Set-Clipboard on Windows, the text on stdin", () => {
    const [first] = copyCommands("win32");
    expect(first?.command).toBe("powershell.exe");
    expect(first?.args.join(" ")).toContain("Set-Clipboard");
    expect(first?.args.join(" ")).toContain("[Console]::In.ReadToEnd()");
  });

  it("copies with wl-copy, then xclip, then xsel on Linux", () => {
    expect(copyCommands("linux").map((c) => c.command)).toEqual(["wl-copy", "xclip", "xsel"]);
  });

  it("writeClipboard tries the tools in order and passes the text on stdin", async () => {
    const calls: [string, string][] = [];
    const ok = await writeClipboard(
      "https://example.com/v",
      async (command, _args, input) => {
        calls.push([command, input]);
        if (command === "wl-copy") throw new Error("no wayland");
      },
      "linux",
    );
    expect(ok).toBe(true);
    expect(calls).toEqual([
      ["wl-copy", "https://example.com/v"],
      ["xclip", "https://example.com/v"],
    ]);
  });

  it("writeClipboard is false when no tool works", async () => {
    const ok = await writeClipboard(
      "x",
      async () => {
        throw new Error("missing");
      },
      "linux",
    );
    expect(ok).toBe(false);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/logic.test.ts`
Expected: FAIL, `copyCommands is not a function` (or a missing export error).

- [ ] **Step 3: Implement** (append to `clipboard.ts`; add `import { spawn } from "node:child_process";` at the top)

```ts
/** Commands that set the clipboard to their stdin, in the order to try them. */
export function copyCommands(platform: NodeJS.Platform): ClipboardCommand[] {
  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
        ],
      },
    ];
  }
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

export type RunWithInput = (command: string, args: string[], input: string) => Promise<void>;

const COPY_TIMEOUT_MS = 4000;

const defaultRunWithInput: RunWithInput = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      timeout: COPY_TIMEOUT_MS,
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
  });

/** Puts `text` on the clipboard. False when no clipboard tool works. */
export async function writeClipboard(
  text: string,
  run: RunWithInput = defaultRunWithInput,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  for (const { command, args } of copyCommands(platform)) {
    try {
      await run(command, args, text);
      return true;
    } catch {
      // Try the next tool.
    }
  }
  return false;
}
```

In `deps.ts`, after `readClipboard`:

```ts
  /** Puts text on the clipboard; false when no clipboard tool works. Never rejects. */
  writeClipboard: (text: string) => Promise<boolean>;
```

In `start.tsx` `realDeps()`, after `readClipboard: () => readClipboard(),`:

```ts
    writeClipboard: (text) => writeClipboard(text),
```

and import it: `import { readClipboard, writeClipboard } from "./clipboard.ts";`.

In `App.test.tsx` `setup()`, add `writeClipboard: vi.fn(async () => true),` next to `readClipboard` in the deps object.

- [ ] **Step 4: Run tests and type check**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/logic.test.ts src/interactive/App.test.tsx && pnpm --filter @mediaforge/desktop exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit message (the user commits)**

```markdown
✨ desktop: write text to the system clipboard

## Description

The manager's detail panel copies the link and the path. Windows uses
Set-Clipboard and Linux tries wl-copy, xclip and xsel. The text goes
over stdin, so no argument quoting can change it.

## Test

pnpm --filter @mediaforge/desktop exec vitest run src/interactive/logic.test.ts
```

---

### Task 5: Menu, TextField and the folder picker

**Files:**
- Modify: `apps/desktop/src/interactive/components/Menu.tsx`
- Modify: `apps/desktop/src/interactive/components/TextField.tsx`
- Modify: `apps/desktop/src/interactive/screens/PathPickerScreen.tsx`
- Test: `apps/desktop/src/interactive/components/Menu.test.tsx`

**Interfaces:**
- Consumes: `Clickable`, `MouseClick`, `MouseProvider` (Task 2); `InputHub`, `attachTestStdin`, `clickAt`, `wheelAt` (Task 1).

- [ ] **Step 1: Write the failing tests** (append to `Menu.test.tsx`; add the imports)

```tsx
import { InputHub } from "../mouse/input.ts";
import { MouseProvider } from "../mouse/MouseProvider.tsx";
import { attachTestStdin, clickAt, wheelAt } from "../mouse/testing.ts";

function withMouse(tree: React.ReactElement) {
  const hub = new InputHub();
  const app = render(<MouseProvider hub={hub}>{tree}</MouseProvider>);
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
    await tick();
    expect(app.lastFrame()).toMatch(/► 2 Bravo/);
    expect(onSelect).not.toHaveBeenCalled();
    app.stdin.write(clickAt(4, 1));
    await tick();
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("ignores clicks on disabled rows", async () => {
    const app = withMouse(<Menu items={four} onSelect={() => {}} />);
    await tick();
    app.stdin.write(clickAt(4, 2));
    await tick();
    expect(app.lastFrame()).toMatch(/► 1 Alpha/);
  });

  it("the wheel moves the highlight, skipping disabled rows", async () => {
    const app = withMouse(<Menu items={four} onSelect={() => {}} />);
    await tick();
    app.stdin.write(wheelAt(4, 0, 1));
    app.stdin.write(wheelAt(4, 0, 1));
    await tick();
    expect(app.lastFrame()).toMatch(/► 4 Delta/);
  });
});

describe("TextField mouse", () => {
  it("a click puts the cursor on the clicked character", async () => {
    const onSubmit = vi.fn();
    const app = withMouse(<TextField initial="abcdef" onSubmit={onSubmit} onCancel={() => {}} />);
    await tick();
    // Border (1) + padding (1) + "► " (2): the text starts at column 4. Column 6 is "c".
    app.stdin.write(clickAt(6, 1));
    await tick();
    app.stdin.write("X");
    await tick();
    expect(app.lastFrame()).toContain("abXcdef");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/components/Menu.test.tsx`
Expected: the four new tests FAIL (nothing reacts to clicks).

- [ ] **Step 3: Implement `Menu`**

Import `Clickable` from `../mouse/MouseProvider.tsx`. Wrap the outer `Box` and each item row:

```tsx
  return (
    <Clickable
      flexDirection="column"
      active={isActive}
      onWheel={(step) => setIndex((i) => stepIndex(items, i, step))}
    >
```

(closing tag `</Clickable>` in place of the outer `</Box>`), and replace the non-divider row's `<Box key={position}>` / `</Box>` with:

```tsx
          <Clickable
            key={position}
            active={isActive}
            onClick={(click) => {
              if (item.disabled) return;
              setIndex(position);
              if (click.double) select(item);
            }}
          >
```

and `</Clickable>`.

- [ ] **Step 4: Implement `TextField` (one-line only)**

Import `Clickable` from `../mouse/MouseProvider.tsx`. In the one-line return, replace the bordered `<Box borderStyle="single" …>` with a `Clickable` taking the same props plus:

```tsx
        onClick={(click) => {
          // Border, padding and "► " come before the text.
          const column = click.localX - TEXT_OFFSET;
          if (column < 0) return;
          const start = cursor - shown.cursor;
          setCursor(Math.min(value.length, start + column));
        }}
```

with `const TEXT_OFFSET = 4;` next to `PASTE_GAP_MS`. The multi-line branch stays as it is.

- [ ] **Step 5: Implement `PathPickerScreen`**

Import `Clickable`. Wrap the folder list block (the fragment that maps `names.slice(start, end)`) in:

```tsx
          <Clickable
            flexDirection="column"
            onWheel={(step) =>
              setIndex((i) => (names.length ? (i + step + names.length) % names.length : 0))
            }
          >
```

and each folder row (`<Text key={name}>…</Text>`) in:

```tsx
                <Clickable
                  key={name}
                  onClick={(click) => {
                    setIndex(start + offset);
                    if (click.double) edit((current) => completeWith(platform, current, name));
                  }}
                >
                  <Text>…unchanged…</Text>
                </Clickable>
```

(the inner `Text` loses its `key`).

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/components src/interactive/App.test.tsx`
Expected: PASS, including the existing Menu and App tests (no provider there: clicks inert).

- [ ] **Step 7: Commit message (the user commits)**

```markdown
✨ desktop: click, double-click and scroll in menus and the folder picker

## Description

Menus highlight on a click and pick on a double-click, the wheel moves
the highlight, and the folder picker opens a folder on a double-click.
A click in a text field puts the cursor on the clicked character.

## Test

pnpm --filter @mediaforge/desktop exec vitest run src/interactive/components
```

---

### Task 6: Frame key hints and the Ctrl+C prompt

**Files:**
- Modify: `apps/desktop/src/interactive/components/Frame.tsx`
- Modify: `apps/desktop/src/interactive/screens/DownloadScreen.tsx`, `apps/desktop/src/interactive/screens/batch/BatchDownloadScreen.tsx`
- Test: `apps/desktop/src/interactive/components/Frame.test.tsx`

**Interfaces:**
- Consumes: `Clickable`, `useMouse` (Task 2); `keySequence` (Task 1).
- Produces: `FrameProps.ctrlCQuestion?: string` (default `Quit MediaForge?` for `ctrlC="Quit"`, `Cancel the download?` for `ctrlC="Cancel"`).

- [ ] **Step 1: Write the failing tests** (append to `Frame.test.tsx`; it already has `deps`, `tick` and the `DepsContext` import; add `type FrameProps` to the `./Frame.tsx` import)

```tsx
import { useInput } from "ink";
import { InputHub } from "../mouse/input.ts";
import { MouseProvider } from "../mouse/MouseProvider.tsx";
import { attachTestStdin, clickAt } from "../mouse/testing.ts";

function KeySpy({ keys }: { keys: string[] }) {
  useInput((input, key) => {
    keys.push(key.escape ? "esc" : key.ctrl && input === "c" ? "ctrl+c" : input);
  });
  return null;
}

function hinted(keys: string[], props: Partial<FrameProps> = {}) {
  const hub = new InputHub();
  const app = render(
    <MouseProvider hub={hub}>
      <DepsContext.Provider value={deps}>
        <Frame crumbs={["Home"]} icon="*" title="T" hints={[["Esc", "Back"], ["↑↓", "Move"]]} {...props}>
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
    await tick(80);
    expect(keys).toEqual(["esc"]);
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
    await tick();
    expect(hintLine()).toContain("y/N  Quit MediaForge?");
    app.stdin.write("n");
    await tick();
    expect(hintLine()).toContain("Esc");
    expect(keys).toEqual([]);
  });

  it("y (key or click) sends Ctrl+C", async () => {
    const keys: string[] = [];
    const { app, hintLine, lineY } = hinted(keys, { ctrlC: "Cancel" });
    await tick();
    app.stdin.write(clickAt(hintLine().indexOf("Ctrl+C"), lineY()));
    await tick();
    expect(hintLine()).toContain("y/N  Cancel the download?");
    app.stdin.write(clickAt(hintLine().indexOf("y"), lineY()));
    await tick();
    expect(keys).toEqual(["ctrl+c"]);
  });

  it("a click elsewhere answers No; Ctrl+C on the keyboard still goes through", async () => {
    const keys: string[] = [];
    const { app, hintLine, lineY } = hinted(keys, { ctrlCQuestion: "Cancel all downloads?" });
    await tick();
    app.stdin.write(clickAt(hintLine().indexOf("Ctrl+C"), lineY()));
    await tick();
    expect(hintLine()).toContain("Cancel all downloads?");
    app.stdin.write(clickAt(0, 0));
    await tick();
    expect(hintLine()).toContain("Esc");
    app.stdin.write(clickAt(hintLine().indexOf("Ctrl+C"), lineY()));
    await tick();
    app.stdin.write("\u0003");
    await tick();
    expect(keys).toEqual(["ctrl+c"]);
  });
});
```

The hint row is the last line of the frame (tests have no terminal height); the version sits at its right end, so `indexOf` finds the hint keys first.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/components/Frame.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement in `Frame.tsx`**

Imports: `useRef, useState` from react; `Clickable, useMouse` from `../mouse/MouseProvider.tsx`; `keySequence` from `../mouse/input.ts`.

Props: add to `FrameProps`:

```ts
  /** The y/N question a click on the Ctrl+C hint asks. Defaults by `ctrlC`. */
  ctrlCQuestion?: string;
```

and a module constant:

```ts
const CTRL_C_QUESTION = { Quit: "Quit MediaForge?", Cancel: "Cancel the download?" } as const;
const CTRL_C = "\u0003";
```

In the component, after `shownHints`:

```tsx
  const mouse = useMouse();
  const [asking, setAsking] = useState(false);
  const answered = useRef(false);
  const answer = (yes: boolean) => {
    if (answered.current) return;
    answered.current = true;
    setAsking(false);
    if (yes) mouse.inject(CTRL_C);
  };
  // While the question shows, keys answer it and reach no screen. Ctrl+C itself still quits.
  useEffect(() => {
    if (!asking) return;
    answered.current = false;
    return mouse.capture((text) => answer(/^[yY]$/.test(text) || text.includes(CTRL_C)));
  }, [asking, mouse]);
  const question = ctrlCQuestion ?? CTRL_C_QUESTION[ctrlC];
```

(Biome may ask for `answer` in the effect's dependency list; wrap `answer` in `useCallback` with `[mouse]` and list it.)

Replace the hint row (`<Box gap={2}>…</Box>`) with:

```tsx
        {asking ? (
          <Clickable modal onOutside={() => answer(false)}>
            <Clickable modal onClick={() => answer(true)}>
              <Text bold color={COLORS.warn}>
                y
              </Text>
            </Clickable>
            <Text color={COLORS.warn}>/</Text>
            <Clickable modal onClick={() => answer(false)}>
              <Text color={COLORS.warn}>N</Text>
            </Clickable>
            <Text color={COLORS.warn}>{`  ${question}`}</Text>
          </Clickable>
        ) : (
          <Box gap={2}>
            {shownHints.map(([key, label]) => {
              const sequence = keySequence(key);
              return (
                <Clickable
                  key={key}
                  active={sequence !== undefined}
                  onClick={() => (key === "Ctrl+C" ? setAsking(true) : sequence && mouse.inject(sequence))}
                >
                  <Text>
                    <Text bold color={COLORS.accent}>
                      {key}
                    </Text>
                    <Text color={COLORS.muted}> {label}</Text>
                  </Text>
                </Clickable>
              );
            })}
          </Box>
        )}
```

Destructure `ctrlCQuestion` in the parameters.

- [ ] **Step 4: Pass the questions**

`BatchDownloadScreen.tsx`: next to `ctrlC="Cancel"` add `ctrlCQuestion="Cancel all downloads?"`. `DownloadScreen.tsx` keeps the default (`Cancel the download?`).

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/components src/interactive/App.test.tsx src/interactive/screens`
Expected: PASS.

- [ ] **Step 6: Commit message (the user commits)**

```markdown
✨ desktop: run a key hint by clicking it

## Description

Every Frame hint types its key when clicked, so the mouse reaches every
screen without screen code. A click on Ctrl+C asks y/N first, since a
stray click should not quit or cancel; the key itself stays immediate.

## Test

pnpm --filter @mediaforge/desktop exec vitest run src/interactive/components/Frame.test.tsx
```

---

### Task 7: Manager table, wheel, key bar and prompt clicks

**Files:**
- Modify: `apps/desktop/src/interactive/manager/model.ts` (+ `model.test.ts`)
- Modify: `apps/desktop/src/interactive/manager/Table.tsx`
- Modify: `apps/desktop/src/interactive/screens/ManagerScreen.tsx`
- Test: `apps/desktop/src/interactive/screens/ManagerScreen.test.tsx`

**Interfaces:**
- Consumes: `Clickable`, `MouseClick`, `useMouse`, `MouseProvider` (Task 2); `keySequence`, `InputHub`, test helpers (Task 1).
- Produces:
  - `tickRange(ticks: string[], visibleIds: string[], cursorId: string | undefined, targetId: string): string[]` in `model.ts`.
  - `TableProps.onRowClick?: (job: DownloadJob, click: MouseClick) => void`, `TableProps.onHeaderClick?: (column: Column) => void`, `TableProps.active?: boolean`.
  - `export const WHEEL_ROWS = 3` and `export const BOX_COLUMNS = [1, 2, 3]` (cells of `[ ]`) in `Table.tsx`.

- [ ] **Step 1: Write the failing `tickRange` tests** (`model.test.ts`)

```ts
describe("tickRange", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("ticks from the last ticked visible row to the target", () => {
    expect(tickRange(["b"], ids, "a", "d")).toEqual(["b", "c", "d"]);
  });

  it("starts at the cursor row when nothing visible is ticked", () => {
    expect(tickRange(["hidden"], ids, "d", "b")).toEqual(["hidden", "b", "c", "d"]);
  });

  it("uses the most recently ticked row as the anchor", () => {
    expect(tickRange(["a", "e"], ids, undefined, "c")).toEqual(["a", "e", "c", "d"]);
  });

  it("ticks the target alone with no anchor", () => {
    expect(tickRange([], ids, undefined, "c")).toEqual(["c"]);
  });
});
```

- [ ] **Step 2: Implement `tickRange`** (`model.ts`)

```ts
/**
 * Ctrl+click: tick every visible row from the anchor to `targetId`, keeping the other ticks.
 * The anchor is the most recently ticked visible row, else the cursor row, else the target.
 */
export function tickRange(
  ticks: string[],
  visibleIds: string[],
  cursorId: string | undefined,
  targetId: string,
): string[] {
  const anchor = [...ticks].reverse().find((id) => visibleIds.includes(id)) ?? cursorId ?? targetId;
  const from = visibleIds.indexOf(anchor);
  const to = visibleIds.indexOf(targetId);
  if (to < 0) return ticks;
  const start = from < 0 ? to : Math.min(from, to);
  const end = from < 0 ? to : Math.max(from, to);
  const added = visibleIds.slice(start, end + 1).filter((id) => !ticks.includes(id));
  return [...ticks, ...added];
}
```

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/manager/model.test.ts` → PASS.

- [ ] **Step 3: Write the failing screen tests** (`ManagerScreen.test.tsx`)

Change `mount` to wrap the tree in a provider and route stdin through it:

```tsx
import { InputHub } from "../mouse/input.ts";
import { MouseProvider } from "../mouse/MouseProvider.tsx";
import { attachTestStdin, clickAt, pressAt, wheelAt } from "../mouse/testing.ts";
```

```tsx
  const hub = new InputHub();
  const app = render(
    <MouseProvider hub={hub}>
      <DepsContext.Provider value={deps}>
        …unchanged…
      </DepsContext.Provider>
    </MouseProvider>,
  );
  attachTestStdin(hub, app.stdin);
```

and add to the returned object:

```ts
  /** Row of the screen whose text contains `text`, and the column where it starts. */
  const find = (text: string) => {
    const lines = frame().split("\n");
    const y = lines.findIndex((line) => line.includes(text));
    return { x: lines[y]?.indexOf(text) ?? -1, y };
  };
  const click = async (x: number, y: number, mods: { ctrl?: boolean } = {}) => {
    app.stdin.write(clickAt(x, y, mods));
    await new Promise((r) => setTimeout(r, 30));
  };
  const wheel = async (step: -1 | 1) => {
    app.stdin.write(wheelAt(10, 3, step));
    await new Promise((r) => setTimeout(r, 30));
  };
```

returning `{ …, find, click, wheel, hub }`. Add `writeClipboard: vi.fn(async () => true)` to the deps object and return it as `writeClipboard` for Task 8.

```tsx
const ten = () =>
  Array.from({ length: 10 }, (_, i) =>
    row(`j${i}`, { title: `Clip ${i}`, lastTryAt: Date.now() - i * 1000 }),
  );
const cursorRow = (frame: string) => tableRows(frame).findIndex((line) => line.startsWith(">"));

describe("ManagerScreen mouse", () => {
  it("a click on a row moves the cursor there", async () => {
    const m = await mount({ jobs: ten() });
    const { y } = m.find("Clip 3");
    await m.click(10, y);
    expect(cursorRow(m.frame())).toBe(3);
  });

  it("a click on the box ticks the row and moves the cursor", async () => {
    const m = await mount({ jobs: ten() });
    const { y } = m.find("Clip 2");
    await m.click(2, y);
    expect(tableRows(m.frame())[2]).toMatch(/^>\[•\]/);
    await m.click(2, y);
    expect(tableRows(m.frame())[2]).toMatch(/^>\[ \]/);
  });

  it("Ctrl+click ticks a range from the cursor row", async () => {
    const m = await mount({ jobs: ten() });
    await m.click(10, m.find("Clip 1").y);
    await m.click(10, m.find("Clip 4").y, { ctrl: true });
    const ticked = tableRows(m.frame()).map((line) => line.includes("[•]"));
    expect(ticked).toEqual([false, true, true, true, true, false, false, false, false, false]);
    expect(cursorRow(m.frame())).toBe(4);
  });

  it("a double-click on a row opens its details", async () => {
    const m = await mount({ jobs: ten() });
    const { y } = m.find("Clip 5");
    await m.click(10, y);
    await m.click(10, y);
    expect(m.frame()).toContain("Details");
    expect(m.frame()).toContain("Clip 5");
  });

  it("a click on a column header sorts by it; again reverses", async () => {
    const m = await mount({ jobs: three() });
    const header = m.find("Size");
    await m.click(header.x, header.y);
    await vi.waitFor(() => expect(m.frame()).toContain("Size ▼"));
    expect(tableRows(m.frame())[0]).toContain("Big Buck Bunny");
    await m.click(header.x, header.y);
    await vi.waitFor(() => expect(m.frame()).toContain("Size ▲"));
  });

  it("the wheel moves the cursor 3 rows", async () => {
    const m = await mount({ jobs: ten() });
    await m.wheel(1);
    expect(cursorRow(m.frame())).toBe(3);
    await m.wheel(-1);
    expect(cursorRow(m.frame())).toBe(0);
  });

  it("a key-bar word runs its key", async () => {
    const m = await mount({ jobs: three() });
    const word = m.find("? Keys");
    await m.click(word.x, word.y);
    expect(m.frame()).toContain("Move the cursor");
  });

  it("y and N in a prompt answer it", async () => {
    const jobs = [row("run", { title: "Live", status: "downloading", lastTryAt: Date.now() })];
    const m = await mount({ jobs });
    await m.press("c");
    const prompt = m.find("y/N");
    expect(prompt.y).toBeGreaterThan(0);
    await m.click(prompt.x + 2, prompt.y);
    expect(m.frame()).not.toContain("y/N");
    await m.press("c");
    await m.click(m.find("y/N").x, m.find("y/N").y);
    await vi.waitFor(() => expect(m.frame()).toContain("Cancelled 1"));
  });

  it("ignores clicks behind a prompt", async () => {
    const m = await mount({ jobs: ten() });
    // Del always asks (x on a completed row would remove it at once).
    await m.press(KEY.del);
    expect(m.frame()).toContain("y/N");
    await m.click(10, m.find("Clip 4").y);
    await m.wheel(1);
    expect(m.frame()).toContain("y/N");
    expect(cursorRow(m.frame())).toBe(0);
  });

  it("ignores clicks on the table while a panel is open", async () => {
    const m = await mount({ jobs: ten() });
    await m.press("f");
    const before = m.frame();
    await m.click(10, 2);
    await m.wheel(1);
    expect(m.frame()).toBe(before);
  });
});
```

`resultText("cancel", 1, 0, [])` is `Cancelled 1` (`actions.ts`). In `y and N in a prompt answer it`, the prompt line reads ` y/N  Cancel 1 download? …`: `find("y/N").x` is the `y`, `+ 2` the `N`.

- [ ] **Step 4: Run to verify they fail**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/screens/ManagerScreen.test.tsx`
Expected: the new `ManagerScreen mouse` tests FAIL; the old ones still PASS.

- [ ] **Step 5: Implement `Table.tsx`**

```tsx
import { Clickable, type MouseClick } from "../mouse/MouseProvider.tsx";

/** Cells of the `[ ]` box in a row: column 0 is the cursor mark. */
export const BOX_COLUMNS = [1, 2, 3];
/** Rows the cursor moves per wheel notch. */
export const WHEEL_ROWS = 3;
```

Add to `TableProps`:

```ts
  onRowClick?: (job: DownloadJob, click: MouseClick) => void;
  onHeaderClick?: (column: Column) => void;
  /** False while a panel or prompt is up: the table takes no clicks. */
  active?: boolean;
```

Header cells: wrap each header `Cell` in

```tsx
          <Clickable key={column} flexShrink={0} active={active} onClick={() => onHeaderClick?.(column)}>
            <Cell width={widthOf(column, name)} … />
          </Clickable>
```

(the `Cell` loses its `key`). Rows: replace each row's outer `<Box key={job.id} width={width} overflow="hidden">` with

```tsx
        <Clickable
          key={job.id}
          width={width}
          overflow="hidden"
          active={active}
          onClick={(click) => onRowClick?.(job, click)}
        >
```

and its closing tag. Destructure `onRowClick`, `onHeaderClick`, `active = true` in `Table`.

- [ ] **Step 6: Implement `ManagerScreen.tsx`**

Imports: `Clickable, type MouseClick, useMouse` from `../mouse/MouseProvider.tsx`; `keySequence` from `../mouse/input.ts`; `BOX_COLUMNS, WHEEL_ROWS` from `../manager/Table.tsx`; `tickRange` from `../manager/model.ts`.

Key bar: replace `keyBar(width): string` with

```ts
/** As many key hints as fit, always ending with `? Keys`. */
function keyBar(width: number): [string, string][] {
  const parts: [string, string][] = [...KEY_BAR];
  const length = (list: [string, string][]) =>
    ` ${[...list, ["?", "Keys"]].map(([k, l]) => `${k} ${l}`).join("  ")}`.length;
  while (parts.length > 0 && length(parts) > width) parts.pop();
  return [...parts, ["?", "Keys"]];
}
```

and delete `KEYS_HINT`.

In the component, after `moveTo`:

```ts
  const mouse = useMouse();
  /** Clicks reach the list only while nothing is drawn over it. */
  const listMode = mode.name === "list" || mode.name === "search";

  const clickRow = (job: DownloadJob, click: MouseClick) => {
    if (click.ctrl) {
      setView((v) => ({ ...v, ticks: tickRange(v.ticks, visibleIds, cursorJob?.id, job.id), cursorId: job.id }));
      return;
    }
    const onBox = BOX_COLUMNS.includes(click.localX);
    setView((v) => ({
      ...v,
      cursorId: job.id,
      ...(onBox && {
        ticks: v.ticks.includes(job.id) ? v.ticks.filter((id) => id !== job.id) : [...v.ticks, job.id],
      }),
    }));
    if (click.double && !onBox) setMode({ name: "detail", id: job.id });
  };

  const answer = (yes: boolean) => {
    if (mode.name !== "confirm") return;
    setMode({ name: "list" });
    if (yes) send(mode.run);
  };
```

(`DownloadJob` type import from `@mediaforge/shared-types`; `visibleIds` must be declared before `clickRow`, so move `const visibleIds = shown.map((job) => job.id);` up next to `ticks`.)

In `useInput`, replace the confirm branch with:

```ts
    if (mode.name === "confirm") {
      answer(input === "y" || input === "Y");
      return;
    }
```

Pass to `Table`:

```tsx
          active={listMode}
          onRowClick={clickRow}
          onHeaderClick={(column) => saveSort(nextSort(sort, column))}
```

Footer: the confirm branch becomes

```tsx
      <Box width={width}>
        <Text> </Text>
        <Clickable modal onClick={() => answer(true)}>
          <Text bold color={COLORS.warn}>
            y
          </Text>
        </Clickable>
        <Text color={COLORS.warn}>/</Text>
        <Clickable modal onClick={() => answer(false)}>
          <Text color={COLORS.warn}>N</Text>
        </Clickable>
        <Box flexShrink={1}>
          {/* Wraps rather than cuts: the whole question must be readable. */}
          <Text color={COLORS.warn} wrap="wrap">
            {mode.text.replace(/^y\/N/, "")}
          </Text>
        </Box>
      </Box>
```

and the key-bar branch:

```tsx
      <Box width={width} overflow="hidden">
        <Text> </Text>
        {keyBar(width).map(([key, label], i) => (
          <Clickable
            key={key}
            flexShrink={0}
            active={mode.name === "list"}
            onClick={() => {
              const sequence = keySequence(key);
              if (sequence) mouse.inject(sequence);
            }}
          >
            <Text color={COLORS.muted}>{`${i > 0 ? "  " : ""}${key} ${label}`}</Text>
          </Clickable>
        ))}
      </Box>
```

Outer box: make the root `Box` a `Clickable` taking the wheel:

```tsx
    <Clickable
      flexDirection="column"
      width={width}
      active={listMode}
      onWheel={(step) => moveTo(cursor + step * WHEEL_ROWS)}
    >
```

(closing `</Clickable>`).

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/screens/ManagerScreen.test.tsx src/interactive/manager`
Expected: PASS, old and new. The 3b key-bar tests compare text: `keyBar` renders the same string as before (`" a Add  p Pause …  ? Keys"`); fix spacing in the render if one fails.

- [ ] **Step 8: Commit message (the user commits)**

```markdown
✨ desktop: click, tick and scroll in the downloads manager

## Description

Rows take clicks (cursor), box clicks (tick), Ctrl+click (range from
the last ticked row) and double-clicks (details). Headers sort, the
wheel moves three rows, key-bar words run their key and y/N answer a
prompt. Shift+click is left to the terminal, which uses it to select.

## Test

pnpm --filter @mediaforge/desktop exec vitest run src/interactive/screens/ManagerScreen.test.tsx src/interactive/manager
```

---

### Task 8: Manager panels, copy and the mouse help

**Files:**
- Modify: `apps/desktop/src/interactive/manager/FilterPanel.tsx`
- Modify: `apps/desktop/src/interactive/manager/DetailPanel.tsx`
- Modify: `apps/desktop/src/interactive/manager/KeyList.tsx`
- Modify: `apps/desktop/src/interactive/about.ts`, `apps/desktop/src/interactive/screens/AboutScreen.tsx`
- Modify: `apps/desktop/src/interactive/screens/ManagerScreen.tsx`
- Test: `apps/desktop/src/interactive/screens/ManagerScreen.test.tsx`, `apps/desktop/src/interactive/about.test.ts`

**Interfaces:**
- Consumes: `Clickable` (Task 2); `AppDeps.writeClipboard` (Task 4); `mount` with `find`, `click`, `wheel`, `writeClipboard` (Task 7).
- Produces: `DetailPanelProps.onCopy: (field: "url" | "path") => void`; `SELECT_TIP` in `about.ts`; copy texts in `ManagerScreen` (H15).

- [ ] **Step 1: Write the failing tests** (`ManagerScreen.test.tsx`)

```tsx
describe("ManagerScreen panels and copy", () => {
  it("a click on a filter option toggles it", async () => {
    const m = await mount({ jobs: three() });
    await m.press("f");
    const option = m.find("[ ] Paused");
    await m.click(option.x + 1, option.y);
    expect(m.frame()).toContain("[x] Paused");
    expect(m.frame()).toContain("1 of 3 items");
  });

  it("y and Y copy the link and the path from the details", async () => {
    const jobs = [row("a", { title: "Clip", outputPath: "/videos/Clip.mp4", lastTryAt: Date.now() })];
    const m = await mount({ jobs });
    await m.press(KEY.enter, "y");
    await vi.waitFor(() => expect(m.frame()).toContain("Copied the link."));
    expect(m.writeClipboard).toHaveBeenLastCalledWith(URL);
    await m.press("Y");
    await vi.waitFor(() => expect(m.frame()).toContain("Copied the path."));
    expect(m.writeClipboard).toHaveBeenLastCalledWith("/videos/Clip.mp4");
  });

  it("a click on the Path line copies it; no file yet says so", async () => {
    // Failed, so the core does not start it; it has no output path.
    const jobs = [row("a", { title: "Clip", status: "failed", lastTryAt: Date.now() })];
    const m = await mount({ jobs });
    await m.press(KEY.enter);
    const path = m.find("Path");
    await m.click(path.x + 10, path.y);
    await vi.waitFor(() => expect(m.frame()).toContain("No file yet."));
    expect(m.writeClipboard).not.toHaveBeenCalled();
  });

  it("says so when the clipboard cannot be written", async () => {
    const jobs = [row("a", { title: "Clip", lastTryAt: Date.now() })];
    const m = await mount({ jobs });
    m.writeClipboard.mockResolvedValue(false);
    await m.press(KEY.enter, "y");
    await vi.waitFor(() => expect(m.frame()).toContain("Could not copy to the clipboard."));
  });

  it("the key list explains the mouse and Shift+drag", async () => {
    const m = await mount({ jobs: three() });
    await m.press("?");
    expect(m.frame()).toContain("Ctrl+click");
    expect(m.frame()).toContain("Shift+drag selects text");
  });
});
```

`about.test.ts`:

```ts
  it("explains how to select text", () => {
    expect(SELECT_TIP).toBe("Shift+drag selects text in Windows Terminal and most Linux terminals.");
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive/screens/ManagerScreen.test.tsx src/interactive/about.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: `about.ts` and `AboutScreen.tsx`**

```ts
/** Mouse capture is always on; this is how text is selected anyway. */
export const SELECT_TIP = "Shift+drag selects text in Windows Terminal and most Linux terminals.";
```

In `AboutScreen.tsx`, inside the licences `Box`, after the `NOTICES.map(...)`:

```tsx
        <Text color={COLORS.muted}>{SELECT_TIP}</Text>
```

(import `SELECT_TIP` with `aboutRows`).

- [ ] **Step 4: `KeyList.tsx`**

Add two rows before `["Esc", …]`:

```ts
  ["y, Y", "Copy the link, the path (in Details)"],
  ["Mouse", "Click moves, [ ] ticks, Ctrl+click ticks a range, double-click opens"],
```

and, after the rows, `<Text color={COLORS.muted}>{SELECT_TIP}</Text>` (import from `../about.ts`).

- [ ] **Step 5: `FilterPanel.tsx`**

Import `Clickable`. Replace each group row with:

```tsx
        <Box key={g.name} overflow="hidden">
          <Clickable width={GROUP_WIDTH} flexShrink={0} onClick={() => setRow(gi)}>
            <Text color={gi === row ? COLORS.accent : COLORS.muted}>{g.name}</Text>
          </Clickable>
          {g.options.map((option, oi) => {
            const on = option.on(filters);
            const mark = g.radio ? (on ? "(•)" : "( )") : on ? "[x]" : "[ ]";
            const here = gi === row && oi === (cols[gi] ?? 0);
            return (
              <Clickable
                key={option.label}
                flexShrink={0}
                onClick={() => {
                  setRow(gi);
                  setCols((c) => c.map((v, i) => (i === gi ? oi : v)));
                  onChange(option.toggle(filters));
                }}
              >
                <Text {...(here && { inverse: true })}>{`${mark} ${option.label}`}</Text>
                {oi < g.options.length - 1 ? <Text>{"  "}</Text> : null}
              </Clickable>
            );
          })}
        </Box>
```

- [ ] **Step 6: `DetailPanel.tsx`**

Add `onCopy: (field: "url" | "path") => void;` to the props. In `useInput`, before the arrows:

```ts
    else if (input === "y") onCopy("url");
    else if (input === "Y") onCopy("path");
```

Keep each line's field: change the `lines` items to carry `field: label` and wrap the line `Box` in

```tsx
        <Clickable
          key={line.id}
          {...((line.field === "URL" || line.field === "Path") && {
            onClick: () => onCopy(line.field === "URL" ? "url" : "path"),
          })}
        >
```

Wrap the panel's root `Box` in `Clickable` with `onWheel={(step) => setTop((t) => Math.max(0, Math.min(maxTop, t + step)))}`. Hint: insert `"y copy link · Y copy path"` before `"Esc close"`.

- [ ] **Step 7: `ManagerScreen.tsx` copy**

```ts
  const copy = (field: "url" | "path") => {
    if (!detailJob) return;
    const text = field === "url" ? detailJob.request.candidate.url : detailJob.outputPath;
    if (!text) return say("No file yet.");
    void deps.writeClipboard(text).then((ok) =>
      say(
        ok
          ? field === "url"
            ? "Copied the link."
            : "Copied the path."
          : "Could not copy to the clipboard.",
      ),
    );
  };
```

Pass `onCopy={copy}` to `DetailPanel`.

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @mediaforge/desktop exec vitest run src/interactive`
Expected: PASS.

- [ ] **Step 9: Commit message (the user commits)**

```markdown
✨ desktop: copy from the details and click in the manager panels

## Description

The detail panel copies the link (y) and the path (Y), also by clicking
those lines, since mouse capture makes plain drag-select unavailable.
Filter options toggle on a click, and the key list and About explain
the mouse and Shift+drag.

## Test

pnpm --filter @mediaforge/desktop exec vitest run src/interactive
```

---

### Task 9: Checklist, spike clean-up, lint

**Files:**
- Modify: `docs/desktop-cli-checklist.md`
- Delete: `tools/dev/mouse-spike.mjs`, `tools/dev/mouse-spike-vt.mjs` (uncommitted)

- [ ] **Step 1: Add the checklist section** after "Downloads manager (phase 3b)":

```markdown
## Mouse (phase 3c)

Run each item in the classic console (cmd), Windows Terminal, the VS Code terminal and one Linux terminal.

- [ ] Home: click a menu item highlights it; double-click opens it; the wheel moves the highlight. Clicking `Esc Back` on a sub-screen goes back.
- [ ] Clicking `Ctrl+C Quit` shows `y/N  Quit MediaForge?`; `n` stays, `y` quits. On a download, `Ctrl+C Cancel` asks `Cancel the download?`. Pressing Ctrl+C on the keyboard still acts at once.
- [ ] Link screen: a click in the field moves the text cursor there.
- [ ] Folder picker: a click highlights a folder, a double-click opens it, the wheel moves.
- [ ] Manager: click a row (cursor), its `[ ]` (tick), Ctrl+click another row (range), double-click (details), a header (sort, again reverses), the wheel (3 rows), `p Pause` in the key bar, `y` / `N` in a prompt.
- [ ] Manager: with the filter, details or keys panel open, clicks on the list area do nothing; with a y/N prompt open, only `y` and `N` react.
- [ ] Details: `y` copies the link, `Y` the path; paste them into Notepad or a text editor. Clicking the URL line copies it too.
- [ ] Shift+drag selects text in Windows Terminal, VS Code and Linux.
- [ ] Quit, then in the same window: clicking prints nothing, and in cmd ↑ still recalls the last command (the console input mode was restored).
- [ ] Windows: right after start the keys work; within about a second clicks work too.
```

- [ ] **Step 2: Delete the spike scripts**

Run: `rm tools/dev/mouse-spike.mjs tools/dev/mouse-spike-vt.mjs` (they were never committed; `tools/dev/` keeps any other files).

- [ ] **Step 3: Lint and the full test run**

Run: `pnpm exec biome check --write apps/desktop/src docs/desktop-cli-checklist.md && pnpm lint && pnpm --filter @mediaforge/desktop test`
Expected: no findings; all tests PASS.

- [ ] **Step 4: Commit message (the user commits)**

```markdown
📝 desktop: add the mouse checks to the release checklist

## Description

The mouse depends on each terminal, so every release checks it by hand
in cmd, Windows Terminal, VS Code and Linux, including that quitting
restores the console input mode.

## Test

Manual: docs/desktop-cli-checklist.md, section Mouse (phase 3c)
```
