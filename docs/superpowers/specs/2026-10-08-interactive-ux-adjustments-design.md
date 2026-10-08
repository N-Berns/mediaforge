# Interactive mode UX adjustments

Date: 2026-10-08
Status: draft, awaiting review
Scope: the interactive app in `apps/desktop/src/interactive`. The release and distribution work is in a separate spec (`2026-10-08-release-distribution-design.md`).

## Goal

Fix five usability gaps found while using the interactive app:

1. The default download folder can only be typed or pasted.
2. The batch Type step applies one type to every link, even links that cannot provide it.
3. Nothing tells users where to find the list of supported sites.
4. Esc only toggles between two screens instead of walking back through history.
5. There is no About page.

## Decisions

| Topic            | Decision                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Folder selection | A built-in folder browser screen, reused in Settings and in the download-time Folder step. No native OS dialog.  |
| Batch type       | Pick per type. A preset applies only to links that support that type. Links not yet covered are asked again.     |
| Sites hint       | Link entry screen, the unsupported-site error (interactive and CLI), and the About page. Not in `--help`.        |
| Esc              | A real back stack, skipping transient screens. Esc on Home asks to quit.                                         |
| About            | A Home row with app, tool, config, developer and notices info. Developer part is minimal: handle plus repo link. |

## 1. Folder browser

New screen `FolderBrowserScreen`.

- **Start location:** the current or default folder. If it does not exist, its nearest existing parent.
- **Rows, in order:** `Choose this folder`, `New folder…`, `.. (up)`, then subfolders sorted by name. Hidden folders (dot-prefixed on all systems, hidden attribute on Windows where cheap to read) are not listed. Long lists scroll through the existing `Menu`.
- **Header:** the full current path.
- **Windows:** at a drive root, `..` becomes a `Drives` row listing available drive letters.
- **Errors:** a folder that cannot be read (permission denied) shows an inline message and keeps the user in place. `New folder…` takes a name through the existing `TextField`, creates it, and enters it. Invalid names show an error.
- **Where it appears:** Settings > Folder and the download-time `FolderScreen` (single and batch) each offer `Browse…` and `Type or paste a path`, plus the existing default option on `FolderScreen`.
- **Paste box tip,** shown under the field, per OS:
  - Windows: "Ctrl+V pastes. In File Explorer, Shift+right-click a folder, then choose Copy as path."
  - macOS: "In Finder, right-click the folder, hold Option, then choose Copy as Pathname."
  - Linux: "Copy the path from your file manager's location bar."
- **Testability:** directory listing and creation go through an injected `fs` in `deps`, like the settings store.

## 2. Batch Type step

`BatchQualityScreen` is replaced by a sectioned screen.

- **Sections:** Video with audio, Video only, Audio only. Each header shows how many of the links still waiting can use it, e.g. `Video with audio · 3 of 4 links`. Each section lists its presets (`PRESETS[kind]`). A section with zero applicable links is greyed out and cannot be selected.
- **Applicability:** from `availableKinds(info)` per link. A link without details (lookup skipped or failed) counts as able to take any type and is flagged. A link with no usable formats at all is marked "no downloadable formats", is excluded from assignment, and does not block Review.
- **Flow:** choosing a preset assigns it to all waiting links that support that type. The screen then shows `N links still need a type` and recounts the sections over the remaining links. This repeats until none remain, then the flow continues to Review. If every link is covered by the first pick, there is no second round.
- **Review:** shows the per-link result as today. `Change all` clears the assignments and returns here. Per-link overrides keep working. `choiceWarning` remains only for links without details.
- **Data:** each batch item stores its assigned choice. The single batch-wide `base` choice goes away.

## 3. Supported-sites hint

- One exported constant, `SUPPORTED_SITES_URL = "https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md"`.
- Link entry screen: a muted line under the link box, "Not sure a site works? Full list: <url>".
- Unsupported-site failures (exit code 5): the what-to-try hint includes the URL, on the interactive error screen and in the CLI error text.
- About page: a `Supported sites` row.
- The URL is printed as plain text so terminals can make it clickable. No escape-sequence hyperlinks.

## 4. Esc as a back stack

A small navigation module: a stack with `push`, `back`, `replace` and `reset`.

- `App` uses it for top-level screens. `BatchFlow` uses the same module for its inner stages and exposes its own root, so popping past the first batch stage returns to the App-level stack.
- Each entry holds its own snapshot (draft, settings, selected rows), so going back restores what the user had.
- **Transient screens use `replace`,** so Esc never lands on them: link lookup, batch lookup, and a running or finished download.
- **During a download,** Esc cancels it, as today, then pops to the page before the download.
- **On the Result screen,** Esc goes Home and resets the stack. A finished download is the end of that session.
- **On Home,** Esc shows "Quit MediaForge? (Y/N)". Ctrl+C behaviour is unchanged.
- **Bug this fixes:** in the batch flow, Review's back goes to Quality and Quality's back goes to Review, so Esc alternates between them. With one stack, each Esc moves one step further back.

## 5. About page

New `AboutScreen`, a Home row after "Check setup" and before "Quit". Number-key jumps are renumbered accordingly. Contents:

- App name, version, and build target (OS and arch).
- Each tool: version, source (`env`, `path`, `bundled`, and `cache` once the release work lands), and path. This reuses the data behind Check setup.
- Config file path.
- Developer: the handle `N-Berns` and the repo link. The repo link stays a placeholder constant until the GitHub URL exists.
- Supported sites link.
- Third-party notices: yt-dlp (Unlicense) and ffmpeg (LGPL, with its license text location). MediaForge's own license is added once chosen.

## Testing

- **Unit:** the navigation stack operations; directory listing and creation with an injected fs, including unreadable folders and invalid names; the per-type assignment logic, including links without details and links with no usable formats.
- **Interactive (`App.test.tsx`):** Esc through a batch (Link, Type, Review, back, back); the folder browser opened from Settings and from the Folder step; Esc on Home; Esc during a download; the About screen renders the tool rows.

## Out of scope

A native OS folder dialog; hyperlink escape sequences; the `--help` sites line; moving the app's config location.
