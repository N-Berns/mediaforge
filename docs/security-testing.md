# Security changes: manual test checklist

Run these in order. Items marked **(Windows)** or **(Linux)** only apply to that system.

## Before you start

1. Run `pnpm install`, then `pnpm --filter @mediaforge/desktop build`. Both should finish without errors.
2. Start MediaForge the way you normally do.

## 1. Logged-in downloads still work (cookies)

1. In your browser, log in to a site that needs an account to watch a video.
2. Open a video there and download it with the extension.
3. It should finish. Before the change, the cookie was passed on the command line.
4. While it downloads, open Task Manager → Details, add the "Command line" column, and look at the `yt-dlp` row. You should not see any cookie text.
5. After the download, open the download folder. The hidden `.mediaforge-…` folder should be gone, with no `request.conf` left over.

## 2. Local addresses are blocked

1. Start any local web server that serves a video file, for example `npx http-server` in a folder with an mp4.
2. Try to download that video from the browser extension. It should fail with a message that the link points at this computer or its local network.
3. Open `%APPDATA%\MediaForge\config.json` **(Windows)** or `~/.config/mediaforge/config.json` **(Linux)**. Add `"allowPrivateUrls": true`, save, and try again. It should now download.
4. Set it back to `false` (or remove the line) and confirm it is blocked again.
5. Download a normal public video. It should still work.
6. Use the terminal app with the same local link. It should work without the setting, because terminal use is exempt.

## 3. yt-dlp stable is pinned and self-corrects

This applies to the `stable` channel, so run `mediaforge update --channel stable` first. On `nightly` and `master` the build is fetched live and checked against that release's `SHA2-256SUMS`, and a cached copy is replaced by the pin only when it is older than the pin. Note that for nightly, master and live ffmpeg the checksum file comes from the same GitHub release as the binary, so the hash protects against corruption and CDN tampering but not against a compromised upstream release; only the stable pin avoids that.

1. Run `mediaforge doctor`. It should show yt-dlp version 2026.08.19 if MediaForge installed it itself.
2. To simulate an old copy, open the tools cache folder, edit `manifest.json`, and change the `yt-dlp` `"version"` to `"2025.01.01"`. Restart the MediaForge core.
3. Within a few seconds, MediaForge should reinstall yt-dlp. Check `manifest.json`: the version should be back to 2026.08.19.
4. If you use your own yt-dlp from PATH and MediaForge has no copy of its own, MediaForge should not install one. Once MediaForge has installed its own yt-dlp, that copy is used before the one on PATH.

## 4. Chromium extension (Brave or Chrome)

1. Build the extension and load it unpacked, as you normally do.
2. On install, the browser should not ask for "access to all websites".
3. Open the extension popup. It should show "MediaForge needs access to all sites to find media" with an **Allow access** button.
4. Click it and accept. Then open a page with a video. The popup should find the media, and the overlay "Download" button should appear on the video.
5. Make sure Firefox still behaves as before: it still gets access at install.

## 5. Token file lock-down (Windows)

1. Start the core. In PowerShell run `icacls "$env:APPDATA\MediaForge\core.token"`.
2. You should see only your own user listed, not Everyone, Users or Administrators.
3. The extension should still connect and download.

## 6. Socket permissions (Linux)

1. Start the core. Run `ls -l $XDG_RUNTIME_DIR/mediaforge-*.sock`. If that variable is empty, look in `/tmp`.
2. The line should start with `srw-------`.

## 7. Open-folder button

1. Finish a download. In the manager or popup, use "show in folder". Explorer should open with the file selected.

## 8. Automatic tests

1. Run `pnpm lint`, `pnpm typecheck` and `pnpm test`. All should pass.
2. (Optional, Linux or Git Bash) Build a binary, then run `bash tools/release/smoke.sh <path-to-binary>`. It should end with `smoke OK`.

## 9. GitHub (after you push)

1. Open the Actions tab. The CI run should be green, with the pinned versions of checkout, setup-node and pnpm.
2. Before tagging a release, run `node tools/release/check-lock-urls.mjs`. It should say all pinned URLs answer.

If any step differs from what is written here, copy the exact message and report it.
