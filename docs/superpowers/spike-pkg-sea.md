# Spike: packaging with `@yao-pkg/pkg --sea`

Date: 2026-10-08. Tool: `@yao-pkg/pkg` 6.23.0 (root devDependency). Host: Windows x64, Node 22.15.0.
pkg downloaded Node 22.23.3 base binaries for the targets.

## Decision (PROVISIONAL, local only)

**Option 1 holds for win-x64, with two required changes (staging a `package.json` and replacing
`promisify(execFile)`). `--sea` on Node 22 works.** No fallback to
Node 24 Standard was needed. The decision is provisional: only win-x64 was executed (on this
machine). The other four targets built but have not been run. See "Still to verify by the user".

If the native-runner checks fail for a target, apply option 2 (Node 24 Standard: in Task 19 set
`PKG_NODE = "node24"` and `PKG_MODE_ARGS = []` in `tools/release/targets.mjs`). If both fail,
option 3 (reopen the build-tool choice, new Phase D).

## Final implementation

The release build does not use the spike scripts. The staging step (bundle plus a `package.json`
beside it, then pkg in enhanced SEA mode) lives in `tools/release/build-binaries.mjs`, with the
targets in `tools/release/targets.mjs`, and the `promisify(execFile)` fix is in the source. The
command lines under "Working command lines" are the spike's originals and predate that script.

## Findings that change Task 19

1. **Simple `--sea` (a plain `.js` input) cannot run this bundle.** Simple SEA runs the entry as CJS,
   so the ESM bundle fails at start: `SyntaxError: Cannot use import statement outside a module`.
   The bundle cannot be made CJS: esbuild rejects `format: "cjs"` because Ink and yoga-layout use
   top-level await (`yoga-layout/dist/src/index.js`, `ink/build/reconciler.js`,
   `ink/build/devtools.js`) and so does `src/main.ts`.
   **Fix: use pkg's "enhanced SEA" mode.** It is selected when the input is a `package.json`
   (not a `.js` file). It handles ESM with top-level await through its own CJS bootstrap. Stage the
   bundle as `<stage>/main.js` next to a `<stage>/package.json`:
   `{"name":"...","version":"0.1.0","type":"module","bin":"main.js"}` and pass that
   `package.json` to pkg. `build.mjs` itself keeps `format: "esm"` and the `createRequire` banner
   unchanged.
2. **`promisify(execFile)` breaks inside the binary.** pkg patches `child_process.execFile`, and the
   patched function has lost `util.promisify.custom`. `promisify(execFile)(...)` then resolves to
   the stdout string instead of `{ stdout, stderr }`, so `.stdout` is `undefined`. In the binary,
   `doctor` reported both tools "(not runnable)", even though they run fine under plain Node.
   Affected source: `packages/binary-resolver/src/resolve.ts` (`execFileAsync`, line 7) and
   `apps/desktop/src/interactive/clipboard.ts` (line 4).
   **Fix (source change, not done in this spike):** replace `promisify(execFile)` with an explicit
   Promise wrapper that uses the callback form:
   `new Promise((res, rej) => execFile(path, args, opts, (e, stdout, stderr) => e ? rej(e) : res({ stdout, stderr })))`.
   Proven with `spike/build-patched.mjs`, which rewrites the call at bundle time. `spawn` and
   `spawnSync` are unaffected.
3. **No change to `apps/desktop/build.mjs` is needed** (format, banner, alias and define all work as
   they are). Only the staging step (a `package.json` beside the bundle) and the source fix in
   finding 2 are new. `import.meta.dirname` in `src/binaries.ts` is harmless: in the binary,
   `execPath` is not `node`, so the bundled dir is `<dir of the exe>/bin`, as designed.

Minor: pkg prints `Cannot stat, ENOENT .../package.json` for a `package.json` one level above the
staged bundle (Ink looks for it). It is a warning and the build still works.
Cross-building a macOS arm64 binary on a non-Mac prints a notice that it must be ad-hoc signed
(`codesign --sign -` on a Mac, or `ldid` on Linux). The workflow signs it on the macOS runner.

## Working command lines

```bash
# 1. bundle (apps/desktop): ESM, same options as build.mjs
cd apps/desktop && node spike/build.mjs        # real code
cd apps/desktop && node spike/build-patched.mjs   # same, with promisify(execFile) swapped out

# 2. stage: bundle plus a package.json that has "type":"module" and "bin"
#    out/spike/stage-main/{main.js,package.json}   (main.js = dist/main.js)

# 3. package
pnpm exec pkg out/spike/stage-main/package.json --sea --targets node22-win-x64 --output out/spike/mediaforge-win-x64.exe
```

Targets use `node22-<win-x64|linux-x64|linux-arm64|macos-x64|macos-arm64>`. `--targets` takes one
Node major per run (enhanced SEA rejects mixed majors).

## Results

Run locally on Windows x64 unless noted. "built" means pkg produced the binary here (cross-build).

| Target | Built (ui / app) | UI_OK | SPAWN_OK | `--version` | `doctor` |
| --- | --- | --- | --- | --- | --- |
| win-x64 | yes / yes (84.3 MB / 84.6 MB) | pass | pass | `0.1.0` pass | pass with the execFile fix (bundled tools found); fails without it |
| linux-x64 | yes / yes (126.2 MB / 126.5 MB) | not run | not run | not run | not run |
| linux-arm64 | yes / yes (123.6 MB / 123.9 MB) | not run | not run | not run | not run |
| macos-x64 | yes / yes (115.6 MB / 115.8 MB) | not run | not run | not run | not run |
| macos-arm64 | yes / yes (113.1 MB / 113.4 MB) | not run | not run | not run | not run |

win-x64 details (all with the staged enhanced-SEA binaries):

- `ui-win-x64.exe` prints `UI_OK` and `SPAWN_OK`. This proves Ink and Yoga's wasm render in the
  binary and that a child process can be spawned. Plain `node dist/spike-ui.js` printed the same.
- `mediaforge-win-x64.exe --version` prints `0.1.0`.
- `doctor` with `MEDIAFORGE_BIN_DIR` or the exe-adjacent `bin/` and a PATH without the tools:
  yt-dlp `2026.08.19` and ffmpeg `9.0.2` both found as `bundled`, at `out/spike/bin`. Without the
  execFile fix: "NOT FOUND ... (not runnable)", exit 3.
- Real run, bundled tools only (PATH stripped): `formats https://www.youtube.com/watch?v=jNQXAC9IVRw`
  lists formats, and `download <same url> -p mp4-720p -o out/spike/dl` produced
  `Video/Me at the zoo.mp4`. This proves `spawn` of yt-dlp and ffmpeg (merge) inside the binary.
  Non-TTY, so progress was only `queued / downloading / processing`.

## Manual TUI and download check (Step 4)

Not done: it needs a real terminal and cannot run headless. See below.

## Still to verify by the user

1. Interactive TUI on win-x64, in a real terminal (not the IDE panel): run
   `out/spike/mediaforge-patched-win-x64.exe` (built from the patched bundle; the unpatched
   `mediaforge-win-x64.exe` shows tools as not runnable). Check: logo and menu render, arrow keys
   and Esc work, "Check setup" shows yt-dlp and ffmpeg as found (bundled), and a real
   `download <url> -p mp4-720p` shows live progress and writes a file. Raw-mode input is the one
   Ink feature not exercised headlessly.
2. Push the branch and run the **Spike pkg** workflow (`.github/workflows/spike-pkg.yml`,
   workflow_dispatch) from the Actions tab. Expect all five `run` jobs to print `UI_OK`,
   `SPAWN_OK`, `0.1.0` and a `doctor` JSON document (tools will show not found on the runners;
   that is expected, the point is that the binary starts):
   1. windows-latest (win-x64)
   2. ubuntu-24.04 (linux-x64)
   3. ubuntu-24.04-arm (linux-arm64)
   4. macos-15-intel (macos-x64), including the `codesign --sign -` step
   5. macos-15 (macos-arm64), including the `codesign --sign -` step
3. If a runner label is rejected (`macos-15-intel`, `ubuntu-24.04-arm`), substitute the label that
   GitHub currently lists, everywhere it appears in the plan.
4. Update the decision above from PROVISIONAL to final once the five jobs pass.

Note: the workflow differs from the plan's text. The plan's version runs
`pkg apps/desktop/dist/main.js --sea`, which produces binaries that die with the ESM `SyntaxError`
(finding 1). The committed workflow stages a `package.json` and uses `build-patched.mjs`.

## Spike files (deleted in Task 25)

- `apps/desktop/spike/ui.tsx`, `build.mjs`, `build-patched.mjs`
- `.github/workflows/spike-pkg.yml`
