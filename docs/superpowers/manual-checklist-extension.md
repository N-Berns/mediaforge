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
- [ ] Download on an item in "On this page": Downloads, Settings, Diagnostics and About fold;
      "On this page" (or the picker it opens) stays open.
- [ ] Close the popup mid-download, reopen: the job is still listed with progress.
- [ ] Keep-alive: leave the popup closed for 5 minutes with a download running, reopen: progress
      is still shown.
- [ ] Leave the browser idle for 5 minutes with the popup closed, reopen: candidates for the open
      tab are still listed (event page suspension).
- [ ] Kill `MediaForge` (core) mid-download: popup reconnects and lists jobs; no duplicates.
- [ ] `about:blank` and `about:addons`: popup shows no items and no error.
- [ ] A private window with the add-on not allowed: nothing is detected.
- [ ] Inspect `storage.session` and the core's config folder: no cookie value is stored anywhere.

## Job controls and the open button (phase 4)

- [ ] Open MediaForge button, no manager running: a new window opens (Windows 10 console, Windows 11
      default terminal, one Linux terminal) and shows the Downloads manager.
- [ ] Open MediaForge button, manager already open: the window flashes and the popup says
      "MediaForge is already open." The note is gone after 5 s.
- [ ] Two fast clicks on the button open one window.
- [ ] With the app closed (not connected), the button is disabled and its tooltip says
      "MediaForge is not connected."
- [ ] Linux without a terminal: the popup says "Could not open a terminal. Run mediaforge --manager."
      with a Copy button; Copy puts the command on the clipboard and relabels to "Copied"; Dismiss
      removes the note.
- [ ] A running job shows pause and cancel buttons; pause shows "Paused N%" with resume and cancel;
      resume continues from the same percentage.
- [ ] A failed job shows Error and a retry button; retry starts it again.
- [ ] Cancel asks "Cancel?" with Yes and No; No keeps the job, Yes cancels it.
- [ ] The speed beside the percentage is in bits after pressing `b` in the manager.
- [ ] Settings shows Speed limit with High, Med, Low and Custom; changing it updates the limit in
      the manager header.
- [ ] Pick Custom in Speed limit: a Custom field shows under the tabs. "5", "5 MB/s" and
      "40 Mbps" save on Enter or when leaving the field, and the Custom tab shows the value; empty
      saves "no limit"; "abc" shows an error and saves nothing. Typing is not lost while a download
      updates the popup. The manager header shows the new value.
- [ ] Cancel a download (Yes): the row says "Cancelled", with no Error link.
- [ ] With finished downloads listed and Downloads unfolded, click the overlay's Download on a
      video with several formats: the popup opens on the picker with the other sections folded,
      and the picker list and its Download selected bar are fully visible.
- [ ] Kill the core with a download running, restart it: the popup shows a notice banner with an
      Open MediaForge button; Dismiss clears it here and in the manager.
