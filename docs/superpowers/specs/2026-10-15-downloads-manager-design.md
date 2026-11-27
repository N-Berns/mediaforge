# Downloads manager

Status: draft for review. Date: 2026-10-15. Builds on
[2026-10-13-extension-core-architecture-design.md](2026-10-13-extension-core-architecture-design.md)
(core and relay) and [2026-10-14-browser-extension-design.md](2026-10-14-browser-extension-design.md)
(extension). Windows and Linux.

## Goal

One list of every MediaForge download, wherever it started (extension, interactive menu, CLI), shown
in a sortable, searchable terminal UI inside `mediaforge.exe`. The user can pause, resume, retry,
cancel, remove and delete downloads from it, alone or in batches, and limit bandwidth. The extension
popup gains pause and resume, a bandwidth preset selector, and a button that opens the manager.

## Decisions already made

| Topic | Decision |
| --- | --- |
| Platforms | Windows and Linux. macOS is not supported. |
| Job owner | The background core runs every download. The interactive menu, the manager and `mediaforge download` are clients of the core. |
| Pause vs cancel | Pause keeps partial files and is resumable. Cancel removes them and is final. |
| Resume | Resumes paused jobs and retries failed jobs under the same id and settings. |
| What is listed | Every download made through MediaForge: extension, interactive menu, manager, CLI. |
| Persistence | `history.json`, written only by the core. Rows stay until the user removes them. |
| Interrupted jobs | Jobs active or queued when the core stopped come back as `paused`. Nothing auto-resumes. A notice says the session ended and how many were paused. |
| Notifications | In-app only: manager banner and extension popup banner. No OS toasts. |
| Delete from disk | Moves files to the Recycle Bin (Windows) or the freedesktop Trash (Linux) after a confirm prompt. Files too large for the Recycle Bin are refused with a warning; on a second confirmation (`permanent: true`) they are deleted for good. |
| Add link | Reuses the existing link, quality and folder wizard, then returns to the table. |
| Home menu download flow | Keeps the progress and result screens; they watch the core's job. |
| CLI Ctrl+C | `mediaforge download` Ctrl+C cancels the job, as today. |
| Entry point | `mediaforge --manager` opens the manager. Listed under Options in `--help`. Home menu gets a "Downloads" item. |
| Popup open button | "Open MediaForge" opens the manager in a new terminal window. If a manager is already open, it flashes for attention instead (best effort). |
| Popup job controls | Pause, resume and retry per job row. |
| Search and filter | `/` text search on name and URL. A filter panel with status, origin and last-try range, combined with AND. |
| Remembered view | Sort column and direction are saved. Search and filters reset each session. |
| Bandwidth limit | One global preset (High, Med, Low, Custom), split evenly across running jobs. Per-job overrides sit outside the global cap. Defaults: High unlimited, Med 5 MB/s, Low 1 MB/s; all four values are editable. Default preset High. |
| Limit controls | Settings screen, manager keys, and a preset selector in the popup. |
| Mouse | The whole interactive app accepts mouse input. Text selection uses Shift+drag. |
| Speed unit | User picks bytes or bits per second. Applies to the exe and the popup. Toggle in Settings and with `b` in the manager. |
| Byte convention | Decimal (×1000) for sizes and speeds: kB, MB, GB, TB, PB and kbps, Mbps, Gbps, Tbps, Pbps. |
| Client trust | The IPC handshake carries a connection role: `relay` or `terminal`. The relay sets it in code, so frames from a page or extension cannot change it. A missing role means `relay`. Relay connections keep today's rules; terminal connections may also send any output folder, a raw format selector and step plans. |
| Concurrency | "Downloads at once" applies live: the core re-reads it on its settings poll and on `settings.reload`. Running jobs are never stopped. |
| Protocol | `PROTOCOL_VERSION` is bumped. An older extension with the new exe shows the existing "incompatible" state. |

## Architecture

```text
extension ──relay──┐
manager (TUI) ─────┼── named pipe / socket ──► core ──► DownloadEngine ──► yt-dlp
interactive menu ──┤                            │
mediaforge download┘                            └──► history.json
```

TUI means text user interface: a full-screen app drawn in a terminal, like the existing interactive
menu.

- **Core.** Sole owner of jobs and of `history.json`. On start it loads the history, reads
  `cleanExit`, turns every `queued`, `downloading` or `processing` row into `paused`, and records a
  session notice when any were turned. It writes `cleanExit: false` once started and `true` on a
  normal shutdown.
- **Engine.** Gains `pause(id)`, `resume(id)` and `setRate(id, bytesPerSec | undefined)`. Pause stops
  yt-dlp, keeps the job's work folder and sets status `paused`. Resume queues the same job id again
  with its saved request; yt-dlp's `--continue` picks up the partial files. Cancel on a paused job
  removes the work folder. `setRate` passes `--limit-rate` on the next start (see Bandwidth).
- **Clients.** A shared `CoreClient` connects over the existing IPC channel (autostarting the core
  when needed), sends `hello`, correlates requests, subscribes to job events and reconnects.
  Closing a terminal no longer stops its downloads; only Ctrl+C in `mediaforge download` cancels.
- **Idle exit.** The core stays alive while any client is connected or any job is active. Paused
  jobs do not keep it alive.

## Bandwidth

Settings:

```ts
limitPreset: "high" | "med" | "low" | "custom";      // default "high"
limits: {                                            // bytes per second; null = unlimited
  high: number | null;                               // default null
  med: number | null;                                // default 5_000_000
  low: number | null;                                // default 1_000_000
  custom: number | null;                             // default null
};
```

- **Global split.** The active preset's value G is divided evenly across running jobs that have no
  override: each gets `floor(G / n)`. Unlimited means no `--limit-rate`.
- **Per-job override.** A job may carry `limitOverride: "high" | "med" | "low" | "custom"`. It uses
  that preset's value as its own cap and is not counted in the global split, so the total can exceed
  the global value.
- **Applying changes.** yt-dlp cannot change its rate while running. When a running job's cap
  changes (preset change, override change, a job starting or finishing), the core restarts it with
  the new `--limit-rate` (pause, then resume; no data is lost). Restarts are debounced by 3 s so a
  burst of changes restarts each job once. Jobs in `processing` (ffmpeg) are not limited or
  restarted.
- Values are stored in bytes per second. The UI shows and accepts them in the chosen speed unit.

## Protocol

`hello` gains `client: "extension" | "manager" | "menu" | "cli"`. The core uses it to:

- send `app.attention` only to `manager` clients;
- lift the 1 MiB browser cap on `jobs.snapshot` for terminal clients (the full history is sent;
  the extension keeps the newest jobs that fit).

`DownloadStatus` gains `paused`. `download.start` gains `origin` (same values as `client`), and for
terminal connections only, `formatSelector` and `plan` (planned steps). Relay connections that send
them get `forbidden`. `download.progress` gains optional `steps` and `overallPercent`;
`download.failed` gains optional `errorKind` (the CLI exit code). `DownloadJob` gains optional
`origin`, `lastTryAt`, `sizeBytes`, `avgSpeed`, `steps`, `overallPercent` and `errorKind`.
`ExtensionSettingsSchema` gains `speedUnit`, `limitPreset` and `limits`, so `settings.get`,
`settings.set` and `settings.value` carry them to and from the popup.

### Requests (client to core)

| Type | Payload | Effect |
| --- | --- | --- |
| `download.pause` | `{ jobIds: string[] }` | Stops yt-dlp, keeps partial files, status `paused`. |
| `download.resume` | `{ jobIds: string[] }` | Queues paused or failed jobs again under the same ids. Other statuses are reported as failures. |
| `download.setLimit` | `{ jobIds: string[], preset: Preset \| null }` | Sets or clears the per-job override. |
| `jobs.remove` | `{ jobIds: string[] }` | Cancels active ones, then drops the rows. Files stay on disk. |
| `jobs.trash` | `{ jobIds: string[], permanent?: boolean }` | Cancels active ones, moves every recorded file of each job to the trash, drops the rows. A file too large for the Recycle Bin fails with code `too-large` unless `permanent` is true, which deletes it for good. |
| `jobs.clearFinished` | `{}` | Drops every `completed` row. |
| `notice.dismiss` | `{}` | Clears the session notice for every client. |
| `settings.reload` | `{}` | Terminal only. Re-reads the settings file and applies "downloads at once". |
| `app.open` | `{}` | Sends `app.attention` to connected manager clients, or launches `mediaforge --manager` in a new terminal window. |

Batch requests reply once, listing per-id failures: `{ failed: Array<{ jobId, message }> }`.

### Pushes and replies (core to client)

| Type | Payload | When |
| --- | --- | --- |
| `download.paused` | `{ jobId }` | A job was paused by a user (not by a limit restart). |
| `app.attention` | `{}` | Pushed to manager clients on `app.open`. |
| `app.opened` | `{ mode: "attention" \| "launched" \| "no-terminal" }` | Reply to `app.open`. |
| `notice` | `{ notice?: Notice }` | Pushed when the notice is dismissed or no paused jobs from it remain. |

`hello.ack` gains `notice?: Notice`, where
`Notice = { reason: "unexpected" | "restarted"; pausedCount: number; jobIds: string[] }`.
`unexpected` means the last session had no clean exit; `restarted` means it exited cleanly with
jobs still active (for example a self-update).

### Path safety

`jobs.trash` takes job ids, never paths. The core deletes only paths in that job's `files` list,
the same rule `folder.open` follows. An unknown id is reported as a failure, not an error frame.

## History

File: `history.json` beside the settings file (`config.json`).

```ts
interface HistoryFile {
  version: 1;
  cleanExit: boolean;
  notice?: Notice;
  jobs: HistoryJob[];
}

interface HistoryJob extends DownloadJob {
  origin: "extension" | "manager" | "menu" | "cli";
  /** Set on each start or resume. */
  lastTryAt: number;
  /** Final size, or the expected size while running. */
  sizeBytes?: number;
  /** Average speed of the finished download, in bytes per second. */
  avgSpeed?: number;
  /** Folder holding partial files; kept while paused or failed. */
  workDir?: string;
  /** Every file the job wrote: output, subtitles. The only paths `jobs.trash` touches. */
  files: string[];
  limitOverride?: "high" | "med" | "low" | "custom";
}
```

`request` already carries URL, profile, format selector and output folder, so resume needs nothing
more.

- Writes are atomic (temp file, then rename) and debounced to about 1 s. Progress ticks are not
  written; status changes are.
- A file that fails to parse is renamed `history.json.bak` and the core starts with an empty list.
- A `version` newer than the core knows is left untouched and the core runs without history,
  logging why.

## Manager TUI

```text
 MediaForge · Downloads                  Limit: High (∞) · 12 items · 2 active · filter: Paused
 ┌ Previous session ended unexpectedly. 2 downloads were paused. ─ R resume all · x dismiss ┐
  [ ] Name                          Size     Status          Speed      ETA    Last try ▼
  [•] Big Buck Bunny 1080p.mp4      412 MB   Downloading 42%  6.1 MB/s   0:39   just now
  [ ] Lecture 07 - Graphs.m4a       58 MB    Paused 71%       —          —      10:42
 >[ ] Trailer.webm                  23 MB    Completed        avg 4 MB/s —      yesterday
  [ ] some-page                     —        Failed           —          —      Oct 12
 ─────────────────────────────────────────────────────────────────────────────────────────
  a Add  p Pause  r Resume  c Cancel  x Remove  Del Delete  / Search  f Filter  l Limit  ? Keys
```

The key bar shows what fits; `?` lists every key.

### Selection

Space ticks the cursor row, Ctrl+A ticks all visible rows (again to clear). Actions apply to ticked
rows, or to the cursor row when nothing is ticked. Rows where an action does not apply are skipped,
and the status line says how many were skipped. Ticks on rows hidden by a filter are kept but not
acted on.

### Keys

| Key | Action |
| --- | --- |
| ↑ ↓ PgUp PgDn Home End | Move the cursor. |
| Space, Ctrl+A | Tick row, tick all visible. |
| `a` | Add link: the existing wizard, then back here with the cursor on the new row. |
| `p` | Pause. |
| `r` | Resume paused, retry failed. |
| `c` | Cancel, after a confirm. |
| `x` | Remove from list. Confirm only when an affected row is active. |
| `Del` | Move files to the trash, after a confirm. |
| `C` | Clear finished rows, after a confirm. |
| `o` | Open the job's folder. |
| `/` | Search: type to filter by name and URL; Enter keeps it, Esc clears it. |
| `f` | Filter panel. |
| `l` | Cycle the global preset: High, Med, Low, Custom. |
| `L` | Set the override on the affected rows: High, Med, Low, Custom, or none. |
| `b` | Toggle speed unit (bytes, bits) and save it. |
| `Enter` | Detail panel: full name, URL, path, origin, override, full error text. Esc closes it. |
| `1`–`6` | Sort by Name, Size, Status, Speed, ETA, Last try. Same key again reverses. |
| `R` | Resume all jobs named in the notice (only while the banner shows). |
| `?` | Key list. |
| `Esc` | Close the open panel or prompt; else clear search and filters; else back to home. Ctrl+C quits. |

Confirm prompts replace the key bar inline, for example `Move 3 files to the trash? y/N`. When the core answers `too-large`, a second prompt follows: `2 files are too large for the Recycle Bin and will be deleted permanently. Delete? y/N`.

### Search and filter

- Search matches case-insensitive substrings of the name and the URL.
- The filter panel has three fields, combined with AND:
  - Status: any of active (downloading, processing), queued, paused, completed, failed, cancelled.
  - Origin: any of extension, menu, manager, CLI.
  - Last try: today, last 7 days, last 30 days, all.
- The header shows the active search and filters. Empty results show "No downloads match. Esc
  clears the filter."
- Search and filters are not saved. Sort column and direction are saved to settings
  (`managerSort`).

### Columns and sorting

| Column | Content |
| --- | --- |
| Name | Output file name, else title, else URL. Cut with `…`. A `⏷` mark shows a per-job override. |
| Size | `sizeBytes`, or `—`. |
| Status | Queued, Downloading N%, Processing, Paused N%, Completed, Failed, Cancelled. |
| Speed | Live speed while downloading; `avg` speed for completed rows; `—` otherwise. |
| ETA | While downloading only. |
| Last try | `just now`, clock time today, `yesterday`, else a short date. |

- Default sort: Last try, newest first.
- Status order: downloading and processing, queued, paused, failed, cancelled, completed.
- Rows with no value in the sort column sort last in both directions.

### Layout

- Columns drop as the terminal narrows: Last try under 100 columns, ETA under 90, Speed under 80.
- The list shows as many rows as fit and scrolls to keep the cursor visible.
- Pushes update state at once; rendering is throttled to 4 per second.

### Mouse

Every key action stays; the mouse is an extra way in.

| Mouse action | Effect |
| --- | --- |
| Click a row | Moves the cursor to it. |
| Click a row's `[ ]` box | Ticks or unticks it. |
| Shift+click a box | Ticks every row from the last ticked one to this one. |
| Double-click a row | Opens the detail panel. |
| Click a column header | Sorts by it; a second click reverses. |
| Click a key-bar word | Runs that action (`Pause`, `Resume`, `Delete`…). |
| Click `y` or `N` in a prompt | Answers the confirm. |
| Click a field or option in a panel | Focuses or toggles it (filter panel, detail panel). |
| Wheel | Scrolls the list by 3 rows. |

### States and errors

- Connection lost: banner "Reconnecting to MediaForge…", actions disabled, the client retries with
  autostart.
- A failed action (for example a locked file during trash) shows in the status line; the row stays.
- `app.attention`: the window flashes and the banner shows "Opened from browser" for a few seconds.

## Mouse input (whole interactive app)

### Mechanism

- **Enable.** On entering the alternate screen, `start.tsx` turns on mouse reporting with SGR
  encoding (`ESC[?1000h ESC[?1006h`: press, release, wheel). It turns it off on exit, on Ctrl+C,
  on crash and before handing the terminal to any child process. The alternate screen means mouse
  coordinates map straight to Ink's layout, with row 1 at the top.
- **Input filter.** A stream between `process.stdin` and Ink strips SGR mouse sequences out, so
  `useInput` never sees them, and sends them as events to a `MouseProvider`.
- **Hit testing.** `useClickable(ref, handlers)` registers an element. After each render it reads
  the element's absolute box from Ink's Yoga layout (its own offset plus every parent's). The
  provider sends each event to the last-registered element under the pointer, so open panels and
  prompts win over the list behind them.
- **Double-click.** Two presses on the same cell within 400 ms.
- **Text selection.** Capture is always on. The `?` key list and the About screen say that
  Shift+drag selects text in Windows Terminal and most Linux terminals. The manager detail panel
  gets `y` to copy the URL and `Y` to copy the path.

### Shared components

| Component | Mouse behavior |
| --- | --- |
| `Menu` | Click highlights an item; double-click picks it (same as Enter). Wheel moves the highlight. |
| `TextField` | Click focuses the field. |
| `PathPickerScreen` | Click highlights a folder; double-click opens it. |
| `Frame` footer hints | Clicking a hint (`Esc back`, `Enter select`…) runs it. |
| Manager | See Manager TUI, Mouse. |

Screens built on these components get mouse support without screen-specific code, except where a
screen draws its own interactive parts.

### Feasibility spike

Phase 3 starts with a spike: confirm that the classic Windows console (conhost) delivers SGR mouse
sequences to Node in raw mode. Windows Terminal and Linux terminals do. If conhost does not, the
mouse works in Windows Terminal and on Linux only, and conhost stays keyboard-only, with no other
change to this design.

## Units

New in `shared-types`, used by the exe and the popup:

- `formatBytes(bytes)`: B, kB, MB, GB, TB, PB in ×1000 steps.
- `formatRate(bytesPerSec, unit)`: with `bytes`, B/s to PB/s; with `bits`, bps, kbps, Mbps, Gbps,
  Tbps, Pbps, all in ×1000 steps.
- `parseRate(text, unit)`: reads user input such as `5`, `5 MB/s`, `40 Mbps` for the Custom limit
  and preset editing; a bare number uses the current unit's M prefix.
- Both formatters pick the largest unit whose value is at least 1. One decimal under 100, none from
  100 up (`6.1 MB/s`, `48.8 Mbps`, `120 Mbps`). Whole bytes and bits show no decimal.

The existing `formatBytes` in `apps/desktop/src/progress-view.ts` (×1024, labeled KB) is replaced;
all its callers switch to decimal sizes.

Setting `speedUnit: "bytes" | "bits"`, default `bytes`.

## Extension popup

- **Open MediaForge:** an icon button in the header sends `app.open`. On `attention` the popup shows
  "MediaForge is already open". On `no-terminal` it shows "Could not open a terminal. Run
  `mediaforge --manager`." with a copy button. Disabled with a tooltip when the app is not
  connected.
- **Job controls:** each job row gets pause (active), resume (paused) or retry (failed) icon
  buttons, sending `download.pause` or `download.resume`.
- **Bandwidth:** a preset selector (High, Med, Low, Custom) showing each value in the speed unit.
  It writes `limitPreset` through `settings.set`. Preset values are edited in the exe only.
- **Session notice:** banner "MediaForge closed unexpectedly. N downloads were paused." (or
  "MediaForge was restarted…" for `restarted`), with "Open MediaForge" and a dismiss button
  (`notice.dismiss`).
- **Paused jobs** show "Paused N%".
- **Speed text** follows `speedUnit`.

## Desktop changes

- `apps/desktop/src/core/client.ts`: `CoreClient` (connect with autostart, hello, request, subscribe,
  reconnect).
- `mediaforge download` submits to the core with `origin: "cli"` and draws progress from pushes.
  Ctrl+C sends `download.cancel`. Exit codes come from the job's `errorKind`, unchanged for scripts.
- The home menu download flow and the batch flow submit through `CoreClient` with `origin: "menu"`.
  `DownloadScreen` and `ResultScreen` watch the job by id.
- The engine runs only in the core; the CLI-side `DownloadDeps.createEngine` is removed.
- `run()` accepts `--manager`; `--help` lists it under Options.
- Settings screen: speed unit, global preset, and the four preset values (entered with `parseRate`).

### Platform helpers

Each helper has a Windows and a Linux implementation behind one interface, chosen by
`process.platform`.

| Helper | Windows | Linux |
| --- | --- | --- |
| `attention.ts` (flash) | With `WT_SESSION` set, write BEL. Otherwise hidden `powershell -NoProfile` with `Add-Type` calling `FlashWindowEx(GetConsoleWindow(), FLASHW_TRAY \| FLASHW_TIMERNOFG)`. | Write BEL (most terminals mark the window urgent). |
| `trash.ts` | One PowerShell call per batch using `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(path, OnlyErrorDialogs, SendToRecycleBin)`. | freedesktop Trash spec in Node: move to `$XDG_DATA_HOME/Trash/files` (default `~/.local/share/Trash`) and write the matching `.trashinfo`. Files on another mount use that mount's `.Trash-$UID`. |
| `open-terminal.ts` | Start `mediaforge.exe --manager` with `CREATE_NEW_CONSOLE`. | Try `$TERMINAL`, `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm`, in that order. None found: `no-terminal`. |

Paths and arguments are passed as process arguments, never interpolated into scripts. Flash
failures are ignored.

## Testing

TDD, matching the current `*.test.ts` layout.

- **History store:** load and save round-trip, atomic write, corrupt file moved to `.bak`, newer
  version left alone, `cleanExit`-based notice and pause on start.
- **Engine:** pause keeps the work folder, resume passes `--continue` with the same id, retry of a
  failed job, cancel after pause removes the partials, `--limit-rate` passed from `setRate`.
- **Bandwidth:** split math, overrides outside the cap, debounced restarts, `processing` jobs left
  alone.
- **Service:** every new message; trash rejects unknown ids and never touches unlisted paths;
  `app.open` picks attention, launch or `no-terminal`; uncapped snapshot for terminal clients only;
  idle rules with paused jobs.
- **Units:** scaling at every boundary for bytes and bits; `parseRate` inputs.
- **Platform helpers:** command and argument construction per platform; Linux trash with a temp
  `XDG_DATA_HOME`.
- **Manager screen** (ink-testing-library): sorting, search, filter panel, selection, batch actions,
  confirms, limit keys, column drops, banner, reconnect state.
- **Mouse:** SGR parser (press, release, wheel, modifiers, split chunks), input filter passes keys
  through untouched, hit testing with nested and overlapping elements, double-click timing, mouse
  reporting turned off on every exit path; `Menu` click and double-click, manager row, box, header,
  key-bar and wheel actions.
- **CLI:** exit codes and Ctrl+C cancel through a fake core.
- **Extension:** open button replies, job controls, preset selector, notice banner, speed unit.
- **Manual checklist** additions: pause and resume of a large real file, limit change during a
  download, flash in conhost, Windows Terminal and one Linux terminal, Recycle Bin and Linux Trash
  restore, crash recovery after killing the core, mouse in conhost, Windows Terminal and one Linux
  terminal, Shift+drag selection, terminal left clean (no mouse reporting) after a crash.

## Phases

Each phase ships on its own.

1. **History and core-owned jobs.** History store, notice on start, `CoreClient`, CLI and menu
   migrated to the core, `client` and `origin` fields, protocol bump.
2. **Job control.** Engine pause, resume and retry, `paused` status, `download.pause`,
   `download.resume`, `jobs.remove`, `jobs.trash` (both platforms), `jobs.clearFinished`,
   `notice.dismiss`.
3. **Manager TUI, units, bandwidth and mouse.** Conhost mouse spike first. `--manager`, the
   Downloads screen with search and filters, `formatBytes`, `formatRate`, `parseRate`,
   `speedUnit`, bandwidth presets and overrides, Settings screen additions, attention flash, mouse
   layer and mouse support in the shared components.
4. **Extension.** Open MediaForge button and terminal launch (both platforms), job controls, preset
   selector, notice banner, speed unit in the popup.

## Out of scope

- Hover effects and drag-and-drop in the TUI.
- OS toast notifications.
- macOS.
- Editing preset values from the popup.
- Per-job priority and scheduling.
