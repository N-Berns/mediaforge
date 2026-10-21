# yt-dlp Channels and Manual Update Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users pick the yt-dlp channel (stable, nightly, master) and run a manual check that shows installed vs latest for yt-dlp and ffmpeg and installs only after confirmation.

**Architecture:** `installTool` gains an optional live `ToolSource` resolver. For yt-dlp on `nightly`/`master` it resolves the newest release of the matching GitHub repo and verifies the download against that release's `SHA2-256SUMS`. For ffmpeg it resolves the newest BtbN build and verifies against its checksums file. `stable` and any tool without a live resolver keep using `tools.lock.json`. The channel is a persisted `ytDlpChannel` setting. A new `checkTools` function backs both `mediaforge update --check` and the interactive Update screen.

**Tech Stack:** TypeScript (Node, ESM), Ink/React TUI, Vitest, Biome, pnpm workspaces.

**Spec:** Decisions from the 2026-10-21 conversation, which build on `docs/superpowers/specs/2026-10-08-release-distribution-design.md`. That spec's "no background checks" rule still holds: every check is user-triggered. Its "`mediaforge update` never touches ffmpeg" rule is **superseded** for `update --check` and the Update screen only. Plain `mediaforge update` keeps updating only yt-dlp.

## Global Constraints

- Channels are exactly `"stable" | "nightly" | "master"`. Default is `"nightly"`.
- Repos: nightly is `https://github.com/yt-dlp/yt-dlp-nightly-builds`, master is `https://github.com/yt-dlp/yt-dlp-master-builds`, stable is `tools.lock.json` (pinned by `pin-ytdlp.mjs`).
- Every download is SHA-256 verified before anything is unpacked or made executable (existing `installTool` guarantee). No unverified channel.
- URLs must be https, except a loopback server for tests and the smoke test (existing `validateLock` rule).
- No background or automatic update checks. The user confirms before any install.
- `MEDIAFORGE_YTDLP_PATH` and a PATH yt-dlp still shadow the cache. Keep the existing "shadowed" warning.
- The working tree has uncommitted lock-pinning changes (`sources.ts`, `lock.ts`, `install.ts`, `tools.lock.json`, `pin-*.mjs`). Build on them. Do not revert them.
- The user creates commits. Tasks end with a proposed commit message only (see CLAUDE.md). After any file change made outside Write/Edit, run `pnpm exec biome check --write <paths>`. Run `pnpm lint` and `pnpm typecheck` at the end.

## Review Focus

- Release exists but its checksum file has no entry for this target's asset: fail with `no-source`, install nothing.
- `releases/latest` redirect has no tag, or GitHub rate-limits (403/429): clear `ToolInstallError`, existing copy untouched.
- Offline during a check: the check reports "could not check" per tool and still lists the installed versions, with no crash.
- Stored `ytDlpChannel` is hand-edited to garbage: falls back to `nightly`.
- Switching channel to `stable` when the cache holds a newer nightly: the install must replace it (the version differs), so "already up to date" compares channel-resolved versions only.
- A shadowing PATH yt-dlp: `--check` must say the cached copy is not the one in use.

## File Structure

- Modify `packages/binary-resolver/src/sources.ts`: live resolvers `resolveYtDlpSource(target, channel, fetch)` and `resolveFfmpegSource(target, fetch)`, plus `YtDlpChannel`.
- Modify `packages/binary-resolver/src/install.ts`: `InstallRequest.source?` is resolved by the caller. `installTool` resolves through an optional `deps.resolveSource`. Add `checkForTool`.
- Modify `packages/binary-resolver/src/index.ts`: export the new names.
- Modify `apps/desktop/src/settings.ts`: `ytDlpChannel` setting and sanitizing.
- Modify `apps/desktop/src/tool-runtime.ts`: the runtime reads the channel and passes it to install and check.
- Modify `apps/desktop/src/tool-commands.ts`: `--channel`, `--check`.
- Modify `apps/desktop/src/interactive/screens/UpdateScreen.tsx` and the Settings screen: channel picker and check/confirm flow.
- Tests live beside each file (`*.test.ts[x]`).

## Task 1: Live yt-dlp source resolver

**Files:**
- Modify: `packages/binary-resolver/src/sources.ts`
- Test: `packages/binary-resolver/src/sources.test.ts`

**Interfaces:**
- Consumes: `request(fetchFn, url, init)` from `download-file.ts`, `httpError` and `ToolInstallError` from `errors.ts`, `FetchLike` from `install-types.ts`, `Target`/`targetKey` from `target.ts`.
- Produces: `type YtDlpChannel = "stable" | "nightly" | "master"`, `YTDLP_CHANNELS: readonly YtDlpChannel[]`, `YTDLP_REPOS: Record<"nightly" | "master", string>`, `YTDLP_ASSETS: Record<string, string>` (restore the HEAD map: `win32-x64` to `yt-dlp.exe`, `linux-x64` to `yt-dlp_linux`, `linux-arm64` to `yt-dlp_linux_aarch64`), and `resolveYtDlpSource(target: Target, channel: "nightly" | "master", fetchFn: FetchLike, repoOverride?: string): Promise<ToolSource>`.

- [ ] **Step 1: Write failing tests** in `sources.test.ts` using a fake `fetchFn` (see `test-helpers.ts`). Tests: `resolves the newest nightly tag and its sha` (redirect `Location: .../releases/tag/2026.10.20.123`, sums file has the `yt-dlp.exe` line, expects `{ version: "2026.10.20.123", url: <repo>/releases/download/<tag>/yt-dlp.exe, sha256, archive: "none" }`); `uses the master repo for master`; `throws no-source when the sums file lacks the asset`; `throws http error on 403`; `throws unsupported for an unknown target`.
- [ ] **Step 2: Run** `pnpm vitest run packages/binary-resolver/src/sources.test.ts`. Expected: FAIL (resolver undefined).
- [ ] **Step 3: Implement** by restoring `latestTag` and `resolveYtDlpSource` from `git show HEAD:packages/binary-resolver/src/sources.ts`, adding the `channel` parameter that picks the repo from `YTDLP_REPOS`. Return `member` undefined, `archive: "none"`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Propose commit:** `✨ binary-resolver: resolve yt-dlp nightly and master builds`.

## Task 2: Live ffmpeg source resolver

**Files:**
- Modify: `packages/binary-resolver/src/sources.ts`
- Test: `packages/binary-resolver/src/sources.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers (`latestTag`, `parseSha256Sums`). The BtbN asset names and archive kinds per target already live in `tools.lock.json` and `tools/release/pin-lib.mjs`, so read them from there (mirror the `FFMPEG_TARGETS` rule).
- Produces: `resolveFfmpegSource(target: Target, fetchFn: FetchLike): Promise<ToolSource>`. Same shape as the pinned source, with `member` and `archive` from the target rule.

- [ ] **Step 1: Write failing tests:** `resolves the newest BtbN build and verifies against checksums.sha256`, `throws no-source when the asset is missing from the checksums`, `throws unsupported for a target BtbN has no build for`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** `resolveFfmpegSource` against `https://github.com/BtbN/FFmpeg-Builds`. Note that BtbN's `latest` tag is a rolling tag, so resolve the newest dated release tag from `/releases` and read its `checksums.sha256`. Confirm the actual asset and checksum file names against `pin-ffmpeg.mjs` before coding.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Propose commit:** `✨ binary-resolver: resolve the newest ffmpeg build`.

## Task 3: Install through a resolver, and check what is available

**Files:**
- Modify: `packages/binary-resolver/src/install.ts`, `packages/binary-resolver/src/install-types.ts`, `packages/binary-resolver/src/index.ts`
- Test: `packages/binary-resolver/src/install.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - `InstallDeps.resolveSource?: (tool: Tool, target: Target) => Promise<ToolSource>`. When present, `installTool` uses it instead of `pinnedSource` (line 84).
  - `ToolCheck = { tool: Tool; installed?: string; latest?: string; upToDate: boolean; error?: string }`.
  - `checkTool(tool: Tool, target: Target, dir: string, deps: InstallDeps): Promise<ToolCheck>`. It reads the manifest version, resolves the source, and compares versions. A resolver failure becomes `error` and does not throw.

- [ ] **Step 1: Write failing tests:** `installTool uses deps.resolveSource when given`, `installTool still verifies the sha of a resolved source` (wrong hash gives a checksum error and no file in `dir`), `checkTool reports upToDate false when versions differ`, `checkTool returns error instead of throwing when resolving fails`, `checkTool reports installed undefined when nothing is cached`.
- [ ] **Step 2: Run** `pnpm vitest run packages/binary-resolver/src/install.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both. Reuse `isOutdated` (install.ts:48) for the manifest read where it fits.
- [ ] **Step 4: Run.** Expected: PASS, and `pnpm typecheck` clean.
- [ ] **Step 5: Propose commit:** `✨ binary-resolver: install from a live source and check for newer builds`.

## Task 4: `ytDlpChannel` setting

**Files:**
- Modify: `apps/desktop/src/settings.ts`
- Test: `apps/desktop/src/settings.test.ts`

**Interfaces:**
- Consumes: `YtDlpChannel` from `@mediaforge/binary-resolver`.
- Produces: `Settings.ytDlpChannel: YtDlpChannel`, `DEFAULT_SETTINGS.ytDlpChannel = "nightly"`. `sanitizeSettings` keeps a valid value and falls back to the default otherwise.

- [ ] **Step 1: Write failing tests:** `defaults ytDlpChannel to nightly`, `keeps a valid channel`, `falls back to nightly for an unknown or non-string value`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** with a type guard modelled on `isPreset`. Update every `Settings` literal in existing tests, as the phase-3b plan did for `managerSort`.
- [ ] **Step 4: Run** `pnpm vitest run apps/desktop/src/settings.test.ts` and `pnpm typecheck`. Expected: PASS and clean.
- [ ] **Step 5: Propose commit:** `✨ desktop: add the yt-dlp channel setting`.

## Task 5: Runtime wiring

**Files:**
- Modify: `apps/desktop/src/tool-runtime.ts`, `apps/desktop/src/test-runtime.ts`
- Test: `apps/desktop/src/tool-runtime.test.ts` (create if absent)

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces: `ToolRuntime.install(tool, onProgress, opts?: { channel?: YtDlpChannel })`, and `ToolRuntime.check(tools: Tool[], opts?: { channel?: YtDlpChannel }): Promise<ToolCheck[]>`. For yt-dlp on `stable`, `deps.resolveSource` falls through to the lock. On `nightly`/`master` it calls `resolveYtDlpSource`. For ffmpeg, `check` uses `resolveFfmpegSource` while `install` stays lock-pinned unless `opts.live` is set (the Update screen sets it after confirm). `defaultToolRuntime` reads the channel from the settings store. When an install changes the channel, `forgetResolvedTools()` still runs.

- [ ] **Step 1: Write failing tests** using the existing `ToolRuntime` fakes: `install passes the saved channel to the yt-dlp resolver`, `install with stable uses the lock`, `check calls the resolver for both tools and never installs`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new tests and the whole `apps/desktop` suite for regressions (`provisioner.test.ts`, `tool-commands.test.ts`). Expected: PASS.
- [ ] **Step 5: Propose commit:** `♻️ desktop: install and check tools through the selected channel`.

## Task 6: CLI `--channel` and `--check`

**Files:**
- Modify: `apps/desktop/src/tool-commands.ts`, `apps/desktop/src/commands.ts` (summary text)
- Test: `apps/desktop/src/tool-commands.test.ts`

**Interfaces:**
- Consumes: Task 5 runtime.
- Produces: `mediaforge update [--channel stable|nightly|master] [--check]`. `--channel X` installs from X and saves it. A bad value gives `CliError(..., ExitCode.Usage)`. `--check` prints one line per tool and installs nothing, for example `yt-dlp  2026.08.19 -> 2026.10.20.123 (nightly)  update available` or `ffmpeg   9.0.2 up to date`. It exits `ExitCode.Ok` either way, and per-tool errors print `could not check: <message>`. When a shadowing yt-dlp exists, print the existing "no effect" note after the lines.

- [ ] **Step 1: Write failing tests:** `update --channel master installs from master and saves the setting`, `update --channel bogus exits with usage`, `update --check lists versions and installs nothing`, `update --check survives an offline resolver`, `update --check notes a shadowing yt-dlp`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/tool-commands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Update `UPDATE_USAGE`, `updateUsage()`, README line 134, and `docs/desktop-cli-checklist.md`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Propose commit:** `✨ desktop: add --channel and --check to update`.

## Task 7: Interactive Update screen and Settings picker

**Files:**
- Modify: `apps/desktop/src/interactive/screens/UpdateScreen.tsx`, the Settings screen, `apps/desktop/src/interactive/deps.ts`
- Test: `apps/desktop/src/interactive/App.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`deps.checkTools`, `deps.installTool(tool, onProgress, opts)`).
- Produces: UpdateScreen opens in a "checking" state, then lists each tool as installed vs latest. The menu is "Update yt-dlp", "Update ffmpeg" (only for rows with an update), "Update all", "Back". Nothing downloads until chosen. The existing flow from a failed download (stale extractor, "Update yt-dlp and retry") keeps working: it still installs straight away because the user has already chosen to update. Settings gets a "yt-dlp channel" row that cycles stable, nightly, master.

- [ ] **Step 1: Write failing tests:** `Update screen lists versions and downloads nothing until chosen`, `choosing Update yt-dlp installs and returns`, `an offline check shows the installed versions and a retry`, `settings cycles the channel and saves it`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/interactive/App.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** and update the stale `UpdateScreen` comment ("Downloads the latest yt-dlp").
- [ ] **Step 4: Run** the file, then `pnpm typecheck` and `pnpm lint`. Expected: PASS and clean.
- [ ] **Step 5: Propose commit:** `✨ desktop: add a manual update check and channel picker`.

## Task 8: Docs and release checks

**Files:**
- Modify: `docs/releasing.md:76`, `README.md`, `docs/desktop-cli-checklist.md`, `docs/security-testing.md` if it describes update trust
- Modify: `tools/release/smoke-server.mjs` only if the smoke test exercises `update`

- [ ] **Step 1:** State in `docs/releasing.md` that stable is lock-pinned while nightly, master and the ffmpeg check are verified against each release's checksum file, and that all of them are user-triggered.
- [ ] **Step 2:** Run `pnpm lint`, `pnpm typecheck`, `pnpm test`. Expected: all green.
- [ ] **Step 3:** Manual check on the real binary: `mediaforge update --channel master`, then `yt-dlp -v "https://www.facebook.com/share/r/1DnCNi2EYk/"` against the cached copy. Report honestly whether Facebook parses.
- [ ] **Step 4: Propose commit:** `📝 document yt-dlp channels and the update check`.

## Task 9: Thinner, closable, movable overlay button with feedback

Added mid-run at the user's request; independent of Tasks 1 to 8.

**Files:**
- Modify: `apps/extension/src/content/overlay.ts` (button creation near `ensureButton`, `BUTTON_STYLE`), `apps/extension/src/content/overlay-logic.ts` (placement helpers)
- Test: `apps/extension/src/content/overlay-logic.test.ts`

**Interfaces:**
- Consumes: `placeButton(rect, scroll, button)`, `BRAND`, `INSET` in `overlay-logic.ts`.
- Produces (pure, unit-tested in `overlay-logic.ts`): `applyDrag(origin: {top:number;left:number}, delta: {dx:number;dy:number}, bounds: {width:number;height:number}, button: {width:number;height:number}): {top:number;left:number}` clamping inside the document bounds; `isDrag(delta: {dx:number;dy:number}): boolean` with a 4px threshold so a click is not swallowed; `placeButton` gains an optional `offset?: {dx:number;dy:number}` added to the default top-right position.

User decisions: the button is about 22px tall (down from about 30px: smaller icon, 11px text, tighter padding). A close (x) button inside the pill hides the overlay for that video until the page reloads (module-level state only; nothing stored). The user can drag the pill; the offset is kept per video element until reload (module-level `WeakMap<HTMLMediaElement, {dx;dy}>`) and follows the video when it resizes or scrolls. Feedback: hover brightens background and border; press (`pointerdown`) darkens the fill and shifts 1px; keep the existing busy dim with the "Opening…" label; `focus-visible` outline; `cursor: grab` on the pill and `grabbing` while dragging.

- [ ] **Step 1: Write failing tests** in `overlay-logic.test.ts`: `placeButton adds the offset`, `applyDrag moves by the delta`, `applyDrag keeps the button inside the bounds on every edge`, `isDrag is false under 4px and true at or above it`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/src/content/overlay-logic.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, then wire `overlay.ts`: pointer events on the pill (not on the close button) drive the drag, using pointer capture; a drag must not fire the download click; the close button calls a `dismiss(target)` that hides the host and records the element in a `WeakSet` so `show` skips it until reload; all existing `stopPropagation` guards for page players stay.
- [ ] **Step 4: Run** the test file, then `pnpm vitest run apps/extension` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Manual check** in a Chromium build with a real page video: thin look, hover and press feedback, drag then click still downloads, close hides until reload, position survives a window resize. Report honestly what was and was not checked.
- [ ] **Step 6: Propose commit:** `💄 extension: make the overlay thinner, closable and movable`.

## Self-review notes

- Coverage: channels (T1, T4), default nightly (T4), settings and CLI flag (T4, T6), verified live fetch (T1 to T3), ffmpeg newest BtbN (T2), check and confirm (T3, T6, T7), no background checks (constraints).
- Open point for the implementer to verify, not guess: the exact BtbN release tag and checksum file naming (Task 2 step 3).
- Not covered by design: extension popup surface (declined), a `--channel` flag on ffmpeg.
