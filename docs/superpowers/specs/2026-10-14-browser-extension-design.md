# Browser extension (sub-project 3)

Status: draft for review. Date: 2026-10-14. Builds on
[2026-10-13-extension-core-architecture-design.md](2026-10-13-extension-core-architecture-design.md)
(the core and relay, already built). Firefox first; Chrome and Edge from the same codebase after.

## Goal

A browser extension that finds media on the page the user is viewing and hands it to the local
MediaForge core to download, with no yt-dlp or ffmpeg ever installed by the user. The extension is
a thin client: the core owns downloading, tools and settings.

## Decisions already made

| Topic | Decision |
| --- | --- |
| Browsers | Firefox first. Chrome and Edge follow from the same codebase. |
| Layout and build | One `apps/extension`, esbuild, plain TypeScript, no UI framework. The empty `apps/chrome`, `apps/edge` and `apps/firefox` folders are removed. |
| UI modes | Toolbar popup, or popup plus an in-page button on `<video>` and `<audio>`. Setting `extensionUi`; default `overlay`. |
| Page-URL check | Ask the core on demand with `media.probe`. The generic extractor is excluded. Results cached per URL for the session. |
| Click behavior | Follow the saved `askQuality` setting: off downloads at once with the default quality; on shows a picker built from the probed formats. |
| Request context | The page's origin (origin plus `/`) as Referer, the browser's User-Agent and the Cookie header are sent, all taken at click time, with sniffed-stream downloads and passed to yt-dlp. |
| Settings access | The extension may read and write `extensionUi` and `askQuality`. |
| Privacy posture | Cookies are read at click time, sent once, never stored by the extension, never persisted or echoed by the core. |
| Dev registration | A dev script registers the native host until sub-project 4 ships the installer. |

## Architecture

New `apps/extension`. It reuses `packages/extension-core` (classification, de-duplication) and
`packages/shared-protocol` (message types). The browser does native-messaging framing; the extension
never uses the framing helpers.

### Background (Firefox event page, Chromium service worker)

- **native-client.** Holds one `connectNative` port to the relay. Sends `hello`, correlates replies
  by message `id`, reconnects with back-off, and exposes one state:
  `not-installed`, `connecting`, `setting-up (percent)`, `ready`, `unavailable`, `incompatible`.
  The hello handshake has a 15 s timeout. A core older than the extension requires is
  `incompatible`: the state is sticky and the client retries every 5 minutes.
- **detector.** Listens on `webRequest.onHeadersReceived`. Runs the existing classifier, rejects
  segments (`ts`, `m4s`) and range fetches, builds candidates. Request headers are not captured: the Referer is the page's
  origin (origin plus `/`) and the User-Agent is the browser's, both taken at click time.
- **tab-store.** Candidates per tab, cleared on navigation (a change of the hash fragment only, an
  SPA route, is not a navigation), mirrored to `storage.session` so a suspended background does not
  lose them.
- **job-mirror.** Subscribes to jobs and keeps a local view of the queue and progress.
- **probe-cache.** `media.info` results per page URL for the session. Cleared completely when the
  connection becomes `ready` again (a restarted core has forgotten the formats it returned). A
  `download.start` refused with `unknown-variant` evicts that page, probes it once more, and retries
  the same `variantId` only if the fresh probe still lists it; otherwise the picker opens with the
  fresh formats. The extension waits 45 s for a `media.probe` reply; the core stops yt-dlp after
  40 s and answers `probe-failed` ("Checking this page took too long.").
- **settings cache.** The core does not push every settings change, so a cached copy is trusted for
  5 s: a download click, `overlayConfig` or a popup state read re-requests `settings.get` when the
  copy is older. Concurrent reads share one request. A pushed `settings.value` refreshes the copy.

### Content script

- **overlay.** Attaches a Download button to media elements. Present only when the setting is
  `overlay`. Asks the background for the item to download; holds no state of its own. Content
  scripts may only send `overlayConfig` and `overlayDownload`; the background accepts every other
  command only from the popup page.
- **Pending picker.** The overlay cannot show a picker. When an overlay click needs a quality
  choice (`askQuality` on), the background keeps that media as the tab's pending picker (one per
  tab; cleared when the tab navigates or closes and once a download starts for it) and the button
  reads "Pick quality in the toolbar popup". The popup's state carries `picker`, and the popup opens
  straight into the same picker a popup click would show.
- **Fallback choice.** When the page itself cannot be probed, the overlay downloads a sniffed
  candidate: the oldest HLS or DASH manifest (later ones are usually variant or audio playlists, or
  ads), else the newest progressive file.

### Popup

Candidates for the current tab, the page-URL action with probed formats (a "Checking this page…"
row while the probe runs), active jobs with cancel, two toggles (button on videos, keep running),
and one banner for the not-installed, setting-up and incompatible states. When the browser has not
granted `<all_urls>` (`permissions.contains`), a banner "MediaForge needs access to all sites to
find media." offers a button that calls `permissions.request` from the click.

### Manifest

One base manifest plus a per-browser transform. Firefox: `background.scripts`, and
`browser_specific_settings.gecko` with the add-on id and `strict_min_version` 128.0. Chromium:
`background.service_worker`.

## Data flow

### Sniffed stream

1. `onHeadersReceived` fires; the classifier accepts it; the detector stores a candidate.
2. On click, the background reads the Cookie header for the request URL, then sends
   `download.start { candidate, profileId, context }`.
3. The core replies with the job's current status. Progress frames follow; completion shows in the
   popup. The first frame may already be `downloading`, never assume `queued`.

### Page URL

1. When the popup opens, or the user clicks the overlay, the background sends
   `media.probe { url }`.
2. The core runs the existing yt-dlp JSON lookup, drops the generic extractor, and replies
   `media.info { title, thumbnail?, durationSec?, formats[] }` or
   `error { code: "unsupported-site" }`.
3. The click follows `askQuality`. A picker choice goes back as `variantId` (the format selector the
   core already understands).

## Protocol and core changes

This sub-project includes these desktop changes. Protocol version stays 2; the additions are new
message types, which an older core answers with `invalid-message`.

- **`media.probe` and `media.info`.** New request and reply. `formats[]` entries carry `id`, `label`,
  `width`, `height`, `container`, `hasVideo`, `hasAudio`, `approxBytes?`. The reply stays under 1 MiB;
  the core trims the list to the best 50 formats if needed.
- **`variantId` to format selector.** A `variantId` taken from `media.info` is a yt-dlp format id.
  The core resolves it to the engine's `formatSelector` (video-only formats get audio added, as the
  menu does) and rejects an id it never returned for that URL.
- **`context` forwarding.** The core maps `referer` to `--referer`, `userAgent` to `--user-agent`,
  and `cookies` and `headers` to `--add-header`. Values are validated (no CR or LF, length-capped).
  The request context is removed from the stored job record, from `jobs.snapshot`, from progress
  frames and from every log line.
- **Firefox relay detection.** Firefox passes the native manifest path and the add-on ID as
  arguments, not a `chrome-extension://` origin. `isRelayInvocation` also accepts a first argument
  that is a `.json` file whose base name is the MediaForge host manifest, followed by the add-on ID.

## Privacy and permissions

Permissions: `webRequest`, `nativeMessaging`, `storage`, `tabs`, `cookies`, and host permission
`<all_urls>`. Nothing else. No remote code, no analytics, no network calls from the extension.
Its only outbound channel is the native pipe to the local machine.

- The Cookie header is read at click time, sent once, and never put in `storage`.
- Candidate lists live in `storage.session` only.
- The core never writes `context` to disk or sends it back.
- Private windows follow the browser default: the extension is off there unless the user allows it.

## Errors and states

| Situation | Behavior |
| --- | --- |
| Relay not reachable | Banner "Install MediaForge" with a link. |
| Relay reachable but the core could not be started (`unavailable`) | Banner "MediaForge could not be started". |
| First-run setup | Banner "Setting up MediaForge… N%" from `setup.progress`. |
| Port drops (`core-disconnected`) | One automatic reconnect through a fresh relay, then `jobs.list` to resync. |
| No reply within 15 s | A visible error in the popup. |
| Probe unsupported | Only sniffed items are offered. |
| Download failed | The engine's message and hint. |
| Host and add-on protocol mismatch, or an older core (`incompatible`) | "Update MediaForge", downloads disabled; retried every 5 minutes. |

## Testing

- Pure logic (detector rules, stores, state machine, manifest transform) is unit-tested with Vitest
  and a fake `browser` object.
- A native-client test runs against the real `runRelay` and a real core pipe, so port, framing,
  handshake and reply path are exercised in CI without a browser.
- Context handling is tested in the core: the cookie never appears in a snapshot, a progress frame
  or a thrown error message.
- Real-browser behavior is a manual checklist: event-page suspension with an open native port,
  overlay on live sites, Firefox launching the native host, private-window behavior.

## Development workflow

`tools/dev/register-native-host.mjs` writes the host manifest and the
`HKCU\Software\Mozilla\NativeMessagingHosts\com.mediaforge.host` key pointing at the built exe.
The extension is loaded as a temporary add-on from `about:debugging`. A `--chromium` flag is added
when Chrome and Edge work starts. Fixed identifiers, chosen now so sub-project 4 only registers
what already exists: host name `com.mediaforge.host`, add-on ID `mediaforge@n-berns`.

## Out of scope

The installer, store listings and AMO signing (sub-project 4). Chrome and Edge host registration.
Auto-capture of browser downloads. Notifications. The Android app. Queue persistence across core
restarts.

## Build order

Each step is independently testable.

1. Desktop: `media.probe` and `media.info`, `context` forwarding, Firefox relay detection.
2. Extension: manifest transform, native client, state machine.
3. Extension: detector and tab store.
4. Extension: popup (list, jobs, toggles, banners).
5. Extension: overlay content script.
6. Dev registration script and the manual browser checklist.

## Open questions

- **Event-page suspension with an open native port** on current Firefox. Verified in step 2; a
  keep-alive alarm is the fallback.
- **Probing logged-in pages.** `media.probe` runs without cookies in this sub-project, so a page
  that needs a login is reported unsupported and falls back to sniffed items. Whether to send
  cookies with probes is decided after real use.
- **Chrome and Edge host IDs.** Their extension IDs are fixed at first store upload, which belongs
  to sub-project 4.
