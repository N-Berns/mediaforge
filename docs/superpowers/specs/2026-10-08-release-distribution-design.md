# Release and distribution design

Date: 2026-10-08
Status: draft, revised after external review (2026-10-08), awaiting your review before planning.
Scope: the desktop CLI in `apps/desktop` only. Browser-extension and native-messaging work stay out of scope.

## Goal

Ship the desktop CLI on Windows, Linux and macOS so a user can install it with one command and run it without installing Node, yt-dlp or ffmpeg first.

- Windows: `irm <url>/install.ps1 | iex`
- Linux and macOS: `curl -fsSL <url>/install.sh | sh`

## Decisions

| Topic           | Decision                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executable      | One self-contained binary per platform, built with `@yao-pkg/pkg --sea` on Node 22. pkg's Standard mode is documented as broken for Node 22 cross-builds, so it is not used there. Fallback if the spike fails: Node 24 in Standard mode. |
| Targets         | win-x64, linux-x64, linux-arm64, macos-x64, macos-arm64. Windows on ARM runs the x64 build under emulation.                                                    |
| Distribution    | GitHub Releases of this repo. Install scripts are release assets.                                                                                              |
| yt-dlp / ffmpeg | Downloaded from upstream, never bundled in the release.                                                                                                        |
| Download logic  | Lives once, in TypeScript (`packages/binary-resolver` and `apps/desktop`). Install scripts stay thin.                                                          |
| Download timing | Both. The installer fetches tools by default (opt out with `-SkipTools` / `--skip-tools`). The app also downloads lazily on first use if a tool is missing.    |
| yt-dlp version  | Latest **nightly**, yt-dlp's recommended channel for regular users. Refreshed by `mediaforge update` or an offer after an extractor failure. No background checks. No `--channel` flag in this phase. |
| ffmpeg version  | One build per platform and architecture, pinned in `tools.lock.json` with version, source, configure flags, license and SHA256. The license is taken from the build's documented configuration, never inferred from which codecs MediaForge uses. LGPL is preferred. |
| macOS ffmpeg    | Martin Riedl's builds (arm64 and amd64, release channel), pinned in `tools.lock.json` with SHA256. They are GPL builds (libx264/libx265 enabled). MediaForge does not redistribute them: the user's machine downloads them from the upstream host. evermeet.cx is dropped because it has no native arm64 build. `brew install ffmpeg` after a prompt stays available. |
| JS runtime      | yt-dlp needs a JavaScript runtime (Deno, Node 20+, Bun or QuickJS) for full YouTube support. This phase only detects one and warns. The packaged MediaForge binary cannot serve as that runtime. |
| Signing         | Early releases (v0.x): Windows unsigned (SmartScreen warnings expected), macOS ad-hoc codesigned. Before a v1.0 public release: Windows code signing, and Apple Developer ID plus notarization. |

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

- yt-dlp: the standalone asset for the platform (`yt-dlp.exe`, `yt-dlp_linux`, `yt-dlp_linux_aarch64`, `yt-dlp_macos`) from the latest nightly release. Verified against the `SHA2-256SUMS` file of the same release.
- ffmpeg, Windows and Linux: a static LGPL build from `BtbN/FFmpeg-Builds` (the yt-dlp fork of that repository publishes only GPL builds). That repository deletes daily builds after 14 days but keeps the last build of each month for two years, so the pin is a month-end build (the pin script's default), and it is re-checked and re-pinned before each MediaForge release. The exact version, asset names and SHA256 per platform are in `tools.lock.json` in the repo. Bumping ffmpeg is a PR that edits this file.
- ffmpeg, macOS: Martin Riedl's release builds for arm64 and amd64, pinned by version and SHA256 in `tools.lock.json`. These are GPL builds, accepted because users download them from the upstream host and MediaForge does not ship them. `tools.lock.json` records the license per entry, and the README notes it. `brew install ffmpeg` with user consent remains available. Risk: single-maintainer host. If it disappears, switch to Homebrew-only or a self-built LGPL ffmpeg.
- Tool model: the resolver and cache are keyed by tool, platform and architecture, and the tool list is data, not hard-coded. `ffprobe` is not used by any current code and is not managed in this phase.

**JS runtime:** `doctor` reports whether Deno, Node, Bun or QuickJS is on PATH. When one is found, it is passed to yt-dlp with `--js-runtimes`. When none is found, `doctor` and the first YouTube error warn that formats are limited. Managing a Deno download in the cache is a later item.

**Verification rules:** download to a temp file in the cache dir, verify the SHA256, set the executable bit, then rename into place. A mismatch aborts, deletes the temp file and reports exit 4 with a distinct message. Nothing is executed before it is verified. Homebrew installs are not verified by us; brew's own signing applies.

## 2. Commands and in-app behaviour

- `mediaforge setup [--yes] [--tools yt-dlp,ffmpeg]`: download whatever is missing into the cache and print a summary. `--yes` skips prompts. On macOS without ffmpeg it asks about brew first. With `--yes` it goes straight to the pinned download and never runs brew unasked.
- `mediaforge update`: re-download the latest yt-dlp into the cache and print old and new versions. It never touches ffmpeg.
- `mediaforge doctor`: unchanged, except `source` can now be `cache`.
- **Lazy first run, CLI (`download`, `formats`):** if a tool is missing and stdin is a TTY, ask "yt-dlp is missing. Download it now? (Y/N)". In non-TTY runs, fail with exit 3 and the hint `run: mediaforge setup`. Nothing downloads silently.
- **Lazy first run, interactive app:** the same prompt as a screen, with a progress bar.
- **Extractor failure:** when yt-dlp fails with an error that indicates a stale extractor, the interactive error screen offers "Update yt-dlp and retry" (default No, never automatic). The CLI prints `run: mediaforge update`. The exact error patterns are fixed during planning.
- **Exit codes:** reuse the existing set. A failed or corrupt tool download is 4 (network). Disk-full and permission errors are 6.

## 3. Build and release pipeline

**Build:** esbuild produces `dist/main.js` as today. `@yao-pkg/pkg --sea` wraps it with Node 22 into `mediaforge-<os>-<arch>[.exe]`. All five targets cross-build on one Linux runner, unless the spike shows a target must be built natively.

**Workflows:** two files, so release machinery stays out of normal CI.

- `.github/workflows/ci.yml`, on pull requests and pushes: install, typecheck, test, `pnpm lint`.
- `.github/workflows/release.yml`, triggered by a `v*` tag:

1. Install, typecheck, test, `pnpm lint`.
2. Build the five binaries.
3. Smoke test on native runners (Windows, Linux x64, Linux arm64, macOS arm64, macOS x64): `mediaforge --version`, `mediaforge doctor --json`, and `mediaforge setup --yes --tools yt-dlp` against a local test endpoint, not the real upstream.
4. Ad-hoc codesign the macOS binaries with `codesign -s -`.
5. Generate `SHA256SUMS`. Publish a GitHub Release with the binaries, `SHA256SUMS`, `install.ps1` and `install.sh`.

**Install scripts:** small, readable, versioned with the release.

- Detect OS and arch. Fetch `SHA256SUMS` and the matching binary from the release. Verify the hash. Abort on mismatch.
- Install to `%LOCALAPPDATA%\MediaForge\mediaforge.exe` on Windows, or `~/.local/bin/mediaforge` on Linux and macOS. Add that directory to the user PATH if it is missing.
- Run `mediaforge setup --yes` unless `-SkipTools` / `--skip-tools` was passed.
- Default to the latest release. A version can be pinned via the `/download/vX.Y.Z/` URL.
- The README states plainly that the script runs locally with the user's privileges, and shows the review-first form: save the script to a file, read it, then run it (`curl -fsSL <url>/install.sh -o install.sh`, then `sh install.sh`; the PowerShell equivalent uses `Invoke-WebRequest -OutFile`).
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

1. **yao-pkg with Ink (highest).** Yoga's wasm, the ESM bundle and the `createRequire` banner may not survive pkg's packaging. The first implementation task is a spike: build with `pkg --sea` on Node 22 for all five targets, then on native runners confirm the TUI renders, `child_process.spawn` runs yt-dlp, and a binary cross-built from another OS starts. If SEA fails, retry with Node 24 in Standard mode. If both fail, the build-tool choice (plain Node SEA or Bun) is reopened. No pipeline work starts before the spike passes.
2. **Paths in a packaged binary.** Anything derived from `__dirname` for locating files must use `process.execPath`.
3. **macOS ffmpeg source.** Martin Riedl's host is a single-maintainer dependency and its builds are GPL. Pinned hashes protect against tampering, not against the host disappearing.
4. **Unsigned binaries.** Defender or SmartScreen may flag the unsigned Windows exe, and each new release builds reputation again. Accepted for v0.x and stated in the README. Signing is planned before v1.0.
5. **Trust in `irm | iex`.** Mitigated by a short script, a hash-verified binary, a pinned-version URL option and no elevated privileges. The README states this plainly.
6. **yt-dlp JS runtime.** Without Deno, Node, Bun or QuickJS on the machine, YouTube downloads work with limited formats. This phase detects and warns. The release checklist includes a manual YouTube download with and without a runtime.

## Out of scope

winget, Scoop and Homebrew packages, Windows ARM native build, code signing and notarization, an `uninstall` command, background update checks, and browser-extension integration.