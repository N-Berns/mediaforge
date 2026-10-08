# Release and distribution design

Date: 2026-10-08
Status: draft, awaiting review
Scope: the desktop CLI in `apps/desktop` only. Browser-extension and native-messaging work stay out of scope.

## Goal

Ship the desktop CLI on Windows, Linux and macOS so a user can install it with one command and run it without installing Node, yt-dlp or ffmpeg first.

- Windows: `irm <url>/install.ps1 | iex`
- Linux and macOS: `curl -fsSL <url>/install.sh | sh`

## Decisions

| Topic           | Decision                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executable      | One self-contained binary per platform, built with `@yao-pkg/pkg` (Node 22).                                                                                   |
| Targets         | win-x64, linux-x64, linux-arm64, macos-x64, macos-arm64. Windows on ARM runs the x64 build under emulation.                                                    |
| Distribution    | GitHub Releases of this repo. Install scripts are release assets.                                                                                              |
| yt-dlp / ffmpeg | Downloaded from upstream, never bundled in the release.                                                                                                        |
| Download logic  | Lives once, in TypeScript (`packages/binary-resolver` and `apps/desktop`). Install scripts stay thin.                                                          |
| Download timing | Both. The installer fetches tools by default (opt out with `-SkipTools` / `--skip-tools`). The app also downloads lazily on first use if a tool is missing.    |
| yt-dlp version  | Latest release. Refreshed by `mediaforge update` or an offer after an extractor failure. No background checks.                                                 |
| ffmpeg version  | One LGPL build pinned in the repo with per-platform SHA256. Only `libmp3lame` is used (`packages/media-profiles/src/profiles.ts`), so an LGPL build is enough. |
| macOS ffmpeg    | Offer `brew install ffmpeg` after a prompt. Otherwise use evermeet.cx with a pinned SHA256.                                                                    |
| Signing         | Windows Authenticode and Apple notarization are deferred. macOS binaries are ad-hoc codesigned.                                                                |

## 1. Resolver and tool cache

Resolution order for each tool:

1. Env override (`MEDIAFORGE_YTDLP_PATH`, `MEDIAFORGE_FFMPEG_PATH`). An unusable override is an error, as today.
2. PATH. ffmpeg must be at least 5.0, as today.
3. `bundledDir` (`MEDIAFORGE_BIN_DIR`, dev runs). Kept, but it must be derived from `process.execPath` when running as a packaged binary, not from `__dirname`.
4. **New:** the managed cache.
5. Otherwise `BinaryNotFoundError`, and `requireTool` starts the lazy download flow.

`BinarySource` gains `"cache"`.

**Cache location:**

- Windows: `%LOCALAPPDATA%\MediaForge\bin`
- Linux: `$XDG_DATA_HOME/mediaforge/bin`, default `~/.local/share/mediaforge/bin`
- macOS: `~/Library/Application Support/MediaForge/bin`

A `manifest.json` in the cache records, per tool: version, source URL, SHA256 and install time. A corrupt or missing manifest is rebuilt by re-verifying the files present; it never blocks the app.

**Sources:**

- yt-dlp: the standalone asset for the platform (`yt-dlp.exe`, `yt-dlp_linux`, `yt-dlp_linux_aarch64`, `yt-dlp_macos`) from yt-dlp's GitHub releases. Verified against the `SHA2-256SUMS` file of the same release.
- ffmpeg, Windows and Linux: an LGPL build from `yt-dlp/FFmpeg-Builds`. The exact version, asset names and SHA256 per platform are in `tools.lock.json` in the repo. Bumping ffmpeg is a PR that edits this file.
- ffmpeg, macOS: `brew install ffmpeg` if the user agrees and brew is present. Otherwise the evermeet.cx download, pinned in `tools.lock.json`.

**Verification rules:** download to a temp file in the cache dir, verify the SHA256, set the executable bit, then rename into place. A mismatch aborts, deletes the temp file and reports exit 4 with a distinct message. Nothing is executed before it is verified. Homebrew installs are not verified by us; brew's own signing applies.

## 2. Commands and in-app behaviour

- `mediaforge setup [--yes] [--tools yt-dlp,ffmpeg]`: download whatever is missing into the cache and print a summary. `--yes` skips prompts. On macOS without ffmpeg it asks about brew first. With `--yes` it goes straight to evermeet.cx and never runs brew unasked.
- `mediaforge update`: re-download the latest yt-dlp into the cache and print old and new versions. It never touches ffmpeg.
- `mediaforge doctor`: unchanged, except `source` can now be `cache`.
- **Lazy first run, CLI (`download`, `formats`):** if a tool is missing and stdin is a TTY, ask "yt-dlp is missing. Download it now? (Y/N)". In non-TTY runs, fail with exit 3 and the hint `run: mediaforge setup`. Nothing downloads silently.
- **Lazy first run, interactive app:** the same prompt as a screen, with a progress bar.
- **Extractor failure:** when yt-dlp fails with an error that indicates a stale extractor, the interactive error screen offers "Update yt-dlp and retry". The CLI prints `run: mediaforge update`. The exact error patterns are fixed during planning.
- **Exit codes:** reuse the existing set. A failed or corrupt tool download is 4 (network). Disk-full and permission errors are 6.

## 3. Build and release pipeline

**Build:** esbuild produces `dist/main.js` as today. `@yao-pkg/pkg` wraps it with Node 22 into `mediaforge-<os>-<arch>[.exe]`. All five targets cross-build on one Linux runner.

**Workflow:** `.github/workflows/release.yml`, triggered by a `v*` tag.

1. Install, typecheck, test, `pnpm lint`.
2. Build the five binaries.
3. Smoke test on native runners (Windows, Linux x64, Linux arm64, macOS arm64, macOS x64): `mediaforge --version` and `mediaforge doctor --json`.
4. Ad-hoc codesign the macOS binaries with `codesign -s -`.
5. Generate `SHA256SUMS`. Publish a GitHub Release with the binaries, `SHA256SUMS`, `install.ps1` and `install.sh`.

**Install scripts:** small, readable, versioned with the release.

- Detect OS and arch. Fetch `SHA256SUMS` and the matching binary from the release. Verify the hash. Abort on mismatch.
- Install to `%LOCALAPPDATA%\MediaForge\mediaforge.exe` on Windows, or `~/.local/bin/mediaforge` on Linux and macOS. Add that directory to the user PATH if it is missing.
- Run `mediaforge setup --yes` unless `-SkipTools` / `--skip-tools` was passed.
- Default to the latest release. A version can be pinned via the `/download/vX.Y.Z/` URL.
- No sudo, no files outside the user's home. There is no `uninstall` command in this phase. The README documents manual removal.

**Versioning:** the version is taken from the git tag and injected into `apps/desktop/src/version.ts` at build time. Changelog generation from commit titles is chosen during planning.

## 4. Testing, errors and risks

**Unit tests (vitest, injected fetch and filesystem, no network):**

- (platform, arch, tool) to asset URL mapping, including unsupported combinations.
- Checksum accept and reject, with the file deleted on mismatch.
- Atomic install: an interrupted download leaves no partial file in the cache.
- Manifest read, write and rebuild.
- Resolver priority with the new cache step, keeping the existing tests.
- `setup`, `update` and the lazy prompt, in TTY and non-TTY branches.

**CI checks:** `shellcheck` on `install.sh`, PSScriptAnalyzer on `install.ps1`, and an end-to-end install smoke test against the release artifacts.

**Errors:** offline, HTTP 404, GitHub API rate limit, checksum mismatch and disk full each get a distinct message with a fix hint, and exit 4 or 6.

**Risks:**

1. **yao-pkg with Ink (highest).** Yoga's wasm, the ESM bundle and the `createRequire` banner may not survive pkg's snapshot filesystem. The first implementation task is a spike on win-x64 and one other target: build the binary, confirm the TUI renders and that child processes spawn. If it fails, the build-tool choice (Node SEA or Bun) is reopened.
2. **Paths in a packaged binary.** Anything derived from `__dirname` for locating files must use `process.execPath`.
3. **evermeet.cx availability.** Single-maintainer host. It is the fallback behind brew, with a pinned hash. An outage only affects macOS users without brew.
4. **Unsigned binaries.** Defender or SmartScreen may flag the Windows exe. Downloading with `irm` avoids Mark-of-the-Web, but heuristic flags remain possible. Signing is deferred.
5. **Trust in `irm | iex`.** Mitigated by a short script, a hash-verified binary, a pinned-version URL option and no elevated privileges. The README states this plainly.

## Out of scope

winget, Scoop and Homebrew packages, Windows ARM native build, code signing and notarization, an `uninstall` command, background update checks, and browser-extension integration.
