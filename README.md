# MediaForge

Cross-platform media downloader: a browser extension, a desktop host/CLI, and an Android app, built on shared TypeScript packages.

> **Status:** early development (v0.1.0). Only the shared packages exist so far. The extension, desktop host/CLI, and Android app are planned and not yet in the repo.

## How it works

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
| `apps/*`, `tools/*`        | (planned)                     | Extension, desktop host/CLI, Android app, tooling.                                                                     |

Dependency direction: everything depends on `shared-types`. `shared-protocol` also depends on `zod`.

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

## Contributing

- Commit messages: `<gitmoji> <scope>: <imperative summary>`, where scope is the package name.
- PR titles use the same format. PR descriptions follow `.github/pull_request_template.md`.
- Run `pnpm test`, `pnpm typecheck`, and `pnpm lint` before opening a PR.
- Full conventions and the allowed gitmoji set are in [CLAUDE.md](CLAUDE.md).
