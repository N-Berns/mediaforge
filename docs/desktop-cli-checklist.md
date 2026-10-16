# Desktop CLI checklist

Progress tracker for the desktop CLI in `apps/desktop`. Tick a box only when the item is done and verified (typecheck, tests, lint, or a manual run).

Scope: the standalone desktop CLI only. Browser-extension integration (native messaging host, host installation) is out of scope here and belongs in its own checklist when that work starts.

Items marked **(decision)** have open questions. Per `CLAUDE.md`, ask before building them.

## 0. Already in place

- [x] Shared types used by the CLI: `DownloadRequest`, `DownloadProgress`, `DownloadJob`, `OutputProfile` (`packages/shared-types`)
- [x] Output profiles (`packages/media-profiles`)
- [x] Binary resolver: env override, then PATH (ffmpeg >= 5.0), then bundled `bin/` (`packages/binary-resolver`)
- [x] Resolver verified on a real machine: PATH, bundled fallback, env override, bad override

## 1. App skeleton

- [x] Create `apps/desktop` package (`package.json`, `tsconfig.json`, entry point)
- [x] Add it to root `tsconfig.json` references (and `apps/*` to vitest projects)
- [x] Argument parser: `node:util` `parseArgs` (no dependency)
- [x] Runtime packaging: single-file binary per platform built with `@yao-pkg/pkg` (see `docs/releasing.md`); `pnpm start` still runs via Node
- [x] Command layout: subcommands `download`, `formats`, `doctor`
- [x] Exit codes: 0 ok, 1 failure, 2 usage, 3 missing tool, 4 network, 5 unsupported site, 6 filesystem, 130 cancelled; errors to stderr

## 2. Binary setup

- [x] Wire `resolveBinary` into the app: bundled dir is `MEDIAFORGE_BIN_DIR`, else `bin/` next to the executable, else repo-root `bin/` when run via Node
- [x] `doctor` command: tool, version, source, path; `--json`; exit 3 if any tool is missing
- [x] Friendly error when a tool is missing (`requireTool`: what was tried, how to fix, exit 3)
- [x] Tools are downloaded on demand from upstream with SHA-256 verification into a per-user cache (`mediaforge setup`, `mediaforge update`); not bundled in the release
- [x] ffmpeg: LGPL build pinned for Windows and Linux; macOS is not supported (see `tools.lock.json` and the README)
- [x] Self-update of yt-dlp into the user data dir (`mediaforge update`, nightly channel)
- [x] Per-platform release artifacts: win-x64, linux-x64, linux-arm64

## 3. Download engine

- [x] Build the yt-dlp command line from a `DownloadRequest` (candidate URL, profile, optional exact format); URL after `--`, no shell
- [x] Run yt-dlp as a child process and capture output (UTF-8 forced, both streams parsed)
- [x] Parse yt-dlp progress into `DownloadProgress` (note: resets per stream when video and audio download separately)
- [x] Apply `OutputProfile` post-processing via yt-dlp flags + ffmpeg (merge, transcode, extract audio)
- [x] Output rules: default `~/Downloads/MediaForge`, title-based name, auto-number on collision (" (1)"), never overwrite
- [x] Cancel a running job and clean up partial files (unit-tested; real-process cancel via taskkill verified by hand)
- [x] Job model using `DownloadJob` statuses (queued, downloading, processing, completed, failed, cancelled)
- [x] Queue with a limit of 2 parallel jobs (`DEFAULT_MAX_CONCURRENT`)
- [x] Error mapping: network, unsupported site, missing tool, filesystem (disk full, permissions)

## 4. Standalone CLI mode

- [x] `download <url>` command with a plain http(s) URL (one URL per run); prints the saved path on stdout, Ctrl+C cancels (exit 130)
- [x] Profile selection: `-p, --profile` (default `best`), help lists profiles
- [x] Quality: chosen by profile; `formats <url>` lists what yt-dlp finds (informational, no per-format selection by decision)
- [x] Progress on stderr: one live line on a TTY, one line per status change otherwise, `-q` hides it (live TTY line unit-tested only)
- [x] `-o, --output` directory option, plus `--filename`
- [x] Defaults: env vars `MEDIAFORGE_PROFILE`, `MEDIAFORGE_OUTPUT_DIR` (flags win)

### Interactive mode (the main user experience)

Running `mediaforge` with no arguments in a terminal opens a full-screen app. The flag commands above stay for scripting. Built with Ink (React for terminals); `pnpm build` bundles it to `apps/desktop/dist/main.js`, run with `node dist/main.js`.

- [x] Full-screen app on the terminal's alternate screen: one screen at a time, replaced in place (no growing log), terminal restored on exit
- [x] Consistent layout: title bar with version, breadcrumb, icon + heading, key-hint bar; plain Unicode icons that the default cmd fonts can draw
- [x] Home: Download media, Settings, Check setup, Quit (number keys jump)
- [x] Link step: one or more links. "Use the link(s) from the clipboard" (shows the link, or the sites when there are several), or type/paste into one box; links can be separated by spaces, new lines or commas; a live list under the box shows each link with its site and what is skipped; Ctrl+V also reads the clipboard; a multi-line paste in the classic console does not submit early
- [x] Bulk download (several links, any mix of sites), chosen automatically when more than one link is given:
  - [x] Lookup of all links (3 at a time) with per-link result; failed lookups can be retried or downloaded without details
  - [x] One quality for all: type, then a preset that works on any site (Best / up to 1080p / up to 720p; m4a / MP3)
  - [x] Review screen: each link with its site and quality; select a link to give it its own type and specific format; warns when a link cannot give the chosen type
  - [x] Folder once for the batch; type subfolders per link
  - [x] Download screen: Overall bar for the batch, one row per link (title, bar, state), scrolls; Esc cancels all
  - [x] Result: saved files and failures (reason + hint); retry only the failed links, open folder, download more
- [x] Footer: key hints on the left, version on the right; a blank line between the logo and the breadcrumb
- [x] Details lookup: title, channel and length shown on an info card before choosing quality; on failure shows the reason, a hint, and "Download anyway"
- [x] Type step: Video with audio / Video only / Audio only (kinds the link lacks are greyed out), then that type's yt-dlp formats in yt-dlp's own ranking, the top row marked "Auto" (what yt-dlp would pick), all columns aligned, HLS streams flagged (scrolls); audio also offers MP3. Without link details, a plain profile menu is shown instead
- [x] Folder step: default folder or type/paste another
- [x] Type folders: files go into `Video`, `Video only` or `Audio` inside the chosen folder (also for `mediaforge download`); on by default, switch off in Settings ("Sort into folders by type")
- [x] Download screen: an "Overall" bar (cyan, weighted by size, merge/convert as the last slice) with bytes, speed and ETA, and below it one coloured bar per step (Video, Audio, Download, Merge, Convert), waiting steps grey, finished ones green. Steps are planned from the chosen format and corrected as yt-dlp runs; merge/convert show real ffmpeg progress (read from ffmpeg `-progress`). Esc or Ctrl+C cancels
- [x] Result screen: success card (file, size, folder) with Open folder / Download another; failure shows the error and a what-to-try hint, with Try again / Choose a different quality / Use a different link
- [x] Settings: default folder, default quality, per-setting "ask each time / use the default", sort into type folders, downloads at once (1-4, default 2, for several links), reset (with confirmation). Saved as JSON in the OS config folder (Windows: `%APPDATA%\MediaForge\config.json`)
- [x] Folder picker like VS Code's open-folder box, for the default folder and the download-time folder step: one path box with live folder suggestions (Tab completes, Enter chooses, Ctrl+N creates), Windows drive completion, hidden folders once the name starts with `.` or `$`, per-OS paste tip
- [x] Bulk type step in three sections; a choice applies only to links that can give that type, leftovers are asked again
- [x] Supported-sites link on the link screen, in unsupported-site errors (app and CLI) and on About
- [x] Esc is a real back stack (single and bulk flows); Esc on Home asks to quit; a cancelled download returns to the page before it
- [x] About page: version, build, settings file, tools, developer, notices
- [x] Verify the folder browser, per-type bulk step, Esc stack and About by hand in a real terminal
- [x] Check setup screen: each tool with version, source and path, or how to fix it
- [x] Saved settings also apply to `mediaforge download`: flags > env vars > saved settings > built-in
- [x] Non-terminal runs (pipes, scripts) print help instead of waiting for input
- [x] Esc goes back on every screen; Ctrl+C quits (or cancels while downloading)
- [x] Verified by hand in a real interactive terminal (arrow keys, Ctrl+V, live progress bar, resize, Ctrl+C during download)

## 5. Quality

- [x] Unit tests for command-line building, progress parsing, settings, and the interactive flow
- [x] Manual end-to-end test: real downloads of a test URL (merged video, mp3, auto-numbering, `formats`)
- [x] `pnpm typecheck`, `pnpm test`, `pnpm exec biome check .` all clean (as of the last change)

## 6. Release

- [x] Single-file binary per platform, installers (install.sh, install.ps1) and SHA256SUMS
- [x] Versioning from the git tag; release notes are GitHub's generated notes
- [x] README section for desktop CLI usage
- [x] Code signing: decided against it (no paid certificates for a hobby project). macOS support dropped; Windows ships unsigned and the README explains SmartScreen and hash checks
- [x] Manage a Deno download so YouTube works without a separate JavaScript runtime (pinned in `tools.lock.json` via `pnpm pin:deno`; `mediaforge setup` fetches it; optional for `doctor` and downloads; yt-dlp gets `--js-runtimes deno:<path>`; `update` leaves it alone)
- [x] Self-update of MediaForge: check at startup (notice on Home) and on About with an "Update to ..." button, plus `mediaforge self-update`; stable releases only, SHA-256 checked, restart afterwards
- [ ] winget and Scoop packages (Homebrew dropped with macOS)

## Downloads in the core (downloads manager phase 1)

- [ ] `mediaforge download <url>` with no core running starts one, downloads, prints the path, exits 0.
- [ ] Ctrl+C during `mediaforge download` prints "Cancelled." and exits with the cancelled code.
- [ ] A menu download keeps going after quitting the menu with Ctrl+C on the home screen; the file appears.
- [ ] `history.json` sits beside `config.json` and lists the CLI, menu and extension downloads with their origin.
- [ ] Kill the core in Task Manager (Windows) or with `kill -9` (Linux) during a download. Start the browser popup: the job shows as paused, and `history.json` has a notice with reason "unexpected".
- [ ] Replace `history.json` with `{broken`. Start the core: `history.json.bak` holds the broken text and a new list starts.
- [ ] Change "Downloads at once" in Settings while three downloads are queued: the new limit applies without restarting the core.
- [ ] An older extension against this exe shows the "update" state rather than errors.
- [ ] Press Esc on the menu download screen before the background service has answered: the download is cancelled and never starts.
- [ ] `mediaforge download <url>` with the background service unreachable fails within about 10 seconds with "Could not start or reach the MediaForge background service." and exit code 1.

## Job control (downloads manager phase 2)

Phase 2 has no buttons yet: send the requests with a small script through `CoreClient` (terminal role), or wait for the manager in phase 3.

- [ ] Pause a large real download: yt-dlp stops, `.mediaforge-<id>` keeps its `.part` file, the row is paused.
- [ ] Resume it: the same id continues from the partial file (the byte count does not restart at 0).
- [ ] Kill the core during a download, start it again, resume the paused job: it continues in the same folder with the same format.
- [ ] A failed download (pull the network cable) keeps its partial file; resume retries and continues.
- [ ] Cancel a paused job: its `.mediaforge-<id>` folder is gone.
- [ ] Remove a completed job: the row goes, the file stays.
- [ ] Trash a completed job on Windows: the file is in the Recycle Bin and restores to its folder.
- [ ] Trash a file that is open in a video player on Windows: the job is reported as failed, the row stays, no dialog appears.
- [ ] Trash a file on a USB stick or network drive on Windows: refused with "no Recycle Bin"; the file stays.
- [ ] Trash a completed job on Linux: the file is in the desktop's Trash and restores to its folder.
- [ ] Trash a file on another mount on Linux: it lands in that mount's `.Trash-<uid>` and the file manager's Trash shows it.
- [ ] Dismiss the notice: `history.json` has no `notice`, and a new popup or terminal does not see it.
- [ ] Resume every job a notice named: the notice clears by itself.
- [ ] Pause a `mediaforge download` job from another client: the CLI prints the paused hint and exits 130.
- [ ] Trash a file larger than the drive's Recycle Bin size on Windows, without confirmation: refused with code `too-large` and "too large for the Recycle Bin; it would be deleted permanently"; the file and its row stay.
- [ ] Send `jobs.trash` again for that job with `permanent: true`: the file is deleted for good (not in the Recycle Bin) and the row is dropped.
- [ ] With "Don't move files to the Recycle Bin" set for a drive on Windows, trash a file there: refused; the file stays.
- [ ] Trash a file reached through a junction that points to another drive or a network share on Windows: checked against the real drive (refused for a share); never deleted for good.
- [ ] Resume a paused download that needed browser cookies after restarting the core: it runs without them (it may fail on login-only sites; start it again from the browser).

## Speed unit and bandwidth (downloads manager phase 3a)

- [ ] Sizes in the menu, the download screen, About and `mediaforge formats` read kB/MB/GB (×1000); a 5 MiB file reads 5.2 MB.
- [ ] Set Speed unit to Mbps: the menu download screen and the `mediaforge download` progress line show Mbps.
- [ ] Set the Bandwidth limit to Low (1.0 MB/s) during one large real download: within about 3 s the speed drops to about 1 MB/s, the screen never shows Paused, and the byte count keeps growing from where it was.
- [ ] Start a second download with Low still active: both settle near 0.5 MB/s.
- [ ] Set the limit back to High: both speed up within about 3 s.
- [ ] Edit Custom to `40 Mbps` with the unit on MB/s: it saves as 5.0 MB/s. Edit it to empty: it shows "no limit".
- [ ] Change the preset while a download is merging (Processing): the merge is not interrupted.
- [ ] Put `"limits": { "med": -5 }` in config.json by hand: Settings shows Med at 5.0 MB/s and the other values are kept.

## Downloads manager (phase 3b)

- [ ] `mediaforge --manager` opens the Downloads table; Esc goes to the home menu. Home → Downloads opens it too. `mediaforge --manager | more` (no terminal) prints `--manager needs a terminal.`
- [ ] Press `2` (Size), quit, reopen: the table is still sorted by Size.
- [ ] `/` with part of a title narrows the list and the header shows `search: "…"` and `x of N items`; `f` → Paused shows only paused rows; Esc clears both.
- [ ] On a large real download: `p` pauses it, `r` resumes it from where it was, `c` then `y` cancels it.
- [ ] `x` on a finished row removes it without asking (the file stays on disk); on a running row it asks first.
- [ ] `Del` then `y` on a finished row: the file is in the Recycle Bin (Windows) or the Trash (Linux) and can be restored.
- [ ] `Del` on a file larger than the Recycle Bin allows: a second prompt says it will be deleted permanently; `y` deletes it.
- [ ] During a real download: `l` cycles the header limit (High, Med, Low, Custom) and the speed follows within about 3 s; `L` → Low marks the row with `⏷`; `b` switches every speed to Mbps.
- [ ] `a` with one link returns to the table with the cursor on the new row; `a` with two links (batch) returns with both rows.
- [ ] Kill the core in Task Manager while the manager is open: the banner says `Reconnecting to MediaForge…`, the rows stay, and they come back live once the core restarts.
- [ ] With a manager open, send `app.open` from the extension (or a test client): the window flashes and `Opened from browser` shows for a few seconds. Check in conhost, Windows Terminal and one Linux terminal.
- [ ] Kill the core during a download, reopen the manager: the notice banner shows; `R` resumes the paused downloads, `z` dismisses the notice.
- [ ] Narrow the window under 80 columns: Last try, ETA and Speed drop; the rows still fit on one line each.
