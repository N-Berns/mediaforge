# Extension manual checklist (Firefox)

Run after `pnpm --filter @mediaforge/desktop build`, `pnpm --filter @mediaforge/extension build`,
and `node tools/dev/register-native-host.mjs`. Load `apps/extension/dist/firefox/manifest.json`
from `about:debugging` as a temporary add-on.

- [ ] Popup on a normal page with the core stopped: banner shows "Connecting…", then the core
      starts and the banner disappears (no console window appears).
- [ ] With the host unregistered (`--uninstall`): popup shows "Install MediaForge".
- [ ] Against an older core than the extension requires: popup shows "Update MediaForge".
- [ ] First run with no tools in the cache folder: "Setting up MediaForge… N%" counts up, then clears.
- [ ] A page with a plain `<video src=*.mp4>`: item appears in the popup and downloads to the
      Video folder; progress and completion show in the popup.
- [ ] A YouTube watch page: "Page video" appears with the title and duration; a download starts.
- [ ] With `askQuality` on: a picker with sizes appears; the chosen format is downloaded.
- [ ] A site yt-dlp does not know, with an HLS stream: the HLS item appears and downloads; a 403
      stream that needs cookies downloads (login required site).
- [ ] The overlay button appears on hover over a large video and works.
- [ ] The overlay appears on hover over a video covered by a custom player's controls (a poster
      or click-catcher overlay on top of the video).
- [ ] The overlay inside an embedded iframe player downloads the embed, not only the top page.
- [ ] Toggling "Download button on videos" off removes the overlay after a page reload.
- [ ] Container tab and private window cookies are not sent from the default profile (inspect the
      context the core receives in a debug build, or use a site that echoes cookies).
- [ ] Close the popup mid-download, reopen: the job is still listed with progress.
- [ ] Keep-alive: leave the popup closed for 5 minutes with a download running, reopen: progress
      is still shown.
- [ ] Leave the browser idle for 5 minutes with the popup closed, reopen: candidates for the open
      tab are still listed (event page suspension).
- [ ] Kill `MediaForge` (core) mid-download: popup reconnects and lists jobs; no duplicates.
- [ ] `about:blank` and `about:addons`: popup shows no items and no error.
- [ ] A private window with the add-on not allowed: nothing is detected.
- [ ] Inspect `storage.session` and the core's config folder: no cookie value is stored anywhere.
