# Interactive UX Adjustments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a folder browser, per-type batch assignment, a supported-sites hint, a real Esc back stack, and an About page to the interactive app in `apps/desktop`.

**Architecture:** A small pure navigation stack (`nav.ts`) replaces the single `screen` state in `App` and the `stage` state in `BatchFlow`; every stack entry carries its own snapshot, so Esc restores exactly what the user had. Batch items carry their own assigned choice (replacing the batch-wide `base`), and a new folder browser is built from pure logic (`folder-browser.ts`) behind an injectable `FolderFs`. The remaining items are small screens and strings.

**Tech Stack:** TypeScript (ESM, `erasableSyntaxOnly`), React 19 + Ink 8, vitest + `ink-testing-library`, Biome.

**Spec:** `docs/superpowers/specs/2026-10-08-interactive-ux-adjustments-design.md`

## Global Constraints

- Work only inside `apps/desktop/src` plus `docs/desktop-cli-checklist.md`. Browser-extension code is out of scope.
- **Never run `git commit`, `git push` or `gh pr create`** (project `CLAUDE.md`). Each task ends with a verification checkpoint, not a commit. The user commits.
- A `PostToolUse` hook runs `biome check --write` on every Write/Edit. Fix every diagnostic it reports. Do not add `biome-ignore` comments. After any change made through Bash, run `pnpm exec biome check --write <paths>`.
- Icons: only characters already in `ICONS` (`apps/desktop/src/interactive/theme.ts`), which are limited to the WGL4 set. No emoji.
- No `enum`, no constructor parameter properties (`erasableSyntaxOnly`). Imports of local files use the `.ts` / `.tsx` extension.
- Tests run on Windows and Linux. Never assert on native `node:path` output; use `win32`/`posix` explicitly, or normalise with `replaceAll("\\", "/")` like the existing tests.
- Run tests from the repo root: `pnpm exec vitest run <path>`. Typecheck: `pnpm typecheck`. Final gate: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- Supported-sites URL, exact: `https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md`.
- Esc on Home asks `Quit MediaForge? (Y/N)`. Esc on the Result screens goes Home and resets the stack. Esc during a download cancels it, then pops to the page before it.
- Developer handle on About is `N-Berns`. The repo URL is `undefined` until the repository exists, and the row is hidden while it is.

## Review Focus

Failure modes the spec implies but no obvious test covers; each has a test in the named task.

1. **A batch where every link has nothing to download** (formats exist but none usable): Review must not offer "Start downloading 0 links", and nothing crashes (Task 4).
2. **Esc pressed at the bottom of a stack** must never empty the stack or leave a blank screen. `back()` at the root is a no-op, and `BatchFlow` hands control to `onLinks` (Tasks 1, 4).
3. **A folder that cannot be opened, or that was deleted while browsing**: the browser shows a message and stays where it was (Task 6). **Invalid new-folder names** (`..`, slashes, reserved Windows names, trailing dot) are rejected with a message (Task 5).
4. **Batch links with no details** (lookup failed) mixed with links that have details: they count as able to take any type and are not stranded in a "still need a type" loop (Tasks 3, 4).
5. **Cancelling a batch after some links finished**: the result must still show what was saved, not silently pop away (Task 4).

---

## File Structure

| File                                                                          | Responsibility                                                   |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `interactive/nav.ts` (new)                                                    | Pure stack operations + `useNav` hook                            |
| `interactive/nav.test.ts` (new)                                               | Stack tests                                                      |
| `interactive/App.tsx`                                                         | Top-level screens on the nav stack                               |
| `interactive/BatchFlow.tsx`                                                   | Batch stages on their own nav stack, items carried in each stage |
| `interactive/batch.ts`                                                        | Per-item `choice`, support/assignment logic                      |
| `interactive/batch.test.ts` (new)                                             | Assignment logic tests                                           |
| `interactive/screens/batch/BatchQualityScreen.tsx`                            | Sectioned type step                                              |
| `interactive/screens/batch/BatchReviewScreen.tsx`                             | Review without a batch-wide base                                 |
| `interactive/components/Menu.tsx`                                             | `heading` rows, `leftIsBack` option                              |
| `interactive/screens/HomeScreen.tsx`                                          | About row, quit confirmation                                     |
| `interactive/screens/ResultScreen.tsx`, `screens/batch/BatchResultScreen.tsx` | Esc goes Home                                                    |
| `interactive/folder-browser.ts` (new)                                         | Pure folder-browser logic, `FolderFs` type, `folderError`        |
| `interactive/folder-fs.ts` (new)                                              | Real and in-memory `FolderFs`                                    |
| `interactive/screens/FolderBrowserScreen.tsx` (new)                           | The browser UI                                                   |
| `interactive/screens/FolderPicker.tsx` (new)                                  | Browse / type chooser shared by Settings and Folder step         |
| `interactive/screens/FolderScreen.tsx`, `SettingsScreen.tsx`                  | Use the picker                                                   |
| `sites.ts` (new)                                                              | `SUPPORTED_SITES_URL`, `errorTip`                                |
| `interactive/about.ts` (new), `interactive/screens/AboutScreen.tsx` (new)     | About page                                                       |
| `interactive/deps.ts`, `interactive/start.tsx`, `interactive/App.test.tsx`    | New deps: `folders`, `configPath`, `target`                      |

---

### Task 1: Navigation stack

**Files:**

- Create: `apps/desktop/src/interactive/nav.ts`
- Test: `apps/desktop/src/interactive/nav.test.ts`

**Interfaces:**

- Produces:
  - `type NavStack<T> = { readonly entries: readonly T[] }`
  - `createStack<T>(root: T): NavStack<T>`, `topOf<T>(s): T`, `canPop(s): boolean`, `pushEntry(s, entry): NavStack<T>`, `popEntry(s): NavStack<T>` (no-op at the root), `unwind(s, count, entry): NavStack<T>` (remove the top `count` entries, then push `entry`), `resetStack<T>(first: T, ...rest: T[]): NavStack<T>`
  - `interface Nav<T> { current: T; depth: number; canGoBack: boolean; push(entry: T): void; replace(entry: T): void; back(): void; unwind(count: number, entry: T): void; reset(first: T, ...rest: T[]): void }`
  - `useNav<T>(root: T): Nav<T>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/interactive/nav.test.ts
import { describe, expect, it } from "vitest";
import {
  canPop,
  createStack,
  popEntry,
  pushEntry,
  resetStack,
  topOf,
  unwind,
} from "./nav.ts";

describe("nav stack", () => {
  it("starts with the root and pushes new entries on top", () => {
    const s = pushEntry(pushEntry(createStack("home"), "link"), "quality");
    expect(topOf(s)).toBe("quality");
    expect(s.entries).toEqual(["home", "link", "quality"]);
    expect(canPop(s)).toBe(true);
  });

  it("pops one entry at a time, like a browser back button", () => {
    let s = pushEntry(pushEntry(createStack("home"), "link"), "quality");
    s = popEntry(s);
    expect(topOf(s)).toBe("link");
    s = popEntry(s);
    expect(topOf(s)).toBe("home");
  });

  it("never pops the root", () => {
    const s = popEntry(popEntry(createStack("home")));
    expect(s.entries).toEqual(["home"]);
    expect(canPop(s)).toBe(false);
  });

  it("replaces the top entry without growing the history", () => {
    const s = unwind(pushEntry(createStack("home"), "lookup"), 1, "quality");
    expect(s.entries).toEqual(["home", "quality"]);
  });

  it("unwinds several entries and pushes one", () => {
    const s = unwind(
      ["a", "b", "c", "d"].reduce(
        (acc, e) => pushEntry(acc, e),
        createStack("root"),
      ),
      3,
      "x",
    );
    expect(s.entries).toEqual(["root", "a", "x"]);
  });

  it("unwinding more than the stack holds leaves just the new entry", () => {
    expect(unwind(createStack("home"), 5, "x").entries).toEqual(["x"]);
  });

  it("resets to the given entries, last one on top", () => {
    const s = resetStack("home", "link");
    expect(s.entries).toEqual(["home", "link"]);
    expect(topOf(s)).toBe("link");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/interactive/nav.test.ts`
Expected: FAIL, cannot resolve `./nav.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/interactive/nav.ts
import { useCallback, useState } from "react";

/** Screens visited so far, newest last. Always holds at least one entry. */
export interface NavStack<T> {
  readonly entries: readonly T[];
}

export const createStack = <T>(root: T): NavStack<T> => ({ entries: [root] });

export const topOf = <T>(stack: NavStack<T>): T =>
  stack.entries[stack.entries.length - 1] as T;

export const canPop = <T>(stack: NavStack<T>): boolean =>
  stack.entries.length > 1;

export const pushEntry = <T>(stack: NavStack<T>, entry: T): NavStack<T> => ({
  entries: [...stack.entries, entry],
});

/** One step back. At the root there is nowhere to go, so the stack is returned as is. */
export const popEntry = <T>(stack: NavStack<T>): NavStack<T> =>
  canPop(stack) ? { entries: stack.entries.slice(0, -1) } : stack;

/** Remove the top `count` entries, then push `entry`. `count` 1 replaces the current screen. */
export const unwind = <T>(
  stack: NavStack<T>,
  count: number,
  entry: T,
): NavStack<T> => ({
  entries: [
    ...stack.entries.slice(0, Math.max(0, stack.entries.length - count)),
    entry,
  ],
});

/** Forget the history and start over from these entries; the last one is shown. */
export const resetStack = <T>(first: T, ...rest: T[]): NavStack<T> => ({
  entries: [first, ...rest],
});

export interface Nav<T> {
  current: T;
  depth: number;
  canGoBack: boolean;
  push: (entry: T) => void;
  /** Swap the current screen for another, e.g. a waiting screen that should not stay in history. */
  replace: (entry: T) => void;
  back: () => void;
  unwind: (count: number, entry: T) => void;
  reset: (first: T, ...rest: T[]) => void;
}

/** A back stack for screens. Entries hold their own state, so going back restores it. */
export function useNav<T>(root: T): Nav<T> {
  const [stack, setStack] = useState<NavStack<T>>(() => createStack(root));
  const push = useCallback(
    (entry: T) => setStack((s) => pushEntry(s, entry)),
    [],
  );
  const replace = useCallback(
    (entry: T) => setStack((s) => unwind(s, 1, entry)),
    [],
  );
  const back = useCallback(() => setStack((s) => popEntry(s)), []);
  const unwindBy = useCallback(
    (count: number, entry: T) => setStack((s) => unwind(s, count, entry)),
    [],
  );
  const reset = useCallback(
    (first: T, ...rest: T[]) => setStack(resetStack(first, ...rest)),
    [],
  );
  return {
    current: topOf(stack),
    depth: stack.entries.length,
    canGoBack: canPop(stack),
    push,
    replace,
    back,
    unwind: unwindBy,
    reset,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/desktop/src/interactive/nav.test.ts`
Expected: PASS (7 tests). Also run `pnpm typecheck` and expect no errors.

---

### Task 2: App on the back stack, Home quit confirmation, Esc on result screens

**Files:**

- Modify: `apps/desktop/src/interactive/App.tsx` (full replacement below)
- Modify: `apps/desktop/src/interactive/screens/HomeScreen.tsx`
- Modify: `apps/desktop/src/interactive/screens/ResultScreen.tsx` (two `Menu` elements)
- Modify: `apps/desktop/src/interactive/screens/batch/BatchResultScreen.tsx` (one `Menu`)
- Create: `apps/desktop/src/interactive/screens/HomeScreen.test.tsx`
- Test: `apps/desktop/src/interactive/App.test.tsx`

**Interfaces:**

- Consumes: `useNav`, `Nav` from Task 1.
- Produces: `HomeScreen` unchanged props (`onPick`), now also handles Esc itself. `ResultScreen` and `BatchResultScreen` call `onAction("home")` on Esc. `App` pops a cancelled single download instead of showing a "cancelled" result.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` to `apps/desktop/src/interactive/App.test.tsx` (after `describe("link step", …)`):

```tsx
describe("back stack", () => {
  /** Home, clipboard link, lookup, then wait for the type screen. */
  async function toQuality(options: Options = {}) {
    const t = setup(options);
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "What do you want to save?");
    return t;
  }

  it("walks back one page per Esc, including the format list", async () => {
    const { app } = await toQuality();
    await press(app, KEY.enter);
    await waitFor(app, "Choose a video quality");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");

    await press(app, KEY.esc);
    await waitFor(app, "Choose a video quality");
    await press(app, KEY.esc);
    await waitFor(app, "What do you want to save?");
    await press(app, KEY.esc);
    await waitFor(app, "What do you want to download?");
    await press(app, KEY.esc);
    await waitFor(app, "What would you like to do?");
    app.unmount();
  });

  it("asks before quitting when Esc is pressed on Home, and stays on N", async () => {
    const { app } = setup();
    await waitFor(app, "What would you like to do?");
    await press(app, KEY.esc);
    await waitFor(app, "Quit MediaForge?");
    await press(app, "n");
    await waitFor(app, "What would you like to do?");
    app.unmount();
  });

  it("goes Home from the result screen with Esc", async () => {
    const { app } = await toQuality();
    await press(app, KEY.enter);
    await waitFor(app, "Choose a video quality");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    await press(app, KEY.enter);
    await waitFor(app, "Download complete");
    await press(app, KEY.esc);
    await waitFor(app, "What would you like to do?");
    app.unmount();
  });

  it("cancelling a download returns to the page before it", async () => {
    const hang: ProcessRunner = (_c, _a, _h, signal) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve({ exitCode: 1 }), {
          once: true,
        }),
      );
    const { app } = await toQuality({ runner: hang });
    await press(app, KEY.enter);
    await waitFor(app, "Choose a video quality");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    await press(app, KEY.enter);
    await waitFor(app, "Cancel download");
    await press(app, KEY.esc);
    await waitFor(app, "Where should it be saved?");
    app.unmount();
  });
});
```

Create `apps/desktop/src/interactive/screens/HomeScreen.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/interactive/App.test.tsx apps/desktop/src/interactive/screens/HomeScreen.test.tsx`
Expected: FAIL: the four new `back stack` tests (no quit prompt, folder Esc goes to quality, result Esc does nothing, cancel shows a result screen) and both Home tests. Existing tests still pass.

- [ ] **Step 3: Implement**

Replace `HomeScreen.tsx` with:

```tsx
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { COLORS, ICONS } from "../theme.ts";

export type HomeChoice = "download" | "settings" | "setup" | "quit";

export function HomeScreen({
  onPick,
}: {
  onPick: (choice: HomeChoice) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  // Esc on Home has nowhere to go back to, so it offers to quit.
  useInput((_input, key) => key.escape && setConfirming(true), {
    isActive: !confirming,
  });
  useInput(
    (input, key) => {
      if (input.toLowerCase() === "y") onPick("quit");
      else if (input.toLowerCase() === "n" || key.escape || key.return)
        setConfirming(false);
    },
    { isActive: confirming },
  );

  if (confirming) {
    return (
      <Frame
        crumbs={["Home"]}
        icon={ICONS.quit}
        tone="warn"
        title="Quit MediaForge? (Y/N)"
        hints={[
          ["Y", "Quit"],
          ["N / Esc", "Stay"],
        ]}
      >
        <Text color={COLORS.muted}>Press Y to quit, or N to go back.</Text>
      </Frame>
    );
  }

  return (
    <Frame
      crumbs={["Home"]}
      icon={ICONS.app}
      title="What would you like to do?"
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["1-4", "Jump"],
        ["Ctrl+C", "Quit"],
      ]}
    >
      <Box marginBottom={1}>
        <Text color={COLORS.muted}>Download video and audio from a link.</Text>
      </Box>
      <Menu<HomeChoice>
        onSelect={onPick}
        items={[
          {
            value: "download",
            icon: ICONS.download,
            label: "Download media",
            hint: "video or audio from a link",
          },
          {
            value: "settings",
            icon: ICONS.settings,
            label: "Settings",
            hint: "default folder and quality",
          },
          {
            value: "setup",
            icon: ICONS.setup,
            label: "Check setup",
            hint: "yt-dlp and ffmpeg",
          },
          { value: "quit", icon: ICONS.quit, label: "Quit" },
        ]}
      />
    </Frame>
  );
}
```

In `ResultScreen.tsx`, add `onBack={() => onAction("home")}` to both `<Menu<ResultAction>` elements (the completed one and the failed/cancelled one). In `BatchResultScreen.tsx`, change the last line to:

```tsx
<Menu<BatchResultAction>
  onSelect={onAction}
  onBack={() => onAction("home")}
  items={items}
/>
```

Replace `App.tsx` with:

```tsx
import { useApp, useInput } from "ink";
import { useRef, useState } from "react";
import type { EngineJob } from "../engine/index.ts";
import type { Settings } from "../settings.ts";
import { BatchFlow } from "./BatchFlow.tsx";
import { type AppDeps, DepsContext } from "./deps.ts";
import {
  type Draft,
  draftSubfolder,
  effectiveFolder,
  nextStep,
  type Plan,
  toPlan,
} from "./flow.ts";
import type { MediaKind } from "./format-choices.ts";
import { useNav } from "./nav.ts";
import { DownloadScreen } from "./screens/DownloadScreen.tsx";
import { FolderScreen } from "./screens/FolderScreen.tsx";
import { FormatsScreen } from "./screens/FormatsScreen.tsx";
import { HomeScreen } from "./screens/HomeScreen.tsx";
import { LinkScreen } from "./screens/LinkScreen.tsx";
import { LookupScreen } from "./screens/LookupScreen.tsx";
import { QualityScreen } from "./screens/QualityScreen.tsx";
import { type ResultAction, ResultScreen } from "./screens/ResultScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { SetupScreen } from "./screens/SetupScreen.tsx";

type Screen =
  | { name: "home" }
  | { name: "link" }
  | { name: "lookup"; url: string }
  | { name: "quality"; draft: Draft; settings: Settings }
  | { name: "formats"; kind: MediaKind; draft: Draft; settings: Settings }
  | { name: "folder"; draft: Draft; settings: Settings }
  /** `run` changes on every retry so the screen starts a fresh download. */
  | { name: "download"; plan: Plan; draft: Draft; run: number }
  | { name: "result"; plan: Plan; draft: Draft; job: EngineJob }
  | { name: "batch"; urls: string[] }
  | { name: "settings" }
  | { name: "setup" };

export function App({ deps }: { deps: AppDeps }) {
  const { exit } = useApp();
  const nav = useNav<Screen>({ name: "home" });
  const screen = nav.current;
  /** Counts downloads started, so each (including retries) gets a fresh screen instance. */
  const runCounter = useRef(0);
  const [batchBusy, setBatchBusy] = useState(false);

  // Ctrl+C quits everywhere except while downloading, where it cancels the download instead.
  useInput((input, key) => {
    const downloading =
      screen.name === "download" || (screen.name === "batch" && batchBusy);
    if (key.ctrl && input === "c" && !downloading) exit();
  });

  /**
   * Work out what is still needed for this draft, using the latest saved settings, and go there.
   * `replace` is for waiting screens (the lookup) that should not stay in the history.
   */
  const advance = async (draft: Draft, how: "push" | "replace" = "push") => {
    const settings = await deps.download.settings.load();
    const folderDefault = effectiveFolder(
      deps.download.env,
      settings,
      deps.defaultOutputDir,
    );
    const next = nextStep(draft, settings, folderDefault);
    const go = how === "push" ? nav.push : nav.replace;
    if (next.step === "download") {
      go({
        name: "download",
        plan: toPlan(next.draft, settings.sortByType),
        draft: next.draft,
        run: ++runCounter.current,
      });
    } else if (next.step === "quality")
      go({ name: "quality", draft: next.draft, settings });
    else go({ name: "folder", draft: next.draft, settings });
  };

  const askQuality = async (draft: Draft) => {
    const settings = await deps.download.settings.load();
    nav.reset(
      { name: "home" },
      { name: "link" },
      {
        name: "quality",
        draft: {
          ...draft,
          profileId: undefined,
          formatSelector: undefined,
          kind: undefined,
        },
        settings,
      },
    );
  };

  const onResult = async (
    action: ResultAction,
    state: Extract<Screen, { name: "result" }>,
  ) => {
    if (action === "open" && state.job.outputPath)
      await deps.openFolder(state.job.outputPath);
    else if (action === "retry") {
      nav.replace({
        name: "download",
        plan: state.plan,
        draft: state.draft,
        run: ++runCounter.current,
      });
    } else if (action === "quality") await askQuality(state.draft);
    else if (action === "again") nav.reset({ name: "home" }, { name: "link" });
    else if (action === "home") nav.reset({ name: "home" });
    else if (action === "quit") exit();
  };

  const body = (() => {
    switch (screen.name) {
      case "home":
        return (
          <HomeScreen
            onPick={(choice) => {
              if (choice === "quit") exit();
              else if (choice === "download") nav.push({ name: "link" });
              else if (choice === "settings") nav.push({ name: "settings" });
              else nav.push({ name: "setup" });
            }}
          />
        );
      case "link":
        return (
          <LinkScreen
            onBack={nav.back}
            onSubmit={(urls) =>
              urls.length === 1
                ? nav.push({ name: "lookup", url: urls[0] as string })
                : nav.push({ name: "batch", urls })
            }
          />
        );
      case "lookup":
        return (
          <LookupScreen
            key={screen.url}
            url={screen.url}
            onInfo={(info) =>
              void advance({ url: screen.url, info }, "replace")
            }
            onSkip={() => void advance({ url: screen.url }, "replace")}
            onChangeLink={nav.back}
          />
        );
      case "quality":
        return (
          <QualityScreen
            draft={screen.draft}
            settings={screen.settings}
            onBack={nav.back}
            onPick={(choice) =>
              "kind" in choice
                ? nav.push({
                    name: "formats",
                    kind: choice.kind,
                    draft: screen.draft,
                    settings: screen.settings,
                  })
                : void advance({
                    ...screen.draft,
                    profileId: choice.profileId,
                    formatSelector: undefined,
                    kind: undefined,
                  })
            }
          />
        );
      case "formats":
        return (
          <FormatsScreen
            info={screen.draft.info ?? {}}
            kind={screen.kind}
            onBack={nav.back}
            onPick={(pick) =>
              void advance({
                ...screen.draft,
                profileId: pick.profileId,
                formatSelector: pick.selector,
                kind: screen.kind,
              })
            }
          />
        );
      case "folder":
        return (
          <FolderScreen
            defaultDir={effectiveFolder(
              deps.download.env,
              screen.settings,
              deps.defaultOutputDir,
            )}
            subfolder={draftSubfolder(screen.draft, screen.settings.sortByType)}
            onBack={nav.back}
            onPick={(dir) => void advance({ ...screen.draft, outputDir: dir })}
          />
        );
      case "download":
        return (
          <DownloadScreen
            key={screen.run}
            plan={screen.plan}
            onDone={(job) =>
              // A cancelled download leaves nothing to show: go back to the page before it.
              job.status === "cancelled"
                ? nav.back()
                : nav.replace({
                    name: "result",
                    plan: screen.plan,
                    draft: screen.draft,
                    job,
                  })
            }
          />
        );
      case "result":
        return (
          <ResultScreen
            job={screen.job}
            onAction={(action) => void onResult(action, screen)}
          />
        );
      case "batch":
        return (
          <BatchFlow
            key={screen.urls.join(" ")}
            urls={screen.urls}
            onLinks={nav.back}
            onHome={() => nav.reset({ name: "home" })}
            onQuit={exit}
            onDownloading={setBatchBusy}
          />
        );
      case "settings":
        return <SettingsScreen onBack={nav.back} />;
      case "setup":
        return <SetupScreen onBack={nav.back} />;
    }
  })();

  return <DepsContext.Provider value={deps}>{body}</DepsContext.Provider>;
}
```

Add the missing import at the top of `App.test.tsx` if absent: it already imports `ProcessRunner`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop/src/interactive`
Expected: all pass. If "cancelling a download returns to the page before it" fails because the engine marks the job `failed` rather than `cancelled` when the runner resolves with exit code 1 after abort, check `engine/engine.ts` for how cancel is recorded and make the test's runner resolve the way the real `runProcess` does on abort (look at `engine/process.ts` lines 26-44); do not change the engine.

- [ ] **Step 5: Checkpoint**

Run: `pnpm typecheck && pnpm exec biome check apps/desktop/src/interactive`
Expected: clean. (Do not commit.)

---

### Task 3: Batch assignment logic

**Files:**

- Modify: `apps/desktop/src/interactive/batch.ts`
- Create: `apps/desktop/src/interactive/batch.test.ts`

**Interfaces:**

- Consumes: existing `availableKinds`, `presetChoice`, `PRESETS`, `ItemChoice`.
- Produces (all exported from `batch.ts`):
  - `BatchItem` gains `choice?: ItemChoice`
  - `type Support = "yes" | "no" | "unknown"`
  - `supports(item, kind): Support`, `isUnusable(item): boolean`
  - `choiceFor(item): ItemChoice | undefined` (**signature change**: no `base` argument; returns `item.override ?? item.choice`)
  - `isAssigned(item): boolean`, `waitingItems(items): BatchItem[]`, `takers(items, kind): BatchItem[]`
  - `assignKind(items, kind, id: PresetId): BatchItem[]`, `assignAll(items, choice): BatchItem[]`, `clearChoices(items): BatchItem[]`
  - `withOverride(items, index, choice): BatchItem[]`, `downloadable(items): BatchItem[]`

Note: `choiceFor`'s new signature breaks `BatchFlow.tsx` and `BatchReviewScreen.tsx` until Task 4 replaces them. Run only the `batch.test.ts` file in this task; the full typecheck is expected to fail until Task 4 is done, so do not run `pnpm typecheck` between Tasks 3 and 4.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/interactive/batch.test.ts
import { describe, expect, it } from "vitest";
import type { MediaInfo } from "../formats.ts";
import {
  assignAll,
  assignKind,
  type BatchItem,
  choiceFor,
  clearChoices,
  downloadable,
  isUnusable,
  presetChoice,
  profileChoice,
  supports,
  takers,
  waitingItems,
  withOverride,
} from "./batch.ts";

const VIDEO: MediaInfo = {
  title: "Clip",
  formats: [
    { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a" },
    {
      format_id: "137",
      ext: "mp4",
      height: 1080,
      vcodec: "avc1",
      acodec: "none",
    },
  ],
};
const AUDIO_ONLY: MediaInfo = {
  title: "Track",
  formats: [{ format_id: "0", ext: "mp3", vcodec: "none", acodec: "mp3" }],
};
const STORYBOARD_ONLY: MediaInfo = {
  title: "Odd",
  formats: [{ format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none" }],
};

const video: BatchItem = { url: "https://a.com/v", info: VIDEO };
const track: BatchItem = { url: "https://soundcloud.com/t", info: AUDIO_ONLY };
const odd: BatchItem = { url: "https://b.com/odd", info: STORYBOARD_ONLY };
const blind: BatchItem = { url: "https://c.com/x", lookupError: "403" };

describe("what a link can give", () => {
  it("knows which kinds a link has", () => {
    expect(supports(video, "video-audio")).toBe("yes");
    expect(supports(video, "video")).toBe("yes");
    expect(supports(video, "audio")).toBe("yes");
    expect(supports(track, "video-audio")).toBe("no");
    expect(supports(track, "audio")).toBe("yes");
  });

  it("cannot tell for a link without details, so it may take any type", () => {
    expect(supports(blind, "video-audio")).toBe("unknown");
    expect(supports({ url: "https://d.com", info: {} }, "audio")).toBe(
      "unknown",
    );
  });

  it("treats a link with only unusable formats as having nothing to download", () => {
    expect(isUnusable(odd)).toBe(true);
    expect(supports(odd, "audio")).toBe("no");
    expect(isUnusable(video)).toBe(false);
    expect(isUnusable(blind)).toBe(false);
    expect(isUnusable({ url: "https://d.com", info: {} })).toBe(false);
  });
});

describe("assigning a type", () => {
  const items = [video, track, blind, odd];

  it("waits for every link that has nothing assigned and can be downloaded", () => {
    expect(waitingItems(items).map((i) => i.url)).toEqual([
      video.url,
      track.url,
      blind.url,
    ]);
  });

  it("lists only the links that can take a kind (unknown ones can)", () => {
    expect(takers(items, "video-audio").map((i) => i.url)).toEqual([
      video.url,
      blind.url,
    ]);
    expect(takers(items, "audio").map((i) => i.url)).toEqual([
      video.url,
      track.url,
      blind.url,
    ]);
  });

  it("gives a preset only to links that can take it", () => {
    const next = assignKind(items, "video-audio", "best");
    expect(choiceFor(next[0] as BatchItem)).toEqual(
      presetChoice("video-audio", "best"),
    );
    expect(choiceFor(next[1] as BatchItem)).toBeUndefined();
    expect(choiceFor(next[2] as BatchItem)).toEqual(
      presetChoice("video-audio", "best"),
    );
    expect(choiceFor(next[3] as BatchItem)).toBeUndefined();
    expect(waitingItems(next).map((i) => i.url)).toEqual([track.url]);
  });

  it("finishes in two rounds for a mixed batch", () => {
    const round1 = assignKind(items, "video-audio", "best");
    const round2 = assignKind(round1, "audio", "mp3");
    expect(waitingItems(round2)).toEqual([]);
    // The first round's choice is not overwritten by the second.
    expect(choiceFor(round2[0] as BatchItem)?.kind).toBe("video-audio");
    expect(choiceFor(round2[1] as BatchItem)?.kind).toBe("audio");
  });

  it("does not touch items that already have an override", () => {
    const changed = withOverride(items, 0, presetChoice("audio", "mp3"));
    const next = assignKind(changed, "video-audio", "best");
    expect(choiceFor(next[0] as BatchItem)?.kind).toBe("audio");
  });

  it("assigns one saved choice to every link that can be downloaded", () => {
    const saved = profileChoice("mp4-720p");
    const next = assignAll(items, saved);
    expect(next.map((i) => choiceFor(i)?.profileId)).toEqual([
      "mp4-720p",
      "mp4-720p",
      "mp4-720p",
      undefined,
    ]);
  });

  it("clears assigned choices but keeps per-link overrides", () => {
    const assigned = withOverride(
      assignKind(items, "audio", "mp3"),
      1,
      presetChoice("audio", "m4a"),
    );
    const cleared = clearChoices(assigned);
    expect(cleared[0]?.choice).toBeUndefined();
    expect(choiceFor(cleared[1] as BatchItem)).toEqual(
      presetChoice("audio", "m4a"),
    );
  });

  it("downloads only links that are usable and have a choice", () => {
    const next = assignKind(items, "audio", "mp3");
    expect(downloadable(next).map((i) => i.url)).toEqual([
      video.url,
      track.url,
      blind.url,
    ]);
    expect(downloadable(items)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/interactive/batch.test.ts`
Expected: FAIL, missing exports (`assignAll`, `supports`, …).

- [ ] **Step 3: Implement**

In `batch.ts`, add `choice?: ItemChoice;` to `BatchItem` under `override`:

```ts
  /** The quality assigned to this link by the type step (or the saved default). */
  choice?: ItemChoice;
  /** A quality chosen for this link alone, replacing the assigned one. */
  override?: ItemChoice;
```

(delete the old `override` comment/field so there is only one.)

Replace the single line `export const choiceFor = …` with the block below, and add the rest after `choiceWarning`:

```ts
/** What this link will download: its own pick, else the one assigned to it. */
export const choiceFor = (item: BatchItem): ItemChoice | undefined =>
  item.override ?? item.choice;

export type Support = "yes" | "no" | "unknown";

const hasKinds = (info: MediaInfo): boolean =>
  Object.values(availableKinds(info)).some(Boolean);

/**
 * A link whose lookup listed formats, none of them usable (e.g. only storyboards). A lookup
 * that listed no formats at all is not unusable: the ready-made profiles may still work.
 */
export const isUnusable = (item: BatchItem): boolean =>
  item.info !== undefined &&
  (item.info.formats?.length ?? 0) > 0 &&
  !hasKinds(item.info);

/** Whether a link can give a kind. "unknown" when there are no details to say either way. */
export function supports(item: BatchItem, kind: MediaKind): Support {
  if (!item.info) return "unknown";
  if (isUnusable(item)) return "no";
  if (!hasKinds(item.info)) return "unknown";
  return availableKinds(item.info)[kind] ? "yes" : "no";
}

export const isAssigned = (item: BatchItem): boolean =>
  choiceFor(item) !== undefined;

/** Links that still need a type: nothing assigned yet, and something to download. */
export const waitingItems = (items: readonly BatchItem[]): BatchItem[] =>
  items.filter((item) => !isAssigned(item) && !isUnusable(item));

/** Waiting links that can take this kind. */
export const takers = (
  items: readonly BatchItem[],
  kind: MediaKind,
): BatchItem[] =>
  waitingItems(items).filter((item) => supports(item, kind) !== "no");

/** Give a preset to every waiting link that can take its kind; the others stay waiting. */
export function assignKind(
  items: readonly BatchItem[],
  kind: MediaKind,
  id: PresetId,
): BatchItem[] {
  const choice = presetChoice(kind, id);
  return items.map((item) =>
    !isAssigned(item) && !isUnusable(item) && supports(item, kind) !== "no"
      ? { ...item, choice }
      : item,
  );
}

/** One choice for every link that has none and can be downloaded (the saved default). */
export const assignAll = (
  items: readonly BatchItem[],
  choice: ItemChoice,
): BatchItem[] =>
  items.map((item) =>
    isAssigned(item) || isUnusable(item) ? item : { ...item, choice },
  );

/** Forget the assigned choices (per-link overrides stay: the user picked those on purpose). */
export const clearChoices = (items: readonly BatchItem[]): BatchItem[] =>
  items.map(({ choice: _choice, ...rest }) => rest);

export const withOverride = (
  items: readonly BatchItem[],
  index: number,
  choice: ItemChoice,
): BatchItem[] =>
  items.map((item, i) => (i === index ? { ...item, override: choice } : item));

/** The links that will actually be downloaded. */
export const downloadable = (items: readonly BatchItem[]): BatchItem[] =>
  items.filter((item) => !isUnusable(item) && isAssigned(item));
```

If Biome flags `_choice` as unused, restructure `clearChoices` as `items.map((item) => { const copy = { ...item }; delete copy.choice; return copy; })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/desktop/src/interactive/batch.test.ts`
Expected: PASS (all). (`pnpm typecheck` is expected to fail until Task 4.)

---

### Task 4: Sectioned type step, Review without a base, BatchFlow on the stack

**Files:**

- Modify: `apps/desktop/src/interactive/components/Menu.tsx` (add `heading`)
- Modify (full replacement): `apps/desktop/src/interactive/screens/batch/BatchQualityScreen.tsx`
- Modify (full replacement): `apps/desktop/src/interactive/screens/batch/BatchReviewScreen.tsx`
- Modify (full replacement): `apps/desktop/src/interactive/BatchFlow.tsx`
- Test: `apps/desktop/src/interactive/App.test.tsx` (update `bulk download` helpers, add tests)

**Interfaces:**

- Consumes: Task 1 `useNav`; Task 3 batch functions.
- Produces: `BatchQualityScreen({ items, onPick(kind: MediaKind, id: PresetId), onBack })`; `BatchReviewScreen({ items, initial?, onSelect })` (no `base` prop); `Menu` item field `heading?: boolean` (bold, never selectable).

- [ ] **Step 1: Write the failing tests**

In `App.test.tsx`, inside `describe("bulk download")`, replace `toReview` with:

```tsx
async function toReview(options: Options = {}) {
  const t = await start(
    options,
    "What do you want to save from these 2 links?",
  );
  await press(t.app, KEY.enter);
  await waitFor(t.app, "Ready to download 2 links");
  return t;
}
```

Add these tests at the end of that `describe`:

```tsx
const TRACK: MediaInfo = {
  title: "Sound Track",
  formats: [{ format_id: "0", ext: "mp3", vcodec: "none", acodec: "mp3" }],
};
const STORYBOARD: MediaInfo = {
  title: "Odd Page",
  formats: [{ format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none" }],
};
const mixed = async (url: string): Promise<MediaInfo> =>
  url.includes("twitch") ? TRACK : titled(url);

it("applies a type only to the links that can use it, then asks for the rest", async () => {
  const t = await start(
    { info: mixed },
    "What do you want to save from these 2 links?",
  );
  const first = t.app.lastFrame() ?? "";
  expect(first).toContain("Video with audio · 1 of 2 links");
  expect(first).toContain("Audio only · 2 of 2 links");

  await press(t.app, KEY.enter);
  await waitFor(t.app, "1 link still needs a type");
  expect(t.app.lastFrame()).toContain("Video with audio · 0 of 1 link");

  await press(t.app, KEY.enter);
  await waitFor(t.app, "Ready to download 2 links");
  const review = t.app.lastFrame() ?? "";
  expect(review).toContain("Video with audio: Best available");
  expect(review).toContain("Audio only: Best audio (m4a)");
  t.app.unmount();
});

it("does not offer to start when no link has anything to download", async () => {
  // Nothing can be assigned, so the type step is skipped straight to Review.
  const t = await start(
    { info: async () => STORYBOARD },
    "Nothing to download",
  );
  const frame = t.app.lastFrame() ?? "";
  expect(frame).toContain("no downloadable formats");
  expect(frame).not.toContain("Start downloading");
  // Esc still leaves: the batch has nowhere earlier to go, so it returns to the link screen.
  await press(t.app, KEY.esc);
  await waitFor(t.app, "What do you want to download?");
  t.app.unmount();
});

it("walks back through the batch instead of toggling between two screens", async () => {
  const t = await toReview();
  await press(t.app, KEY.esc);
  await waitFor(t.app, "What do you want to save from these 2 links?");
  // The undone pick is gone: nothing is assigned yet.
  expect(t.app.lastFrame()).toContain("Video with audio · 2 of 2 links");
  await press(t.app, KEY.esc);
  await waitFor(t.app, "What do you want to download?");
  await press(t.app, KEY.esc);
  await waitFor(t.app, "What would you like to do?");
  t.app.unmount();
});

it("keeps links without details assignable to any type", async () => {
  const t = await start(
    {
      info: async (url) => {
        if (url.includes("twitch")) throw new CliError("403", ExitCode.Network);
        return titled(url);
      },
    },
    "Could not read details for 1 of 2 links",
  );
  await press(t.app, KEY.enter);
  await waitFor(t.app, "What do you want to save from these 2 links?");
  expect(t.app.lastFrame()).toContain("Video only · 2 of 2 links");
  await press(t.app, KEY.enter);
  await waitFor(t.app, "Ready to download 2 links");
  t.app.unmount();
});

it("shows what was saved when a batch is cancelled after some links finished", async () => {
  let calls = 0;
  const t = await toReview({
    runner: (c, a, h, s) => {
      calls++;
      if (calls === 1) return succeed(c, a, h, s);
      return new Promise((resolve) =>
        s.addEventListener("abort", () => resolve({ exitCode: 1 }), {
          once: true,
        }),
      );
    },
  });
  await startDownloads(t.app);
  await waitFor(t.app, "Overall");
  await tick(150);
  await press(t.app, KEY.esc);
  await waitFor(t.app, "saved");
  expect(t.app.lastFrame()).toContain("1 of 2 saved");
  t.app.unmount();
});
```

Also add to the same file's `describe("bulk download")` the existing test `"gives one link its own quality"` unchanged: it must keep passing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/interactive/App.test.tsx -t "bulk download"`
Expected: FAIL (old two-level type screen, `base` state, `toReview` times out).

- [ ] **Step 3: Implement**

`Menu.tsx`: add to `MenuItem`:

```ts
  /** A non-selectable title row that groups the rows after it. */
  heading?: boolean;
```

and replace the row-rendering `color`/`Text` lines:

```tsx
        const selected = position === index;
        const color = item.heading
          ? COLORS.accent
          : item.disabled
            ? COLORS.muted
            : selected
              ? COLORS.accent
              : undefined;
        return (
          <Box key={position}>
            <Text color={COLORS.accent}>{selected ? `${ICONS.pointer} ` : "  "}</Text>
            <Text color={color} bold={selected || item.heading} dimColor={item.disabled && !item.heading}>
```

(keep the rest of the row as is). Headings must also be `disabled: true` when created, so `stepIndex` skips them.

Replace `BatchQualityScreen.tsx` with:

```tsx
import { Box, Text } from "ink";
import {
  type BatchItem,
  isAssigned,
  KIND_LABELS,
  PRESETS,
  type PresetId,
  takers,
  waitingItems,
} from "../../batch.ts";
import { Frame } from "../../components/Frame.tsx";
import { Menu, type MenuItem } from "../../components/Menu.tsx";
import type { MediaKind } from "../../format-choices.ts";
import { COLORS, ICONS } from "../../theme.ts";

export const KIND_ICONS: Record<MediaKind, string> = {
  "video-audio": ICONS.kindVideoAudio,
  video: ICONS.kindVideo,
  audio: ICONS.kindAudio,
};

const KINDS: MediaKind[] = ["video-audio", "video", "audio"];

export interface BatchQualityScreenProps {
  items: BatchItem[];
  onPick: (kind: MediaKind, preset: PresetId) => void;
  onBack: () => void;
}

const linkCount = (n: number) => (n === 1 ? "1 link" : `${n} links`);

/**
 * Pick a type and quality per section. A choice applies only to the links that can give that
 * type; links left over are asked again, with the sections recounted over what is left.
 */
export function BatchQualityScreen({
  items,
  onPick,
  onBack,
}: BatchQualityScreenProps) {
  const waiting = waitingItems(items);
  const firstRound = !items.some(isAssigned);

  const rows: MenuItem<string>[] = KINDS.flatMap((kind) => {
    const able = takers(items, kind).length;
    return [
      {
        value: `heading:${kind}`,
        label: `${KIND_LABELS[kind]} · ${able} of ${linkCount(waiting.length)}`,
        heading: true,
        disabled: true,
      },
      ...PRESETS[kind].map((p) => ({
        value: `${kind}:${p.id}`,
        icon: KIND_ICONS[kind],
        label: p.label,
        hint: p.hint,
        disabled: able === 0,
      })),
    ];
  });

  return (
    <Frame
      crumbs={["Home", "Download", "Type"]}
      icon={ICONS.video}
      title={
        firstRound
          ? `What do you want to save from these ${items.length} links?`
          : `${linkCount(waiting.length)} still ${waiting.length === 1 ? "needs" : "need"} a type`
      }
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Back"],
      ]}
    >
      <Box marginBottom={1}>
        <Text color={COLORS.muted}>
          {firstRound
            ? "A choice applies only to the links that can give that type. You can change single links on the next screen."
            : "Choose a type for the links that are left."}
        </Text>
      </Box>
      <Menu<string>
        items={rows}
        onBack={onBack}
        onSelect={(value) => {
          const [kind, id] = value.split(":") as [MediaKind, PresetId];
          onPick(kind, id);
        }}
      />
    </Frame>
  );
}
```

Replace `BatchReviewScreen.tsx` with:

```tsx
import { Box, Text } from "ink";
import {
  type BatchItem,
  choiceFor,
  choiceWarning,
  downloadable,
  isUnusable,
  itemTitle,
  KIND_LABELS,
} from "../../batch.ts";
import { shorten } from "../../clipboard-hint.ts";
import { Frame } from "../../components/Frame.tsx";
import { Menu, type MenuItem } from "../../components/Menu.tsx";
import { useTerminalSize } from "../../components/use-terminal-size.ts";
import { siteOf } from "../../links.ts";
import { COLORS, ICONS } from "../../theme.ts";
import { KIND_ICONS } from "./BatchQualityScreen.tsx";

/** The type icons are two characters wide; the others are padded so the labels line up. */
const wide = (icon: string) => icon.padEnd(2);

/** "start", "all", "back", or the index of a link (as a number) to change it alone. */
export type ReviewChoice = "start" | "all" | "back" | number;

export interface BatchReviewScreenProps {
  items: BatchItem[];
  /** The row to highlight, e.g. the link that was just changed. */
  initial?: ReviewChoice;
  onSelect: (choice: ReviewChoice) => void;
}

const linkCount = (n: number) => (n === 1 ? "1 link" : `${n} links`);

/** What will be downloaded for each link, with a way to change single links before starting. */
export function BatchReviewScreen({
  items,
  initial,
  onSelect,
}: BatchReviewScreenProps) {
  const { columns, rows } = useTerminalSize();
  const width = Math.min(columns, 100);
  // Cap at 34 (Menu's LABEL_CAP) so every link label pads to the same width.
  const titleWidth = Math.min(34, Math.max(16, Math.floor(width * 0.4)));
  const maxVisible = rows ? Math.max(4, rows - 18) : 12;
  const ready = downloadable(items).length;
  // With nothing to download there is nothing to start, so the row is left out.
  const startRow: MenuItem<ReviewChoice>[] =
    ready > 0
      ? [
          {
            value: "start",
            icon: wide(ICONS.download),
            label: `Start downloading ${linkCount(ready)}`,
          },
        ]
      : [];

  const linkRows: MenuItem<ReviewChoice>[] = items.map((item, index) => {
    const choice = choiceFor(item);
    const unusable = isUnusable(item);
    const warning =
      choice && !unusable ? choiceWarning(item, choice) : undefined;
    const what = unusable
      ? "no downloadable formats"
      : choice
        ? `${KIND_LABELS[choice.kind]}: ${choice.label}${item.override ? " (changed)" : ""}`
        : "no type chosen";
    const note = unusable
      ? what
      : (warning ?? (item.lookupError ? "no details" : what));
    return {
      value: index,
      icon:
        unusable || warning || item.lookupError || !choice
          ? wide(ICONS.warn)
          : KIND_ICONS[choice.kind],
      label: shorten(itemTitle(item), titleWidth).padEnd(titleWidth),
      hint: [siteOf(item.url), note].join(" · "),
    };
  });

  const warnings = items.filter((i) => {
    const choice = choiceFor(i);
    return choice && !isUnusable(i) && choiceWarning(i, choice);
  }).length;
  const skipped = items.filter(isUnusable).length;

  return (
    <Frame
      crumbs={["Home", "Download", "Review"]}
      icon={ICONS.download}
      title={
        ready === 0
          ? "Nothing to download"
          : `Ready to download ${linkCount(ready)}`
      }
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Back"],
      ]}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text color={COLORS.muted}>
          Select a link to change its type or quality.
        </Text>
        {skipped ? (
          <Text color={COLORS.warn}>
            {ICONS.warn} {linkCount(skipped)} {skipped === 1 ? "has" : "have"}{" "}
            nothing to download and will be skipped.
          </Text>
        ) : null}
        {warnings ? (
          <Text color={COLORS.warn}>
            {ICONS.warn} {linkCount(warnings)} cannot give this; change{" "}
            {warnings === 1 ? "it" : "them"} or {warnings === 1 ? "it" : "they"}{" "}
            will fail.
          </Text>
        ) : null}
      </Box>
      <Menu<ReviewChoice>
        initial={initial ?? "start"}
        maxVisible={maxVisible}
        onBack={() => onSelect("back")}
        onSelect={onSelect}
        items={[
          ...startRow,
          ...linkRows,
          {
            value: "all",
            icon: wide(ICONS.format),
            label: "Change the type and quality for all",
          },
          { value: "back", icon: wide(ICONS.back), label: "Back" },
        ]}
      />
    </Frame>
  );
}
```

Replace `BatchFlow.tsx` with:

```tsx
import { DEFAULT_PROFILE_ID } from "@mediaforge/media-profiles";
import { useEffect, useRef, useState } from "react";
import type { EngineJob } from "../engine/index.ts";
import type { Settings } from "../settings.ts";
import {
  assignAll,
  assignKind,
  type BatchItem,
  choiceFor,
  clearChoices,
  downloadable,
  formatChoice,
  type ItemChoice,
  itemDraft,
  profileChoice,
  waitingItems,
  withOverride,
} from "./batch.ts";
import { useDeps } from "./deps.ts";
import { effectiveFolder, type Plan, toPlan } from "./flow.ts";
import type { MediaKind } from "./format-choices.ts";
import { useNav } from "./nav.ts";
import { BatchDownloadScreen } from "./screens/batch/BatchDownloadScreen.tsx";
import { BatchLookupScreen } from "./screens/batch/BatchLookupScreen.tsx";
import { BatchQualityScreen } from "./screens/batch/BatchQualityScreen.tsx";
import {
  type BatchResultAction,
  BatchResultScreen,
} from "./screens/batch/BatchResultScreen.tsx";
import {
  BatchReviewScreen,
  type ReviewChoice,
} from "./screens/batch/BatchReviewScreen.tsx";
import { FolderScreen } from "./screens/FolderScreen.tsx";
import { FormatsScreen } from "./screens/FormatsScreen.tsx";
import { QualityScreen } from "./screens/QualityScreen.tsx";

/** Every stage that depends on the choices made so far carries its own copy of the items. */
type Stage =
  | { name: "lookup" }
  | { name: "quality"; items: BatchItem[] }
  | { name: "review"; items: BatchItem[]; focus?: ReviewChoice }
  | { name: "item"; items: BatchItem[]; index: number }
  | { name: "item-formats"; items: BatchItem[]; index: number; kind: MediaKind }
  | { name: "folder"; items: BatchItem[] }
  /** `run` changes on every retry so the screen starts fresh downloads. */
  | { name: "download"; plans: Plan[]; run: number }
  | { name: "result"; plans: Plan[]; jobs: EngineJob[] };

export interface BatchFlowProps {
  urls: string[];
  /** Back to the link screen (to change the links, or to download more). */
  onLinks: () => void;
  onHome: () => void;
  onQuit: () => void;
  /** Told when downloads start and stop, so Ctrl+C can cancel them instead of quitting. */
  onDownloading?: (busy: boolean) => void;
}

/** Several links: look them all up, choose a type for each (or per link), then download. */
export function BatchFlow({
  urls,
  onLinks,
  onHome,
  onQuit,
  onDownloading,
}: BatchFlowProps) {
  const deps = useDeps();
  const nav = useNav<Stage>({ name: "lookup" });
  const stage = nav.current;
  const [settings, setSettings] = useState<Settings>();
  const runs = useRef(0);

  useEffect(() => {
    let live = true;
    deps.download.settings.load().then((s) => live && setSettings(s));
    return () => {
      live = false;
    };
  }, [deps]);

  const downloading = stage.name === "download";
  useEffect(() => {
    onDownloading?.(downloading);
  }, [downloading, onDownloading]);

  if (!settings) return null;

  const folderDefault = effectiveFolder(
    deps.download.env,
    settings,
    deps.defaultOutputDir,
  );

  /** Esc: one step back through the batch, or out to the link screen from its first screen. */
  const back = () => (nav.canGoBack ? nav.back() : onLinks());

  const startDownloads = (dir: string, items: BatchItem[]) => {
    const plans = downloadable(items).map((item) => {
      const plan = toPlan(
        itemDraft(item, choiceFor(item) as ItemChoice, dir),
        settings.sortByType,
      );
      // Without details there is no title yet; the link stands in for it.
      return plan.title ? plan : { ...plan, title: item.url };
    });
    nav.push({ name: "download", plans, run: ++runs.current });
  };

  /** After the types are settled: ask for the folder, or go straight to downloading. */
  const toFolder = (items: BatchItem[]) => {
    if (settings.askFolder) nav.push({ name: "folder", items });
    else startDownloads(folderDefault, items);
  };

  switch (stage.name) {
    case "lookup":
      return (
        <BatchLookupScreen
          urls={urls}
          onBack={onLinks}
          onDone={(found) => {
            // Set not to ask about quality: every link uses the saved default.
            if (!settings.askQuality) {
              const saved = profileChoice(
                settings.quality ?? DEFAULT_PROFILE_ID,
              );
              nav.replace({ name: "review", items: assignAll(found, saved) });
            } else if (waitingItems(found).length === 0) {
              // Nothing can be downloaded, so there is no type to ask about.
              nav.replace({ name: "review", items: found });
            } else nav.replace({ name: "quality", items: found });
          }}
        />
      );
    case "quality":
      return (
        <BatchQualityScreen
          key={nav.depth}
          items={stage.items}
          onBack={back}
          onPick={(kind, id) => {
            const items = assignKind(stage.items, kind, id);
            // Links this type could not cover are asked again, on a new page of history.
            if (waitingItems(items).length > 0)
              nav.push({ name: "quality", items });
            else nav.push({ name: "review", items });
          }}
        />
      );
    case "review":
      return (
        <BatchReviewScreen
          items={stage.items}
          {...(stage.focus !== undefined && { initial: stage.focus })}
          onSelect={(choice) => {
            if (choice === "start") toFolder(stage.items);
            else if (choice === "all") {
              nav.push({ name: "quality", items: clearChoices(stage.items) });
            } else if (choice === "back") back();
            else nav.push({ name: "item", items: stage.items, index: choice });
          }}
        />
      );
    case "item": {
      const item = stage.items[stage.index] as BatchItem;
      return (
        <QualityScreen
          draft={{ url: item.url, ...(item.info && { info: item.info }) }}
          settings={settings}
          onBack={back}
          onPick={(choice) =>
            "kind" in choice
              ? nav.push({
                  name: "item-formats",
                  items: stage.items,
                  index: stage.index,
                  kind: choice.kind,
                })
              : // Back to Review (dropping this page and the old Review) with the new pick.
                nav.unwind(2, {
                  name: "review",
                  items: withOverride(
                    stage.items,
                    stage.index,
                    profileChoice(choice.profileId),
                  ),
                  focus: stage.index,
                })
          }
        />
      );
    }
    case "item-formats": {
      const item = stage.items[stage.index] as BatchItem;
      return (
        <FormatsScreen
          info={item.info ?? {}}
          kind={stage.kind}
          onBack={back}
          onPick={(pick) =>
            nav.unwind(3, {
              name: "review",
              items: withOverride(
                stage.items,
                stage.index,
                formatChoice(item.info ?? {}, stage.kind, pick),
              ),
              focus: stage.index,
            })
          }
        />
      );
    }
    case "folder":
      return (
        <FolderScreen
          defaultDir={folderDefault}
          {...(settings.sortByType && {
            note: "Each file goes into a Video, Video only or Audio folder inside the one you choose.",
          })}
          onBack={back}
          onPick={(dir) => startDownloads(dir, stage.items)}
        />
      );
    case "download":
      return (
        <BatchDownloadScreen
          key={stage.run}
          plans={stage.plans}
          concurrency={settings.concurrency}
          onDone={(jobs) =>
            // Cancelled before anything finished: nothing to report, go back a page.
            // If some links were saved, show what happened to each.
            jobs.length > 0 && jobs.every((j) => j.status === "cancelled")
              ? nav.back()
              : nav.replace({ name: "result", plans: stage.plans, jobs })
          }
        />
      );
    case "result":
      return (
        <BatchResultScreen
          plans={stage.plans}
          jobs={stage.jobs}
          onAction={(action: BatchResultAction) => {
            if (action === "retry") {
              const again = stage.plans.filter(
                (_, i) => stage.jobs[i]?.status !== "completed",
              );
              nav.replace({
                name: "download",
                plans: again,
                run: ++runs.current,
              });
            } else if (action === "open") {
              const saved = stage.jobs.find((j) => j.outputPath)?.outputPath;
              if (saved) void deps.openFolder(saved);
            } else if (action === "again") onLinks();
            else if (action === "home") onHome();
            else onQuit();
          }}
        />
      );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop/src/interactive`
Expected: all pass, including `nav`, `batch`, and the full `App.test.tsx`. Then `pnpm typecheck`: expected clean now that `choiceFor` callers are updated.

- [ ] **Step 5: Checkpoint**

Run: `pnpm exec biome check apps/desktop/src/interactive`. Fix any diagnostics (the hook already applied safe fixes).

---

### Task 5: Folder browser logic and filesystem adapters

**Files:**

- Create: `apps/desktop/src/interactive/folder-browser.ts`
- Create: `apps/desktop/src/interactive/folder-fs.ts`
- Test: `apps/desktop/src/interactive/folder-browser.test.ts`

**Interfaces:**

- Produces from `folder-browser.ts`:
  - `interface FolderFs { platform: NodeJS.Platform; listDirs(dir): Promise<string[]>; exists(dir): Promise<boolean>; mkdir(dir): Promise<void>; drives(): Promise<string[]> }`
  - `pathFor(platform)`, `isHiddenFolder(name)`, `visibleFolders(names)`, `parentOf(platform, dir): string | undefined`, `startFolder(fs, wanted): Promise<string>`, `type Listing = { ok: true; dirs: string[] } | { ok: false; message: string }`, `readFolder(fs, dir): Promise<Listing>`, `describeFsError(error): string`, `folderNameError(platform, name): string | undefined`, `childPath(platform, dir, name): string`, `pasteTip(platform): string`, `folderError(value): string | undefined` (moved here from `FolderScreen.tsx`)
- Produces from `folder-fs.ts`: `realFolderFs(platform?): FolderFs`, `memoryFolderFs(tree, options?): FolderFs`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/interactive/folder-browser.test.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  childPath,
  folderError,
  folderNameError,
  isHiddenFolder,
  parentOf,
  pasteTip,
  readFolder,
  startFolder,
  visibleFolders,
} from "./folder-browser.ts";
import { memoryFolderFs, realFolderFs } from "./folder-fs.ts";

describe("folder listing", () => {
  it("hides dot folders and Windows system folders, and sorts by name ignoring case", () => {
    expect(isHiddenFolder(".git")).toBe(true);
    expect(isHiddenFolder("$RECYCLE.BIN")).toBe(true);
    expect(isHiddenFolder("System Volume Information")).toBe(true);
    expect(isHiddenFolder("Music")).toBe(false);
    expect(visibleFolders(["b", ".x", "A", "$Recycle.Bin", "c"])).toEqual([
      "A",
      "b",
      "c",
    ]);
  });

  it("reads a folder through the injected fs", async () => {
    const fs = memoryFolderFs({ "/a": ["z", "y", ".h"] });
    expect(await readFolder(fs, "/a")).toEqual({ ok: true, dirs: ["y", "z"] });
  });

  it("explains a folder that cannot be opened", async () => {
    const fs = memoryFolderFs({ "/a": [], "/b": [] }, { unreadable: ["/b"] });
    const denied = await readFolder(fs, "/b");
    expect(denied).toEqual({
      ok: false,
      message: expect.stringContaining("Permission denied"),
    });
    const gone = await readFolder(fs, "/missing");
    expect(gone).toEqual({
      ok: false,
      message: expect.stringContaining("no longer exists"),
    });
  });
});

describe("paths", () => {
  it("finds the parent, and none at a root", () => {
    expect(parentOf("linux", "/a/b")).toBe("/a");
    expect(parentOf("linux", "/a")).toBe("/");
    expect(parentOf("linux", "/")).toBeUndefined();
    expect(parentOf("win32", "C:\\Users\\me")).toBe("C:\\Users");
    expect(parentOf("win32", "C:\\")).toBeUndefined();
  });

  it("starts at the nearest folder that exists", async () => {
    const fs = memoryFolderFs({ "/": ["a"], "/a": [] });
    expect(await startFolder(fs, "/a")).toBe("/a");
    expect(await startFolder(fs, "/a/gone/deeper")).toBe("/a");
    expect(await startFolder(memoryFolderFs({}), "/x/y")).toBe("/");
  });

  it("joins a child path for the platform", () => {
    expect(childPath("linux", "/a", " New ")).toBe("/a/New");
    expect(childPath("win32", "C:\\a", "New")).toBe("C:\\a\\New");
  });
});

describe("new folder names", () => {
  it("accepts ordinary names", () => {
    expect(folderNameError("linux", "Music 2")).toBeUndefined();
    expect(folderNameError("win32", "Music 2")).toBeUndefined();
  });

  it("rejects empty, dot, and path-like names", () => {
    for (const name of ["", "   ", ".", "..", "a/b", "a\\b"]) {
      expect(folderNameError("linux", name), JSON.stringify(name)).toEqual(
        expect.any(String),
      );
    }
  });

  it("rejects what Windows does not allow, but only on Windows", () => {
    for (const name of [
      "a:b",
      "a?",
      "con",
      "NUL",
      "com1",
      "lpt9.txt",
      "name.",
    ]) {
      expect(folderNameError("win32", name), name).toEqual(expect.any(String));
    }
    expect(folderNameError("linux", "a:b")).toBeUndefined();
    expect(folderNameError("linux", "con")).toBeUndefined();
  });
});

describe("tips and validation", () => {
  it("explains how to copy a path on each system", () => {
    expect(pasteTip("win32")).toContain("Copy as path");
    expect(pasteTip("darwin")).toContain("Option");
    expect(pasteTip("linux")).toContain("location bar");
    expect(pasteTip("win32")).toContain("Ctrl+V");
  });

  it("requires a folder path to be typed", () => {
    expect(folderError("")).toBe("Enter a folder path.");
    expect(folderError("/x")).toBeUndefined();
  });
});

describe("memory fs", () => {
  it("creates a folder inside its parent and refuses duplicates", async () => {
    const fs = memoryFolderFs({ "/a": [] });
    await fs.mkdir("/a/new");
    expect(await fs.listDirs("/a")).toEqual(["new"]);
    expect(await fs.exists("/a/new")).toBe(true);
    await expect(fs.mkdir("/a/new")).rejects.toMatchObject({ code: "EEXIST" });
  });
});

describe("real fs", () => {
  it("lists only folders and can create one", async () => {
    const root = await mkdtemp(join(tmpdir(), "mf-folders-"));
    try {
      await mkdir(join(root, "sub"));
      await writeFile(join(root, "file.txt"), "x");
      const fs = realFolderFs();
      expect(await fs.listDirs(root)).toEqual(["sub"]);
      expect(await fs.exists(join(root, "sub"))).toBe(true);
      expect(await fs.exists(join(root, "file.txt"))).toBe(false);
      await fs.mkdir(join(root, "made"));
      expect((await fs.listDirs(root)).sort()).toEqual(["made", "sub"]);
      await expect(fs.listDirs(join(root, "missing"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.drives()).toEqual(
        process.platform === "win32" ? expect.any(Array) : [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/interactive/folder-browser.test.ts`
Expected: FAIL, cannot resolve `./folder-browser.ts`.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/interactive/folder-browser.ts
import { posix, win32 } from "node:path";

/** What the folder browser needs from the file system. Tests replace it. */
export interface FolderFs {
  platform: NodeJS.Platform;
  /** Names of the folders directly inside `dir`. Rejects when it cannot be read. */
  listDirs: (dir: string) => Promise<string[]>;
  exists: (dir: string) => Promise<boolean>;
  /** Create one folder; its parent must exist. Rejects if it already exists. */
  mkdir: (dir: string) => Promise<void>;
  /** Drive roots such as "C:\\"; empty where there are no drives. */
  drives: () => Promise<string[]>;
}

export const pathFor = (platform: NodeJS.Platform) =>
  platform === "win32" ? win32 : posix;

/** Hidden folders and the system folders Windows keeps at the top of a drive. */
export const isHiddenFolder = (name: string): boolean =>
  name.startsWith(".") ||
  name.startsWith("$") ||
  name.toLowerCase() === "system volume information";

export const visibleFolders = (names: readonly string[]): string[] =>
  names
    .filter((name) => !isHiddenFolder(name))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

/** The folder above this one, or undefined at the top (a drive root on Windows, "/" elsewhere). */
export function parentOf(
  platform: NodeJS.Platform,
  dir: string,
): string | undefined {
  const parent = pathFor(platform).dirname(dir);
  return parent === dir ? undefined : parent;
}

/** `wanted` if it exists, else its nearest parent that does. */
export async function startFolder(
  fs: FolderFs,
  wanted: string,
): Promise<string> {
  let dir = pathFor(fs.platform).resolve(wanted);
  for (;;) {
    if (await fs.exists(dir)) return dir;
    const parent = parentOf(fs.platform, dir);
    if (!parent) return dir;
    dir = parent;
  }
}

export function describeFsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM")
    return "Permission denied: this folder cannot be opened.";
  if (code === "ENOENT" || code === "ENOTDIR")
    return "This folder no longer exists.";
  if (code === "EEXIST") return "A folder with that name already exists.";
  return error instanceof Error ? error.message : String(error);
}

export type Listing =
  | { ok: true; dirs: string[] }
  | { ok: false; message: string };

/** The visible subfolders of `dir`, or why they could not be read. */
export async function readFolder(fs: FolderFs, dir: string): Promise<Listing> {
  try {
    return { ok: true, dirs: visibleFolders(await fs.listDirs(dir)) };
  } catch (error) {
    return { ok: false, message: describeFsError(error) };
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why this cannot be the name of a new folder, or undefined if it can. */
export function folderNameError(
  platform: NodeJS.Platform,
  name: string,
): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a folder name.";
  if (trimmed === "." || trimmed === "..") return "That name is not allowed.";
  if (/[\\/]/.test(trimmed)) return "A folder name cannot contain / or \\.";
  if (platform === "win32") {
    if (/[<>:"|?*]/.test(trimmed))
      return 'A folder name cannot contain < > : " | ? *';
    if (/\.$/.test(trimmed)) return "A folder name cannot end with a dot.";
    if (WINDOWS_RESERVED.test(trimmed))
      return "That name is reserved by Windows.";
  }
  return undefined;
}

export const childPath = (
  platform: NodeJS.Platform,
  dir: string,
  name: string,
): string => pathFor(platform).join(dir, name.trim());

/** How to copy a folder's path on this system, shown under the paste box. */
export function pasteTip(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return "Ctrl+V pastes. In File Explorer, Shift+right-click a folder, then choose Copy as path.";
  }
  if (platform === "darwin") {
    return "Ctrl+V pastes. In Finder, right-click the folder, hold Option, then choose Copy as Pathname.";
  }
  return "Ctrl+V pastes. Copy the path from your file manager's location bar.";
}

/** Blocks an empty typed folder path. */
export function folderError(value: string): string | undefined {
  return value ? undefined : "Enter a folder path.";
}
```

```ts
// apps/desktop/src/interactive/folder-fs.ts
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type FolderFs, pathFor } from "./folder-browser.ts";

/** The real file system. Symbolic links to folders count as folders. */
export function realFolderFs(
  platform: NodeJS.Platform = process.platform,
): FolderFs {
  return {
    platform,
    async listDirs(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      const names: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) names.push(entry.name);
        else if (entry.isSymbolicLink()) {
          try {
            if ((await stat(join(dir, entry.name))).isDirectory())
              names.push(entry.name);
          } catch {
            // A broken link is not a folder.
          }
        }
      }
      return names;
    },
    async exists(dir) {
      try {
        return (await stat(dir)).isDirectory();
      } catch {
        return false;
      }
    },
    async mkdir(dir) {
      await mkdir(dir);
    },
    async drives() {
      if (platform !== "win32") return [];
      const found: string[] = [];
      for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        const root = `${letter}:\\`;
        try {
          await access(root);
          found.push(root);
        } catch {
          // No such drive.
        }
      }
      return found;
    },
  };
}

export interface MemoryFolderOptions {
  platform?: NodeJS.Platform;
  drives?: string[];
  /** Folders whose listing fails with a permission error. */
  unreadable?: string[];
}

/** In-memory folders for tests: a map from each folder to the names of its subfolders. */
export function memoryFolderFs(
  tree: Record<string, string[]>,
  options: MemoryFolderOptions = {},
): FolderFs {
  const platform = options.platform ?? "linux";
  const path = pathFor(platform);
  const dirs = new Map(
    Object.entries(tree).map(([dir, names]) => [dir, [...names]] as const),
  );
  const fail = (code: string) => Object.assign(new Error(code), { code });
  return {
    platform,
    exists: async (dir) => dirs.has(dir),
    listDirs: async (dir) => {
      if (options.unreadable?.includes(dir)) throw fail("EACCES");
      const names = dirs.get(dir);
      if (!names) throw fail("ENOENT");
      return [...names];
    },
    mkdir: async (dir) => {
      if (dirs.has(dir)) throw fail("EEXIST");
      dirs.set(dir, []);
      dirs.get(path.dirname(dir))?.push(path.basename(dir));
    },
    drives: async () => options.drives ?? [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/desktop/src/interactive/folder-browser.test.ts`
Expected: PASS.

---

### Task 6: Folder browser UI, picker, Settings and Folder step

**Files:**

- Modify: `apps/desktop/src/interactive/deps.ts` (add `folders: FolderFs`)
- Modify: `apps/desktop/src/interactive/start.tsx` (provide `realFolderFs()`)
- Modify: `apps/desktop/src/interactive/components/Menu.tsx` (add `leftIsBack`)
- Create: `apps/desktop/src/interactive/screens/FolderBrowserScreen.tsx`
- Create: `apps/desktop/src/interactive/screens/FolderPicker.tsx`
- Modify: `apps/desktop/src/interactive/screens/FolderScreen.tsx` (full replacement)
- Modify: `apps/desktop/src/interactive/screens/SettingsScreen.tsx` (folder mode, imports)
- Test: `apps/desktop/src/interactive/App.test.tsx`

**Interfaces:**

- Consumes: `FolderFs`, `readFolder`, `startFolder`, `parentOf`, `folderNameError`, `childPath`, `pasteTip`, `folderError` (Task 5).
- Produces: `FolderBrowserScreen({ crumbs, startDir, onPick, onCancel })`; `FolderPicker({ crumbs, startDir, initialText?, initialStage, onPick, onCancel })` where `initialStage: "choose" | "browse" | "type"`; `AppDeps.folders`.

- [ ] **Step 1: Write the failing tests**

In `App.test.tsx`: add imports `import { memoryFolderFs } from "./folder-fs.ts";` and `import type { FolderFs } from "./folder-browser.ts";`. Extend `Options` with `folders?: FolderFs;` and add to the `deps` object in `setup()`:

```tsx
    folders:
      options.folders ??
      memoryFolderFs({ "/": ["downloads", "music"], "/downloads": [], "/music": [] }),
```

Add `ctrlU: "\u0015"` to the `KEY` object, then update the existing test `saves a typed default folder`. The typed field now starts with the current folder (`/downloads`) pre-filled, so clear it with Ctrl+U before typing:

```tsx
it("saves a typed default folder", async () => {
  const t = await openSettings();
  await press(t.app, KEY.enter);
  await waitFor(t.app, "Browse for a folder");
  await press(t.app, KEY.down, KEY.enter);
  await waitFor(t.app, "Esc Cancel");
  expect(t.app.lastFrame()).toContain("Ctrl+V pastes");
  await press(t.app, KEY.ctrlU, "/music", KEY.enter);
  await waitFor(t.app, "Saved");
  expect((await t.store.load()).folder).toMatch(/\/music$/);
  t.app.unmount();
});
```

Add a new `describe`:

```tsx
describe("folder browser", () => {
  const TREE = {
    "/": ["downloads", "music", "secret"],
    "/downloads": ["Existing"],
    "/downloads/Existing": [],
    "/music": [],
    "/secret": [],
  };

  async function openBrowser(options: Options = {}) {
    const t = setup({
      folders: memoryFolderFs(TREE, { unreadable: ["/secret"] }),
      ...options,
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.down, KEY.enter);
    await waitFor(t.app, "Default download folder");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Browse for a folder");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Choose this folder");
    return t;
  }

  it("picks a default folder by browsing into it", async () => {
    const t = await openBrowser();
    expect(t.app.lastFrame()).toContain("/downloads");
    await moveTo(t.app, "Existing");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "/downloads/Existing");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Saved");
    expect((await t.store.load()).folder).toBe("/downloads/Existing");
    t.app.unmount();
  });

  it("goes up a level with the up row and the left arrow", async () => {
    const t = await openBrowser();
    await moveTo(t.app, ".. (up)");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "music");
    await moveTo(t.app, "music");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "/music");
    await press(t.app, "\u001B[D");
    await waitFor(t.app, "downloads");
    t.app.unmount();
  });

  it("creates a new folder and enters it", async () => {
    const t = await openBrowser();
    await moveTo(t.app, "New folder...");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Name of the new folder");
    await press(t.app, "..", KEY.enter);
    await waitFor(t.app, "That name is not allowed.");
    await press(t.app, KEY.ctrlU, "Fresh", KEY.enter);
    await waitFor(t.app, "/downloads/Fresh");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Saved");
    expect((await t.store.load()).folder).toBe("/downloads/Fresh");
    t.app.unmount();
  });

  it("stays put and says why when a folder cannot be opened", async () => {
    // The saved folder is "/", so the browser opens at the root, where "secret" is unreadable.
    const t = await openBrowser({ settings: { folder: "/" } });
    await moveTo(t.app, "secret");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Permission denied");
    const frame = t.app.lastFrame() ?? "";
    expect(frame).toContain("Choose this folder");
    expect(frame).toContain("downloads");
    t.app.unmount();
  });

  it("lists drives at the top of a Windows drive", async () => {
    const fs = memoryFolderFs(
      { "C:\\": ["Users"], "D:\\": ["Games"] },
      { platform: "win32", drives: ["C:\\", "D:\\"] },
    );
    const t = setup({ folders: fs, settings: { folder: "C:\\" } });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.down, KEY.enter);
    await waitFor(t.app, "Default download folder");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Browse for a folder");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Choose this folder");
    expect(t.app.lastFrame()).not.toContain(".. (up)");
    await moveTo(t.app, "Drives");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "D:\\");
    await moveTo(t.app, "D:\\");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Games");
    t.app.unmount();
  });

  it("offers to browse from the download folder step too", async () => {
    const t = setup({ folders: memoryFolderFs(TREE) });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "What do you want to save?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Choose a video quality");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Where should it be saved?");
    await moveTo(t.app, "Browse for a folder");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Choose this folder");
    await moveTo(t.app, "Existing");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "/downloads/Existing");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download complete");
    t.app.unmount();
  });
});
```

For the "cannot be opened" test the first line `openBrowser({ settings: { folder: "/" } })` already starts at `/` because `startDir` is the effective folder (`/`); remove the `.. (up)` hop and the "secret" wait that follows it, so the test reads: open the browser (it starts at `/`), `moveTo secret`, Enter, wait for "Permission denied", assert "Choose this folder" is still shown.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/interactive/App.test.tsx -t "folder"`
Expected: FAIL (`folders` is not part of `AppDeps`; no browser screen).

- [ ] **Step 3: Implement**

`deps.ts`: add `import type { FolderFs } from "./folder-browser.ts";` and to `AppDeps`:

```ts
/** The file system the folder browser reads. */
folders: FolderFs;
```

`start.tsx`: add `import { realFolderFs } from "./folder-fs.ts";` and `folders: realFolderFs(),` in `realDeps()`.

`Menu.tsx`: add to `MenuProps`:

```ts
  /** Whether the left arrow also counts as "back". Turn off where it means something else. */
  leftIsBack?: boolean;
```

default `leftIsBack = true` in the destructure, and change the key handler line to:

```ts
      } else if (key.escape || (key.leftArrow && leftIsBack)) onBack?.();
```

`FolderBrowserScreen.tsx`:

```tsx
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { Frame } from "../components/Frame.tsx";
import { Menu, type MenuItem } from "../components/Menu.tsx";
import { TextField } from "../components/TextField.tsx";
import { useTerminalSize } from "../components/use-terminal-size.ts";
import { useDeps } from "../deps.ts";
import {
  childPath,
  describeFsError,
  folderNameError,
  parentOf,
  readFolder,
  startFolder,
} from "../folder-browser.ts";
import { COLORS, ICONS } from "../theme.ts";

export interface FolderBrowserProps {
  crumbs: string[];
  /** Where to open. A folder that does not exist opens at its nearest parent. */
  startDir: string;
  onPick: (dir: string) => void;
  onCancel: () => void;
}

type View = "folder" | "new" | "drives";

/** Browse folders with the arrow keys and choose one. */
export function FolderBrowserScreen({
  crumbs,
  startDir,
  onPick,
  onCancel,
}: FolderBrowserProps) {
  const { folders } = useDeps();
  const { rows } = useTerminalSize();
  const [current, setCurrent] = useState<{ dir: string; dirs: string[] }>();
  const [view, setView] = useState<View>("folder");
  const [drives, setDrives] = useState<string[]>([]);
  const [problem, setProblem] = useState<string>();

  /** Open a folder. If it cannot be read, say why and stay where we are. */
  const open = async (dir: string) => {
    const listing = await readFolder(folders, dir);
    if (listing.ok) {
      setCurrent({ dir, dirs: listing.dirs });
      setProblem(undefined);
    } else setProblem(listing.message);
    setView("folder");
  };

  useEffect(() => {
    let live = true;
    void startFolder(folders, startDir).then(async (dir) => {
      const listing = await readFolder(folders, dir);
      if (!live) return;
      setCurrent({ dir, dirs: listing.ok ? listing.dirs : [] });
      if (!listing.ok) setProblem(listing.message);
    });
    return () => {
      live = false;
    };
  }, [folders, startDir]);

  const up = current ? parentOf(folders.platform, current.dir) : undefined;

  // The left arrow goes up a level, like the ".." row.
  useInput(
    (_input, key) => {
      if (key.leftArrow && up) void open(up);
    },
    { isActive: view === "folder" },
  );

  if (!current) return null;

  const hints: [string, string][] = [
    ["↑↓", "Move"],
    ["Enter", "Open"],
    ["←", "Up"],
    ["Esc", "Cancel"],
  ];

  if (view === "new") {
    return (
      <Frame
        crumbs={[...crumbs, "New folder"]}
        icon={ICONS.folder}
        title="Name of the new folder"
        hints={[
          ["Enter", "Create"],
          ["Esc", "Cancel"],
        ]}
      >
        <Text color={COLORS.muted}>In {current.dir}</Text>
        <Box marginTop={1} flexDirection="column">
          <TextField
            validate={(name) => folderNameError(folders.platform, name)}
            onCancel={() => setView("folder")}
            onSubmit={async (name) => {
              const path = childPath(folders.platform, current.dir, name);
              try {
                await folders.mkdir(path);
                await open(path);
              } catch (error) {
                setProblem(describeFsError(error));
                setView("folder");
              }
            }}
          />
        </Box>
      </Frame>
    );
  }

  if (view === "drives") {
    return (
      <Frame
        crumbs={[...crumbs, "Drives"]}
        icon={ICONS.folder}
        title="Choose a drive"
        hints={[
          ["↑↓", "Move"],
          ["Enter", "Open"],
          ["Esc", "Back"],
        ]}
      >
        <Menu<string>
          items={drives.map((d) => ({
            value: d,
            icon: ICONS.folder,
            label: d,
          }))}
          onBack={() => setView("folder")}
          onSelect={(root) => void open(root)}
        />
      </Frame>
    );
  }

  const items: MenuItem<string>[] = [
    { value: "choose", icon: ICONS.ok, label: "Choose this folder" },
    { value: "new", icon: ICONS.type, label: "New folder..." },
    ...(up
      ? [{ value: "up", icon: ICONS.back, label: ".. (up)" }]
      : folders.platform === "win32"
        ? [{ value: "drives", icon: ICONS.folder, label: "Drives" }]
        : []),
    ...current.dirs.map((name) => ({
      value: `dir:${name}`,
      icon: ICONS.folder,
      label: name,
    })),
  ];

  return (
    <Frame
      crumbs={crumbs}
      icon={ICONS.folder}
      title="Choose a folder"
      hints={hints}
    >
      <Box marginBottom={1} flexDirection="column">
        <Text color={COLORS.accent}>{current.dir}</Text>
        {problem ? (
          <Text color={COLORS.error}>
            {ICONS.error} {problem}
          </Text>
        ) : null}
      </Box>
      <Menu<string>
        // A fresh menu per folder, so the highlight starts on "Choose this folder".
        key={current.dir}
        items={items}
        maxVisible={rows ? Math.max(4, rows - 18) : 12}
        leftIsBack={false}
        onBack={onCancel}
        onSelect={(value) => {
          if (value === "choose") onPick(current.dir);
          else if (value === "new") setView("new");
          else if (value === "up" && up) void open(up);
          else if (value === "drives") {
            void folders.drives().then((found) => {
              setDrives(found);
              setView("drives");
            });
          } else if (value.startsWith("dir:")) {
            void open(childPath(folders.platform, current.dir, value.slice(4)));
          }
        }}
      />
    </Frame>
  );
}
```

`FolderPicker.tsx`:

```tsx
import { Box, Text } from "ink";
import { useState } from "react";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { TextField } from "../components/TextField.tsx";
import { useDeps } from "../deps.ts";
import { folderError, pasteTip } from "../folder-browser.ts";
import { COLORS, ICONS } from "../theme.ts";
import { FolderBrowserScreen } from "./FolderBrowserScreen.tsx";

type Stage = "choose" | "browse" | "type";

export interface FolderPickerProps {
  crumbs: string[];
  /** Where the browser opens. */
  startDir: string;
  /** Text already in the box when typing. */
  initialText?: string;
  /** "choose" asks first; the others go straight to browsing or typing. */
  initialStage: Stage;
  onPick: (dir: string) => void;
  onCancel: () => void;
}

/** Pick a folder by browsing for it, or by typing or pasting its path. */
export function FolderPicker({
  crumbs,
  startDir,
  initialText,
  initialStage,
  onPick,
  onCancel,
}: FolderPickerProps) {
  const deps = useDeps();
  const [stage, setStage] = useState<Stage>(initialStage);
  // Esc goes back to the question if that is where we started, else out of the picker.
  const leave = () =>
    initialStage === "choose" && stage !== "choose"
      ? setStage("choose")
      : onCancel();

  if (stage === "browse") {
    return (
      <FolderBrowserScreen
        crumbs={crumbs}
        startDir={startDir}
        onPick={onPick}
        onCancel={leave}
      />
    );
  }

  if (stage === "type") {
    return (
      <Frame
        crumbs={crumbs}
        icon={ICONS.folder}
        title="Type or paste a folder path"
        hints={[
          ["Enter", "Save"],
          ["Ctrl+V", "Paste"],
          ["Esc", "Cancel"],
        ]}
      >
        <TextField
          {...(initialText !== undefined && { initial: initialText })}
          validate={folderError}
          readClipboard={deps.readClipboard}
          onSubmit={onPick}
          onCancel={leave}
        />
        <Box marginTop={1}>
          <Text color={COLORS.muted}>
            {ICONS.info} Tip: {pasteTip(deps.folders.platform)}
          </Text>
        </Box>
      </Frame>
    );
  }

  return (
    <Frame
      crumbs={crumbs}
      icon={ICONS.folder}
      title="How do you want to choose the folder?"
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Cancel"],
      ]}
    >
      <Menu<"browse" | "type">
        onBack={onCancel}
        onSelect={setStage}
        items={[
          {
            value: "browse",
            icon: ICONS.folder,
            label: "Browse for a folder",
            hint: "pick with the arrow keys",
          },
          { value: "type", icon: ICONS.type, label: "Type or paste a path" },
        ]}
      />
    </Frame>
  );
}
```

`FolderScreen.tsx` full replacement:

```tsx
import { Box, Text } from "ink";
import { useState } from "react";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { COLORS, ICONS } from "../theme.ts";
import { FolderPicker } from "./FolderPicker.tsx";

type Choice = "default" | "browse" | "type";

export interface FolderScreenProps {
  defaultDir: string;
  /** Type subfolder the file will go into, when sorting is on. */
  subfolder?: string;
  /** Replaces the subfolder sentence, e.g. for several links that go to different folders. */
  note?: string;
  onPick: (dir: string) => void;
  onBack: () => void;
}

export function FolderScreen({
  defaultDir,
  subfolder,
  note,
  onPick,
  onBack,
}: FolderScreenProps) {
  const [picker, setPicker] = useState<"browse" | "type">();

  if (picker) {
    return (
      <FolderPicker
        crumbs={["Home", "Download", "Folder"]}
        startDir={defaultDir}
        initialStage={picker}
        onPick={onPick}
        onCancel={() => setPicker(undefined)}
      />
    );
  }

  return (
    <Frame
      crumbs={["Home", "Download", "Folder"]}
      icon={ICONS.folder}
      title="Where should it be saved?"
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Back"],
      ]}
    >
      {note || subfolder ? (
        <Box marginBottom={1}>
          <Text color={COLORS.muted}>
            {ICONS.info}{" "}
            {note ??
              `It will go into a "${subfolder}" folder inside the one you choose.`}
          </Text>
        </Box>
      ) : null}
      <Menu<Choice>
        onBack={onBack}
        onSelect={(choice) =>
          choice === "default" ? onPick(defaultDir) : setPicker(choice)
        }
        items={[
          {
            value: "default",
            icon: ICONS.folder,
            label: defaultDir,
            hint: "default",
          },
          { value: "browse", icon: ICONS.type, label: "Browse for a folder" },
          { value: "type", icon: ICONS.type, label: "Type or paste a path" },
        ]}
      />
    </Frame>
  );
}
```

`SettingsScreen.tsx`: remove `import { TextField } …` and `import { folderError } from "./FolderScreen.tsx";` (check `TextField` is not used elsewhere in the file; it is only used in the folder branch), add `import { FolderPicker } from "./FolderPicker.tsx";`, and replace the whole `if (mode === "folder") { … }` block with:

```tsx
if (mode === "folder") {
  return (
    <FolderPicker
      crumbs={["Home", "Settings", "Folder"]}
      startDir={folder}
      initialText={folder}
      initialStage="choose"
      onPick={(value) => void save({ ...settings, folder: value })}
      onCancel={() => setMode("menu")}
    />
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop/src/interactive` then `pnpm typecheck`.
Expected: all pass, typecheck clean. If `moveTo` mis-detects a selected row because a heading-like line starts with ` ►`, give that row a different icon rather than changing the helper.

---

### Task 7: Supported-sites hint

**Files:**

- Create: `apps/desktop/src/sites.ts`
- Test: `apps/desktop/src/sites.test.ts`
- Modify: `apps/desktop/src/cli.ts`
- Modify: `apps/desktop/src/interactive/hints.ts`
- Modify: `apps/desktop/src/interactive/screens/LinkScreen.tsx`
- Test: `apps/desktop/src/interactive/App.test.tsx`, `apps/desktop/src/interactive/logic.test.ts`

**Interfaces:**

- Produces: `SUPPORTED_SITES_URL: string`, `sitesTip: string`, `errorTip(code: ExitCode): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/sites.test.ts
import { describe, expect, it } from "vitest";
import { ExitCode } from "./exit-codes.ts";
import { errorTip, SUPPORTED_SITES_URL, sitesTip } from "./sites.ts";

describe("supported sites hint", () => {
  it("points at yt-dlp's list", () => {
    expect(SUPPORTED_SITES_URL).toBe(
      "https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md",
    );
    expect(sitesTip).toContain(SUPPORTED_SITES_URL);
  });

  it("adds the list to unsupported-site errors only", () => {
    expect(errorTip(ExitCode.UnsupportedSite)).toBe(
      `Supported sites: ${SUPPORTED_SITES_URL}\n`,
    );
    expect(errorTip(ExitCode.Network)).toBe("");
    expect(errorTip(ExitCode.Failure)).toBe("");
  });
});
```

In `logic.test.ts`, extend the existing `failureHint` assertion area (line ~241) with:

```ts
expect(failureHint(ExitCode.UnsupportedSite, "")).toContain(
  "https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md",
);
```

In `App.test.tsx` `describe("link step")` add:

```tsx
it("tells the user where to find the supported sites", async () => {
  const { app } = setup({ clipboard: undefined });
  await waitFor(app, "What would you like to do?");
  await press(app, KEY.enter);
  await waitFor(app, "Copy one link");
  expect(app.lastFrame()).toContain("supportedsites.md");
  await press(app, KEY.enter);
  await waitFor(app, "Type or paste one or more links");
  expect(app.lastFrame()).toContain("supportedsites.md");
  app.unmount();
});
```

and in `describe("download flow")` extend the test `"explains a failed lookup…"` neighbour with a new one:

```tsx
it("links to the supported sites when a link is not supported", async () => {
  const t = setup({
    info: async () => {
      throw new CliError(
        "Unsupported URL: https://x",
        ExitCode.UnsupportedSite,
      );
    },
  });
  await waitFor(t.app, "What would you like to do?");
  await press(t.app, KEY.enter);
  await waitFor(t.app, URL);
  await press(t.app, KEY.enter);
  await waitFor(t.app, "Could not read details for this link");
  expect(t.app.lastFrame()).toContain("supportedsites.md");
  t.app.unmount();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/sites.test.ts apps/desktop/src/interactive`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/sites.ts
import { ExitCode } from "./exit-codes.ts";

/** yt-dlp's list of every site it can download from. */
export const SUPPORTED_SITES_URL =
  "https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md";

export const sitesTip = `Not sure a site works? Full list of supported sites: ${SUPPORTED_SITES_URL}`;

/** Extra line printed under an error, for the errors where it helps. */
export const errorTip = (code: ExitCode): string =>
  code === ExitCode.UnsupportedSite
    ? `Supported sites: ${SUPPORTED_SITES_URL}\n`
    : "";
```

`cli.ts`: add `import { errorTip } from "./sites.ts";` and change the CliError branch to

```ts
io.stderr(`${error.message}\n${errorTip(error.exitCode)}`);
```

`hints.ts`: add `import { SUPPORTED_SITES_URL } from "../sites.ts";` and change the `UnsupportedSite` case to

```ts
return `This link is not supported. Check that it points to a video or audio page, and that yt-dlp is up to date. All supported sites: ${SUPPORTED_SITES_URL}`;
```

`LinkScreen.tsx`: add `import { sitesTip } from "../../sites.ts";`. In the typing view, after the `<FoundLinks … />` box add:

```tsx
<Box marginTop={1}>
  <Text color={COLORS.muted}>
    {ICONS.info} {sitesTip}
  </Text>
</Box>
```

and in the menu view, directly after the `Copy one link, or several…` `<Text>` pair, add before `<Menu>`:

```tsx
      <Text color={COLORS.muted}>
        {ICONS.info} {sitesTip}
      </Text>
      <Text> </Text>
```

(remove the existing lone `<Text> </Text>` line that followed the intro so there is a single blank line).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop/src` then `pnpm typecheck`.
Expected: all pass. Long URLs wrap in narrow terminals; that is acceptable.

---

### Task 8: About page

**Files:**

- Create: `apps/desktop/src/interactive/about.ts`
- Create: `apps/desktop/src/interactive/screens/AboutScreen.tsx`
- Modify: `apps/desktop/src/interactive/deps.ts` (add `configPath`, `target`)
- Modify: `apps/desktop/src/interactive/start.tsx` (provide them)
- Modify: `apps/desktop/src/interactive/screens/HomeScreen.tsx` (About row, hint `1-5`)
- Modify: `apps/desktop/src/interactive/App.tsx` (`about` screen)
- Test: `apps/desktop/src/interactive/about.test.ts`, `apps/desktop/src/interactive/App.test.tsx`

**Interfaces:**

- Produces: `DEVELOPER`, `REPO_URL: string | undefined`, `NOTICES`, `aboutRows(info: { version; target; configPath }): [string, string][]`, `developerRows(): [string, string][]`; `HomeChoice` gains `"about"`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/interactive/about.test.ts
import { describe, expect, it } from "vitest";
import { aboutRows, DEVELOPER, developerRows, NOTICES } from "./about.ts";

describe("about page data", () => {
  it("describes the app, its build target and its config file", () => {
    expect(
      aboutRows({
        version: "1.2.3",
        target: "win32-x64",
        configPath: "C:\\c.json",
      }),
    ).toEqual([
      ["Version", "1.2.3"],
      ["Build", "win32-x64"],
      ["Settings file", "C:\\c.json"],
    ]);
  });

  it("names the developer and hides the repository row until there is a link", () => {
    const rows = developerRows(undefined);
    expect(rows).toEqual([["Developer", DEVELOPER]]);
    expect(developerRows("https://example.com/repo")).toEqual([
      ["Developer", DEVELOPER],
      ["Repository", "https://example.com/repo"],
    ]);
  });

  it("credits the tools it downloads with their licenses", () => {
    expect(NOTICES.map((n) => n.name)).toEqual(["yt-dlp", "ffmpeg"]);
    for (const notice of NOTICES) {
      expect(notice.license).toBeTruthy();
      expect(notice.url).toMatch(/^https:\/\//);
    }
  });
});
```

In `App.test.tsx`: add to `deps` in `setup()`: `configPath: "/config/mediaforge/config.json", target: "linux-x64",`. Add:

```tsx
describe("about", () => {
  it("shows the app, tools, developer, sites link and notices", async () => {
    const { app } = setup();
    await waitFor(app, "What would you like to do?");
    await moveTo(app, "About");
    await press(app, KEY.enter);
    await waitFor(app, "About MediaForge");
    // The tool versions load a moment later. ("yt-dlp" alone would match Home's hint text.)
    await waitFor(app, "2026.1.1");
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("9.9.9");
    expect(frame).toContain("linux-x64");
    expect(frame).toContain("/config/mediaforge/config.json");
    expect(frame).toContain("2026.1.1");
    expect(frame).toContain("N-Berns");
    expect(frame).toContain("supportedsites.md");
    expect(frame).toContain("Unlicense");
    expect(frame).toContain("LGPL");
    await press(app, KEY.esc);
    await waitFor(app, "What would you like to do?");
    app.unmount();
  });
});
```

Also update the `home` test's label loop to include `"About"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/interactive/about.test.ts apps/desktop/src/interactive/App.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/interactive/about.ts

/** Shown on the About page. */
export const DEVELOPER = "N-Berns";

/** Set to the repository link once it is public; the About page hides the row until then. */
export const REPO_URL: string | undefined = undefined;

/** The tools MediaForge downloads and runs, with the license each one is distributed under. */
export const NOTICES = [
  {
    name: "yt-dlp",
    license: "Unlicense (public domain)",
    url: "https://github.com/yt-dlp/yt-dlp",
  },
  {
    name: "ffmpeg",
    license: "LGPL 2.1 or later (some builds GPL)",
    url: "https://ffmpeg.org/legal.html",
  },
] as const;

export interface AboutInfo {
  version: string;
  target: string;
  configPath: string;
}

export const aboutRows = ({
  version,
  target,
  configPath,
}: AboutInfo): [string, string][] => [
  ["Version", version],
  ["Build", target],
  ["Settings file", configPath],
];

export const developerRows = (
  repo: string | undefined = REPO_URL,
): [string, string][] => [
  ["Developer", DEVELOPER],
  ...(repo ? ([["Repository", repo]] as [string, string][]) : []),
];
```

`deps.ts`: add to `AppDeps`:

```ts
/** Where the settings file lives, shown on the About page. */
configPath: string;
/** The platform and CPU this build runs on, e.g. "win32-x64". */
target: string;
```

`start.tsx`: add `import { settingsPath } from "../settings.ts";` and in `realDeps()`:

```ts
    configPath: settingsPath(process.env),
    target: `${process.platform}-${process.arch}`,
```

`AboutScreen.tsx`:

```tsx
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { ToolReport } from "../../doctor.ts";
import { SUPPORTED_SITES_URL } from "../../sites.ts";
import { aboutRows, developerRows, NOTICES } from "../about.ts";
import { Card } from "../components/Card.tsx";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { useDeps } from "../deps.ts";
import { COLORS, ICONS } from "../theme.ts";

export function AboutScreen({ onBack }: { onBack: () => void }) {
  const deps = useDeps();
  const [reports, setReports] = useState<ToolReport[]>();

  useEffect(() => {
    let live = true;
    deps.inspectTools().then((r) => live && setReports(r));
    return () => {
      live = false;
    };
  }, [deps]);

  return (
    <Frame
      crumbs={["Home", "About"]}
      icon={ICONS.info}
      title="About MediaForge"
      hints={[
        ["Enter", "Back"],
        ["Esc", "Back"],
      ]}
    >
      <Card
        rows={[
          ...aboutRows({
            version: deps.version,
            target: deps.target,
            configPath: deps.configPath,
          }),
          ...developerRows(),
          ["Supported sites", SUPPORTED_SITES_URL],
        ]}
      />
      {!reports ? (
        <Spinner label="Looking for yt-dlp and ffmpeg..." />
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {reports.map((r) => (
            <Text key={r.tool} color={r.found ? undefined : COLORS.error}>
              {r.found ? ICONS.ok : ICONS.error} {r.tool}
              <Text color={COLORS.muted}>
                {r.found
                  ? `  ${r.version ?? "unknown version"}  (${r.source})  ${r.path}`
                  : "  not found"}
              </Text>
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" marginBottom={1}>
        {NOTICES.map((n) => (
          <Text key={n.name} color={COLORS.muted}>
            {n.name}: {n.license}. {n.url}
          </Text>
        ))}
      </Box>
      <Menu<"back">
        onBack={onBack}
        onSelect={onBack}
        items={[{ value: "back", icon: ICONS.back, label: "Back" }]}
      />
    </Frame>
  );
}
```

`HomeScreen.tsx`: `HomeChoice = "download" | "settings" | "setup" | "about" | "quit"`; hint `["1-5", "Jump"]`; insert before the `quit` item:

```tsx
          { value: "about", icon: ICONS.info, label: "About", hint: "version, tools and credits" },
```

`App.tsx`: add `import { AboutScreen } from "./screens/AboutScreen.tsx";`, add `| { name: "about" }` to `Screen`, change the Home `onPick` fallthrough to

```tsx
              else if (choice === "setup") nav.push({ name: "setup" });
              else nav.push({ name: "about" });
```

and add the case:

```tsx
      case "about":
        return <AboutScreen onBack={nav.back} />;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop/src` then `pnpm typecheck`.
Expected: all pass. Existing Check-setup tests still select the third row with two `down` presses; About is after it.

---

### Task 9: Final verification and checklist

**Files:**

- Modify: `docs/desktop-cli-checklist.md`

- [ ] **Step 1: Update the checklist**

Under `### Interactive mode (the main user experience)` in `docs/desktop-cli-checklist.md`, add these lines after the existing Settings line, ticking only what you have verified in this task:

```markdown
- [x] Folder browser (arrow keys, up row, new folder, Windows drive list) for the default folder and the download-time folder step; paste box has a per-OS tip
- [x] Bulk type step in three sections; a choice applies only to links that can give that type, leftovers are asked again
- [x] Supported-sites link on the link screen, in unsupported-site errors (app and CLI) and on About
- [x] Esc is a real back stack (single and bulk flows); Esc on Home asks to quit; a cancelled download returns to the page before it
- [x] About page: version, build, settings file, tools, developer, notices
```

- [ ] **Step 2: Full gate**

Run, in order, and read each output:

1. `pnpm lint`: expected: no findings. Fix every finding (no ignore comments).
2. `pnpm typecheck`: expected: clean.
3. `pnpm test`: expected: all tests pass.

- [ ] **Step 3: Manual check in a real terminal**

Run `pnpm --filter @mediaforge/desktop start` and verify by hand, then report what you saw:

1. Home → Settings → Default download folder → Browse: arrow keys, `..`, left arrow, New folder (try `..` and a good name), Choose this folder; the Saved note appears.
2. Paste one SoundCloud-style audio link and one YouTube link: the type step shows counts, picks apply only to links that can use them, leftovers are asked again.
3. Esc through Review → Type → Link → Home; Esc on Home shows the quit prompt.
4. Start a download and press Esc: you return to the Folder page (or the Link page if folder asking is off).
5. Home → About shows tools and the sites link.

Do not commit. Report any step you could not run.

---

## Self-Review Notes

- **Spec coverage:** §1 folder browser → Tasks 5, 6; §2 batch type step → Tasks 3, 4; §3 sites hint → Task 7; §4 Esc stack → Tasks 1, 2, 4; §5 About → Task 8; testing list → each task's tests; checklist → Task 9.
- **Interpretations to confirm with the user:** a cancelled single download pops back instead of showing the old "cancelled" result screen (the spec says "then pops to the page before it"); a cancelled batch still shows its result when at least one link finished; "Change all" clears assigned choices but keeps per-link overrides; hidden folders are detected by dot/`$` prefix and the Windows system folder name, not by the Windows hidden attribute.
- **Known follow-up, not in this plan:** `ResultScreen`'s "cancelled" branch is now unreachable for single downloads. It is harmless and left alone.
