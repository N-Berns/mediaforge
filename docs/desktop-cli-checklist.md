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
- [x] Runtime packaging: deferred, run via Node for now (`pnpm start`); revisit at release
- [x] Command layout: subcommands `download`, `formats`, `doctor`
- [x] Exit codes: 0 ok, 1 failure, 2 usage, 3 missing tool, 4 network, 5 unsupported site, 6 filesystem, 130 cancelled; errors to stderr

## 2. Binary setup

- [x] Wire `resolveBinary` into the app: bundled dir is `MEDIAFORGE_BIN_DIR`, else `bin/` next to the executable, else repo-root `bin/` when run via Node
- [x] `doctor` command: tool, version, source, path; `--json`; exit 3 if any tool is missing
- [x] Friendly error when a tool is missing (`requireTool`: what was tried, how to fix, exit 3)
- [ ] Release script that downloads pinned yt-dlp and ffmpeg into `bin/` with checksum verification
- [ ] ffmpeg: use an LGPL build and ship its license text
- [ ] Self-update of bundled yt-dlp into a user data dir (deferred) **(decision)**
- [ ] Per-platform release artifacts (Windows, macOS, Linux)

## 3. Download engine

- [x] Build the yt-dlp command line from a `DownloadRequest` (candidate URL, profile, optional exact format); URL after `--`, no shell
- [x] Run yt-dlp as a child process and capture output (UTF-8 forced, both streams parsed)
- [x] Parse yt-dlp progress into `DownloadProgress` (note: resets per stream when video and audio download separately)
- [x] Apply `OutputProfile` post-processing via yt-dlp flags + ffmpeg (merge, transcode, extract audio)
- [x] Output rules: default `~/Downloads/MediaForge`, title-based name, auto-number on collision (" (1)"), never overwrite
- [ ] Cancel a running job and clean up partial files (implemented and unit-tested; real-process cancel via taskkill not yet verified)
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

- [ ] Installer or zip layout (executable, `bin/`, license files)
- [ ] Versioning and changelog
- [ ] README section for desktop CLI usage
