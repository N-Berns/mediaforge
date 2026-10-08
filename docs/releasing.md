# Releasing the desktop CLI

A release is a git tag. Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`, which checks the code, builds five binaries, smoke-tests each on its own OS, and publishes a GitHub Release with `SHA256SUMS`, `install.sh` and `install.ps1`.

## How the workflow runs

1. `check`: the tag (without a `-suffix`) must equal the `apps/desktop/package.json` version. Then `pnpm typecheck`, `pnpm test`, `pnpm lint`.
2. `build`: bundles `apps/desktop` with `MEDIAFORGE_VERSION` set from the tag, then `tools/release/build-binaries.mjs` stages `dist/main.js` next to a `package.json` and runs `@yao-pkg/pkg` in enhanced SEA mode for win-x64, linux-x64, linux-arm64, macos-x64 and macos-arm64. The packaged binary carries its own Node runtime, so users need no Node installed. It cannot serve as yt-dlp's JavaScript runtime.
3. `verify-binaries`: each binary runs on a native runner (macOS binaries are ad-hoc signed first) through `tools/release/smoke.sh`: `--version`, `--help`, `doctor --json`, and `setup --yes --tools yt-dlp` against a local fake yt-dlp server.
4. `publish`: stamps the tag into `install/install.sh` and `install/install.ps1`, writes `SHA256SUMS`, and creates the release with generated notes. A tag with a dash is marked as a pre-release.
5. `verify-install` and `verify-install-windows`: run the published installers on Linux, macOS and Windows and check the installed version. They run only when the repository is public: they download the installer anonymously, and GitHub answers 404 for the release files of a private repository. On a private repo they show as "Skipped"; check the published files by hand (see "Checking a release of a private repository" below).

yt-dlp and ffmpeg are never part of a release. They are downloaded by the user's machine from upstream.

## Before tagging

1. Set the version in `apps/desktop/package.json` and the fallback in `apps/desktop/src/version.ts` to `X.Y.Z`. The workflow fails if the tag (without a `-suffix`) differs from the package version.
2. `pnpm typecheck`, `pnpm test` and `pnpm lint` are green on `master`. CI runs them on Linux and Windows.
3. Check that every pinned ffmpeg URL still resolves. BtbN keeps only the last 14 daily builds, but keeps the last build of each month for two years, so the pin must be a month-end build. A pruned URL would make `mediaforge setup` fail for every user. Run `pnpm pin:ffmpeg` (no `--` separator: pnpm 11 passes `--` through and the script rejects it); by default it picks the newest finished month's last build that has all three static LGPL assets (`--tag` overrides this, and a daily tag will stop working within two weeks), or `pnpm pin:ffmpeg --list` to see the assets of a release. Then confirm each `url` in `packages/binary-resolver/src/tools.lock.json` answers, for example `curl -fsSI <url>`, review the diff (URLs, versions, licences), and commit the lock.
4. Run the manual checks below on your own machine with a locally built binary:

   ```sh
   pnpm --filter @mediaforge/desktop build
   pnpm release:build --target win-x64 --out out/release
   ```

   `pnpm release:build` runs `node tools/release/build-binaries.mjs`, which you can also call directly. Do not put `--` between a pnpm script name and its flags; pnpm 11 rejects it.

## Rehearse with a pre-release

Push `vX.Y.Z-rc.1`. A tag with a dash is published as a pre-release. Watch every job. If `verify-install` fails, fix the cause, delete the pre-release and its tag on GitHub, and push `-rc.2`.

## Release

Push `vX.Y.Z`. Check the Releases page: five binaries, `SHA256SUMS`, `install.sh`, `install.ps1` and generated notes. The `verify-install` jobs run the published installers on Linux, macOS and Windows.

## Manual checks (not automated)

- YouTube without a JavaScript runtime: with no Deno, Node or Bun on PATH, download a YouTube link. It should work with fewer formats and the failure text should mention a JavaScript runtime if it fails.
- YouTube with a runtime: install Deno or Node 20+, repeat. All formats should appear.
- Interactive menu in a real terminal on each OS: render, arrow keys, a short download.
- Windows: download the `.exe` in a browser and check what SmartScreen says; note it in the release notes if it blocks.
- macOS: run the installer on Apple Silicon without Homebrew and check `mediaforge setup` downloads ffmpeg.

## Testing the installers

`tools/release/test-install.sh` (Linux and macOS) and `tools/release/test-install.ps1` (Windows, run with `pwsh -File`) run the installers against a local fake release. They use `MEDIAFORGE_RELEASE_TAG`, `MEDIAFORGE_RELEASE_BASE_URL` and `MEDIAFORGE_INSTALL_DIR`, which exist for these tests and are not meant for users. CI runs both.

## Checking a release of a private repository

The `verify-install` jobs are skipped while the repo is private. To check the published files anyway, download them while logged in and serve them from your own machine:

1. On the release page, download every file (the five binaries, `SHA256SUMS`, `install.sh`, `install.ps1`) into one empty folder, for example `C:\temp\rc`.
2. In that folder, start a small local file server and leave it running:
   ```sh
   node -e "require('http').createServer((q,s)=>require('fs').createReadStream('.'+q.url).on('error',()=>{s.statusCode=404;s.end()}).pipe(s)).listen(8000)"
   ```
3. In a second window, run the installer against it. The tag must be the release's tag. Windows PowerShell:
   ```powershell
   $env:MEDIAFORGE_RELEASE_TAG = 'v0.1.0-rc.2'
   $env:MEDIAFORGE_RELEASE_BASE_URL = 'http://127.0.0.1:8000'
   $env:MEDIAFORGE_INSTALL_DIR = "$env:TEMP\mf-check"
   Get-Content -Raw C:\temp\rc\install.ps1 | iex
   ```
   Linux and macOS:
   ```sh
   MEDIAFORGE_RELEASE_TAG=v0.1.0-rc.2 MEDIAFORGE_RELEASE_BASE_URL=http://127.0.0.1:8000 \
     MEDIAFORGE_INSTALL_DIR="$HOME/mf-check" sh /path/to/rc/install.sh
   ```
4. Run `mediaforge --version` from the install folder. It must print the tag without the leading `v`.

The installer adds its folder to your PATH, so remove that entry afterwards (Windows: "Edit environment variables for your account"). This tests the real stamped installer, the real `SHA256SUMS` and the real binary, without needing the repo to be public.

## Known limits

- Windows is unsigned and macOS is ad-hoc signed. Windows code signing and Apple Developer ID plus notarization are planned before v1.0.
- yt-dlp updates are manual (`mediaforge update`). There are no background checks.
- ffmpeg builds for Windows and Linux are pinned to a month-end BtbN autobuild release (BtbN keeps those for two years and deletes daily builds after 14 days). Month-end builds are pruned eventually too, so before each MediaForge release run `pnpm pin:ffmpeg` and confirm each URL in `tools.lock.json` still resolves (see "Before tagging"). An already-published MediaForge release keeps pointing at the URLs it was built with; if upstream removes them, `mediaforge setup` fails with a download error until a new release re-pins.
- The macOS ffmpeg comes from one third-party server (Martin Riedl). If it disappears, switch to Homebrew only or a self-built LGPL ffmpeg and update `tools.lock.json`.
