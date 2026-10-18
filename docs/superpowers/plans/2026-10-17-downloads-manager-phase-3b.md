# Downloads Manager, Phase 3b: Manager Screen (Keyboard) and Attention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `mediaforge --manager` and a new "Downloads" home item open a full-screen, keyboard-driven list of every download, with sorting, search, filters, batch actions, limit keys, the session notice banner and a flash when the browser asks for attention.

**Architecture:** The core learns each client's kind from `hello`, sends terminal clients the whole history, and answers a new `app.open` by pushing `app.attention` to manager clients. In the exe, pure modules hold the table rules (`manager/model.ts`) and the action rules (`manager/actions.ts`). A `useCoreSession` hook owns one core connection with reconnect and folds pushes into a job map that is rendered at most 4 times a second. `ManagerScreen` draws its own full-width layout (not `Frame`) from those pieces. Add link reuses the existing wizard and batch flow, then submits with `origin: "manager"` and returns.

**Tech Stack:** TypeScript (Node 24, ESM), zod 4 (in `shared-protocol` only), vitest, Ink 8 + React 19, ink-testing-library, Biome, pnpm workspaces.

**Spec:** [docs/superpowers/specs/2026-10-15-downloads-manager-design.md](../specs/2026-10-15-downloads-manager-design.md), sections Protocol (`hello.client`, uncapped terminal snapshot, `app.open`, `app.attention`, `app.opened`), Manager TUI (all but Mouse), Desktop changes (`--manager`, `attention.ts`). Phase 3 is split in three plans: 3a (done: units, bandwidth), **3b** (this one), 3c (mouse, including the conhost spike, `y`/`Y` copy and the Shift+drag note). `open-terminal.ts` and the popup are phase 4.

## Decisions taken in this plan

G1 to G9 were confirmed by the user on 2026-10-16 and 2026-10-17. G10 to G24 are this plan's recommended answers; change any of them before execution starts.

| #              | Question                                       | This plan does                                                                                                                                                                                                                                                                          | Why                                                                                              |
| -------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| G1 (confirmed) | `app.open` scope                               | The core handles `app.open` and pushes `app.attention` to manager clients; the manager flashes and shows the banner. With no manager connected the reply is `{ mode: "no-terminal" }` until phase 4 adds the launch.                                                                    | Keeps 3b smaller; launch is tested with the popup.                                               |
| G2 (confirmed) | Lost core                                      | A manager-level `useCoreSession` hook: banner "Reconnecting to MediaForge…", actions disabled, retry with autostart every 1 s, then re-subscribe and take the fresh snapshot. `CoreClient` stays one-shot.                                                                              | CLI and menu flows stay unchanged.                                                               |
| G3 (confirmed) | After Add link                                 | Submit with `origin: "manager"`, skip the progress and result screens, return to the table with the cursor on the new row. A multi-link paste goes through the batch flow, also returns, cursor on the first new row.                                                                    | The table already shows progress.                                                                |
| G4 (confirmed) | Esc at the top level                           | Goes to the home menu, also when started with `--manager`. Ctrl+C quits.                                                                                                                                                                                                                | One meaning per key.                                                                             |
| G5 (confirmed) | `L` (per-job override)                         | A small picker panel: High, Med, Low, Custom, None, each with its value in the speed unit (`Med · 5.0 MB/s`). Enter applies to the affected rows, Esc cancels.                                                                                                                         | Shows the values; one request per choice.                                                        |
| G6 (confirmed) | Home menu item                                 | Second item, plain label "Downloads": Download, Downloads, Settings, Setup, About, Quit. No count.                                                                                                                                                                                       | The home screen never joins the core.                                                           |
| G7 (confirmed) | `o` with ticks                                 | Always the cursor row; ticks are ignored.                                                                                                                                                                                                                                                | A batch could open many windows.                                                                 |
| G8 (confirmed) | Very narrow terminal                           | After Last try, ETA and Speed drop, Name shrinks to 10 columns; below that, lines are cut at the right edge.                                                                                                                                                                             | Never blocks the user.                                                                           |
| G9 (confirmed) | Dismiss key (the spec mock's `x` clashes)      | `z` dismisses the notice (only while the banner shows); `x` stays Remove. Banner: `R resume all · z dismiss`.                                                                                                                                                                           | User's choice.                                                                                   |
| G10            | Snapshot size for terminal clients             | Terminal connections send and receive frames up to `MAX_EXTENSION_MESSAGE_BYTES` (64 MiB). Their `jobs.snapshot` has no 200-job limit; it is trimmed from the oldest end only past 60,000,000 bytes. Relay connections keep 200 jobs and 900,000 bytes.                                 | Spec: "the full history is sent". The cap still guards against a runaway file.                   |
| G11            | Who gets `app.attention`                       | Clients whose handshake role is `terminal` and whose `hello.client` is `"manager"`. A relay saying `client: "manager"` gets nothing.                                                                                                                                                    | The role is the trusted part (spec, Client trust).                                               |
| G12            | `app.open` and roles                           | Allowed for relay and terminal connections.                                                                                                                                                                                                                                              | The popup sends it through the relay.                                                            |
| G13            | Protocol version                               | `PROTOCOL_VERSION` stays 3. An older core answers `app.open` with `invalid-message`; phase 4 treats that as `no-terminal`.                                                                                                                                                              | Same reasoning as 3a E8.                                                                         |
| G14            | Name before the file exists                    | `startPayload` puts the wizard's title in `candidate.pageTitle` (menu, batch and manager). Name = `basename(outputPath)`, else `pageTitle`, else the URL.                                                                                                                               | Running rows otherwise show only a URL.                                                          |
| G15            | `managerSort` storage                          | In `config.json` only, through `SettingsStore`; not in `ExtensionSettingsSchema`. Shape `{ column: "name" \| "size" \| "status" \| "speed" \| "eta" \| "lastTry", descending: boolean }`, default `{ column: "lastTry", descending: true }`. A bad value falls back to the default. | Terminal-only setting.                                                                           |
| G16            | First press of a sort key                      | Name A→Z, Size largest first, Status in the spec's status order, Speed fastest first, ETA soonest first, Last try newest first. Same key again reverses. Ties: Last try newest first, then id.                                                                                           | The useful end first.                                                                            |
| G17            | `l` and `b`                                    | Sent as `settings.set` (`limitPreset`, `speedUnit`) over the manager's connection, so the core saves and applies them. The header and the app's speed unit follow the `settings.value` reply.                                                                                        | One writer for those fields, applied live.                                                       |
| G18            | Which rows each action applies to              | Pause: queued, downloading, processing. Resume: paused, failed. Cancel: queued, downloading, processing, paused. Remove and Delete: any. Limit override: any but completed and cancelled. Open: completed only. Other rows are skipped and counted.                                       | Mirrors what the core accepts, so skips are known before sending.                               |
| G19            | Confirm texts                                  | See Task 7. Default is No; any key but `y` or `Y` answers No. Delete counts downloads, not files (the protocol job has no file list).                                                                                                                                                   | The client cannot count files.                                                                   |
| G20            | Status line                                    | One line above the key bar, e.g. `Paused 2 · 1 skipped` or `Paused 1 · 1 failed: <first core message>`. Cleared after 5 s or by the next action.                                                                                                                                      | Spec: "the status line says how many were skipped".                                              |
| G21            | Header counts                                  | `12 items`; with a search or filter set, `3 of 12 items`. `2 active` counts queued, downloading and processing rows in the whole list. Unlimited shows as `∞` (`Limit: High (∞)`).                                                                                                    | Matches the spec mock.                                                                           |
| G22            | Last try and ETA text                          | Last try: under 60 s `just now`; today `HH:MM` (24 h); yesterday `yesterday`; same year `Oct 12`; older `Oct 12 2025`. ETA: `m:ss`, from one hour `h:mm:ss`.                                                                                                                          | Matches the mock (`10:42`, `0:39`).                                                              |
| G23            | `--manager` without a terminal                 | `--manager needs a terminal.` on stderr, exit code `Usage`.                                                                                                                                                                                                                            | Same as other interactive-only paths.                                                            |
| G24            | Attention banner                               | `Opened from browser` for 4 s, in the banner row, below the reconnect banner in priority and above the notice.                                                                                                                                                                          | Spec: "for a few seconds".                                                                       |

## Global Constraints

- Platforms: Windows and Linux. No macOS-specific code.
- Byte convention: decimal (×1000); use `formatBytes`, `formatRate`, `formatLimit` from `@mediaforge/shared-types`. Speeds follow the user's speed unit (`useSpeedUnit()`).
- Keys exactly as the spec's Keys table, with G9: `z` dismisses the notice.
- Selection: Space ticks the cursor row, Ctrl+A ticks all visible rows (again to clear). Actions apply to ticked visible rows, or to the cursor row when nothing visible is ticked. Ticks on hidden rows are kept but not acted on.
- Search: case-insensitive substring of the name and the URL; Enter keeps it, Esc clears it.
- Filter: Status (active = downloading or processing, queued, paused, completed, failed, cancelled), Origin (extension, menu, manager, CLI), Last try (today, last 7 days, last 30 days, all), combined with AND. Empty result: `No downloads match. Esc clears the filter.`
- Search and filters are not saved. Sort column and direction are saved (`managerSort`).
- Default sort Last try, newest first. Status order: downloading and processing, queued, paused, failed, cancelled, completed. Rows with no value in the sort column sort last in both directions.
- Columns: Name (`…` cut, `⏷` marks an override), Size (`sizeBytes`, or `—`), Status (`Queued`, `Downloading N%`, `Processing`, `Paused N%`, `Completed`, `Failed`, `Cancelled`), Speed (live while downloading, `avg …` for completed, `—` otherwise), ETA (downloading only), Last try.
- Columns drop as the terminal narrows: Last try under 100 columns, ETA under 90, Speed under 80.
- The list shows as many rows as fit and scrolls to keep the cursor visible. Pushes update state at once; rendering is throttled to 4 per second.
- Confirm prompts replace the key bar inline. `too-large` gets the second prompt from the spec.
- Connection lost: banner `Reconnecting to MediaForge…`, actions disabled, retry with autostart.
- `app.attention`: flash the window and show `Opened from browser` for a few seconds.
- `attention.ts`: with `WT_SESSION` set, write BEL. Otherwise on Windows, a `powershell -NoProfile` child calling `FlashWindowEx(GetConsoleWindow(), FLASHW_TRAY | FLASHW_TIMERNOFG)`. Linux: write BEL. Flash failures are ignored. The PowerShell script is a constant; nothing is interpolated into it.
- The flash child must share the manager's console (no `detached`, no `-WindowStyle Hidden`, no `CREATE_NEW_CONSOLE`): `GetConsoleWindow()` must return the manager's window, and hiding a shared console hides the manager.
- Repo rules: never run `git commit`. Each task's last step prints a commit message for the user, in the format from `CLAUDE.md`. Run `pnpm exec biome check --write <paths>` on files changed through Bash. Run `pnpm lint` before finishing.

## Review Focus

1. **Rows changing under an open confirm prompt.** A push adds, removes or re-sorts rows while `Cancel 3 downloads? y/N` is shown. `y` acts on the ids captured when the prompt opened, never on whatever row the cursor now points at. Test in Task 7.
2. **A long history (2,000 jobs).** A terminal client gets all 2,000 rows in one snapshot (no 200 cap), and the manager scrolls and sorts them. Tests in Task 2 and Task 6.
3. **The core restarting mid-session.** Ticks survive for rows still present after the reconnect snapshot; a prompt open at the moment of loss closes with `Not connected.`. Tests in Task 5 and Task 7.
4. **Wide and long names (CJK, emoji, 300-character URLs).** Cells are cut by display width (Ink `wrap="truncate-end"` inside fixed-width boxes), so the Size column stays aligned and no line exceeds the terminal width. Test in Task 6.
5. **Repeated action keys.** Pressing `p` twice before the core answers sends one `download.pause`; action keys are ignored while a request is in flight. Test in Task 7.

---

## File Structure

| File                                                               | Status | Responsibility                                                                                     |
| ------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| `packages/shared-protocol/src/messages.ts`                         | Modify | `app.open`, `app.opened`, `app.attention`.                                                         |
| `packages/shared-protocol/src/parse.test.ts`                       | Modify | Tests for the three messages.                                                                      |
| `apps/desktop/src/core/ipc.ts`                                     | Modify | 64 MiB frames for terminal connections, both ends.                                                 |
| `apps/desktop/src/core/service.ts`                                 | Modify | Client kind from `hello`, `app.open`, uncapped terminal snapshot.                                  |
| `apps/desktop/src/core/in-process.ts`                              | Modify | `connectAs(client)`, `dropAll()` for tests.                                                        |
| `apps/desktop/src/core/job-watch.ts`                               | Modify | Export `jobIdOf`.                                                                                  |
| `apps/desktop/src/attention.ts`                                    | Create | `flashWindow`.                                                                                     |
| `apps/desktop/src/settings.ts`                                     | Modify | `managerSort`.                                                                                     |
| `apps/desktop/src/download.ts`                                     | Modify | `candidateFor(url, kind, title?)`.                                                                 |
| `apps/desktop/src/interactive/submit.ts`                           | Create | `startPayload`, `submitPlans`.                                                                     |
| `apps/desktop/src/interactive/manager/model.ts`                    | Create | Row text, sorting, search, filter, columns, scrolling window.                                      |
| `apps/desktop/src/interactive/manager/actions.ts`                  | Create | Applicability, targets, prompt and result texts.                                                   |
| `apps/desktop/src/interactive/manager/session.ts`                  | Create | `foldPush`, `useCoreSession` (reconnect, throttled render).                                        |
| `apps/desktop/src/interactive/manager/Table.tsx`                   | Create | Column header and rows.                                                                            |
| `apps/desktop/src/interactive/manager/FilterPanel.tsx`             | Create | Filter panel.                                                                                      |
| `apps/desktop/src/interactive/manager/DetailPanel.tsx`             | Create | Detail panel.                                                                                      |
| `apps/desktop/src/interactive/manager/LimitPicker.tsx`             | Create | Override picker.                                                                                   |
| `apps/desktop/src/interactive/manager/KeyList.tsx`                 | Create | `?` key list.                                                                                      |
| `apps/desktop/src/interactive/screens/ManagerScreen.tsx`           | Create | The screen: layout, keys, prompts, panels.                                                         |
| `apps/desktop/src/interactive/screens/ManagerScreen.test.tsx`      | Create | Screen tests against `inProcessCore`.                                                              |
| `apps/desktop/src/interactive/App.tsx`                             | Modify | `manager` screen, start screen, Add link return, view memory.                                      |
| `apps/desktop/src/interactive/BatchFlow.tsx`                       | Modify | `onPlans` to hand plans back instead of downloading.                                               |
| `apps/desktop/src/interactive/screens/HomeScreen.tsx`              | Modify | "Downloads" item.                                                                                  |
| `apps/desktop/src/interactive/screens/DownloadScreen.tsx`          | Modify | Use `startPayload`.                                                                                |
| `apps/desktop/src/interactive/screens/batch/BatchDownloadScreen.tsx` | Modify | Use `startPayload`.                                                                              |
| `apps/desktop/src/interactive/deps.ts`                             | Modify | `managerCore`, `flash`.                                                                            |
| `apps/desktop/src/interactive/start.tsx`                           | Modify | Real `managerCore` and `flash`; `startInteractive({ manager })`.                                   |
| `apps/desktop/src/cli.ts`, `apps/desktop/src/main.ts`              | Modify | `--manager`, help text.                                                                            |
| `docs/desktop-cli-checklist.md`                                    | Modify | Manual checks for phase 3b.                                                                        |

---

### Task 1: Protocol messages for attention

**Files:**
- Modify: `packages/shared-protocol/src/messages.ts`
- Test: `packages/shared-protocol/src/parse.test.ts`

**Interfaces:**
- Produces: `AppOpenMessage` (`app.open`, payload `{}`) in `ExtensionToHostMessage`; `AppOpenedMessage` (`app.opened`, payload `{ mode: "attention" | "launched" | "no-terminal" }`) and `AppAttentionMessage` (`app.attention`, payload `{}`) in `HostToExtensionMessage`.

- [ ] **Step 1: Write the failing tests** in `parse.test.ts`, in a `describe("attention messages")`:
  - `parses app.open` — `parseExtensionMessage({ v: PROTOCOL_VERSION, id: "1", type: "app.open", payload: {} })` is ok.
  - `parses app.opened with each mode` — `parseHostMessage` accepts `attention`, `launched`, `no-terminal`; rejects `{ mode: "other" }`.
  - `parses app.attention` — host message with payload `{}` is ok.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared-protocol/src/parse.test.ts` — expect FAIL (unknown type).
- [ ] **Step 3: Add the three schemas** with one-line doc comments and add them to the two unions. The `never` default in `CoreService.#dispatch` then fails to compile: add `case "app.open":` replying `app.opened` `{ mode: "no-terminal" }` (Task 2 makes it real).
- [ ] **Step 4: Run** the same command and `pnpm typecheck` — PASS, clean.
- [ ] **Step 5: Commit message**

```markdown
✨ shared-protocol: add app.open, app.opened and app.attention

## Description

The popup's "Open MediaForge" button needs to ask the core to bring the
downloads manager forward. app.open asks, app.opened says what happened,
and app.attention tells a running manager to flash. The core answers
no-terminal for now.

## Test

pnpm vitest run packages/shared-protocol/src/parse.test.ts
```

---

### Task 2: Core — client kind, `app.open`, whole history for terminals

**Files:**
- Modify: `apps/desktop/src/core/ipc.ts`, `apps/desktop/src/core/service.ts`, `apps/desktop/src/core/in-process.ts`
- Test: `apps/desktop/src/core/ipc.test.ts`, `apps/desktop/src/core/service.test.ts`

**Interfaces:**
- Consumes: Task 1 messages.
- Produces:
  - `inProcessCore(...)` returns `{ connect, connectAs(client: JobOrigin): CoreConnector, dropAll(): void, service }`. `connect` stays `connectAs("cli")`. `dropAll()` closes every open in-process connection (both ends see a close).
  - Service behavior: `hello` stores `payload.client` on the client state; `app.open` replies `app.opened`.

- [ ] **Step 1: Write the failing service tests** in `service.test.ts`:
  - `app.open pushes app.attention to terminal manager clients and replies attention` — attach a terminal client, send `hello` with `client: "manager"`, then from a second client send `app.open`; the manager client receives `app.attention`, the sender gets `app.opened` `{ mode: "attention" }`.
  - `app.open replies no-terminal without a manager` — only a `menu` client is attached; reply `{ mode: "no-terminal" }`, nothing pushed.
  - `a relay client calling itself manager gets no attention` — relay role, `hello` `client: "manager"`; `app.open` from another client replies `no-terminal` and the relay receives no `app.attention`.
  - `a manager that has not said hello gets no attention` — terminal client attached but silent: `no-terminal`.
  - `terminal clients get the whole history in jobs.list` — seed 300 history rows; a terminal client's `jobs.list` has 300 jobs; a relay client's has 200.
  - `terminal snapshots hold 2000 jobs` (Review Focus 2) — seed 2000 small rows; terminal `jobs.list` length 2000.
- [ ] **Step 2: Write the failing IPC test** in `ipc.test.ts`: `terminal connections carry frames over 1 MiB` — through a real `listenCore`/`connectCore` pair with role `terminal`, the core sends a 2 MiB message and the client receives it; with role `relay` the same send throws (the existing over-cap behavior).
- [ ] **Step 3: Run** `pnpm vitest run apps/desktop/src/core/service.test.ts apps/desktop/src/core/ipc.test.ts` — FAIL.
- [ ] **Step 4: Implement.**
  - `ipc.ts`: the server's `wrapSocket` gets `maxSendBytes: MAX_EXTENSION_MESSAGE_BYTES` when the handshake role is `terminal`; `connectCore` uses `maxReceiveBytes: MAX_EXTENSION_MESSAGE_BYTES` for role `terminal`, else `MAX_HOST_MESSAGE_BYTES`.
  - `service.ts`: `ClientState.kind?: JobOrigin`, set in the `hello` case (not `host.info`). `#snapshot(requestId, role)`: relay keeps `SNAPSHOT_LIMIT` (200) and `SNAPSHOT_MAX_BYTES`; terminal uses no count limit and `TERMINAL_SNAPSHOT_MAX_BYTES = 60_000_000`. `#pushSnapshot` passes each client's role. `case "app.open"`: every client with `active && role === "terminal" && kind === "manager"` gets `app.attention`; reply `app.opened` `{ mode: any ? "attention" : "no-terminal" }`.
  - `in-process.ts`: `connectAs(client)` passes `client` to `openCoreClient`; keep a set of open connections for `dropAll()`.
- [ ] **Step 5: Run** the tests — PASS. `pnpm typecheck` — clean.
- [ ] **Step 6: Commit message**

```markdown
✨ desktop: answer app.open and send terminals the whole history

## Description

The downloads manager lists every job, but terminal clients still got
the browser's 200-job, 1 MiB snapshot. Terminal connections now carry
frames up to 64 MiB and their snapshots are uncapped (trimmed only past
60 MB).

The core remembers which kind of client said hello. app.open pushes
app.attention to managers on terminal connections and replies
attention, or no-terminal when none is open; launching a new window
comes with the popup in phase 4. A relay calling itself a manager is
ignored.

## Test

pnpm vitest run apps/desktop/src/core
```

---

### Task 3: Window flash helper

**Files:**
- Create: `apps/desktop/src/attention.ts`
- Test: `apps/desktop/src/attention.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FlashDeps {
    platform: NodeJS.Platform;
    env: Record<string, string | undefined>;
    /** Writes to the terminal (BEL). */
    write: (text: string) => void;
    /** Starts a process sharing this console; returns nothing, must not throw. */
    spawn: (command: string, args: string[]) => void;
  }
  export const FLASH_SCRIPT: string;
  export function flashWindow(deps?: Partial<FlashDeps>): void;
  ```

- [ ] **Step 1: Write the failing tests:**
  - `writes BEL on Linux` — platform `linux`: `write` called with `"\x07"`, `spawn` not called.
  - `writes BEL in Windows Terminal` — `win32`, `env.WT_SESSION = "x"`: BEL, no spawn.
  - `flashes the console window in conhost` — `win32`, no `WT_SESSION`: `spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", FLASH_SCRIPT])`, no write.
  - `the script is constant and does not hide the window` — `FLASH_SCRIPT` contains `FlashWindowEx`, `GetConsoleWindow` and the flags value `14` (`FLASHW_TRAY` 2 | `FLASHW_TIMERNOFG` 12); does not contain `-WindowStyle` or `Hidden`.
  - `never throws` — `spawn` and `write` that throw: `flashWindow` returns normally.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/attention.test.ts` — FAIL.
- [ ] **Step 3: Implement.** The script: `Add-Type` a C# class with `[DllImport("kernel32.dll")] GetConsoleWindow()` and `[DllImport("user32.dll")] FlashWindowEx(ref FLASHWINFO)`, then flash with `dwFlags = 14`, `uCount = 0`, `dwTimeout = 0`. The default `spawn` uses `child_process.spawn(command, args, { stdio: "ignore" })` with an `error` listener and `unref()`; no `detached`, no `windowsHide`. The default `write` is `process.stdout.write`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit message**

```markdown
✨ desktop: flash the terminal window on request

## Description

When the browser asks for the downloads manager and one is already
open, it should draw the user's eye. Windows Terminal and Linux
terminals mark the window on BEL; the classic console needs
FlashWindowEx, called from a PowerShell child that shares the console
so GetConsoleWindow finds the manager's window. Failures are ignored.

## Test

pnpm vitest run apps/desktop/src/attention.test.ts
```

---

### Task 4: Table rules and the saved sort

**Files:**
- Create: `apps/desktop/src/interactive/manager/model.ts`
- Modify: `apps/desktop/src/settings.ts`
- Test: `apps/desktop/src/interactive/manager/model.test.ts`, `apps/desktop/src/settings.test.ts`

**Interfaces:**
- Produces (in `settings.ts`):
  ```ts
  export const SORT_COLUMNS = ["name", "size", "status", "speed", "eta", "lastTry"] as const;
  export type SortColumn = (typeof SORT_COLUMNS)[number];
  export interface ManagerSort { column: SortColumn; descending: boolean }
  // Settings gains: managerSort: ManagerSort  (default { column: "lastTry", descending: true })
  ```
- Produces (in `model.ts`):
  ```ts
  export type StatusFilter = "active" | "queued" | "paused" | "completed" | "failed" | "cancelled";
  export type LastTryFilter = "today" | "7d" | "30d" | "all";
  export interface Filters { statuses: StatusFilter[]; origins: JobOrigin[]; lastTry: LastTryFilter }
  export const NO_FILTERS: Filters; // { statuses: [], origins: [], lastTry: "all" }
  export type Column = "name" | "size" | "status" | "speed" | "eta" | "lastTry";
  export const COLUMN_WIDTH: Record<Exclude<Column, "name">, number>; // size 9, status 17, speed 12, eta 8, lastTry 10
  export const MIN_NAME_WIDTH = 10;
  export function rowName(job: DownloadJob): string;               // basename(outputPath) ?? pageTitle ?? url
  export function statusText(job: DownloadJob): string;
  export function sizeText(job: DownloadJob): string;              // formatBytes(sizeBytes ?? progress.totalBytes) or "—"
  export function speedText(job: DownloadJob, unit: SpeedUnit): string;
  export function etaText(job: DownloadJob): string;
  export function lastTryText(at: number | undefined, now: number): string;
  export function sortJobs(jobs: DownloadJob[], sort: ManagerSort): DownloadJob[];
  export function nextSort(current: ManagerSort, column: SortColumn): ManagerSort;
  export function matchesSearch(job: DownloadJob, query: string): boolean;
  export function matchesFilters(job: DownloadJob, filters: Filters, now: number): boolean;
  export function hasFilters(filters: Filters): boolean;
  export function filterSummary(filters: Filters): string;          // "Paused, Extension, 7 days"; "" when none
  export function visibleColumns(width: number): Column[];
  export function nameWidth(width: number, columns: Column[]): number; // max(MIN_NAME_WIDTH, width - checkbox(4) - cursor(1) - other widths)
  export function scrollWindow(cursor: number, total: number, size: number, top: number): number; // new top
  ```
  `lastTryText` uses local time. "Today" and "yesterday" are local calendar days. Filters measure "today" from local midnight, and 7 and 30 days from `now`.

- [ ] **Step 1: Write the failing settings tests:**
  - `managerSort defaults to last try, newest first`.
  - `a bad managerSort falls back to the default` — `{ column: "colour", descending: true }`, `"x"`, `{ column: "size" }` (missing boolean) each load as the default; `{ column: "size", descending: false }` loads as is.
- [ ] **Step 2: Write the failing model tests**, each with the spec's values:
  - `rowName prefers the file name, then the title, then the URL`.
  - `rowName marks an override` — `limitOverride: "low"` gives a name ending in ` ⏷`.
  - `statusText` — `Downloading 42%` from `overallPercent: 42.7` (floor), falls back to `progress.percent`; `Paused 71%`; `Queued`, `Processing`, `Completed`, `Failed`, `Cancelled`; `Downloading` with no percent shows `Downloading 0%`.
  - `speedText` — downloading `6.1 MB/s` (bytes) and `48.8 Mbps` (bits) for 6_100_000 B/s; completed `avg 4.0 MB/s`; paused `—`.
  - `etaText` — `0:39`, `59:59`, `1:00:00`; `—` when not downloading or no `etaSec`.
  - `lastTryText` — 30 s ago `just now`; today 10:42 `10:42`; yesterday `yesterday`; Oct 12 same year `Oct 12`; Oct 12 2025 from 2026 `Oct 12 2025`; undefined `—`.
  - `sorts by last try newest first by default`.
  - `status order is active, queued, paused, failed, cancelled, completed`.
  - `rows without a value sort last in both directions` — size with one `sizeBytes` missing: last ascending and descending.
  - `ties break on last try then id`.
  - `nextSort` — new column gets its first direction (G16: name ascending, size/speed/lastTry descending, eta ascending, status in status order = ascending); same column flips `descending`.
  - `search matches name and URL case-insensitively`.
  - `filters combine with AND` — status paused + origin extension excludes a paused CLI job; `active` matches downloading and processing.
  - `last try filter` — `today` excludes yesterday; `7d` includes 6 days ago, excludes 8.
  - `filterSummary` — `"Paused, Extension, 7 days"`.
  - `visibleColumns drops last try, ETA, speed as the terminal narrows` — 120: all six; 99: no lastTry; 89: no eta; 79: name, size, status.
  - `nameWidth never goes under 10` — width 30.
  - `scrollWindow keeps the cursor visible` — moving past the bottom shifts top; moving above top sets top to cursor; total smaller than size gives 0.
- [ ] **Step 3: Run** `pnpm vitest run apps/desktop/src/interactive/manager/model.test.ts apps/desktop/src/settings.test.ts` — FAIL.
- [ ] **Step 4: Implement** `managerSort` in `Settings`, `DEFAULT_SETTINGS`, `sanitizeSettings` and the memory store copy; then `model.ts`. Sorting uses a comparator per column on extracted values (`undefined` = missing, always last), then the G16 ties.
- [ ] **Step 5: Run** — PASS; `pnpm typecheck` clean (update existing `Settings` literals in tests with `managerSort`).
- [ ] **Step 6: Commit message**

```markdown
✨ desktop: add the downloads table rules and a saved sort

## Description

The manager needs one place that says how a job reads in each column,
how rows sort, search and filter, and which columns fit. Sorting puts
rows without a value last in both directions and breaks ties on the
last try. The sort column and direction are saved in config.json as
managerSort; a bad value falls back to last try, newest first.

## Test

pnpm vitest run apps/desktop/src/interactive/manager apps/desktop/src/settings.test.ts
```

---

### Task 5: Core session with reconnect

**Files:**
- Create: `apps/desktop/src/interactive/manager/session.ts`
- Modify: `apps/desktop/src/core/job-watch.ts` (export `jobIdOf`)
- Test: `apps/desktop/src/interactive/manager/session.test.ts`

**Interfaces:**
- Consumes: `CoreConnector`, `CoreClient`, `applyFrame` (job-watch), `inProcessCore().connectAs/dropAll` (Task 2).
- Produces:
  ```ts
  export const RENDER_INTERVAL_MS = 250;
  export const RECONNECT_MS = 1000;
  export type Jobs = ReadonlyMap<string, DownloadJob>;
  /** Fold one push into the job map; returns the same map when nothing changed. */
  export function foldPush(jobs: Jobs, message: HostToExtensionMessage): Jobs;
  export interface CoreSession {
    state: "connecting" | "ready" | "reconnecting";
    jobs: Jobs;
    notice: Notice | undefined;
    settings: ExtensionSettings | undefined;
    /** Rejects with CoreLostError when not connected. */
    request: CoreClient["request"];
  }
  export function useCoreSession(
    connect: CoreConnector,
    options?: { onAttention?: () => void; renderMs?: number; retryMs?: number },
  ): CoreSession;
  ```
  On each connection: `jobs.subscribe`, `jobs.list` (replaces the map), `settings.get`; `notice` from `client.ack.notice`. Pushes: `jobs.snapshot` replaces; `download.*` frames go through `applyFrame` (an id not in the map is ignored until the next snapshot); `notice` sets or clears; `settings.value` replaces `settings`; `app.attention` calls `onAttention`. Pushes write into a ref; a timer every `renderMs` copies the ref into state when it changed. On close: `state: "reconnecting"`, keep the last jobs, retry `connect` every `retryMs` until it works or the hook unmounts. Unmount closes the client.

- [ ] **Step 1: Write the failing tests:**
  - `foldPush replaces the map on a snapshot`.
  - `foldPush applies progress to a known job and ignores unknown ids`.
  - `foldPush returns the same map for unrelated frames` (identity check).
  - `loads jobs, settings and the notice on connect` — render a tiny test component using the hook with `inProcessCore`; after a job is started through another client, the hook's `jobs` holds it with status updates.
  - `renders at most every renderMs` — with `renderMs: 1000`, two progress pushes 10 ms apart produce one render (count renders of the test component between them).
  - `reconnects after the core drops` (Review Focus 3) — `dropAll()`; state becomes `reconnecting`, jobs kept; after the retry the state is `ready` and jobs come from the fresh snapshot.
  - `request rejects while reconnecting` with `CoreLostError`.
  - `calls onAttention on app.attention` — `connectAs("manager")`, another client sends `app.open`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/interactive/manager/session.test.ts` — FAIL.
- [ ] **Step 3: Implement** `foldPush` and `useCoreSession`. A connect failure while `connecting` also moves to `reconnecting` and retries.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit message**

```markdown
✨ desktop: keep a live job list for the downloads manager

## Description

The manager must stay current while the core pushes progress, and
survive the core going away. useCoreSession subscribes, loads the jobs,
the settings and the session notice, folds every push into one job map
and renders at most four times a second. When the core drops it keeps
the last rows, says it is reconnecting and retries every second.

## Test

pnpm vitest run apps/desktop/src/interactive/manager/session.test.ts
```

---

### Task 6: Manager screen — table, cursor, selection, sort, search

**Files:**
- Create: `apps/desktop/src/interactive/manager/Table.tsx`, `apps/desktop/src/interactive/screens/ManagerScreen.tsx`
- Modify: `apps/desktop/src/interactive/deps.ts` (`managerCore: CoreConnector`, `flash: () => void`), `apps/desktop/src/interactive/App.test.tsx` setup (provide both), `apps/desktop/src/interactive/start.tsx` (`managerCore: defaultCoreConnector("manager")`, `flash: () => flashWindow()`)
- Test: `apps/desktop/src/interactive/screens/ManagerScreen.test.tsx`

**Interfaces:**
- Consumes: Tasks 4 and 5.
- Produces:
  ```ts
  export interface ManagerView {
    cursorId?: string;
    ticks: string[];
    search: string;
    filters: Filters;
  }
  export interface ManagerScreenProps {
    onBack: () => void;
    /** Opens the link wizard; the app returns here afterwards. */
    onAdd: () => void;
    onSpeedUnit: (unit: SpeedUnit) => void;
    /** View to restore after the wizard; undefined on first open. */
    view?: ManagerView;
    onView?: (view: ManagerView) => void;
    /** Move the cursor to this job once it appears (after Add link). */
    focusId?: string;
  }
  ```
  Layout, top to bottom: header line; banner row (only when something shows); column header (`[ ]` then labels, with `▼`/`▲` after the sort column); rows; divider `─`; status line; key bar. Header: ` MediaForge · Downloads` left, right `Limit: <Preset> (<formatLimit or ∞>) · <N items | x of N items> · <k active>[ · search: "<q>"][ · filter: <summary>]`. Row: `>` on the cursor row, else space; `[•]` ticked, `[ ]` not; then the visible columns. Each cell is a fixed-width `Box` holding `<Text wrap="truncate-end">`. Key bar: `a Add  p Pause  r Resume  c Cancel  x Remove  Del Delete  / Search  f Filter  l Limit  ? Keys`, cut to what fits at word boundaries, `? Keys` always kept last. Rows fit `rows - fixed lines`; without `rows` (tests), 20.

- [ ] **Step 1: Write the failing screen tests** (ink-testing-library; seed jobs into `inProcessCore` history; `managerCore: core.connectAs("manager")`; wait for the throttled render with `vi.waitFor`):
  - `lists jobs newest last try first` — three rows in that order.
  - `shows the header counts and limit` — `Limit: High (∞) · 3 items · 1 active`.
  - `moves the cursor with arrows, PgDn and End` — `>` on the expected row.
  - `Space ticks the cursor row and Ctrl+A ticks all visible, then clears` — `[•]` counts.
  - `number keys sort and the same key reverses` — `2` sorts by Size largest first with `Size ▼`; `2` again `Size ▲`; the choice is saved in the settings store (`managerSort`).
  - `slash searches name and URL; Enter keeps; Esc clears` — header shows `search: "lec"` and `1 of 3 items`.
  - `shows the empty filter text` — search with no match: `No downloads match. Esc clears the filter.`.
  - `drops columns as the terminal narrows` — set `stdout.columns` to 85: no `Last try`, no `ETA` header; 120: both.
  - `cuts wide names without breaking alignment` (Review Focus 4) — rows: a CJK name of 80 characters, a 300-character ASCII URL, a short ASCII name, each with a different size. The CJK row shows its size and its name cell ends in `…`. On the two ASCII rows and the column header, `line.indexOf(<size text or "Size">)` is the same, and no ASCII line is longer than `columns`.
  - `scrolls 2000 rows and keeps the cursor visible` (Review Focus 2) — End shows the last row with `>`.
  - `shows the reconnect banner and keeps rows` — `dropAll()`: `Reconnecting to MediaForge…`, the rows remain.
  - `Esc goes back when nothing is open` — `onBack` called.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/interactive/screens/ManagerScreen.test.tsx` — FAIL.
- [ ] **Step 3: Implement** `Table.tsx` (pure rendering from rows, columns, widths, cursor index, ticks, top) and `ManagerScreen.tsx` (session, view state, keys for this task). The view is reported through `onView` on every change. Cursor follows `cursorId`; when that row disappears, the cursor keeps its index, clamped. `Esc` order: search field open → clear search; else search or filters set → clear both; else `onBack`.
- [ ] **Step 4: Run** — PASS; `pnpm typecheck`.
- [ ] **Step 5: Commit message**

```markdown
✨ desktop: add the downloads manager table

## Description

A full-width table of every download: name, size, status, speed, ETA
and last try, sorted by number keys (saved), searched with /, scrolled
with the cursor and ticked with Space or Ctrl+A. Columns drop as the
window narrows, and cells are cut by display width so wide names keep
the columns aligned. While the core is away the rows stay and a banner
says it is reconnecting.

## Test

pnpm vitest run apps/desktop/src/interactive/screens/ManagerScreen.test.tsx
```

---

### Task 7: Manager actions, prompts and limit keys

**Files:**
- Create: `apps/desktop/src/interactive/manager/actions.ts`, `apps/desktop/src/interactive/manager/LimitPicker.tsx`
- Modify: `apps/desktop/src/interactive/screens/ManagerScreen.tsx`
- Test: `apps/desktop/src/interactive/manager/actions.test.ts`, `ManagerScreen.test.tsx`

**Interfaces:**
- Produces (`actions.ts`):
  ```ts
  export type Action = "pause" | "resume" | "cancel" | "remove" | "trash" | "limit" | "open";
  export function appliesTo(action: Action, job: DownloadJob): boolean; // G18
  /** Ticked visible rows, else the cursor row. */
  export function targets(visible: DownloadJob[], ticks: ReadonlySet<string>, cursorId?: string): DownloadJob[];
  export interface Split { ids: string[]; skipped: number }
  export function split(action: Action, jobs: DownloadJob[]): Split;
  export function confirmText(action: "cancel" | "remove" | "trash" | "clear", jobs: DownloadJob[]): string | undefined;
  export function tooLargeText(count: number): string;
  export function resultText(verb: string, done: number, skipped: number, failed: { message: string }[]): string;
  export const STATUS_MS = 5000;
  ```
  Texts (G19, G20), `n` is the count with the right plural:
  - cancel: `Cancel 3 downloads? Partial files are deleted. y/N`
  - remove, only when a target is queued, downloading or processing: `Remove 3 downloads? 1 is still running and will be cancelled. y/N`; else `undefined` (no prompt).
  - trash: `Move the files of 3 downloads to the trash? y/N`
  - clear: `Clear 5 finished downloads from the list? Files stay on disk. y/N`
  - too-large: `2 downloads are too large for the Recycle Bin and will be deleted permanently. Delete? y/N`
  - result: `Paused 2`, `Paused 2 · 1 skipped`, `Paused 1 · 1 failed: <first message>`; nothing applicable: `Nothing to pause.` (verbs: Paused/pause, Resumed/resume, Cancelled/cancel, Removed/remove, Moved to the trash/move to the trash, Limit set/limit, Cleared/clear).

- [ ] **Step 1: Write the failing `actions.test.ts`:** `appliesTo` table for every action × status (G18); `targets` prefers ticked visible rows, ignores hidden ticks, falls back to the cursor row; `split` counts skips; every text above with singular and plural (`1 download`).
- [ ] **Step 2: Write the failing screen tests:**
  - `p pauses the cursor row` — a downloading job becomes `Paused`; status line `Paused 1`.
  - `p on ticked rows skips the ones that do not apply` — one downloading, one completed ticked: `Paused 1 · 1 skipped`.
  - `r resumes paused and retries failed`.
  - `c asks first and N keeps the job` — prompt text replaces the key bar; `n` → no request, key bar back.
  - `x removes finished rows without asking; asks for running ones`.
  - `Del moves files to the trash after y` — the fake `trash` dep sees the job's files.
  - `Del asks again for too-large files and sends permanent` — fake trash returns `code: "too-large"` the first time; second prompt text from `tooLargeText(1)`; `y` sends `permanent: true` and the row goes.
  - `C clears finished rows after y`.
  - `o opens the cursor row's folder only` — `openPath` dep called once with the completed row's path although two rows are ticked; on a running row the status line says `Nothing to open.`.
  - `l cycles the global preset` — header goes `High (∞)` → `Med (5.0 MB/s)`; the settings store has `limitPreset: "med"`.
  - `L opens the picker and applies the override` — picker shows `Med · 5.0 MB/s`; Enter on `Low` → row name ends with `⏷`; `None` clears it.
  - `b toggles the speed unit and saves it` — speed text switches to `Mbps`; `onSpeedUnit("bits")` called; store `speedUnit: "bits"`.
  - `a prompt acts on the rows it was opened for` (Review Focus 1) — open `c` on row A, then a new job arrives and sorts above A (cursor index now points at it); `y` cancels A only.
  - `a lost connection closes the prompt` (Review Focus 3) — prompt open, `dropAll()`: prompt gone, status `Not connected.`.
  - `action keys wait for the reply` (Review Focus 5) — wrap `request` to count `download.pause`; `p` `p` quickly: one request.
  - `actions while reconnecting say Not connected` — `p` during `reconnecting`: no request, status `Not connected.`.
- [ ] **Step 3: Run** `pnpm vitest run apps/desktop/src/interactive/manager apps/desktop/src/interactive/screens/ManagerScreen.test.tsx` — FAIL.
- [ ] **Step 4: Implement** `actions.ts`, `LimitPicker.tsx` (uses `Menu`; items in `LIMIT_PRESETS` order then None; `initial` = the cursor row's override or None) and the keys in `ManagerScreen`. A prompt stores `{ action, ids }` when it opens. One in-flight request at a time (`busy` ref); keys that send are ignored while busy. Requests: `download.pause`, `download.resume`, `download.cancel` (one per id, `notify`), `jobs.remove`, `jobs.trash`, `jobs.clearFinished`, `folder.open { jobId }`, `settings.set { limitPreset }` / `{ speedUnit }`, `download.setLimit`. `jobs.result.failed` feeds `resultText`; `too-large` failures open the second prompt with their ids.
- [ ] **Step 5: Run** — PASS.
- [ ] **Step 6: Commit message**

```markdown
✨ desktop: pause, resume, cancel, remove and trash from the manager

## Description

Actions apply to the ticked rows, or to the cursor row, and skip rows
where they do not fit, saying how many. Cancel, trash, clear and
removing running rows ask first; a prompt acts on the rows it was opened
for even if the list moves. Files too large for the Recycle Bin get a
second prompt before being deleted for good. l cycles the global limit,
L picks a per-row override, b switches bytes and bits. Only one request
is in flight at a time.

## Test

pnpm vitest run apps/desktop/src/interactive/manager apps/desktop/src/interactive/screens/ManagerScreen.test.tsx
```

---

### Task 8: Panels, banners and attention

**Files:**
- Create: `apps/desktop/src/interactive/manager/FilterPanel.tsx`, `DetailPanel.tsx`, `KeyList.tsx`
- Modify: `apps/desktop/src/interactive/screens/ManagerScreen.tsx`
- Test: `ManagerScreen.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function FilterPanel(props: { filters: Filters; onChange: (f: Filters) => void; onClose: () => void }): JSX.Element;
  export function DetailPanel(props: { job: DownloadJob; unit: SpeedUnit; limits: Limits; onClose: () => void }): JSX.Element;
  export function KeyList(props: { onClose: () => void }): JSX.Element;
  export const ATTENTION_MS = 4000;
  ```
  Panels replace the table area; the header stays. FilterPanel rows: `Status` options, `Origin` options, `Last try` options (radio); ↑↓ move, Space toggles (Last try picks one), Enter or Esc closes; changes apply live. DetailPanel rows: Name (full), URL, Path (`outputPath` or `—`), Origin, Limit (`Low · 1.0 MB/s` or `None (shares the global limit)`), Status, Error (full text, wrapped). KeyList: every row of the spec's Keys table with G9. Banner priority: reconnecting, then attention, then notice.

- [ ] **Step 1: Write the failing tests:**
  - `f opens the filter panel and filters live` — toggle `Paused`: header `filter: Paused`, only paused rows after closing.
  - `Esc clears search and filters before going back` — with a filter set, Esc clears it (no `onBack`); second Esc calls `onBack`.
  - `Enter shows the detail panel with the full error` — a failed job with a 300-character error shows all of it; Esc closes.
  - `? lists every key` — contains `z` `Dismiss the session notice` and `L` `Set the override`.
  - `shows the session notice banner` — seed a notice (`reason: "unexpected"`, 2 ids): `Previous session ended unexpectedly. 2 downloads were paused.` and `R resume all · z dismiss`.
  - `R resumes the notice jobs` — both become queued or downloading; banner gone once none is paused.
  - `z dismisses the notice` — banner gone; another client's `hello.ack` has no notice.
  - `R and z do nothing without a banner` — no request sent.
  - `app.attention flashes and shows the banner` — another client sends `app.open`: `flash` dep called once; `Opened from browser` shown, gone after `ATTENTION_MS` (fake timers or a short `ATTENTION_MS` override prop).
  - Restarted text: `MediaForge was restarted. 2 downloads were paused.`
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit message**

```markdown
✨ desktop: add filters, details, the key list and banners to the manager

## Description

f opens a status, origin and last-try filter combined with AND; Enter
shows a row's full name, link, path, origin, override and error; ? lists
every key. The session notice shows as a banner with R to resume its
downloads and z to dismiss it. When the browser asks for MediaForge,
the window flashes and the banner says it was opened from the browser.

## Test

pnpm vitest run apps/desktop/src/interactive/screens/ManagerScreen.test.tsx
```

---

### Task 9: Entry points and Add link

**Files:**
- Create: `apps/desktop/src/interactive/submit.ts`
- Modify: `apps/desktop/src/download.ts`, `apps/desktop/src/interactive/App.tsx`, `BatchFlow.tsx`, `screens/HomeScreen.tsx`, `screens/DownloadScreen.tsx`, `screens/batch/BatchDownloadScreen.tsx`, `start.tsx`, `apps/desktop/src/cli.ts`, `apps/desktop/src/main.ts`, `docs/desktop-cli-checklist.md`
- Test: `apps/desktop/src/interactive/submit.test.ts`, `App.test.tsx`, `HomeScreen.test.tsx`, `apps/desktop/src/cli.test.ts`

**Interfaces:**
- Consumes: `ManagerScreen` (Task 6), `jobIdOf` (Task 5).
- Produces:
  ```ts
  // download.ts
  export const candidateFor: (url: string, kind: "video" | "audio", title?: string) => MediaCandidate; // title → pageTitle
  // submit.ts
  export function startPayload(plan: Plan, origin: JobOrigin): StartPayload;
  export function submitPlans(connect: CoreConnector, plans: Plan[], origin: JobOrigin): Promise<{ ids: string[]; errors: string[] }>;
  // BatchFlowProps gains
  onPlans?: (plans: Plan[]) => void; // set: hand the plans back instead of downloading
  // HomeChoice gains "downloads"
  // App
  export function App(props: { deps: AppDeps; start?: "manager" }): JSX.Element;
  // start.tsx
  export function startInteractive(options?: { manager?: boolean }): Promise<ExitCode>;
  // cli.ts RunOptions.interactive
  interactive?: (options?: { manager?: boolean }) => Promise<number>;
  ```
  `startPayload` sets `candidate.pageTitle` only when `plan.title` exists and differs from `plan.url`. `submitPlans` opens one client, sends `download.start` per plan in order, collects ids (`jobIdOf(reply)`) and error messages, then closes it. App: `Screen` gains `{ name: "manager"; focusId?: string }`; a `managerView` ref keeps the `ManagerView` between visits; `addFromManager` ref is set by `onAdd` and cleared when the user backs out to the manager. While it is set, `advance` reaching `download` calls `submitPlans([plan], "manager")` and unwinds to the manager with `focusId` = the first id (errors become a status notice `Could not start: <message>`), and the batch screen gets `onPlans` doing the same for all plans. `start === "manager"` makes the stack `[home, manager]`.

- [ ] **Step 1: Write the failing tests:**
  - `submit.test.ts`: `startPayload carries origin, folder, selector, steps and the title`; `startPayload leaves out a title equal to the URL`; `submitPlans returns ids in order and closes the client` (with `inProcessCore`).
  - `HomeScreen.test.tsx`: `lists Downloads second`.
  - `App.test.tsx`:
    - `Downloads opens the manager and Esc returns home`.
    - `start manager opens the manager first and Esc goes home` (G4).
    - `a adds one link and returns with the cursor on the new row` — settings `SKIP_QUESTIONS`; type URL, Enter: back on the manager, no progress screen, the new row has `>` and origin `manager` in the history.
    - `a with several links goes through the batch flow and returns` — two URLs; after the batch review's download pick, back on the manager with two new rows, cursor on the first.
    - `backing out of the wizard returns to the manager with its view` — search `x` set, `a`, Esc: manager shows `search: "x"`.
    - `the menu download shows the title before the file exists` — the core's job has `request.candidate.pageTitle === "My Test Video"`.
  - `cli.test.ts`: `--manager opens the manager` (interactive called with `{ manager: true }`); `--manager without a terminal fails with Usage` (`--manager needs a terminal.`); `help lists --manager under Options` (`  --manager      Open the downloads manager`).
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/interactive apps/desktop/src/cli.test.ts` — FAIL.
- [ ] **Step 3: Implement.** `DownloadScreen` and `BatchDownloadScreen` switch to `startPayload(plan, "menu")`. `main.ts` passes the options through to `startInteractive`.
- [ ] **Step 4: Add the manual checks** to `docs/desktop-cli-checklist.md` under `## Downloads manager (phase 3b)`: open with `--manager` and from Home; sort and reopen (sort kept); search and filter; pause, resume, cancel, remove, Delete with Recycle Bin restore; a file over the Recycle Bin limit gets the second prompt; `l`, `L`, `b` during a real download; kill the core from Task Manager while the manager is open (banner, then rows come back); run the extension's `app.open` with a manager open and check the flash in conhost, Windows Terminal and one Linux terminal; narrow the window under 80 columns.
- [ ] **Step 5: Run** `pnpm lint && pnpm typecheck && pnpm test` — all clean.
- [ ] **Step 6: Commit message**

```markdown
✨ desktop: open the downloads manager from the menu and --manager

## Description

The manager is reached from a new Downloads item on the home menu and
from mediaforge --manager (listed in --help). Esc goes back to the home
menu either way. Add link runs the usual wizard, or the batch flow for
several links, then submits with origin manager and returns to the
table with the cursor on the new row, keeping the search and filters.
Downloads now carry the looked-up title, so running rows show a name
before the file exists.

## Test

pnpm lint && pnpm typecheck && pnpm test
Manual: docs/desktop-cli-checklist.md, "Downloads manager (phase 3b)"
```
