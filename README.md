# MediaForge

Cross-platform media downloader: a browser extension, a desktop host/CLI, and an Android app, built on shared TypeScript packages.

> **Status:** early development (v0.1.0). The shared packages and the standalone desktop CLI exist. The browser extension, the native messaging host, and the Android app are planned and not yet built. `apps/chrome`, `apps/edge`, `apps/firefox`, and `apps/android` are empty placeholders.

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
| `packages/binary-resolver` | `@mediaforge/binary-resolver` | Finds the `yt-dlp` and `ffmpeg` executables: env override, then `PATH`, then a bundled `bin/` directory.               |
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

## Requirements

- Node.js 22 (see `.nvmrc`)
- pnpm 11

## Desktop CLI

Run it from the repo root (builds with esbuild, then runs `dist/main.js`):

```sh
pnpm --filter @mediaforge/desktop start                      # interactive menu (in a terminal)
pnpm --filter @mediaforge/desktop start download <url> -p mp4-1080p
pnpm --filter @mediaforge/desktop start formats <url>
pnpm --filter @mediaforge/desktop start doctor
```

| Command    | Purpose                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `download` | Download media from a URL. Options: `-p/--profile`, `-o/--output`, `--filename`, `-q/--quiet`. |
| `formats`  | List the formats available for a URL.                                                          |
| `doctor`   | Check that yt-dlp and ffmpeg are found. `--json` for scripts.                                  |

- Without a command, a terminal opens the interactive menu. Without a terminal, it prints help.
- Built-in profiles: `best`, `mp4-1080p`, `mp4-720p`, `audio-mp3-320`, `audio-m4a`. Run `download --help` for the full list.
- Settings precedence: flags, then environment variables (`MEDIAFORGE_PROFILE`, `MEDIAFORGE_OUTPUT_DIR`), then saved settings, then defaults. Default output is `~/Downloads/MediaForge`.

### yt-dlp and ffmpeg

The CLI needs both tools. It looks for each in this order:

1. `MEDIAFORGE_YTDLP_PATH` / `MEDIAFORGE_FFMPEG_PATH` (full path to the executable).
2. `PATH` (ffmpeg 5.0 or newer).
3. The bundled directory: `MEDIAFORGE_BIN_DIR`, else `bin/` next to the executable, else the repo-root `bin/` when run through Node.

Run `doctor` to see what was found and where.

### Exit codes

| Code | Meaning                  |
| ---- | ------------------------ |
| 0    | Success                  |
| 1    | Failure                  |
| 2    | Usage error              |
| 3    | yt-dlp or ffmpeg missing |
| 4    | Network error            |
| 5    | Unsupported site         |
| 6    | Filesystem error         |
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

## Contributing

- Commit messages: `<gitmoji> <scope>: <imperative summary>`, where scope is the package name.
- PR titles use the same format. PR descriptions follow `.github/pull_request_template.md`.
- Run `pnpm test`, `pnpm typecheck`, and `pnpm lint` before opening a PR.
- Full conventions and the allowed gitmoji set are in [CLAUDE.md](CLAUDE.md).
