# Publishing the Firefox add-on

How to submit the MediaForge extension to addons.mozilla.org (AMO): what to check first, what to upload, and the text for each field. The add-on ID is `mediaforge@n-berns` (`FIREFOX_ADDON_ID` in `packages/shared-protocol/src/host.ts`); never change it, or installed copies stop updating and the app stops accepting them.

## Before the first submission

1. A Firefox account with two-step authentication, signed in at <https://addons.mozilla.org/developers/>.
2. The GitHub repository and its releases are public. Reviewers download the app from there, and the popup's "Get MediaForge" link points there.
3. A published MediaForge release whose `mediaforge setup` registers the native host. Reviewers test against it, so it must exist before the add-on is submitted (see `docs/releasing.md`).

## Before each submission

1. Raise `version` in `apps/extension/package.json`. AMO refuses a version it already has.
2. `pnpm typecheck`, `pnpm test` and `pnpm lint` pass.
3. Build and check the add-on:

   ```sh
   pnpm --filter @mediaforge/extension pack:firefox
   ```

   This builds `apps/extension/dist/firefox`, runs `web-ext lint` on it (it must report 0 errors and 0 warnings), and writes `apps/extension/dist/artifacts/mediaforge-firefox-<version>.xpi`.
4. Make the source archive reviewers rebuild from. It holds the tracked files of the commit, nothing ignored:

   ```sh
   git archive --format=zip --output mediaforge-source-<version>.zip HEAD
   ```

   Commit everything first: the archive is built from `HEAD`, not from the working tree.

## Upload

On AMO: **Submit a New Add-on** (or **Upload New Version** on the add-on's page), choose **On this site**, upload the `.xpi`. When asked whether the code is generated or minified, answer **Yes** (esbuild bundles it) and upload the source archive with the build notes below.

## Notes for reviewers

Paste this into **Notes to Reviewer**:

```text
MediaForge is a browser front end for the MediaForge desktop app (MIT, https://github.com/N-Berns/mediaforge). The add-on finds the media on a page and hands it to the app through native messaging (host name com.mediaforge.host); the app downloads it with yt-dlp and ffmpeg on the user's computer. Without the app, the popup shows "Install MediaForge" and a link to the releases.

The add-on loads no remote code. The only data it sends anywhere is a bug report the user writes and sends from the popup (Google Form); it asks for the optional technicalAndInteraction and browsingActivity data-collection permissions first.

To test on Windows:
1. In PowerShell: irm https://github.com/N-Berns/mediaforge/releases/latest/download/install.ps1 | iex
   This installs mediaforge.exe in %LOCALAPPDATA%\MediaForge, downloads yt-dlp/ffmpeg/Deno, and registers the native host for Firefox (HKCU\Software\Mozilla\NativeMessagingHosts\com.mediaforge.host).
2. Install the add-on, open a page with a video (e.g. a Vimeo or Wikimedia Commons video), and use the Download button over the video or the toolbar popup.
3. `mediaforge doctor` shows whether Firefox is registered.
On Linux: curl -fsSL https://github.com/N-Berns/mediaforge/releases/latest/download/install.sh | sh

To build the add-on from the source archive:
- Node.js 22 or newer, pnpm 11 (corepack enable, or npm i -g pnpm@11)
- pnpm install --frozen-lockfile
- pnpm --filter @mediaforge/extension pack:firefox
- The build is apps/extension/dist/firefox; the packed file is apps/extension/dist/artifacts/mediaforge-firefox-<version>.xpi
Entry points: apps/extension/src/background/index.ts, src/popup/index.ts, src/content/overlay.ts; the manifest is generated from src/manifest.ts by apps/extension/build.mjs.
```

## Listing

| Field | Value |
| --- | --- |
| Name | MediaForge |
| Add-on URL | `mediaforge` |
| Summary | See below |
| Categories | Download Management |
| Support email | Leave empty |
| Support site | <https://github.com/N-Berns/mediaforge/issues> |
| Homepage | <https://github.com/N-Berns/mediaforge> |
| License | MIT License |
| Privacy policy | Yes: paste `PRIVACY.md` |
| Requires payment | No |
| Tags | download, video, audio, yt-dlp |

Summary (at most 250 characters):

```text
Download the video and audio on a page with the free MediaForge app on your computer. Pick the quality, add subtitles, and follow your downloads from the toolbar. Needs the MediaForge app.
```

Description:

```text
MediaForge connects Firefox to the free, open-source MediaForge app on your computer, which downloads with yt-dlp and ffmpeg. It works on most video sites yt-dlp supports, including YouTube.

What it does:
• A Download button over videos on the page.
• The toolbar popup lists the video and audio the page has, with the qualities on offer.
• Choose the quality, video only or audio only, and subtitles.
• Follow your downloads in the popup: progress, pause, resume, cancel, and a speed limit.
• Downloads on sites you are signed in to work, because the add-on passes that site's cookies to the app when you click Download.

Requires the MediaForge app (Windows or Linux): https://github.com/N-Berns/mediaforge/releases/latest

Privacy: no ads, no analytics, no tracking. What the add-on finds on a page goes only to the MediaForge app on your own computer. The only thing sent anywhere else is a bug report you choose to send, and Firefox asks you first.

Download only what you have the right to download, and respect each site's terms.
```

Screenshots (1280×800 or larger, PNG): the Download button over a video, the popup listing a page's media with the quality picker, and the popup's downloads list. Take them on a site whose content you may show.

## After approval

- Set `REVIEW_URL` in `apps/extension/src/popup/about.ts` to the add-on's AMO page, so the popup links to it.
- Link the AMO page from the README's install section.
