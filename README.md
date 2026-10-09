# MediaForge

Cross-platform media downloader: a browser extension, a desktop host/CLI, and an Android app, built on shared TypeScript packages.

> **Status:** early release (v0.2.0). The desktop CLI is available as a download for Windows and Linux. The browser extension, the native messaging host and the Android app are planned and not yet built. `apps/chrome`, `apps/edge`, `apps/firefox` and `apps/android` are empty placeholders.

## How it works

This is the target design. Today only the desktop CLI exists, and it runs standalone: no extension, no native messaging.

1. The **extension** detects media on a page (DOM, network requests, HLS/DASH manifests) and builds `MediaCandidate` objects.
2. The user picks a candidate, a variant, and an **output profile** (for example "MP4 1080p" or "MP3 320 kbps").
3. The extension sends a `download.start` request to the **host** over Chrome native messaging.
4. The host downloads and post-processes the media, and reports progress back to the extension.

## Repository layout

| Path                       | Package                       | Purpose                                                                                                                |
| -------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/shared-types`    | `@mediaforge/shared-types`    | Domain types: media candidates, variants, download requests and progress, output profiles. Types only.                 |
| `packages/shared-protocol` | `@mediaforge/shared-protocol` | Extension ↔ host wire protocol: Zod schemas, message envelopes, native-messaging framing, parsing, `PROTOCOL_VERSION`. |
| `packages/extension-core`  | `@mediaforge/extension-core`  | Browser-agnostic detection logic: MIME/extension classification, candidate creation, URL de-duplication.               |
| `packages/media-profiles`  | `@mediaforge/media-profiles`  | Built-in output profiles and variant selection.                                                                        |
| `packages/binary-resolver` | `@mediaforge/binary-resolver` | Finds the `yt-dlp` and `ffmpeg` executables (env override, `PATH`, bundled `bin/`, managed cache) and downloads them. |
| `apps/desktop`             | `@mediaforge/desktop`         | Desktop CLI and interactive terminal menu (Ink). Downloads with yt-dlp and ffmpeg.                                     |
| `apps/*`, `tools/*`        | (planned)                     | Browser extensions (`chrome`, `edge`, `firefox`), Android app, tooling. Placeholders only.                             |

Dependency direction: `shared-types` is the base. `shared-protocol` also depends on `zod`. `apps/desktop` uses `shared-types`, `media-profiles`, and `binary-resolver`.

## Protocol

Messages are JSON envelopes `{ v, id, type, payload }`, framed for native messaging with a 32-bit little-endian length prefix.

- Extension → host: `hello`, `download.start`, `download.cancel`, `host.info`.
- Host → extension: `hello.ack` and further response and progress messages (see `packages/shared-protocol/src/messages.ts`).
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

- Skip the tool download with `--skip-tools` (`sh -s -- --skip-tools` when piping) or `-SkipTools` (`& ([scriptblock]::Create((irm <url>))) -SkipTools`).
- Install without starting MediaForge with `--no-launch` (`sh -s -- --no-launch` when piping) or `-NoLaunch`. It also does not start when there is no interactive terminal.
- Pin a version by replacing `latest/download` with `download/vX.Y.Z` in the URL.
- Supported: Windows x64 (Windows on ARM runs it through emulation), Linux x64 and arm64.
- **macOS is not supported.** Apple charges a yearly fee to sign programs for distribution, and this is a hobby project.
- **Windows:** the program is not code-signed (certificates cost money), so SmartScreen or Defender may warn about it. Choose "More info", then "Run anyway" if you trust the source. To check the file first, compare its SHA-256 with the release's `SHA256SUMS`: `Get-FileHash .\mediaforge-win-x64.exe -Algorithm SHA256`. The installer does this check for you.
- **ffmpeg licence:** on Windows and Linux MediaForge downloads a static LGPL build of ffmpeg (`LGPL-3.0-or-later`, from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), pinned to a month-end build because BtbN deletes daily builds after 14 days). `packages/binary-resolver/src/tools.lock.json` records the version, source, SHA-256 and licence of every build.
- **Remove it:** delete the program, MediaForge's tool folder (`%LOCALAPPDATA%\MediaForge\bin`, or `~/.local/share/mediaforge`), its settings file, and the PATH line the installer added.

## Requirements (development)

- Node.js 22 (see `.nvmrc`)
- pnpm 11

## Desktop CLI

After [installing](#install), run `mediaforge` to open the interactive menu, or give it a command:

```sh
mediaforge                                    # interactive menu (in a terminal)
mediaforge download <url>                     # best quality, saved to ~/Downloads/MediaForge
mediaforge download <url> -p mp4-720p         # pick an output profile
mediaforge download <url> -p audio-mp3-320 -o ~/Music --filename "My song"
mediaforge formats <url>                      # list the formats available for a link
mediaforge setup                              # download yt-dlp, ffmpeg and deno if missing
mediaforge update                             # update yt-dlp to the latest nightly
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
| `update`   | Download the latest yt-dlp nightly into MediaForge's tool folder. Never changes ffmpeg or Deno. |
| `self-update` | Replace the `mediaforge` program with the newest release, after checking its SHA-256. |
| `doctor`   | Check that yt-dlp and ffmpeg are found, and whether a JavaScript runtime is available. `--json` for scripts. |

- Without a command, a terminal opens the interactive menu. Without a terminal, it prints help.
- Built-in profiles: `best`, `mp4-1080p`, `mp4-720p`, `audio-mp3-320`, `audio-m4a`. Run `download --help` for the full list.
- Settings precedence: flags, then environment variables (`MEDIAFORGE_PROFILE`, `MEDIAFORGE_OUTPUT_DIR`), then saved settings, then defaults. Default output is `~/Downloads/MediaForge`.

### yt-dlp and ffmpeg

The CLI needs both tools. It looks for each in this order:

1. `MEDIAFORGE_YTDLP_PATH` / `MEDIAFORGE_FFMPEG_PATH` / `MEDIAFORGE_DENO_PATH` (full path to the executable).
2. `PATH` (ffmpeg 5.0 or newer).
3. The bundled directory: `MEDIAFORGE_BIN_DIR`, else `bin/` next to the executable, else the repo-root `bin/` when run through Node.
4. MediaForge's tool folder, filled by `mediaforge setup`. Override its location with `MEDIAFORGE_CACHE_DIR`.

If a tool is missing, the interactive menu and `download` / `formats` in a terminal offer to download it. Without a terminal they exit with code 3 and print `run: mediaforge setup`. Nothing downloads without a yes. Downloads are checked against a SHA-256 before anything is run. The interactive app checks GitHub for a newer MediaForge when it starts and again on the About page, where "Update to ..." installs it (restart afterwards). `mediaforge self-update` does the same from the command line; it works on the installed program, not when run through Node. `mediaforge update` fetches the latest yt-dlp nightly; if a `yt-dlp` on your PATH comes first, it says so.

**YouTube** needs a JavaScript runtime for all formats: install [Deno](https://deno.com) or Node.js 20 or newer. The MediaForge program itself cannot serve as that runtime. `doctor` shows whether one was found.

Run `doctor` to see what was found and where.

### Environment variables

| Variable                  | Purpose                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `MEDIAFORGE_YTDLP_PATH`   | Full path to a yt-dlp executable. An unusable path is an error, not a fallback.        |
| `MEDIAFORGE_FFMPEG_PATH`  | Full path to an ffmpeg executable. An unusable path is an error, not a fallback.       |
| `MEDIAFORGE_BIN_DIR`      | Folder with bundled `yt-dlp` and `ffmpeg`, searched after `PATH`.                      |
| `MEDIAFORGE_CACHE_DIR`    | Where `setup` and `update` put downloaded tools (default: the per-user folder above).  |
| `MEDIAFORGE_PROFILE`      | Default output profile (a `-p/--profile` flag wins).                                   |
| `MEDIAFORGE_OUTPUT_DIR`   | Default output folder (a `-o/--output` flag wins).                                     |
| `MEDIAFORGE_YTDLP_REPO_URL` | Testing only: looks up yt-dlp releases on another server.                            |

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
- **esbuild** bundles the desktop app. **Ink** and **React** render its interactive menu.
- **@yao-pkg/pkg** builds the single-file binaries; **GitHub Actions** builds, tests and publishes them (see [docs/releasing.md](docs/releasing.md)).

## Contributing

- Commit messages: `<gitmoji> <scope>: <imperative summary>`, where scope is the package name.
- PR titles use the same format. PR descriptions follow `.github/pull_request_template.md`.
- Run `pnpm test`, `pnpm typecheck`, and `pnpm lint` before opening a PR.
- Full conventions and the allowed gitmoji set are in [CLAUDE.md](CLAUDE.md).
- Release process: [docs/releasing.md](docs/releasing.md).
