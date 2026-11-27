# Privacy policy

Last updated: 27 November 2026

This policy covers the MediaForge browser extension (Firefox, Chrome and other Chromium browsers) and the MediaForge app on your computer.

## In short

- MediaForge has no accounts, ads, analytics or tracking.
- The extension sends what it finds on a page only to the MediaForge app on your own computer.
- Data leaves your computer only in three cases: when MediaForge downloads from a site you chose, when the app fetches or updates its tools or checks for a new version, and when you send a bug report.
- MediaForge never sells or shares data.

## The browser extension

### What it reads and why

| What | Why | Where it goes |
| --- | --- | --- |
| The address and title of the page you are on | To show the video and audio on that page | The MediaForge app on your computer |
| The addresses of media the page loads (watched through the browser's request events) | To list streams the page plays | Kept in the browser's session memory, gone when the browser closes. Sent to the app only when you download one |
| The site's cookies for the media you download, and your browser's user agent | So downloads work on sites you are signed in to | The MediaForge app on your computer, only when you start a download |
| Your theme and font size | To remember how you like the popup | The browser's own extension storage |

The extension reads cookies only when you click Download, and only for that site. It never sends page data, cookies or browsing history to any server.

### Bug reports

The popup has a "Report a problem" form. Nothing is sent until you press Send. A report contains:

- what you typed,
- whether the problem is with the extension or the app,
- the extension and app versions, your operating system and browser,
- technical details: tool status, connection state, the current tab's address without its query (`https://example.com/watch`, never `?v=…`), the addresses of detected media without their queries, and recent error messages.

It never contains cookies, request headers or anything after `?` in an address. Reports go to a Google Form that only the developer reads. Google's privacy policy applies to the form: <https://policies.google.com/privacy>.

In Firefox 140 and later, Firefox asks your permission the first time you send a report. If you decline, nothing is sent.

## The MediaForge app

- **Downloads.** MediaForge runs yt-dlp and ffmpeg on your computer to download from the sites you choose. Those sites see the request as they would from your browser. When you download through the extension, the cookies and user agent it passed are given to yt-dlp in a file only your user account can read, in the download's work folder. That folder is removed when the download finishes or is cancelled. A paused or failed download keeps it until you resume, retry or remove the download. Cookies are never saved to the download history and are removed from logs and error messages.
- **Download history and settings** are saved on your computer only: `%APPDATA%\MediaForge` on Windows, `~/.config/mediaforge` on Linux.
- **Tools and updates.** The app downloads yt-dlp, ffmpeg and Deno from their official GitHub releases, and checks MediaForge's own GitHub releases for a new version. Like any download, these requests show GitHub your IP address. They carry nothing else about you.
- **Browser registration.** `mediaforge setup` adds entries that let your browsers start MediaForge: per-user registry keys on Windows, small files in the browsers' folders on Linux. They contain only the path to MediaForge and the extension IDs allowed to use it.
- **Bug reports** from the app work as described above, without browser details.

## Your choices

- Do not send bug reports.
- Remove the extension from your browser at any time. Its stored settings go with it.
- `mediaforge setup --no-browser` skips the browser registration.

## Contact

Questions about this policy: open an issue at <https://github.com/N-Berns/mediaforge/issues>.

## Changes

Changes to this policy are published in this file, with a new date at the top.
