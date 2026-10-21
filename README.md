<p align="center">
  <img src="assets/brand/png/icon-128.png" alt="MediaForge logo" width="96" height="96">
</p>

# MediaForge

Cross-platform media downloader: a browser extension, a desktop app with a background core and CLI, and a planned Android app, built on shared TypeScript packages.

> **Status:** early release (v0.2.0). The desktop app (CLI, interactive menu and downloads manager) is available as a download for Windows and Linux. The browser extension (Firefox first, Chromium builds from the same code) and the native messaging relay are built but not yet released, and the installer does not register them; for now you build the extension and register the native host yourself (see [Browser extension](#browser-extension-development)). The Android app is planned: `apps/android` is an empty placeholder.

## How it works

The CLI and the interactive app also run on their own, with no extension.

1. The **extension** detects media on a page (network requests, HLS/DASH manifests, page media elements) and builds `MediaCandidate` objects. It can also ask the core whether the page URL itself is downloadable (`media.probe`).
2. The user picks an item from the toolbar popup or an in-page button, optionally a quality, and the extension sends `download.start` (with the page's Referer, User-Agent and cookies, taken at click time) over browser native messaging.
3. A short-lived **relay** (`mediaforge --native-host`) started by the browser forwards messages to the long-lived background **core** (`mediaforge --core`), starting it if needed.
4. The core owns downloading with yt-dlp and ffmpeg, the job queue, history, bandwidth limits and settings. It reports progress back to the extension and to the desktop app, so the popup, the menu and the manager (`mediaforge --manager`) show the same jobs.

## Repository layout

| Path                       | Package                       | Purpose                                                                                                                |
| -------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/shared-types`    | `@mediaforge/shared-types`    | Domain types: media candidates, variants, download requests and progress, output profiles. Types only.                 |
| `packages/shared-protocol` | `@mediaforge/shared-protocol` | Extension ↔ host wire protocol: Zod schemas, message envelopes, native-messaging framing, parsing, `PROTOCOL_VERSION`. |
| `packages/extension-core`  | `@mediaforge/extension-core`  | Browser-agnostic detection logic: MIME/extension classification, candidate creation, URL de-duplication.               |
| `packages/media-profiles`  | `@mediaforge/media-profiles`  | Built-in output profiles and variant selection.                                                                        |
| `packages/binary-resolver` | `@mediaforge/binary-resolver` | Finds the `yt-dlp` and `ffmpeg` executables (env override, `PATH`, bundled `bin/`, managed cache; for yt-dlp the managed cache comes right after the env override) and downloads them. |
| `apps/desktop`             | `@mediaforge/desktop`         | One `mediaforge` program: CLI, interactive menu and downloads manager (Ink), background core, native-messaging relay. Downloads with yt-dlp and ffmpeg. |
| `apps/extension`           | `@mediaforge/extension`       | Browser extension (background, popup, in-page overlay). Builds for Firefox and Chromium with esbuild.                  |
| `apps/android`             | (planned)                     | Android app. Empty placeholder.                                                                                        |
| `tools/*`                  | (scripts)                     | Brand icons, release tooling, and the dev script that registers the native host.                                       |
| `docs/`                    |                               | Specs and plans under `docs/superpowers/`, the CLI checklist, and `docs/releasing.md`.                                 |

Dependency direction: `shared-types` is the base. `shared-protocol` also depends on `zod`. `apps/desktop` uses `shared-types`, `shared-protocol`, `media-profiles`, and `binary-resolver`. `apps/extension` uses `shared-types`, `shared-protocol`, `media-profiles`, and `extension-core`.

## Protocol

Messages are JSON envelopes `{ v, id, type, payload }`, framed for native messaging with a 32-bit little-endian length prefix.

- Extension → host: `hello`, `host.info`, `media.probe`, `download.start` / `cancel` / `pause` / `resume` / `setLimit`, `jobs.list` / `subscribe` / `unsubscribe` / `remove` / `trash` / `clearFinished`, `folder.open`, `settings.get` / `set` / `reload`, `notice.dismiss`, `app.open`.
- Host → extension: `hello.ack`, `jobs.snapshot`, `settings.value`, `setup.progress`, `download.progress` / `completed` / `failed`, and probe and error replies (see `packages/shared-protocol/src/messages.ts` for the full list).
- Native host name: `com.mediaforge.host`.
- Size limits: 1 MB host → extension, 64 MiB extension → host (Chrome limits).
- Bump `PROTOCOL_VERSION` when a message shape changes incompatibly.
- Zod schemas are checked at compile time against the types in `shared-types`, so the two cannot drift apart.

## Install

Windows (PowerShell):

```powershell
irm https://github.com/N-Berns/mediaforge/releases/latest/download/install.ps1 | iex
```

Linux:

```sh
curl -fsSL https://github.com/N-Berns/mediaforge/releases/latest/download/install.sh | sh
```

The installer downloads one `mediaforge` program, checks it against the release's `SHA256SUMS`, puts it in `%LOCALAPPDATA%\MediaForge` (Windows) or `~/.local/bin` (Linux), adds that folder to your PATH, runs `mediaforge setup --yes` to download yt-dlp, ffmpeg and Deno, and then starts MediaForge. It needs no administrator rights and uses no `sudo`. The program is a single file and needs no Node.js.

**These one-line commands run a script from this repository on your computer with your own permissions.** If you prefer to read it first, save it and run it yourself:

```sh
curl -fsSL https://github.com/N-Berns/mediaforge/releases/latest/download/install.sh -o install.sh
less install.sh
sh install.sh
```

```powershell
Invoke-WebRequest https://github.com/N-Berns/mediaforge/releases/latest/download/install.ps1 -OutFile install.ps1
Get-Content install.ps1
./install.ps1
```

If PowerShell refuses with "running scripts is disabled", run `powershell -ExecutionPolicy Bypass -File .\install.ps1` instead (or `Unblock-File .\install.ps1` first).

<!-- TODO: uncomment once the scoop-mediaforge bucket exists and the install is tested.

Windows with [Scoop](https://scoop.sh):

```powershell
scoop bucket add mediaforge https://github.com/N-Berns/scoop-mediaforge
scoop install mediaforge
mediaforge setup
```

Update later with `scoop update mediaforge`. Scoop installs the same program and checks its hash; run `mediaforge setup` once to download yt-dlp, ffmpeg and Deno.
-->

- Skip the tool download with `--skip-tools` (`sh -s -- --skip-tools` when piping) or `-SkipTools` (`& ([scriptblock]::Create((irm <url>))) -SkipTools`).
- Install without starting MediaForge with `--no-launch` (`sh -s -- --no-launch` when piping) or `-NoLaunch`. It also does not start when there is no interactive terminal.
- Pin a version by replacing `latest/download` with `download/vX.Y.Z` in the URL.
- Supported: Windows x64 (Windows on ARM runs it through emulation), Linux x64 and arm64.
- **macOS is not supported.** Apple charges a yearly fee to sign programs for distribution, and this is a hobby project.
- **Windows:** the program is not code-signed (certificates cost money), so SmartScreen or Defender may warn about it. Choose "More info", then "Run anyway" if you trust the source. To check the file first, compare its SHA-256 with the release's `SHA256SUMS`: `Get-FileHash .\mediaforge-win-x64.exe -Algorithm SHA256`. The installer does this check for you.
- **ffmpeg licence:** on Windows and Linux MediaForge downloads a static LGPL build of ffmpeg (`LGPL-3.0-or-later`, from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), pinned to a month-end build because BtbN deletes daily builds after 14 days; a live daily BtbN build can be installed from the Update screen). `packages/binary-resolver/src/tools.lock.json` records the version, source, SHA-256 and licence of every build.
- **Remove it:** delete the program, MediaForge's tool folder (`%LOCALAPPDATA%\MediaForge\bin`, or `~/.local/share/mediaforge`), its settings file, and the PATH line the installer added.

## Browser extension (development)

Not released yet. To try it from a clone (Windows, Firefox):

```sh
pnpm install
pnpm --filter @mediaforge/desktop build      # the relay the browser launches
pnpm --filter @mediaforge/extension build    # dist/firefox (add -- --target chromium for dist/chromium)
node tools/dev/register-native-host.mjs      # register the native host (--exe <path> for an installed build)
```

Then load `apps/extension/dist/firefox` as a temporary add-on in `about:debugging`. For Brave, add `--brave-id <extension-id>` to the register command. `--uninstall` removes the registration. Manual test steps: [docs/superpowers/manual-checklist-extension.md](docs/superpowers/manual-checklist-extension.md).

The extension has two UI modes (setting `extensionUi`): toolbar popup only, or popup plus a Download button on page `<video>` and `<audio>` (default).

## Requirements (development)

- Node.js 22 (see `.nvmrc`)
- pnpm 11

## Desktop CLI

After [installing](#install), run `mediaforge` to open the interactive menu, or give it a command:

```sh
mediaforge                                    # interactive menu (in a terminal)
mediaforge --manager                          # open the downloads manager directly
mediaforge download <url>                     # best quality, saved to ~/Downloads/MediaForge
mediaforge download <url> -p mp4-720p         # pick an output profile
mediaforge download <url> -p audio-mp3-320 -o ~/Music --filename "My song"
mediaforge formats <url>                      # list the formats available for a link
mediaforge setup                              # download yt-dlp, ffmpeg and deno if missing
mediaforge update [--channel stable|nightly|master] [--check]  # update yt-dlp; --check only lists versions
mediaforge self-update                        # update MediaForge itself to the newest release
mediaforge doctor                             # check that the tools are found
mediaforge <command> --help                   # options for one command
mediaforge --version
```

`download` prints the path of the saved file on stdout and progress on stderr, so it works in scripts: `file=$(mediaforge download <url> -q)`.

To run it from a clone of the repo instead (builds with esbuild, then runs `dist/main.js`), replace `mediaforge` with `pnpm --filter @mediaforge/desktop start`:

```sh
pnpm --filter @mediaforge/desktop start download <url> -p mp4-1080p
```

| Command    | Purpose                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `download` | Download media from a URL. Options: `-p/--profile`, `-o/--output`, `--filename`, `-q/--quiet`. |
| `formats`  | List the formats available for a URL.                                                          |
| `setup`    | Download yt-dlp, ffmpeg and Deno (the JavaScript runtime YouTube needs) when missing. Options: `-y/--yes`, `--tools yt-dlp,ffmpeg,deno`. |
| `update`   | Update yt-dlp from your channel (stable, nightly or master; `--channel` picks and saves it). `--check` lists yt-dlp and ffmpeg versions without installing. Never changes ffmpeg or Deno. |
| `self-update` | Replace the `mediaforge` program with the newest release, after checking its SHA-256. |
| `doctor`   | Check that yt-dlp and ffmpeg are found, and whether a JavaScript runtime is available. `--json` for scripts. |

- Without a command, a terminal opens the interactive menu. Without a terminal, it prints help.
- `--manager` opens the downloads manager: every download (from the menu, the CLI or the extension) with pause, resume, cancel, remove, move to trash, search, filter, sort, bandwidth limits (High, Med, Low, Custom) and a detail panel. Press `?` for the keys. The mouse works across the whole interactive app.
- `--core` and `--native-host` are internal: the background core and the browser relay.
- Built-in profiles: `best`, `mp4-1080p`, `mp4-720p`, `audio-mp3-320`, `audio-m4a`. Run `download --help` for the full list.
- Settings precedence: flags, then environment variables (`MEDIAFORGE_PROFILE`, `MEDIAFORGE_OUTPUT_DIR`), then saved settings, then defaults. Default output is `~/Downloads/MediaForge`.

### yt-dlp and ffmpeg

The CLI needs both tools. It looks for each in this order:

1. `MEDIAFORGE_YTDLP_PATH` / `MEDIAFORGE_FFMPEG_PATH` / `MEDIAFORGE_DENO_PATH` (full path to the executable).
2. For yt-dlp only: MediaForge's tool folder (the copy downloaded by `mediaforge setup` or `mediaforge update`), so an update always takes effect. If that copy is missing or does not run, the lookup continues below.
3. `PATH` (ffmpeg 5.0 or newer).
4. The bundled directory: `MEDIAFORGE_BIN_DIR`, else `bin/` next to the executable, else the repo-root `bin/` when run through Node.
5. MediaForge's tool folder, filled by `mediaforge setup` (the last step for ffmpeg and Deno). Override its location with `MEDIAFORGE_CACHE_DIR`.

If a tool is missing, the interactive menu and `download` / `formats` in a terminal offer to download it. Without a terminal they exit with code 3 and print `run: mediaforge setup`. Nothing downloads without a yes. Downloads are checked against a SHA-256 before anything is run. The interactive app checks GitHub for a newer MediaForge when it starts and again on the About page, where "Update to ..." installs it (restart afterwards). `mediaforge self-update` does the same from the command line; it works on the installed program, not when run through Node. `mediaforge update` fetches the latest yt-dlp from your channel (stable, nightly or master; `--channel` picks and saves it) and `mediaforge update --check` only lists installed and latest versions of yt-dlp and ffmpeg; if `MEDIAFORGE_YTDLP_PATH` points at a yt-dlp that comes first, it says so.

**YouTube** needs a JavaScript runtime for all formats: install [Deno](https://deno.com) or Node.js 20 or newer. The MediaForge program itself cannot serve as that runtime. `doctor` shows whether one was found.

Run `doctor` to see what was found and where.

### Environment variables

| Variable                  | Purpose                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `MEDIAFORGE_YTDLP_PATH`   | Full path to a yt-dlp executable. An unusable path is an error, not a fallback.        |
| `MEDIAFORGE_FFMPEG_PATH`  | Full path to an ffmpeg executable. An unusable path is an error, not a fallback.       |
| `MEDIAFORGE_DENO_PATH`    | Full path to a Deno executable (the JavaScript runtime YouTube needs).                 |
| `MEDIAFORGE_BIN_DIR`      | Folder with bundled `yt-dlp` and `ffmpeg`, searched after `PATH`.                      |
| `MEDIAFORGE_CACHE_DIR`    | Where `setup` and `update` put downloaded tools (default: the per-user folder above).  |
| `MEDIAFORGE_PROFILE`      | Default output profile (a `-p/--profile` flag wins).                                   |
| `MEDIAFORGE_OUTPUT_DIR`   | Default output folder (a `-o/--output` flag wins).                                     |
| `MEDIAFORGE_TOOLS_LOCK`    | Testing only: a JSON file that replaces the built-in pinned tool downloads. Whoever sets it chooses what gets installed. |

### Exit codes

| Code | Meaning                  |
| ---- | ------------------------ |
| 0    | Success                  |
| 1    | Failure                  |
| 2    | Usage error              |
| 3    | yt-dlp or ffmpeg missing |
| 4    | Network error, or a failed or corrupt tool download |
| 5    | Unsupported site         |
| 6    | Filesystem error (including disk full or permissions when installing a tool) |
| 130  | Cancelled (Ctrl+C)       |

Progress and remaining work are tracked in [docs/desktop-cli-checklist.md](docs/desktop-cli-checklist.md).

## Getting started

```sh
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc -b
pnpm lint        # biome check
pnpm format      # biome format --write
```

## Tooling

- **TypeScript** with project references (`tsc -b`), ESM only.
- **Vitest** for tests, colocated as `*.test.ts` next to the source.
- **Biome** for linting and formatting (2-space indent, 100-column lines, double quotes).
- **pnpm workspaces** for the monorepo (`apps/*`, `packages/*`, `tools/*`).
- **esbuild** bundles the desktop app and the browser extension. **Ink** and **React** render the interactive menu and manager.
- **@yao-pkg/pkg** builds the single-file binaries; **GitHub Actions** builds, tests and publishes them (see [docs/releasing.md](docs/releasing.md)).

## Contributing

- Commit messages: `<gitmoji> <scope>: <imperative summary>`, where scope is the package name.
- PR titles use the same format. PR descriptions follow `.github/pull_request_template.md`.
- Run `pnpm test`, `pnpm typecheck`, and `pnpm lint` before opening a PR.
- Full conventions and the allowed gitmoji set are in [CLAUDE.md](CLAUDE.md).
- Release process: [docs/releasing.md](docs/releasing.md).
