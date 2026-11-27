# MediaForge browser extension: core architecture

Status: draft for review. Date: 2026-10-13. Platform scope: Windows first, Linux after Windows is tested.

## Goal

Publish an Internet Download Manager style integration, for media only. The user installs
`MediaForge.exe`, then installs the browser extension. The extension finds media and hands it to the
app. The app downloads it. The user is never asked to install yt-dlp, ffmpeg or deno.

## Decisions already made

| Topic | Decision |
| --- | --- |
| Install model | Install `MediaForge.exe`, then the extension, as IDM does. Needing the `.exe` is acceptable. |
| Third-party tools | Never user-visible. A small installer; the app downloads yt-dlp, ffmpeg and deno silently on first run and keeps yt-dlp fresh. |
| Core | `MediaForge.exe` is the core. The extension is a thin client. |
| Process model | One long-lived core process holds the engine and queue. A short-lived relay (`--native-host`) bridges the browser to it. |
| Residency | A user setting, `keepRunning`, default off. Off means on-demand: the core starts when needed and exits when idle with no jobs. In-flight downloads are never killed. |
| Extension UI | Two modes: toolbar popup only, and popup plus an in-page overlay on `<video>`. Overlay is the default. User chooses in settings. |
| Inputs | The extension sends the page URL when yt-dlp has an extractor for the site, and falls back to sniffed stream URLs. |
| Binary form | One exe with three modes (TUI, `--native-host`, `--core`). One build, one update path. A separate relay stub is a later optimization, only if startup is slow. |
| Deferred | Auto-capture of browser downloads. Linux. A GUI window. A tray icon. |

## Architecture

```
Browser extension ──native messaging (stdio, length-prefixed JSON)──▶ MediaForge.exe --native-host
                                                                              │ named pipe, token handshake
                                                                              ▼
                                                    MediaForge.exe core (single instance)
                                                    DownloadEngine · queue · tool provisioning · settings
                                                                              ▲
                                                           TUI (interactive menu) is also a client
```

`MediaForge.exe` runs in three modes:

1. **TUI** (today). Unchanged entry point. In a later step it becomes a client of the core so it and
   the extension see one queue.
2. **`--native-host`**. Started by the browser. Speaks the existing framing from
   `packages/shared-protocol` on stdio. Forwards messages to the core, spawning it detached if it is
   not running. Holds no state and exits when the browser closes the port.
3. **core** (`--core`). Owns the `DownloadEngine`, the queue, settings, and tool provisioning.
   Listens on a named pipe.

Why a relay and a core: the browser terminates the native host when the extension port closes.
Downloads must outlive tabs and the browser, so the engine cannot live in the relay.

## Decomposition

Each piece gets its own spec, plan and build, in this order.

1. **Core and relay** (this document, detailed below).
2. **Silent tool provisioning**. Removes the terminal prompt and exit-3 path for core and relay.
3. **Extension** (`apps/extension`, new). Manifest V3, Chrome and Edge first, Firefox after.
   Detection, popup, overlay, mode setting.
4. **Installer and registration**. Windows installer, native host manifest and registry keys,
   cross-linking between installer and store listing, "Install MediaForge" empty state.

## Sub-project 1: core and relay (detailed)

### Existing seams

- `DownloadEngine` (`apps/desktop/src/engine/engine.ts`) already exposes `submit`, `get`, `list`,
  `cancel`, `whenSettled` and an `onUpdate(job)` callback. The core wraps it; the engine is not
  rewritten.
- `shared-protocol` already defines `hello`, `download.start`, `download.cancel`, `host.info`,
  `hello.ack`, `download.progress`, `download.completed`, `download.failed`, `error`, with Zod schemas
  and framing (`createDecoder`, `encodeMessage`). `MediaCandidate`, `DownloadRequest` and
  `DownloadProgress` are shared types.
- Settings live in `%APPDATA%\MediaForge\config.json` through `SettingsStore`, written by
  write-then-rename. `Settings` gains new fields below.
- Tool resolution and install live in `binary-resolver` and `apps/desktop/src/tool-runtime.ts`.
  `ensureTools` currently prompts or fails with exit 3. The core uses `acquireTool` directly and
  never prompts.

### New settings fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `keepRunning` | boolean | `false` | Core stays resident, with no idle exit. When on, a per-user Run registry key starts it at login. |
| `extensionUi` | `"popup"` or `"overlay"` | `"overlay"` | Whether the extension injects the in-page button. Read by the extension through the core. |

`sanitizeSettings` keeps its rule: unknown or invalid values fall back to defaults.

### Protocol additions

`PROTOCOL_VERSION` is bumped. Additions, extension to host unless noted:

- `jobs.list`: returns all jobs. Reply `jobs.snapshot` (host to extension).
- `jobs.subscribe` / `jobs.unsubscribe`: the core pushes `download.progress`, `download.completed`,
  `download.failed` for subscribed jobs, so a popup opened late sees current state.
- `settings.get` / `settings.set`: reads and writes the settings the extension may touch
  (`extensionUi`, `keepRunning`, folder, quality). Reply `settings.value`.
- `setup.progress` (host to extension): tool provisioning state per tool, with phase and percent.
  Drives a "Setting up MediaForge… 40%" state in the popup.
- `hello.ack` gains `setup: "ready" | "installing" | "failed"` and the core's `keepRunning` value.
- `download.start` payload gains optional `context`: `{ referer?, userAgent?, cookies?, headers? }`
  for sniffed streams that need them. Exact fields are finalized in sub-project 3, but the slot is
  reserved here so the protocol is bumped once.

Host to extension messages stay under the 1 MiB Chrome cap. `jobs.snapshot` paginates if it grows.

### Core lifecycle

1. Started by the relay (detached, no console window) or by the user with `--core`.
2. Takes the pipe: `net.listen` on `\\.\pipe\mediaforge-<username>`. `EADDRINUSE` means another core
   is live; the new process exits and the relay connects to the existing one. The pipe is the
   single-instance lock, so no separate lock file.
3. Writes a random token to a per-user file under `%APPDATA%\MediaForge\`. A client's first frame
   must carry that token or the core drops the connection.
4. Starts provisioning tools in the background if any are missing, emitting `setup.progress`.
   Starts a once-per-day yt-dlp refresh using the existing update logic.
5. Idle exit: when `keepRunning` is off, no jobs are queued or running, and no client is connected,
   the core exits after a short grace period (default 60 seconds). `keepRunning` on disables this.
6. A download request that arrives before tools are ready is queued. It starts when provisioning
   completes. The extension shows setup progress meanwhile.

### Relay behavior

- Reads framed messages from stdin and forwards them over the pipe unchanged; the core validates every message with `parseExtensionMessage`.
  Writes core replies to stdout through `encodeMessage`.
- If the pipe is not reachable, spawns `MediaForge.exe --core` detached, waits up to a short timeout
  for the pipe, then connects. On timeout it replies with an `error` message (`core-unavailable`).
- Chrome cannot pass flags to a native host on Windows, so relay mode is also selected when the
  first argument is a `chrome-extension://` or `moz-extension://` origin.
- Never writes anything but protocol frames to stdout. Logs go to stderr and a log file.

### Security

- No localhost HTTP server. IPC is a per-user named pipe plus a token read from a file only the user
  can read.
- Node's named pipe default ACL allows other local users to connect, so the token handshake is the
  access control, not the pipe name.
- The native host manifest (sub-project 4) lists only our extension ID in `allowed_origins`.
- Core validates every message against the Zod schemas and the output directory against the same
  rules the TUI already uses. A request cannot make the core write outside the configured folders
  without the setting allowing it.

### Error handling

- Pipe drop: relay returns `error` to the extension and exits; the extension reconnects through a
  fresh relay.
- Core crash with jobs in flight: jobs are lost in v1. Persisting the queue is explicitly out of
  scope here and listed under open questions.
- Tool provisioning failure: `setup: "failed"` with the existing install error message and hint. The
  next core start retries.

### Testing

- Engine, settings and tool runtime are already injectable. The core takes them as dependencies.
- Pipe server and relay are tested against a real named pipe in the test run, using the shared
  framing helpers.
- Protocol additions get schema tests alongside the existing ones in `shared-protocol`.
- Idle-exit and provisioning-while-queued use fake timers and a fake tool runtime.
- Windows is the verified platform. Linux uses a Unix domain socket behind the same interface and is
  tested after Windows.

## Open questions

- **Queue persistence.** Should queued and running jobs survive a core crash or reboot? Not in v1;
  needs a decision before the extension ships.
- **Tray icon.** The Node-based exe has no GUI toolkit. `keepRunning` in v1 means the process stays
  alive hidden with a login autostart. A visible tray or GUI is a separate sub-project.
- **Relay startup time.** Measure the real startup of `--native-host` on Windows once built. If it
  is noticeably slow, extract the relay into a small separate stub. The relay is isolated (stdio in,
  pipe out), so this is cheap later.
- **Cookie and header forwarding scope** for sniffed streams. Settled in sub-project 3.
