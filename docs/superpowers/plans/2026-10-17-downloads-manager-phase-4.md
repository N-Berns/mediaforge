# Downloads Manager Phase 4 (Extension Popup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The extension popup can open the manager in a terminal, pause, resume, retry and cancel
jobs, pick the bandwidth preset, and show the session notice. Speeds follow the speed unit.

**Architecture:** The core's `app.open` gets a real launch: a new desktop helper
(`open-terminal.ts`) opens `mediaforge --manager` in a new terminal window. The extension
background gains popup commands for the existing protocol requests and keeps the session notice.
The popup model turns that state into rows, banners and the preset choice, and `popup/index.ts`
draws them. No protocol change: every message used here exists at `PROTOCOL_VERSION = 3`.

**Tech Stack:** TypeScript, Node child processes, vitest, WebExtension popup (plain DOM), Biome.

**Spec:** `docs/superpowers/specs/2026-10-15-downloads-manager-design.md`, sections "Extension
popup", "Platform helpers" (`open-terminal.ts`) and "Phases" step 4.

## Decisions (2026-10-17)

These settle the points the spec leaves open or that the user changed. Everything else follows the
spec.

| Topic | Decision |
| --- | --- |
| Job row buttons | Pause on active rows (queued, downloading, processing), resume on paused rows, retry on failed rows, plus cancel on active and paused rows. |
| Cancel confirmation | Cancel asks once inside the popup (`Cancel? Yes / No`) before it sends `download.cancel`, because cancelling deletes the partial files. |
| Windows "Open MediaForge" | Open a new console window, so Windows 11 uses the user's default terminal app and Windows 10 a classic console. No special case for `wt.exe`. |
| Open button place | A new top bar: "MediaForge" on the left, the icon button on the right. |
| Preset selector place | The Settings section: a High / Med / Low / Custom tab row, each tab with its value. Shown only while connected. |
| Repeat clicks | The core remembers a launch for 10 s. Another `app.open` in that time, with no manager connected, replies `launched` without opening a second window. |
| Open feedback | An info banner. "MediaForge is already open." clears after 5 s. The no-terminal banner stays until dismissed, because it holds a command to copy. `launched` shows no banner. |
| Scope from the spec | Open MediaForge button (`app.open`, `attention`, `no-terminal` with a copy button, disabled while not connected), preset selector (writes `limitPreset`; values are edited in the app only), session notice banner with Open MediaForge and dismiss, "Paused N%", speed text in the speed unit. |

### Follow-up decisions (2026-10-18)

| Topic | Decision |
| --- | --- |
| Custom limit in the popup | Only Custom is editable from the popup; High, Med and Low stay app-only. The core lets a relay `settings.set` carry `limits` only when High, Med and Low are unchanged. |
| Custom limit input | A text field under the tabs while Custom is picked, read with `parseRate` in the speed unit; empty means no limit. Saved on Enter or blur; a bad value shows an error under it. |
| Cancelled jobs | Shown as "Cancelled", never as an error. |
| App "Report a problem" | An item in the About screen. Type (App or Extension), description, then send with or without diagnostics (app version and target, OS, tool versions, setup state, last failed download). Same Google Form as the extension; the browser fields say "n/a (app)". |

### Ruling: the Windows launch goes through PowerShell `Start-Process`

The decision says "new console window". Node cannot make one directly: `spawn` with
`detached: true` on Windows gives the child no console (checked on 2026-10-17: the child saw no
TTY). `Start-Process` from a hidden `powershell.exe` does give it one (checked: the child saw a TTY,
120 columns; a missing exe made PowerShell exit 1). The effect is the decision's: a new console
window, in the default terminal app on Windows 11. The path and arguments travel in environment
variables, never in the script text, as the spec requires.

### Not in this phase

- Parallel-part downloads (IDM-style). Dropped for now. If revisited: yt-dlp's
  `--concurrent-fragments` does not speed up YouTube (single-file `https` formats); aria2c is the
  only option that does, at the cost of a fourth managed tool and coarser progress.

## Global Constraints

- Platforms: Windows and Linux. No macOS code paths.
- Every string shown in the popup is untrusted: text nodes only, never `innerHTML`.
- Sizes and speeds use `formatBytes`, `formatRate` and `formatLimit` from `@mediaforge/shared-types`
  (decimal, ×1000). No local formatters.
- Paths and arguments are passed as process arguments or environment variables, never interpolated
  into scripts.
- `speedUnit` missing from settings means `"bytes"`.
- Never run `git commit`. Each task ends by printing a commit message in the repo format
  (gitmoji, scope, `## Description`, `## Test`), with no attribution lines.
- Run `pnpm exec biome check --write <paths>` on files changed through Bash; run `pnpm lint` and
  the package tests before reporting a task done.
- Tests: `pnpm --filter @mediaforge/desktop test` and `pnpm --filter @mediaforge/extension test`.

## Review Focus

1. Two quick clicks on Open MediaForge, before the first manager connects: one window opens.
   Pinned in Task 2.
2. A dev checkout or install path with spaces: the launched manager still gets the right script
   path. Pinned in Task 1 (the script quotes each argument; the values go through the env).
3. The core restarts without a notice (clean session): the old notice banner goes away on the new
   `hello.ack`. Pinned in Task 3.
4. A pause click on a job that finished a moment before: the popup shows the core's message and
   stays usable. Pinned in Task 3.
5. A job finishes while its `Cancel? Yes / No` is showing: the row redraws without the prompt and
   no cancel is sent for a finished job. Pinned in Task 4 (`confirmingCancel` only holds for rows
   that can still cancel) and Task 5.

---

### Task 1: `open-terminal.ts` helper

**Files:**
- Create: `apps/desktop/src/open-terminal.ts`
- Test: `apps/desktop/src/open-terminal.test.ts`

**Interfaces:**
- Consumes: `powershellPath(env)` from `apps/desktop/src/powershell.ts`.
- Produces:
  - `export type OpenResult = "launched" | "no-terminal";`
  - `export function managerCommand(execPath: string, argv1: string | undefined): { command: string; args: string[] }`.
    Same rule as `coreSpawnCommand` in `core/autostart.ts`: through node (`basename` of `execPath`
    is `node` or `node.exe`, case-insensitive) with `argv1` → `{ command: execPath, args: [argv1, "--manager"] }`,
    else `{ command: execPath, args: ["--manager"] }`.
  - `export function linuxTerminalArgs(terminal: string, command: string, args: string[]): string[]`.
  - `export async function openManagerTerminal(overrides?: Partial<OpenTerminalDeps>): Promise<OpenResult>`. Never throws.
  - `export interface OpenTerminalDeps { platform: NodeJS.Platform; env: Record<string, string | undefined>; execPath: string; argv1: string | undefined; run: (command: string, args: string[], env: Record<string, string | undefined>) => Promise<boolean>; }`
    `run` resolves `true` when the launch worked. Default `run`: on Windows, spawn with
    `stdio: "ignore"`, `windowsHide: true`, the given `env`, and resolve `exit code === 0`
    (`false` on `error`). On Linux, spawn with `detached: true`, `stdio: "ignore"`, `unref()`,
    and resolve `true` on the `spawn` event, `false` on `error`.
  - `export const OPEN_SCRIPT: string` (below).

Windows: `run(powershellPath(env), ["-NoProfile", "-NonInteractive", "-Command", OPEN_SCRIPT], { ...env, MEDIAFORGE_OPEN_FILE: command, MEDIAFORGE_OPEN_ARGS: JSON.stringify(args) })`.
`true` → `"launched"`, `false` → `"no-terminal"`. The script, exactly (the parentheses around
`ConvertFrom-Json` make PowerShell 5.1 enumerate the array; each argument is quoted because
`Start-Process` joins `-ArgumentList` with plain spaces):

```text
try { $a = @((ConvertFrom-Json $env:MEDIAFORGE_OPEN_ARGS) | ForEach-Object { '"' + $_ + '"' }); Start-Process -FilePath $env:MEDIAFORGE_OPEN_FILE -ArgumentList $a -ErrorAction Stop } catch { exit 1 }
```

Linux: candidates in order: `env.TERMINAL` (when set and not empty), `x-terminal-emulator`,
`gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm`. Try each with
`run(terminal, linuxTerminalArgs(terminal, command, args), env)`; the first `true` →
`"launched"`; none → `"no-terminal"`. `linuxTerminalArgs` by the terminal's basename:
`gnome-terminal` → `["--", command, ...args]`; `xfce4-terminal` → `["-x", command, ...args]`;
every other name → `["-e", command, ...args]`.

Any other platform → `"no-terminal"` without running anything.

- [ ] **Step 1: Write the failing tests** in `open-terminal.test.ts`:
  - `managerCommand("C:\\Program Files\\nodejs\\node.exe", "E:\\a b\\main.js")` →
    `{ command: "C:\\Program Files\\nodejs\\node.exe", args: ["E:\\a b\\main.js", "--manager"] }`;
    `managerCommand("C:\\MediaForge\\mediaforge.exe", "x")` → `args: ["--manager"]`.
  - Windows: `run` is called once with the full PowerShell path from `powershellPath`
    (`SystemRoot: "D:\\Win"` → `D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`),
    args `["-NoProfile", "-NonInteractive", "-Command", OPEN_SCRIPT]`, and an env with
    `MEDIAFORGE_OPEN_FILE` = the command and `MEDIAFORGE_OPEN_ARGS` = `JSON.stringify(args)`;
    `OPEN_SCRIPT` contains neither value. Result `"launched"`; with `run` resolving `false`,
    `"no-terminal"`.
  - Linux: with `TERMINAL: "kitty"` and `run` true only for `kitty`, the first call is
    `("kitty", ["-e", command, ...args])` and the result is `"launched"`.
  - Linux without `TERMINAL`: `run` false for all → calls in the order
    `x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, xterm`, result `"no-terminal"`.
  - `linuxTerminalArgs("/usr/bin/gnome-terminal", "mf", ["--manager"])` →
    `["--", "mf", "--manager"]`; `xfce4-terminal` → `["-x", "mf", "--manager"]`;
    `konsole` → `["-e", "mf", "--manager"]`.
  - `platform: "darwin"` → `"no-terminal"`, `run` never called.
  - A `run` that rejects → `"no-terminal"` (Windows) / tries the next terminal (Linux).
- [ ] **Step 2:** Run `pnpm --filter @mediaforge/desktop test -- open-terminal`. Expected: FAIL
  (module not found).
- [ ] **Step 3:** Implement `open-terminal.ts` to the interface above. Doc comments in the style
  of `attention.ts`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Print the commit message (`✨ desktop: open the manager in a new terminal window`).

### Task 2: Core `app.open` launches the manager

**Files:**
- Modify: `apps/desktop/src/core/service.ts` (`CoreServiceDeps`, the `case "app.open"` block)
- Modify: `apps/desktop/src/core/run-core.ts` (`RunCoreDeps`, the `new CoreService({...})` call)
- Test: `apps/desktop/src/core/service.test.ts` (the `describe("app.open and client kinds")` block)

**Interfaces:**
- Consumes: `openManagerTerminal(): Promise<OpenResult>` and `OpenResult` from Task 1.
- Produces:
  - `CoreServiceDeps.openManager?: () => Promise<"launched" | "no-terminal">`. Missing → the core
    replies `no-terminal` (keeps every existing test setup valid).
  - `RunCoreDeps.openManager?: () => Promise<"launched" | "no-terminal">`, default
    `() => openManagerTerminal()`, passed through to `CoreService`.
  - `const LAUNCH_MEMORY_MS = 10_000;` in `service.ts`.

Behavior of `app.open`: any active terminal `manager` client → push `app.attention` to each and
reply `attention` (unchanged; this wins even inside the 10 s window). Otherwise, when a launch
succeeded less than `LAUNCH_MEMORY_MS` ago (by `deps.now()`), reply `launched` without calling
`openManager`. Otherwise call `openManager`; on `launched` remember `now()`; reply with its result.
A rejected `openManager` replies `no-terminal`. A `no-terminal` result is not remembered.

- [ ] **Step 1: Write the failing tests** (fake `now` and a `vi.fn` `openManager`):
  - No manager: `app.open` calls `openManager` once and replies `{ mode: "launched" }`.
  - Two `app.open` 9_999 ms apart: `openManager` called once, both replies `launched`.
    At 10_000 ms after the first: called again.
  - `openManager` resolves `no-terminal`: reply `no-terminal`; a second `app.open` right after
    calls it again.
  - `openManager` rejects: reply `no-terminal`.
  - A manager connects after a launch, inside the window: `app.open` replies `attention` and
    pushes `app.attention`.
  - The existing "app.open replies no-terminal without a manager" test keeps passing with no
    `openManager` dep.
- [ ] **Step 2:** Run `pnpm --filter @mediaforge/desktop test -- service`. Expected: the new tests
  FAIL.
- [ ] **Step 3:** Implement as described. Wire `openManager` in `run-core.ts`.
- [ ] **Step 4:** Run `pnpm --filter @mediaforge/desktop test` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Print the commit message (`✨ desktop: launch the manager when the browser asks for it`).

### Task 3: Background commands and the session notice

**Files:**
- Modify: `apps/extension/src/background/controller.ts`
- Modify: `apps/extension/src/background/index.ts` (the `client.onPush` broadcast condition)
- Test: `apps/extension/src/background/controller.test.ts`

**Interfaces:**
- Consumes: `NativeClient.request`, `NativeClient.onPush` (every frame, including `hello.ack`),
  the `jobs.result` reply (`{ failed: Array<{ jobId, message }> }`), the `app.opened` reply
  (`{ mode }`), `Notice` from `@mediaforge/shared-types`.
- Produces:
  - `PopupState.notice?: Notice`.
  - New `Command` members, all added to `POPUP_KINDS`:
    - `{ kind: "pause"; jobId: string }` → `download.pause` `{ jobIds: [jobId] }`.
    - `{ kind: "resume"; jobId: string }` → `download.resume` `{ jobIds: [jobId] }` (resume and retry).
    - `{ kind: "openApp" }` → `app.open` `{}`.
    - `{ kind: "dismissNotice" }` → `notice.dismiss` `{}`.
  - `setSetting.key` gains `"limitPreset"`.
  - Results: pause and resume return `{ ok: true }` when `failed` is empty, else
    `{ ok: false, message: failed[0].message }`; a rejected request returns
    `{ ok: false, message }`. `openApp` returns `{ ok: true, mode }`, or `{ ok: false, message }`.
    `dismissNotice` clears the kept notice and returns `{ ok: true }`, or `{ ok: false, message }`
    when the request fails (the notice then stays).

Notice tracking in `createController`: on a `hello.ack` push, set the notice to
`payload.notice` (undefined when absent, which clears a stale one). On a `notice` push, set it to
`payload.notice`. `getState` includes `notice` when set. In `index.ts`, also `broadcast()` when
`message.type` is `"notice"` or `"hello.ack"`.

- [ ] **Step 1: Write the failing tests** in `controller.test.ts`, using its existing fake client:
  - `pause` sends `download.pause` with `{ jobIds: ["j1"] }` and returns `{ ok: true }`.
  - `pause` whose reply is `{ failed: [{ jobId: "j1", message: "Only queued or running downloads can be paused." }] }`
    returns `{ ok: false, message: "Only queued or running downloads can be paused." }`.
  - `resume` sends `download.resume` with `{ jobIds: ["j1"] }`.
  - `openApp` returns `{ ok: true, mode: "attention" }` for an `app.opened` reply with that mode.
  - A `hello.ack` push with `notice: { reason: "unexpected", pausedCount: 2, jobIds: ["a", "b"] }`
    puts it in `getState`; a later `hello.ack` without `notice` removes it; a `notice` push with
    `{}` removes it too.
  - `dismissNotice` sends `notice.dismiss` and `getState` no longer has `notice`.
  - `setSetting` with `key: "limitPreset", value: "low"` sends `settings.set` `{ limitPreset: "low" }`.
  - A tab sender (content script) sending `pause` gets `{ ok: false, message: "not allowed" }`.
- [ ] **Step 2:** Run `pnpm --filter @mediaforge/extension test -- controller`. Expected: FAIL.
- [ ] **Step 3:** Implement the commands, the notice tracking and the broadcast condition.
- [ ] **Step 4:** Run `pnpm --filter @mediaforge/extension test`. Expected: PASS.
- [ ] **Step 5:** Print the commit message (`✨ extension: pause, resume and open MediaForge from the popup`).

### Task 4: Popup model

**Files:**
- Modify: `apps/extension/src/popup/model.ts`
- Test: `apps/extension/src/popup/model.test.ts`

**Interfaces:**
- Consumes: `PopupState.notice` (Task 3), `ExtensionSettings.speedUnit`, `.limitPreset`, `.limits`,
  `MirrorJob.speed`, `formatBytes`, `formatRate`, `formatLimit`, `DEFAULT_LIMITS`, `LIMIT_PRESETS`
  from `@mediaforge/shared-types`.
- Produces (Task 5 draws these):
  - `JobRow` gains `canPause: boolean; canResume: boolean; canRetry: boolean; canCancel: boolean;`
    and `speedText?: string`.
    - `canPause`: status `queued`, `downloading` or `processing`.
    - `canResume`: `paused`. `canRetry`: `failed`.
    - `canCancel`: `queued`, `downloading`, `processing` or `paused`.
    - `speedText`: `formatRate(speed, unit)` while `downloading` with a speed; else absent.
  - Status text: a paused row's `percentText` is `Paused 71%` (`Paused` with no percent);
    other rows keep today's text.
  - `PopupModel.openApp: { enabled: boolean; tooltip?: string }`, always set. Enabled for
    `ready` and `setting-up`; else `{ enabled: false, tooltip: "MediaForge is not connected." }`.
    Built before the early `return`s in `buildPopupModel`, so every connection state has it.
  - `PopupModel.notice?: { text: string }`, from `state.notice` while connected:
    - `unexpected`: `MediaForge closed unexpectedly. N downloads were paused.`
    - `restarted`: `MediaForge was restarted. N downloads were paused.`
    - `pausedCount === 1`: `1 download was paused.` in place of `N downloads were paused.`
  - `PopupModel.presets?: { current: LimitPreset; options: Array<{ value: LimitPreset; label: string; detail: string }> }`,
    set when `state.settings` is set (connected). Labels `High`, `Med`, `Low`, `Custom`; `detail`
    is `formatLimit(limits[value], unit)` with `limits` falling back to `DEFAULT_LIMITS` and
    `current` to `"high"`.
  - `export function openResultBanner(mode: "attention" | "launched" | "no-terminal"): OpenBanner | undefined`
    with `export interface OpenBanner { text: string; copy?: string; clearAfterMs?: number }`:
    - `attention` → `{ text: "MediaForge is already open.", clearAfterMs: 5000 }`.
    - `no-terminal` → `{ text: "Could not open a terminal. Run mediaforge --manager.", copy: "mediaforge --manager" }`.
    - `launched` → `undefined`.
  - `export const MANAGER_COMMAND = "mediaforge --manager";` (used by `copy` above).
  - The picker's size detail uses `formatBytes` in place of the local `megabytes`, which is
    removed.

- [ ] **Step 1: Write the failing tests** in `model.test.ts`:
  - A downloading job with `percent: 42, speed: 6_100_000` and `speedUnit: "bits"` →
    `percentText: "42%"`, `speedText: "48.8 Mbps"`; with `"bytes"` or no `speedUnit` → `"6.1 MB/s"`.
  - A paused job with `percent: 71.4` → `percentText: "Paused 71%"`, `canResume: true`,
    `canCancel: true`, `canPause: false`, no `speedText`.
  - A failed job → `canRetry: true`, `canCancel: false`. A completed job → all four false.
  - `processing` → `canPause: true`, `canCancel: true`.
  - `openApp` for `ready` is `{ enabled: true }`; for `not-installed` and `connecting` it is
    `{ enabled: false, tooltip: "MediaForge is not connected." }`.
  - `notice` texts for `unexpected` with 2, `restarted` with 3, and `unexpected` with 1
    (`MediaForge closed unexpectedly. 1 download was paused.`). No `notice` while `connecting`.
  - `presets` with `limitPreset: "med"`, `speedUnit: "bytes"`, default limits →
    `current: "med"`, options `High no limit`, `Med 5.0 MB/s`, `Low 1.0 MB/s`, `Custom no limit`
    (`label` + `detail`).
  - `openResultBanner` for all three modes, exact values above.
  - The picker detail for `approxBytes: 412_000_000` contains `412 MB`.
- [ ] **Step 2:** Run `pnpm --filter @mediaforge/extension test -- model`. Expected: FAIL.
- [ ] **Step 3:** Implement. Update tests that relied on the old `megabytes` output.
- [ ] **Step 4:** Run `pnpm --filter @mediaforge/extension test`. Expected: PASS.
- [ ] **Step 5:** Print the commit message (`✨ extension: model job controls, presets and the notice in the popup`).

### Task 5: Popup view

**Files:**
- Modify: `apps/extension/src/popup/index.ts`
- Modify: `apps/extension/src/popup/popup.css`
- Modify: `docs/superpowers/manual-checklist-extension.md` (new phase 4 section)
- Modify: `docs/desktop-cli-checklist.md` (one line under "Downloads manager (phase 3b)" or a new
  "Extension popup (phase 4)" section: the Windows and Linux launch)

**Interfaces:**
- Consumes: Task 3 commands, Task 4 `PopupModel` fields and `openResultBanner`.
- Produces: no new exports.

What to draw (all with `el`, `icon`, `iconButton`, `guarded`, `segmented`; text nodes only):

- **Top bar**, first node of every render (also the unreachable and not-installed renders): a
  `header` with `MediaForge` and an icon-only button (new icon `open`: a box with an arrow,
  `aria-label` `Open MediaForge`). Disabled when `model.openApp.enabled` is false, with
  `title` = the tooltip. Click → `send({ kind: "openApp" })`; on `{ ok: true, mode }`, set
  `openBanner = openResultBanner(mode)`; on `{ ok: false, message }`, set the existing `notice`.
  An `openBanner` with `clearAfterMs` clears itself with a timer (cancel the old timer when a new
  banner replaces it) and re-renders.
- **Open banner:** info tone, under the top bar. With `copy`, a `Copy` icon button that writes
  `copy` to the clipboard and relabels itself `Copied`, plus a dismiss button (`aria-label`
  `Dismiss`). Without `copy`, no buttons.
- **Session notice banner:** info tone, text `model.notice.text`, an `Open MediaForge` button
  (same action as the top bar) and a dismiss button that sends `dismissNotice` then refreshes.
- **Job rows:** replace today's text `Cancel` button with icon-only buttons in the row end:
  pause (`canPause`), resume (`canResume`, `aria-label` `Resume <title>`), retry (`canRetry`,
  the existing `refresh` icon, `aria-label` `Retry <title>`), cancel (`canCancel`, an `x` icon).
  New icons: `pause` (two bars), `play` (triangle), `x` (two crossing lines). Status text shows
  `percentText`, then ` · speedText` when set. Failed rows keep the `Error` link beside the retry
  button. The progress bar stays on active rows.
- **Cancel confirm:** a module-level `confirmingCancel: string | undefined` (job id). Cancel sets
  it and re-renders; the row end then shows `Cancel?` with `Yes` and `No` buttons. `Yes` sends
  `{ kind: "cancel", jobId }` and clears it; `No` clears it. On every render, clear it when the
  job is gone or its `canCancel` is false.
- **Preset selector:** in Settings, after the toggles, when `model.presets` is set: a field
  `Speed limit` with `segmented("Speed limit", ...)`, each tab label `${label} ${detail}`.
  A pick → `setting("limitPreset", value)`.
- **CSS:** the top bar (flex, title left, button right, bottom border in the existing border
  token), icon-only button sizing reuses `.icon-only`, the confirm row inline. Keep the existing
  tokens; no new colors.
- Re-render rule: include `openBanner` and `confirmingCancel` in the `render` key, so a change to
  either redraws.

- [ ] **Step 1:** Implement the view.
- [ ] **Step 2:** Run `pnpm --filter @mediaforge/extension test`, `pnpm typecheck`,
  `pnpm --filter @mediaforge/extension build`. Expected: all PASS, `dist/firefox` rebuilt.
- [ ] **Step 3:** Add the manual checks to `docs/superpowers/manual-checklist-extension.md`
  (unticked): open button with no manager (new window, Windows 10 console and Windows 11 default
  terminal, one Linux terminal), with a manager open (flash, "already open" banner gone after
  5 s), two fast clicks (one window), disabled with tooltip when the app is closed, no-terminal
  copy button (Linux without a terminal), pause / resume / retry / cancel with its confirm,
  "Paused N%", speed in bits after `b` in the manager, preset change shows in the manager header,
  notice banner after killing the core with a download running, dismiss clears it in the manager
  too.
- [ ] **Step 4:** Run `pnpm lint`. Expected: no findings.
- [ ] **Step 5:** Print the commit message (`✨ extension: add job controls, the preset selector and the open button to the popup`).
