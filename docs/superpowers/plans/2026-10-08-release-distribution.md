# Release and Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the desktop CLI as one self-contained binary per platform on GitHub Releases, with one-command installers that fetch hash-verified yt-dlp and ffmpeg into a managed per-user cache.

**Architecture:** `packages/binary-resolver` gains a tool-install library (target model, SHA-256 verified streaming download, atomic install, manifest, cache lookup step). `apps/desktop` gains `setup` and `update` commands, a lazy "download it now?" flow in the CLI and the interactive app, JS-runtime detection and stale-extractor handling. `tools/release` holds build, checksum, pin and smoke scripts; two GitHub workflows (`ci.yml`, `release.yml`) and two thin install scripts (`install/install.sh`, `install/install.ps1`) do the shipping.

**Tech Stack:** TypeScript (ESM, Node 22), Vitest, Biome, esbuild, `@yao-pkg/pkg --sea`, Ink 8 / React 19, GitHub Actions, POSIX sh, PowerShell 5.1+.

**Spec:** [docs/superpowers/specs/2026-10-08-release-distribution-design.md](../specs/2026-10-08-release-distribution-design.md). Read it before Task 1. Where this plan adds detail the spec leaves open, the plan says so ("Plan decision").

## Global Constraints

Every task's requirements include this section.

- Node 22 (`.nvmrc` is `22`, root `engines.node` is `>=22`), pnpm 11, ESM only.
- TypeScript rules from `tsconfig.base.json`: `erasableSyntaxOnly` (no enums, no constructor parameter properties, no namespaces), `verbatimModuleSyntax` (use `import type`), `noUncheckedIndexedAccess`, imports end in `.ts`. Biome: 2-space indent, 100-column lines, double quotes.
- Targets: win-x64, linux-x64, linux-arm64, macos-x64, macos-arm64. Windows on ARM runs the x64 build under emulation.
- yt-dlp and ffmpeg are downloaded from upstream, never bundled in the release.
- Resolution order per tool: env override (`MEDIAFORGE_YTDLP_PATH`, `MEDIAFORGE_FFMPEG_PATH`; an unusable override is an error), then PATH (ffmpeg at least 5.0), then `bundledDir` (`MEDIAFORGE_BIN_DIR`), then the managed cache, then `BinaryNotFoundError`. `BinarySource` gains `"cache"`.
- Cache: Windows `%LOCALAPPDATA%\MediaForge\bin`; Linux `$XDG_DATA_HOME/mediaforge/bin`, default `~/.local/share/mediaforge/bin`; macOS `~/Library/Application Support/MediaForge/bin`. `manifest.json` in it records, per tool, version, source URL, SHA256 and install time. A corrupt or missing manifest never blocks the app.
- Install rule: download to a temp file in the cache dir, verify SHA256, set the executable bit, then rename into place. A mismatch aborts, deletes the temp file, exits 4 with a distinct message. Nothing is executed before it is verified. Nothing downloads silently.
- Exit codes: a failed or corrupt tool download is 4. Disk-full and permission errors are 6. A missing tool in a non-TTY run is 3 with the hint `run: mediaforge setup`.
- yt-dlp: latest **nightly**, verified against the `SHA2-256SUMS` file of the same release. No `--channel` flag. `mediaforge update` re-downloads yt-dlp and never touches ffmpeg.
- ffmpeg: pinned per platform and architecture in `tools.lock.json`. Windows and Linux use an LGPL build from `yt-dlp/FFmpeg-Builds`. macOS uses Martin Riedl's release builds (GPL, downloaded by the user's machine, not redistributed). `brew install ffmpeg` only after the user agrees; with `--yes` it is never run.
- Install locations: `%LOCALAPPDATA%\MediaForge\mediaforge.exe` on Windows, `~/.local/bin/mediaforge` on Linux and macOS. No sudo, nothing outside the user's home.
- Signing: v0.x ships Windows unsigned and macOS ad-hoc codesigned (`codesign -s -`).
- Git rules from `CLAUDE.md`: never run `git commit`, `git push` or `gh pr create`. At the end of each task, output the commit message text for the user (gitmoji from the allowed set, scope is the package name, no `Co-Authored-By`, no "Generated with" line). Files created through Bash are not seen by the Biome hook: run `pnpm exec biome check --write <paths>` on them. Run `pnpm lint` before finishing each phase.

## Review Focus

Failure modes the spec implies but no task's tests would exercise by default. Each line is pinned by a test in the task named in brackets.

1. **Offline or truncated download during `setup`.** No partial file stays in the cache, the message names the host, exit code is 4. [Task 6 and Task 8]
2. **Cache path with spaces or non-ASCII characters** (a Windows user called `José Núñez`). The install and the `tar` extraction must work from such a directory. [Task 9]
3. **Prompt with no usable stdin.** `ensureTools` and `askYesNo` must never hang when stdin is closed or not a TTY: closed stdin means "no", a non-TTY run exits 3 with `run: mediaforge setup`. [Task 11]
4. **`mediaforge update` when a PATH or env yt-dlp shadows the cache.** The download succeeds but would have no effect, so the command must say so. [Task 13]
5. **Re-running the installer or `setup`.** `setup` with everything present changes nothing and says so. The installers replace an existing binary atomically, and a binary that is in use produces a clear message. [Task 12, Task 23, Task 24]

## File Structure

New files (all paths from the repo root):

| Path | Responsibility |
| --- | --- |
| `packages/binary-resolver/src/target.ts` | Platform and CPU model, `binaryFileName` |
| `packages/binary-resolver/src/errors.ts` | `ToolInstallError`, message and hint factories, fs error mapping |
| `packages/binary-resolver/src/install-types.ts` | `InstallFs`, `FetchLike`, `InstallProgress`, `InstallResult`, `ArchiveKind` |
| `packages/binary-resolver/src/cache-dir.ts` | Cache directory per OS |
| `packages/binary-resolver/src/manifest.ts` | Read, write and repair `manifest.json` |
| `packages/binary-resolver/src/download-file.ts` | `request`, streaming `downloadFile` with SHA-256 |
| `packages/binary-resolver/src/sources.ts` | `parseSha256Sums`, `resolveYtDlpSource` |
| `packages/binary-resolver/src/lock.ts` | `tools.lock.json` types and `ffmpegSource` |
| `packages/binary-resolver/src/tools.lock.json` | Pinned ffmpeg builds (generated by `pin-ffmpeg.mjs`) |
| `packages/binary-resolver/src/install.ts` | `installTool` orchestration |
| `packages/binary-resolver/src/node-adapters.ts` | Real fs, fetch and `tar` extraction |
| `packages/binary-resolver/src/test-helpers.ts` | In-memory fs and fake fetch for tests |
| `tools/release/*` | `targets.mjs`, `build-binaries.mjs`, `checksums.mjs`, `pin-lib.mjs`, `pin-ffmpeg.mjs`, `smoke-server.mjs`, `smoke.sh` |
| `apps/desktop/src/tool-runtime.ts` | `ToolRuntime`, `acquireTool`, `ensureTools`, prompt, progress printer, error mapping |
| `apps/desktop/src/tool-commands.ts` | `runSetup`, `runUpdate` |
| `apps/desktop/src/js-runtime.ts` | JS runtime detection and `--js-runtimes` args |
| `apps/desktop/src/stale-extractor.ts` | Stale-extractor error patterns and hints |
| `apps/desktop/src/interactive/screens/UpdateScreen.tsx` | "Update yt-dlp and retry" screen |
| `install/install.sh`, `install/install.ps1` | Installers (published as release assets) |
| `.github/workflows/ci.yml`, `.github/workflows/release.yml` | CI and release pipelines |
| `LICENSE`, `docs/releasing.md` | MIT license, release runbook |

Modified: `packages/binary-resolver/src/{resolve,version,index}.ts`, `packages/binary-resolver/tsconfig.json`, `tsconfig.base.json`, `vitest.config.ts`, `apps/desktop/src/{binaries,doctor,download,formats,commands,version}.ts`, `apps/desktop/src/engine/{args,engine,progress}.ts`, `apps/desktop/src/interactive/{App.tsx,deps.ts,start.tsx}` and the Setup and Result screens, `apps/desktop/build.mjs`, `README.md`, `docs/desktop-cli-checklist.md`.

---

## Phase A: Spike (gate)

No pipeline work starts before this passes (spec risk 1).

### Task 1: Packaging spike with `pkg --sea`

**Files:**
- Create: `apps/desktop/spike/ui.tsx` (throwaway)
- Create: `apps/desktop/spike/build.mjs` (throwaway)
- Create: `.github/workflows/spike-pkg.yml` (throwaway)
- Create: `docs/superpowers/spike-pkg-sea.md` (the result record, kept)
- Modify: `package.json` (devDependency `@yao-pkg/pkg`)

**Interfaces:**
- Consumes: the existing esbuild bundle (`apps/desktop/build.mjs`) and the repo-root `bin/yt-dlp.exe` and `bin/ffmpeg.exe` on the Windows dev machine.
- Produces: a written decision in `docs/superpowers/spike-pkg-sea.md` that names the build mode (`--sea` on Node 22, or Node 24 Standard) and any changes `build.mjs` needs. Task 19 reads it.

All code in `apps/desktop/spike/` and `spike-pkg.yml` is throwaway and is deleted in Task 25. Only the result document stays.

- [ ] **Step 1: Add pkg as a root devDependency**

Run:
```bash
pnpm add -D -w @yao-pkg/pkg
```
Expected: the dependency is added to the root `package.json` and `pnpm-lock.yaml`. If pnpm reports an ignored build script for pkg, add the package name to `allowBuilds` in `pnpm-workspace.yaml` (set to `true`) and re-run `pnpm install`.

- [ ] **Step 2: Write the headless Ink and spawn probe**

Create `apps/desktop/spike/ui.tsx`:
```tsx
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { render, Text } from "ink";

// Render one Ink frame into a fake terminal, then check that a child process can be spawned.
const out = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
let frames = "";
out.on("data", (chunk) => {
  frames += chunk.toString();
});

const app = render(<Text>hello from ink</Text>, {
  stdout: out as unknown as NodeJS.WriteStream,
  debug: true,
  patchConsole: false,
});
app.unmount();
await app.waitUntilExit();
console.log(frames.includes("hello from ink") ? "UI_OK" : "UI_FAIL");

const shell = process.platform === "win32" ? ["cmd", ["/c", "echo spawn-ok"]] : ["sh", ["-c", "echo spawn-ok"]];
const child = spawnSync(shell[0] as string, shell[1] as string[], { encoding: "utf8" });
console.log(child.stdout.includes("spawn-ok") ? "SPAWN_OK" : "SPAWN_FAIL");
```

Create `apps/desktop/spike/build.mjs`, a copy of the options in `apps/desktop/build.mjs` that bundles both entries:
```js
import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  jsx: "automatic",
  alias: { "react-devtools-core": "./build/empty-module.js" },
  define: { "process.env.NODE_ENV": '"production"', "process.env.DEV": '"false"' },
  banner: {
    js: "import { createRequire as __mfCreateRequire } from 'node:module'; const require = __mfCreateRequire(import.meta.url);",
  },
  logLevel: "info",
};

await build({ ...shared, entryPoints: ["spike/ui.tsx"], outfile: "dist/spike-ui.js" });
await build({ ...shared, entryPoints: ["src/main.ts"], outfile: "dist/main.js" });
```

Run (from the repo root):
```bash
pnpm exec biome check --write apps/desktop/spike
cd apps/desktop && node spike/build.mjs && node dist/spike-ui.js
```
Expected: `UI_OK` and `SPAWN_OK` printed by plain Node. If not, fix the probe before blaming pkg.

- [ ] **Step 3: Build and run the win-x64 binaries locally**

Run (repo root, Git Bash or PowerShell; create `out/spike/` first):
```bash
mkdir -p out/spike/bin && cp bin/yt-dlp.exe bin/ffmpeg.exe out/spike/bin/
pnpm exec pkg apps/desktop/dist/spike-ui.js --sea --targets node22-win-x64 --output out/spike/ui-win-x64.exe
pnpm exec pkg apps/desktop/dist/main.js --sea --targets node22-win-x64 --output out/spike/mediaforge-win-x64.exe
./out/spike/ui-win-x64.exe
./out/spike/mediaforge-win-x64.exe --version
./out/spike/mediaforge-win-x64.exe doctor
```
Expected: `UI_OK`, `SPAWN_OK`, the version `0.1.0`, and `doctor` listing yt-dlp and ffmpeg with `(bundled)` and the `out/spike/bin` paths. If `pkg` rejects a flag, run `pnpm exec pkg --help` and adjust; record the final working command line in the result document.

If the ESM bundle fails to start inside the binary (for example a `createRequire` or top-level-await error), change the spike build to `format: "cjs"` (drop the banner) and rebuild. Record exactly what had to change in `apps/desktop/build.mjs` for Task 19.

- [ ] **Step 4: Check the full interactive app and a real download by hand**

In a real terminal (not the IDE output panel), run:
```bash
./out/spike/mediaforge-win-x64.exe
```
Check by hand: the logo and menu render, arrow keys and Esc work, "Check setup" shows yt-dlp and ffmpeg found (bundled). Then download a short public clip of your choice with `./out/spike/mediaforge-win-x64.exe download <url> -p mp4-720p`. Expected: progress shows and a file appears. This proves Yoga's wasm, raw-mode input, and `spawn` of yt-dlp and ffmpeg all work inside the binary.

- [ ] **Step 5: Cross-build all five targets and run them natively on GitHub runners**

Create `.github/workflows/spike-pkg.yml`:
```yaml
name: Spike pkg
on: workflow_dispatch

jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - run: npm install -g pnpm@11
      - run: pnpm install --frozen-lockfile
      - run: cd apps/desktop && node spike/build.mjs
      - name: Build five targets
        run: |
          mkdir -p out
          for t in win-x64 linux-x64 linux-arm64 macos-x64 macos-arm64; do
            ext=""; [ "$t" = "win-x64" ] && ext=".exe"
            pnpm exec pkg apps/desktop/dist/spike-ui.js --sea --targets "node22-$t" --output "out/ui-$t$ext"
            pnpm exec pkg apps/desktop/dist/main.js --sea --targets "node22-$t" --output "out/mediaforge-$t$ext"
          done
      - uses: actions/upload-artifact@v4
        with:
          name: spike-binaries
          path: out/

  run:
    needs: build
    strategy:
      fail-fast: false
      matrix:
        include:
          - { target: win-x64, runner: windows-latest, ext: .exe }
          - { target: linux-x64, runner: ubuntu-24.04, ext: "" }
          - { target: linux-arm64, runner: ubuntu-24.04-arm, ext: "" }
          - { target: macos-x64, runner: macos-15-intel, ext: "" }
          - { target: macos-arm64, runner: macos-15, ext: "" }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: spike-binaries
          path: out
      - name: Run
        shell: bash
        run: |
          ui="out/ui-${{ matrix.target }}${{ matrix.ext }}"
          app="out/mediaforge-${{ matrix.target }}${{ matrix.ext }}"
          chmod +x "$ui" "$app"
          if [ "$RUNNER_OS" = "macOS" ]; then codesign --force --sign - "$ui" "$app"; fi
          "$ui"
          "$app" --version
          "$app" doctor --json || echo "doctor exit code: $?"
```

Run `pnpm exec biome check --write .github/workflows/spike-pkg.yml` (Biome ignores YAML; the command is harmless). Tell the user to push the branch and run the workflow from the Actions tab (the user pushes; do not run `git push`). Expected: all five `run` jobs print `UI_OK`, `SPAWN_OK`, `0.1.0`, and a `doctor` JSON document. If the runner label `macos-15-intel` or `ubuntu-24.04-arm` is rejected, check GitHub's current runner list and substitute the matching label everywhere it appears in this plan.

- [ ] **Step 6: Record the result and decide**

Create `docs/superpowers/spike-pkg-sea.md` with: the date, the exact pkg command line that worked, a table of the five targets (`UI_OK`, `SPAWN_OK`, `--version`, `doctor`) with pass or fail, the manual TUI and download result from Step 4, and one of these decisions:
1. **SEA on Node 22 works for all five.** Task 19 uses `--sea` and `node22`. Done.
2. **SEA fails for some target.** Repeat Steps 3 and 5 with Node 24 Standard (`--targets node24-<target>`, no `--sea`) and record the result. If it passes, the decision is Node 24 Standard: in Task 19, set `PKG_NODE = "node24"` and `PKG_MODE_ARGS = []` in `tools/release/targets.mjs`; nothing else in this plan changes.
3. **Both fail.** Stop. Report to the user: the build-tool choice (plain Node SEA or Bun) is reopened and this plan needs a new Phase D.

Also record any `apps/desktop/build.mjs` changes the binary needed (for example `format: "cjs"`).

- [ ] **Step 7: Gate**

Do not continue to Task 2 unless the document records decision 1 or 2. Tasks 2 to 18 do not depend on the packaging result, so the user may allow them to proceed in parallel, but nothing in Phase D may start.

- [ ] **Step 8: Commit message**

Output for the user (do not run `git commit`):
```text
🔨 desktop: spike pkg --sea packaging for all five targets

Body: why (spec risk 1: Ink, Yoga wasm and spawn inside a packaged binary), result summary.
Test: run the spike-pkg workflow; see docs/superpowers/spike-pkg-sea.md
```

---

## Phase B: Tool install library (`packages/binary-resolver`)

All Phase B code is pure TypeScript with injected `fetch` and file system, so tests need no network. Run package tests with `pnpm exec vitest run packages/binary-resolver`.

### Task 2: Target model

**Files:**
- Create: `packages/binary-resolver/src/target.ts`
- Create: `packages/binary-resolver/src/target.test.ts`
- Modify: `packages/binary-resolver/src/version.ts` (add `ALL_TOOLS`)
- Modify: `packages/binary-resolver/src/index.ts`

**Interfaces:**
- Consumes: `Tool` from `version.ts`.
- Produces:
  - `type OsName = "win32" | "linux" | "darwin"`, `type CpuArch = "x64" | "arm64"`, `interface Target { os: OsName; arch: CpuArch }`
  - `class UnsupportedTargetError extends Error` (fields `platform: string`, `arch: string`)
  - `resolveTarget(platform?: string, arch?: string): Target` (defaults to `process.platform` and `process.arch`; Windows arm64 returns `{ os: "win32", arch: "x64" }`)
  - `targetKey(target: Target): string` (for example `"linux-arm64"`)
  - `binaryFileName(tool: Tool, os: OsName): string` (`.exe` on win32 only)
  - `ALL_TOOLS: readonly Tool[]` (`["yt-dlp", "ffmpeg"]`)

- [ ] **Step 1: Write the failing test**

Create `packages/binary-resolver/src/target.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { binaryFileName, resolveTarget, targetKey, UnsupportedTargetError } from "./target.ts";

describe("resolveTarget", () => {
  it.each([
    ["win32", "x64", "win32-x64"],
    ["linux", "x64", "linux-x64"],
    ["linux", "arm64", "linux-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["darwin", "arm64", "darwin-arm64"],
  ])("accepts %s %s", (platform, arch, key) => {
    expect(targetKey(resolveTarget(platform, arch))).toBe(key);
  });

  it("runs Windows on ARM as x64 under emulation", () => {
    expect(resolveTarget("win32", "arm64")).toEqual({ os: "win32", arch: "x64" });
  });

  it("rejects other combinations with a message that names them", () => {
    expect(() => resolveTarget("freebsd", "x64")).toThrow(UnsupportedTargetError);
    expect(() => resolveTarget("linux", "ia32")).toThrow(/linux-ia32/);
    expect(() => resolveTarget("win32", "ia32")).toThrow(UnsupportedTargetError);
  });
});

describe("binaryFileName", () => {
  it("adds .exe on Windows only", () => {
    expect(binaryFileName("yt-dlp", "win32")).toBe("yt-dlp.exe");
    expect(binaryFileName("ffmpeg", "linux")).toBe("ffmpeg");
    expect(binaryFileName("ffmpeg", "darwin")).toBe("ffmpeg");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run packages/binary-resolver/src/target.test.ts`
Expected: FAIL, cannot resolve `./target.ts`.

- [ ] **Step 3: Implement**

Create `packages/binary-resolver/src/target.ts`:
```ts
import type { Tool } from "./version.ts";

export type OsName = "win32" | "linux" | "darwin";
export type CpuArch = "x64" | "arm64";

export interface Target {
  os: OsName;
  arch: CpuArch;
}

export class UnsupportedTargetError extends Error {
  readonly platform: string;
  readonly arch: string;

  constructor(platform: string, arch: string) {
    super(
      `Unsupported platform: ${platform}-${arch}. Supported: win32-x64, linux-x64, linux-arm64, darwin-x64, darwin-arm64.`,
    );
    this.name = "UnsupportedTargetError";
    this.platform = platform;
    this.arch = arch;
  }
}

/** Map Node's platform and arch to a supported target. Windows on ARM runs the x64 build. */
export function resolveTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): Target {
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    return { os: "win32", arch: "x64" };
  }
  if ((platform === "linux" || platform === "darwin") && (arch === "x64" || arch === "arm64")) {
    return { os: platform, arch };
  }
  throw new UnsupportedTargetError(platform, arch);
}

export const targetKey = (target: Target): string => `${target.os}-${target.arch}`;

/** The file name a tool has inside the cache. */
export const binaryFileName = (tool: Tool, os: OsName): string =>
  os === "win32" ? `${tool}.exe` : tool;
```

Add the tool list to `packages/binary-resolver/src/version.ts`, right under the `Tool` type:
```ts
export type Tool = "yt-dlp" | "ffmpeg";

/** Every tool MediaForge manages. Commands loop over this list instead of naming tools. */
export const ALL_TOOLS: readonly Tool[] = ["yt-dlp", "ffmpeg"];
```

Replace `packages/binary-resolver/src/index.ts` with:
```ts
export * from "./resolve.ts";
export * from "./target.ts";
export * from "./version.ts";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run packages/binary-resolver && pnpm typecheck`
Expected: PASS (existing resolver tests still pass).

- [ ] **Step 5: Commit message**

Output for the user (do not run `git commit`):
```text
✨ binary-resolver: add platform target model for tool downloads

Test: pnpm exec vitest run packages/binary-resolver
```

### Task 3: Install errors and shared types

**Files:**
- Create: `packages/binary-resolver/src/install-types.ts`
- Create: `packages/binary-resolver/src/errors.ts`
- Create: `packages/binary-resolver/src/errors.test.ts`
- Modify: `packages/binary-resolver/src/index.ts`

**Interfaces:**
- Consumes: `Tool` from `version.ts`.
- Produces (`install-types.ts`):
  - `type ArchiveKind = "none" | "zip" | "tar.xz" | "tar"`
  - `interface WritableFile { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> }`
  - `interface InstallFs { mkdir(path): Promise<void>; openWrite(path): Promise<WritableFile>; rename(from, to): Promise<void>; rm(path): Promise<void>; chmod(path, mode: number): Promise<void>; readText(path): Promise<string>; writeText(path, data: string): Promise<void>; exists(path): Promise<boolean>; listFiles(dir): Promise<string[]>; sha256File(path): Promise<string> }` (`rm` removes files or trees and ignores missing paths; `listFiles` returns paths relative to `dir` with `/` separators)
  - `type FetchLike = (url: string, init?: { redirect?: "follow" | "manual"; signal?: AbortSignal }) => Promise<Response>`
  - `type InstallPhase = "resolving" | "downloading" | "verifying" | "extracting" | "installing"`
  - `interface InstallProgress { tool: Tool; phase: InstallPhase; received?: number; total?: number }`
  - `interface InstallResult { tool: Tool; version: string; path: string; sha256: string; url: string }`
- Produces (`errors.ts`):
  - `type InstallErrorKind = "offline" | "not-found" | "rate-limit" | "http" | "checksum" | "disk-full" | "permission" | "io" | "extract" | "unsupported" | "no-source"`
  - `class ToolInstallError extends Error { kind: InstallErrorKind; hint: string }` with constructor `(kind, message, hint)`
  - `offlineError(url)`, `httpError(url, status)`, `checksumError(name, expected, actual)`, `isFsError(error): boolean`, `fsError(error, path): ToolInstallError`

- [ ] **Step 1: Write the failing test**

Create `packages/binary-resolver/src/errors.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  checksumError,
  fsError,
  httpError,
  isFsError,
  offlineError,
  ToolInstallError,
} from "./errors.ts";

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("install errors", () => {
  it("names the host when offline", () => {
    const error = offlineError("https://github.com/yt-dlp/yt-dlp/releases/latest");
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("offline");
    expect(error.message).toContain("github.com");
    expect(error.hint).toContain("internet connection");
  });

  it("tells 404, rate limits and other HTTP failures apart", () => {
    expect(httpError("https://x.test/a", 404).kind).toBe("not-found");
    expect(httpError("https://x.test/a", 403).kind).toBe("rate-limit");
    expect(httpError("https://x.test/a", 429).kind).toBe("rate-limit");
    const other = httpError("https://x.test/a", 500);
    expect(other.kind).toBe("http");
    expect(other.message).toContain("500");
  });

  it("reports both hashes on a checksum mismatch and says the file was discarded", () => {
    const error = checksumError("yt-dlp", "aaa", "bbb");
    expect(error.kind).toBe("checksum");
    expect(error.message).toContain("aaa");
    expect(error.message).toContain("bbb");
    expect(error.message).toContain("discarded");
  });

  it("maps file system errors to disk-full, permission or io", () => {
    expect(fsError(errno("ENOSPC"), "/c/yt-dlp").kind).toBe("disk-full");
    expect(fsError(errno("EACCES"), "/c/yt-dlp").kind).toBe("permission");
    expect(fsError(errno("EPERM"), "/c/yt-dlp").kind).toBe("permission");
    expect(fsError(errno("EIO"), "/c/yt-dlp").kind).toBe("io");
    expect(fsError(errno("ENOSPC"), "/c/yt-dlp").message).toContain("/c/yt-dlp");
  });

  it("passes an existing install error through unchanged", () => {
    const original = checksumError("ffmpeg", "a", "b");
    expect(fsError(original, "/x")).toBe(original);
  });

  it("recognises file system error codes but not network ones", () => {
    expect(isFsError(errno("ENOSPC"))).toBe(true);
    expect(isFsError(errno("ECONNRESET"))).toBe(false);
    expect(isFsError(new TypeError("terminated"))).toBe(false);
    expect(isFsError(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run packages/binary-resolver/src/errors.test.ts`
Expected: FAIL, cannot resolve `./errors.ts`.

- [ ] **Step 3: Implement**

Create `packages/binary-resolver/src/install-types.ts`:
```ts
import type { Tool } from "./version.ts";

/** How a download is packed. `none` is a bare executable. */
export type ArchiveKind = "none" | "zip" | "tar.xz" | "tar";

export interface WritableFile {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** The file system operations an install needs. Tests use an in-memory copy. */
export interface InstallFs {
  mkdir(path: string): Promise<void>;
  openWrite(path: string): Promise<WritableFile>;
  rename(from: string, to: string): Promise<void>;
  /** Remove a file or folder tree. A missing path is not an error. */
  rm(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Every file under `dir`, as paths relative to it, always with `/` separators. */
  listFiles(dir: string): Promise<string[]>;
  sha256File(path: string): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: { redirect?: "follow" | "manual"; signal?: AbortSignal },
) => Promise<Response>;

export type InstallPhase = "resolving" | "downloading" | "verifying" | "extracting" | "installing";

export interface InstallProgress {
  tool: Tool;
  phase: InstallPhase;
  /** Bytes received so far (downloading only). */
  received?: number;
  /** Total bytes, when the server said. */
  total?: number;
}

export interface InstallResult {
  tool: Tool;
  version: string;
  path: string;
  sha256: string;
  url: string;
}
```

Create `packages/binary-resolver/src/errors.ts`:
```ts
export type InstallErrorKind =
  | "offline"
  | "not-found"
  | "rate-limit"
  | "http"
  | "checksum"
  | "disk-full"
  | "permission"
  | "io"
  | "extract"
  | "unsupported"
  | "no-source";

const ISSUES_URL = "https://github.com/N-Berns/mediaforge/issues";

/** A failed tool download or install. `hint` says what the user can do about it. */
export class ToolInstallError extends Error {
  readonly kind: InstallErrorKind;
  readonly hint: string;

  constructor(kind: InstallErrorKind, message: string, hint: string) {
    super(message);
    this.name = "ToolInstallError";
    this.kind = kind;
    this.hint = hint;
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const offlineError = (url: string): ToolInstallError =>
  new ToolInstallError(
    "offline",
    `Could not reach ${hostOf(url)}.`,
    "Check your internet connection, then try again.",
  );

export function httpError(url: string, status: number): ToolInstallError {
  if (status === 404) {
    return new ToolInstallError(
      "not-found",
      `Not found: ${url} (HTTP 404).`,
      "The file moved or was removed upstream. Update MediaForge, or install the tool yourself and add it to PATH.",
    );
  }
  if (status === 403 || status === 429) {
    return new ToolInstallError(
      "rate-limit",
      `${hostOf(url)} refused the request (HTTP ${status}).`,
      "GitHub may be rate limiting this network. Wait a few minutes, then try again.",
    );
  }
  return new ToolInstallError(
    "http",
    `Download failed: HTTP ${status} from ${url}.`,
    "Try again later.",
  );
}

export const checksumError = (name: string, expected: string, actual: string): ToolInstallError =>
  new ToolInstallError(
    "checksum",
    `Checksum mismatch for ${name}: expected ${expected}, got ${actual}. The download was discarded.`,
    `Try again. If it keeps happening, do not install this file; report it at ${ISSUES_URL}.`,
  );

const FS_ERROR_CODES = new Set([
  "ENOSPC",
  "EDQUOT",
  "EACCES",
  "EPERM",
  "EROFS",
  "EBUSY",
  "EMFILE",
  "ENOENT",
  "EEXIST",
  "EISDIR",
  "ENOTDIR",
  "EIO",
]);

/** True for errors raised by the file system (as opposed to the network). */
export function isFsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && FS_ERROR_CODES.has(code);
}

/** Turn a file system error into an install error that names the path. */
export function fsError(error: unknown, path: string): ToolInstallError {
  if (error instanceof ToolInstallError) return error;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") {
    return new ToolInstallError(
      "disk-full",
      `No space left to write ${path}.`,
      "Free up disk space, then try again.",
    );
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "EBUSY") {
    return new ToolInstallError(
      "permission",
      `Not allowed to write ${path}.`,
      "Close any running MediaForge or yt-dlp windows and check the folder's permissions, or set MEDIAFORGE_CACHE_DIR to a folder you can write to.",
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ToolInstallError(
    "io",
    `Could not write ${path}: ${detail}`,
    "Check the folder, then try again.",
  );
}
```

Replace `packages/binary-resolver/src/index.ts` with:
```ts
export * from "./errors.ts";
export * from "./install-types.ts";
export * from "./resolve.ts";
export * from "./target.ts";
export * from "./version.ts";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run packages/binary-resolver && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit message**

Output for the user:
```text
✨ binary-resolver: add install error types and file system contract

Test: pnpm exec vitest run packages/binary-resolver
```

### Task 4: Cache directory, manifest and test helpers

**Files:**
- Create: `packages/binary-resolver/src/test-helpers.ts`
- Create: `packages/binary-resolver/src/cache-dir.ts`
- Create: `packages/binary-resolver/src/cache-dir.test.ts`
- Create: `packages/binary-resolver/src/manifest.ts`
- Create: `packages/binary-resolver/src/manifest.test.ts`
- Modify: `packages/binary-resolver/src/index.ts`

**Interfaces:**
- Consumes: `InstallFs`, `FetchLike` (Task 3), `ALL_TOOLS`, `binaryFileName`, `OsName` (Task 2).
- Produces:
  - `CACHE_DIR_ENV = "MEDIAFORGE_CACHE_DIR"`
  - `cacheDir(env: Record<string, string | undefined>, platform?: NodeJS.Platform, home?: string): string`
  - `interface ManifestEntry { version: string; url: string; sha256: string; installedAt: string }`, `type Manifest = Partial<Record<Tool, ManifestEntry>>`, `MANIFEST_FILE = "manifest.json"`
  - `readManifest(fs: Pick<InstallFs, "readText">, dir: string): Promise<Manifest>` (never throws)
  - `writeManifest(fs: Pick<InstallFs, "mkdir" | "writeText" | "rename">, dir: string, manifest: Manifest): Promise<void>`
  - `repairManifest(fs, dir: string, os: OsName, now?: () => Date): Promise<Manifest>` (never throws)
  - test-only (`test-helpers.ts`, not exported from the package): `memoryInstallFs(initial?)`, `routeFetch(routes)`, `streamResponse(data, chunk?, failAfter?)`

- [ ] **Step 1: Write the test helpers**

Create `packages/binary-resolver/src/test-helpers.ts`:
```ts
import { createHash } from "node:crypto";
import type { FetchLike, InstallFs } from "./install-types.ts";

const norm = (path: string): string => path.replaceAll("\\", "/");

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const errno = (code: string, path: string) =>
  Object.assign(new Error(`${code}: ${path}`), { code });

/**
 * An in-memory `InstallFs`. Written data is visible after every chunk, like a real partial file.
 * Set `state.writeError` to make the next writes fail.
 */
export function memoryInstallFs(initial: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>();
  const modes = new Map<string, number>();
  const encoder = new TextEncoder();
  const state: { writeError?: Error } = {};
  for (const [path, text] of Object.entries(initial)) files.set(norm(path), encoder.encode(text));

  const fs: InstallFs = {
    mkdir: async () => {},
    openWrite: async (path) => {
      const chunks: Uint8Array[] = [];
      return {
        write: async (chunk) => {
          if (state.writeError) throw state.writeError;
          chunks.push(chunk.slice());
          files.set(norm(path), concat(chunks));
        },
        close: async () => {},
      };
    },
    rename: async (from, to) => {
      const data = files.get(norm(from));
      if (!data) throw errno("ENOENT", from);
      files.delete(norm(from));
      files.set(norm(to), data);
      const mode = modes.get(norm(from));
      if (mode !== undefined) {
        modes.delete(norm(from));
        modes.set(norm(to), mode);
      }
    },
    rm: async (path) => {
      const key = norm(path);
      files.delete(key);
      for (const existing of [...files.keys()]) {
        if (existing.startsWith(`${key}/`)) files.delete(existing);
      }
    },
    chmod: async (path, mode) => {
      if (!files.has(norm(path))) throw errno("ENOENT", path);
      modes.set(norm(path), mode);
    },
    readText: async (path) => {
      const data = files.get(norm(path));
      if (!data) throw errno("ENOENT", path);
      return new TextDecoder().decode(data);
    },
    writeText: async (path, data) => {
      files.set(norm(path), encoder.encode(data));
    },
    exists: async (path) => {
      const key = norm(path);
      return files.has(key) || [...files.keys()].some((k) => k.startsWith(`${key}/`));
    },
    listFiles: async (dir) => {
      const prefix = `${norm(dir)}/`;
      return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },
    sha256File: async (path) => {
      const data = files.get(norm(path));
      if (!data) throw errno("ENOENT", path);
      return createHash("sha256").update(data).digest("hex");
    },
  };

  return {
    fs,
    files,
    state,
    has: (path: string) => files.has(norm(path)),
    text: (path: string) => new TextDecoder().decode(files.get(norm(path))),
    mode: (path: string) => modes.get(norm(path)),
    /** All stored paths with `/` separators, sorted. */
    paths: () => [...files.keys()].sort(),
  };
}

/**
 * A 200 response whose body arrives in small chunks. With `failAfter`, the stream errors once that
 * many bytes were sent, like a dropped connection.
 */
export function streamResponse(data: string | Uint8Array, chunk = 4, failAfter?: number): Response {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && offset >= failAfter) {
        controller.error(new TypeError("terminated"));
        return;
      }
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
  return new Response(body, { status: 200, headers: { "content-length": String(bytes.length) } });
}

/** A fake `fetch` that answers from a table of exact URLs; anything else is a 404. */
export function routeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  };
  return Object.assign(fetchFn, { calls });
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/binary-resolver/src/cache-dir.test.ts`:
```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CACHE_DIR_ENV, cacheDir } from "./cache-dir.ts";

describe("cacheDir", () => {
  it("honours MEDIAFORGE_CACHE_DIR first", () => {
    expect(cacheDir({ [CACHE_DIR_ENV]: "/custom" }, "linux", "/home/a")).toBe("/custom");
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(cacheDir({ LOCALAPPDATA: "L" }, "win32", "H")).toBe(join("L", "MediaForge", "bin"));
  });

  it("falls back to AppData/Local on Windows without LOCALAPPDATA", () => {
    expect(cacheDir({}, "win32", "H")).toBe(join("H", "AppData", "Local", "MediaForge", "bin"));
  });

  it("uses XDG_DATA_HOME on Linux, else ~/.local/share", () => {
    expect(cacheDir({ XDG_DATA_HOME: "X" }, "linux", "H")).toBe(join("X", "mediaforge", "bin"));
    expect(cacheDir({}, "linux", "H")).toBe(join("H", ".local", "share", "mediaforge", "bin"));
  });

  it("uses Application Support on macOS", () => {
    expect(cacheDir({}, "darwin", "H")).toBe(
      join("H", "Library", "Application Support", "MediaForge", "bin"),
    );
  });
});
```

Create `packages/binary-resolver/src/manifest.test.ts`:
```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE, readManifest, repairManifest, writeManifest } from "./manifest.ts";
import { memoryInstallFs } from "./test-helpers.ts";

const DIR = "/cache/bin";
const NOW = new Date("2026-10-08T12:00:00.000Z");
const entry = { version: "1", url: "https://x.test/a", sha256: "ab", installedAt: "t" };

describe("readManifest", () => {
  it("returns an empty manifest when the file is missing or corrupt", async () => {
    expect(await readManifest(memoryInstallFs().fs, DIR)).toEqual({});
    const bad = memoryInstallFs({ [join(DIR, MANIFEST_FILE)]: "{not json" });
    expect(await readManifest(bad.fs, DIR)).toEqual({});
  });

  it("keeps valid entries and drops unknown tools and malformed ones", async () => {
    const raw = JSON.stringify({
      "yt-dlp": entry,
      ffmpeg: { version: 7 },
      deno: entry,
    });
    const mem = memoryInstallFs({ [join(DIR, MANIFEST_FILE)]: raw });
    expect(await readManifest(mem.fs, DIR)).toEqual({ "yt-dlp": entry });
  });
});

describe("writeManifest", () => {
  it("round-trips and leaves no temp file behind", async () => {
    const mem = memoryInstallFs();
    await writeManifest(mem.fs, DIR, { "yt-dlp": entry });
    expect(await readManifest(mem.fs, DIR)).toEqual({ "yt-dlp": entry });
    expect(mem.paths()).toEqual(["/cache/bin/manifest.json"]);
  });
});

describe("repairManifest", () => {
  it("adds entries for tool files the manifest does not know", async () => {
    const mem = memoryInstallFs({ [join(DIR, "yt-dlp")]: "BIN" });
    const manifest = await repairManifest(mem.fs, DIR, "linux", () => NOW);
    expect(manifest["yt-dlp"]).toMatchObject({
      version: "unknown",
      installedAt: NOW.toISOString(),
    });
    expect(manifest["yt-dlp"]?.sha256).toHaveLength(64);
    expect(manifest.ffmpeg).toBeUndefined();
    expect(await readManifest(mem.fs, DIR)).toEqual(manifest);
  });

  it("drops entries whose file is gone", async () => {
    const mem = memoryInstallFs({ [join(DIR, MANIFEST_FILE)]: JSON.stringify({ ffmpeg: entry }) });
    expect(await repairManifest(mem.fs, DIR, "linux", () => NOW)).toEqual({});
  });

  it("looks for .exe names on Windows", async () => {
    const mem = memoryInstallFs({ [join(DIR, "ffmpeg.exe")]: "BIN" });
    const manifest = await repairManifest(mem.fs, DIR, "win32", () => NOW);
    expect(manifest.ffmpeg?.version).toBe("unknown");
  });

  it("never throws, even when the file system fails", async () => {
    const mem = memoryInstallFs({ [join(DIR, "yt-dlp")]: "BIN" });
    mem.fs.sha256File = async () => {
      throw new Error("EIO");
    };
    await expect(repairManifest(mem.fs, DIR, "linux", () => NOW)).resolves.toEqual({});
  });
});
```

- [ ] **Step 3: Run them to confirm they fail**

Run: `pnpm exec vitest run packages/binary-resolver/src/cache-dir.test.ts packages/binary-resolver/src/manifest.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

Create `packages/binary-resolver/src/cache-dir.ts`:
```ts
import { homedir } from "node:os";
import { join } from "node:path";

/** Overrides the managed tool folder. Used by tests and by people who want the tools elsewhere. */
export const CACHE_DIR_ENV = "MEDIAFORGE_CACHE_DIR";

/** Where downloaded yt-dlp and ffmpeg live, per OS. */
export function cacheDir(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env[CACHE_DIR_ENV];
  if (override) return override;
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "MediaForge", "bin");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "MediaForge", "bin");
  }
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "mediaforge", "bin");
}
```

Create `packages/binary-resolver/src/manifest.ts`:
```ts
import { join } from "node:path";
import type { InstallFs } from "./install-types.ts";
import { type OsName, binaryFileName } from "./target.ts";
import { ALL_TOOLS, type Tool } from "./version.ts";

export const MANIFEST_FILE = "manifest.json";

export interface ManifestEntry {
  version: string;
  url: string;
  sha256: string;
  installedAt: string;
}

export type Manifest = Partial<Record<Tool, ManifestEntry>>;

function sanitize(raw: unknown): Manifest {
  const manifest: Manifest = {};
  if (typeof raw !== "object" || raw === null) return manifest;
  for (const tool of ALL_TOOLS) {
    const value = (raw as Record<string, unknown>)[tool];
    if (typeof value !== "object" || value === null) continue;
    const { version, url, sha256, installedAt } = value as Record<string, unknown>;
    if (
      typeof version === "string" &&
      typeof url === "string" &&
      typeof sha256 === "string" &&
      typeof installedAt === "string"
    ) {
      manifest[tool] = { version, url, sha256, installedAt };
    }
  }
  return manifest;
}

/** Never throws: a missing or corrupt file gives an empty manifest. */
export async function readManifest(fs: Pick<InstallFs, "readText">, dir: string): Promise<Manifest> {
  try {
    return sanitize(JSON.parse(await fs.readText(join(dir, MANIFEST_FILE))));
  } catch {
    return {};
  }
}

export async function writeManifest(
  fs: Pick<InstallFs, "mkdir" | "writeText" | "rename">,
  dir: string,
  manifest: Manifest,
): Promise<void> {
  await fs.mkdir(dir);
  // Write then rename, so a crash never leaves a half-written manifest.
  const temp = join(dir, `${MANIFEST_FILE}.tmp`);
  await fs.writeText(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rename(temp, join(dir, MANIFEST_FILE));
}

/**
 * Make the manifest match the files in the cache: add an entry (version "unknown") for each tool
 * file it does not know, and drop entries whose file is gone. Never throws.
 */
export async function repairManifest(
  fs: Pick<InstallFs, "readText" | "exists" | "sha256File" | "mkdir" | "writeText" | "rename">,
  dir: string,
  os: OsName,
  now: () => Date = () => new Date(),
): Promise<Manifest> {
  const manifest = await readManifest(fs, dir);
  try {
    let changed = false;
    for (const tool of ALL_TOOLS) {
      const present = await fs.exists(join(dir, binaryFileName(tool, os)));
      if (!present && manifest[tool]) {
        delete manifest[tool];
        changed = true;
      } else if (present && !manifest[tool]) {
        manifest[tool] = {
          version: "unknown",
          url: "",
          sha256: await fs.sha256File(join(dir, binaryFileName(tool, os))),
          installedAt: now().toISOString(),
        };
        changed = true;
      }
    }
    if (changed) await writeManifest(fs, dir, manifest);
    return manifest;
  } catch {
    return await readManifest(fs, dir);
  }
}
```
Note: in the "never throws" test the `sha256File` failure aborts the loop, so the function returns the manifest as read from disk (`{}`).

Add to `packages/binary-resolver/src/index.ts` (keep the list alphabetical):
```ts
export * from "./cache-dir.ts";
export * from "./errors.ts";
export * from "./install-types.ts";
export * from "./manifest.ts";
export * from "./resolve.ts";
export * from "./target.ts";
export * from "./version.ts";
```

- [ ] **Step 5: Run the tests and format**

Run:
```bash
pnpm exec biome check --write packages/binary-resolver/src
pnpm exec vitest run packages/binary-resolver && pnpm typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit message**

Output for the user:
```text
✨ binary-resolver: add tool cache directory and manifest

Test: pnpm exec vitest run packages/binary-resolver
```

### Task 5: Resolver cache step and `findOnPath`

**Files:**
- Create: `packages/binary-resolver/src/exec.ts`, `packages/binary-resolver/src/exec.test.ts`
- Modify: `packages/binary-resolver/src/resolve.ts`
- Modify: `packages/binary-resolver/src/resolve.test.ts`, `packages/binary-resolver/src/index.ts`

**Interfaces:**
- Consumes: existing `resolveBinary`.
- Produces: `BinarySource` includes `"cache"`; `ResolveOptions.cacheDir?: string`; `findOnPath(name: string, options?: { env?; platform?; isExecutable? }): Promise<string | undefined>`; `execFileText(path: string, args: string[], options?: { timeoutMs?: number; maxBuffer?: number }): Promise<string>` (stdout of a finished program; rejects on a non-zero exit or a missing program).

Spike finding (Task 1, `docs/superpowers/spike-pkg-sea.md`): inside a pkg binary, `util.promisify(execFile)` resolves to the stdout string instead of `{ stdout, stderr }`, because pkg patches `execFile` and the patched function loses its promisify symbol. Every tool then looks "not runnable". `execFileText` uses the callback form of `execFile`, which works in both plain Node and the binary. Every place that runs a program and needs its output uses it: `resolve.ts` (this task), `js-runtime.ts` (Task 15) and `clipboard.ts` (Task 19).

- [ ] **Step 1: Write the failing tests**

Append to `packages/binary-resolver/src/resolve.test.ts` (the file already imports `join`, `delimiter`, `describe`, `expect`, `it`, `resolveBinary`; add `findOnPath` to the import from `./resolve.ts`). Add after the existing `resolveBinary` describe block:
```ts
describe("resolveBinary cache step", () => {
  const cache = join("cache", "bin");
  const withCache = (files: Record<string, string>) => ({ ...setup(files), cacheDir: cache });

  it("uses the managed cache when nothing else has the tool", async () => {
    const opts = withCache({ [join(cache, "yt-dlp")]: "2026.10.08" });
    expect(await resolveBinary("yt-dlp", opts)).toEqual({
      tool: "yt-dlp",
      path: join(cache, "yt-dlp"),
      source: "cache",
      version: "2026.10.08",
    });
  });

  it("prefers PATH, then the bundled folder, over the cache", async () => {
    const both = withCache({
      [join(binDir, "yt-dlp")]: "1",
      [join(bundled, "yt-dlp")]: "2",
      [join(cache, "yt-dlp")]: "3",
    });
    expect((await resolveBinary("yt-dlp", both)).source).toBe("path");
    const noPath = withCache({ [join(bundled, "yt-dlp")]: "2", [join(cache, "yt-dlp")]: "3" });
    expect((await resolveBinary("yt-dlp", noPath)).source).toBe("bundled");
  });

  it("does not hold a cached ffmpeg to the PATH version floor", async () => {
    const opts = withCache({
      [join(binDir, "ffmpeg")]: "ffmpeg version 4.2",
      [join(cache, "ffmpeg")]: "ffmpeg version 4.9",
    });
    expect((await resolveBinary("ffmpeg", opts)).source).toBe("cache");
  });

  it("names the cache in the not-found error", async () => {
    await expect(resolveBinary("yt-dlp", withCache({}))).rejects.toThrow(/cache in/);
  });

  it("tries .exe names in the cache on Windows", async () => {
    const opts = {
      ...withCache({ [join(cache, "ffmpeg.exe")]: "ffmpeg version 7.1" }),
      platform: "win32" as const,
    };
    expect((await resolveBinary("ffmpeg", opts)).path).toBe(join(cache, "ffmpeg.exe"));
  });
});

describe("findOnPath", () => {
  it("returns the first executable match on PATH", async () => {
    const path = await findOnPath("node", {
      env: { PATH: [join("a", "bin"), join("b", "bin")].join(delimiter) },
      platform: "linux",
      isExecutable: async (p) => p === join("b", "bin", "node"),
    });
    expect(path).toBe(join("b", "bin", "node"));
  });

  it("tries PATHEXT names on Windows and returns undefined when absent", async () => {
    const env = { PATH: join("a", "bin"), PATHEXT: ".EXE;.CMD" };
    expect(
      await findOnPath("deno", {
        env,
        platform: "win32",
        isExecutable: async (p) => p === join("a", "bin", "deno.exe"),
      }),
    ).toBe(join("a", "bin", "deno.exe"));
    expect(
      await findOnPath("deno", { env, platform: "win32", isExecutable: async () => false }),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm exec vitest run packages/binary-resolver/src/resolve.test.ts`
Expected: FAIL (`findOnPath` is not exported; cache cases fail).

- [ ] **Step 3: Implement**

In `packages/binary-resolver/src/resolve.ts`:

1. Change the source type and options:
```ts
export type BinarySource = "env" | "path" | "bundled" | "cache";
```
and add to `ResolveOptions`, below `bundledDir`:
```ts
  /** The managed tool folder (see `cacheDir`). Searched last. */
  cacheDir?: string;
```

2. Make `fileNames` accept any name:
```ts
function fileNames(name: string, env: ResolveOptions["env"], platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [name];
  const exts = (env?.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
  return exts.map((ext) => `${name}${ext.toLowerCase()}`);
}
```

3. In `resolveBinary`, replace the whole `if (options.bundledDir) { ... }` block (from `if (options.bundledDir) {` to the closing brace before `throw new BinaryNotFoundError(tool, tried);`) with:
```ts
  const fromDir = async (dir: string | undefined, source: BinarySource) => {
    if (!dir) return undefined;
    for (const name of names) {
      const path = join(dir, name);
      if (!(await isExecutable(path))) continue;
      const output = await works(path);
      if (output !== undefined) return found(path, source, output);
    }
    tried.push(`${source} in ${dir}`);
    return undefined;
  };

  const bundled = await fromDir(options.bundledDir, "bundled");
  if (bundled) return bundled;
  const cached = await fromDir(options.cacheDir, "cache");
  if (cached) return cached;
```

4. Append `findOnPath` at the end of the file:
```ts
export interface FindOnPathOptions {
  env?: ResolveOptions["env"];
  platform?: NodeJS.Platform;
  isExecutable?: (path: string) => Promise<boolean>;
}

/** The first executable called `name` on PATH, or undefined. Does not run it. */
export async function findOnPath(
  name: string,
  options: FindOnPathOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const file of fileNames(name, env, platform)) {
      const path = join(dir, file);
      if (await isExecutable(path)) return path;
    }
  }
  return undefined;
}
```
Make sure the existing PATH loop in `resolveBinary` (`const names = fileNames(tool, env, platform);`) still compiles; `tool` is a `Tool`, which is a string.

5. Replace `promisify(execFile)` in `resolve.ts`. Delete the imports `execFile` (from `node:child_process`) and `promisify` (from `node:util`) and the line `const execFileAsync = promisify(execFile);`, import `execFileText` from `./exec.ts`, and replace `defaultRun` with:
```ts
const defaultRun = (path: string, args: string[]) => execFileText(path, args);
```
(The old `defaultRun` passed `timeout: 10_000, windowsHide: true`; `execFileText` has the same defaults.)

Create `packages/binary-resolver/src/exec.test.ts` first and see it fail:
```ts
import { describe, expect, it } from "vitest";
import { execFileText } from "./exec.ts";

describe("execFileText", () => {
  it("resolves with the program's stdout as a string", async () => {
    expect(await execFileText(process.execPath, ["-p", "1 + 1"])).toBe("2\n");
  });

  it("rejects when the program exits with an error", async () => {
    await expect(execFileText(process.execPath, ["-e", "process.exit(3)"])).rejects.toThrow();
  });

  it("rejects when the program does not exist", async () => {
    await expect(execFileText("definitely-not-a-program-mediaforge", [])).rejects.toThrow();
  });

  it("rejects when the program outruns the timeout", async () => {
    await expect(
      execFileText(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 100 }),
    ).rejects.toThrow();
  });
});
```
Then create `packages/binary-resolver/src/exec.ts`:
```ts
import { execFile } from "node:child_process";

export interface ExecTextOptions {
  /** Kill the program after this long. Default 10 seconds. */
  timeoutMs?: number;
  /** Largest stdout to accept, in bytes. Node's default (1 MiB) when omitted. */
  maxBuffer?: number;
}

/**
 * Run a program and return its stdout. It uses the callback form of `execFile` on purpose: inside
 * a pkg binary `util.promisify(execFile)` resolves to the stdout string instead of
 * `{ stdout, stderr }` (pkg patches `execFile`), so `.stdout` was undefined and every tool looked
 * "not runnable".
 */
export function execFileText(
  path: string,
  args: string[],
  { timeoutMs = 10_000, maxBuffer }: ExecTextOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      path,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8", ...(maxBuffer !== undefined && { maxBuffer }) },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}
```
Add `export * from "./exec.ts";` to `packages/binary-resolver/src/index.ts` (alphabetical, after `errors`).

- [ ] **Step 4: Run all resolver tests**

Run: `pnpm exec biome check --write packages/binary-resolver/src && pnpm exec vitest run packages/binary-resolver && pnpm typecheck`
Expected: PASS, including the existing "reports what it tried" test (its message still contains `older than supported`).

- [ ] **Step 5: Commit message**

Output for the user:
```text
✨ binary-resolver: look in the managed cache and expose findOnPath

Test: pnpm exec vitest run packages/binary-resolver
```

### Task 6: Streaming download with SHA-256

**Files:**
- Create: `packages/binary-resolver/src/download-file.ts`
- Create: `packages/binary-resolver/src/download-file.test.ts`
- Modify: `packages/binary-resolver/src/index.ts`

**Interfaces:**
- Consumes: `FetchLike`, `InstallFs`, `WritableFile` (Task 3), `offlineError`, `httpError`, `fsError`, `isFsError`, `ToolInstallError` (Task 3), test helpers (Task 4).
- Produces:
  - `request(fetchFn: FetchLike, url: string, init?: Parameters<FetchLike>[1]): Promise<Response>` (a network failure becomes `offlineError(url)`; an abort is rethrown as is)
  - `downloadFile(options: { url: string; dest: string; fetch: FetchLike; fs: InstallFs; signal?: AbortSignal; onProgress?: (received: number, total: number | undefined) => void }): Promise<{ sha256: string; bytes: number }>` (on any failure the partly written `dest` is removed)

- [ ] **Step 1: Write the failing test**

Create `packages/binary-resolver/src/download-file.test.ts`:
```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { downloadFile } from "./download-file.ts";
import { ToolInstallError } from "./errors.ts";
import { memoryInstallFs, routeFetch, streamResponse } from "./test-helpers.ts";

const URL = "https://example.test/yt-dlp";
const DEST = "/cache/bin/.yt-dlp.download";

describe("downloadFile", () => {
  it("writes the file, hashes it and reports progress", async () => {
    const mem = memoryInstallFs();
    const seen: [number, number | undefined][] = [];
    const result = await downloadFile({
      url: URL,
      dest: DEST,
      fetch: routeFetch({ [URL]: () => streamResponse("hello world", 4) }),
      fs: mem.fs,
      onProgress: (received, total) => seen.push([received, total]),
    });
    expect(result).toEqual({
      sha256: createHash("sha256").update("hello world").digest("hex"),
      bytes: 11,
    });
    expect(mem.text(DEST)).toBe("hello world");
    expect(seen.at(-1)).toEqual([11, 11]);
    expect(seen.map(([received]) => received)).toEqual([...seen.map(([r]) => r)].sort((a, b) => a - b));
  });

  it("turns HTTP errors into install errors and writes nothing", async () => {
    const mem = memoryInstallFs();
    const error = await downloadFile({
      url: URL,
      dest: DEST,
      fetch: routeFetch({}),
      fs: mem.fs,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("not-found");
    expect(mem.paths()).toEqual([]);
  });

  it("reports an unreachable host as offline", async () => {
    const mem = memoryInstallFs();
    const error = await downloadFile({
      url: URL,
      dest: DEST,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      fs: mem.fs,
    }).catch((e) => e);
    expect(error.kind).toBe("offline");
    expect(error.message).toContain("example.test");
  });

  it("removes the partial file when the connection drops mid-download", async () => {
    const mem = memoryInstallFs();
    const error = await downloadFile({
      url: URL,
      dest: DEST,
      fetch: routeFetch({ [URL]: () => streamResponse("0123456789abcdef", 4, 8) }),
      fs: mem.fs,
    }).catch((e) => e);
    expect(error.kind).toBe("offline");
    expect(mem.paths()).toEqual([]);
  });

  it("reports a full disk and removes the partial file", async () => {
    const mem = memoryInstallFs();
    mem.state.writeError = Object.assign(new Error("full"), { code: "ENOSPC" });
    const error = await downloadFile({
      url: URL,
      dest: DEST,
      fetch: routeFetch({ [URL]: () => streamResponse("data", 2) }),
      fs: mem.fs,
    }).catch((e) => e);
    expect(error.kind).toBe("disk-full");
    expect(mem.paths()).toEqual([]);
  });

  it("rethrows an abort as is", async () => {
    const mem = memoryInstallFs();
    const controller = new AbortController();
    controller.abort(new DOMException("Aborted", "AbortError"));
    await expect(
      downloadFile({
        url: URL,
        dest: DEST,
        signal: controller.signal,
        fetch: async (_url, init) => {
          throw init?.signal?.reason;
        },
        fs: mem.fs,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run packages/binary-resolver/src/download-file.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `packages/binary-resolver/src/download-file.ts`:
```ts
import { createHash } from "node:crypto";
import { fsError, httpError, isFsError, offlineError, ToolInstallError } from "./errors.ts";
import type { FetchLike, InstallFs, WritableFile } from "./install-types.ts";

/** `fetch` that turns a network failure into an `offline` install error. */
export async function request(
  fetchFn: FetchLike,
  url: string,
  init?: Parameters<FetchLike>[1],
): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw offlineError(url);
  }
}

export interface DownloadFileOptions {
  url: string;
  /** Where the bytes go. Removed again if anything fails. */
  dest: string;
  fetch: FetchLike;
  fs: InstallFs;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number | undefined) => void;
}

/** Stream a URL to `dest`, hashing as it goes. Returns the SHA-256 of what was written. */
export async function downloadFile(
  options: DownloadFileOptions,
): Promise<{ sha256: string; bytes: number }> {
  const { url, dest, fs } = options;
  const response = await request(options.fetch, url, { signal: options.signal });
  if (!response.ok) throw httpError(url, response.status);
  if (!response.body) {
    throw new ToolInstallError("http", `Empty response from ${url}.`, "Try again later.");
  }

  const total = Number(response.headers.get("content-length")) || undefined;
  const hash = createHash("sha256");
  let received = 0;
  let file: WritableFile | undefined;
  try {
    file = await fs.openWrite(dest);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      await file.write(value);
      received += value.byteLength;
      options.onProgress?.(received, total);
    }
    await file.close();
    file = undefined;
  } catch (error) {
    await file?.close().catch(() => {});
    await fs.rm(dest).catch(() => {});
    if (options.signal?.aborted || error instanceof ToolInstallError) throw error;
    // A file system code means the disk is the problem; anything else is the connection.
    throw isFsError(error) ? fsError(error, dest) : offlineError(url);
  }
  return { sha256: hash.digest("hex"), bytes: received };
}
```

Add `export * from "./download-file.ts";` to `packages/binary-resolver/src/index.ts` (alphabetical, after `cache-dir`).

- [ ] **Step 4: Run the tests**

Run: `pnpm exec biome check --write packages/binary-resolver/src && pnpm exec vitest run packages/binary-resolver && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit message**

Output for the user:
```text
✨ binary-resolver: add hash-verified streaming download

Test: pnpm exec vitest run packages/binary-resolver
```

### Task 7: Tool sources (yt-dlp nightly and the ffmpeg lock)

**Files:**
- Create: `packages/binary-resolver/src/sources.ts`
- Create: `packages/binary-resolver/src/sources.test.ts`
- Create: `packages/binary-resolver/src/lock.ts`
- Create: `packages/binary-resolver/src/lock.test.ts`
- Create: `packages/binary-resolver/src/tools.lock.json`
- Modify: `packages/binary-resolver/tsconfig.json`, `tsconfig.base.json`, `packages/binary-resolver/src/index.ts`

**Interfaces:**
- Consumes: `Target`, `targetKey` (Task 2), `ToolInstallError`, `httpError` (Task 3), `request` (Task 6), `ArchiveKind`, `FetchLike`.
- Produces:
  - `interface ToolSource { version: string; url: string; sha256: string; archive: ArchiveKind; member?: string }` (`member` is the file to take out of an archive, matched as a path suffix)
  - `DEFAULT_YTDLP_REPO = "https://github.com/yt-dlp/yt-dlp-nightly-builds"`, `YTDLP_ASSETS: Record<string, string>` (keyed by `targetKey`)
  - `parseSha256Sums(text: string): Map<string, string>` (file name to lowercase hex)
  - `resolveYtDlpSource(target: Target, fetchFn: FetchLike, repoUrl?: string): Promise<ToolSource>`
  - `interface LockEntry { version: string; url: string; sha256: string; archive: ArchiveKind; member: string; license: string; buildInfo: string }`, `interface ToolsLock { schema: 1; ffmpeg: Record<string, LockEntry> }`
  - `TOOLS_LOCK: ToolsLock`, `ffmpegSource(target: Target, lock?: ToolsLock): ToolSource`, `validateLock(lock: ToolsLock): string[]` (problems, empty when valid)

- [ ] **Step 1: Allow JSON imports**

In `tsconfig.base.json` add `"resolveJsonModule": true` to `compilerOptions`. In `packages/binary-resolver/tsconfig.json` change `"include": ["src"]` to `"include": ["src", "src/**/*.json"]`.

Create `packages/binary-resolver/src/tools.lock.json` (Task 10 fills it):
```json
{
  "schema": 1,
  "ffmpeg": {}
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/binary-resolver/src/sources.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ToolInstallError } from "./errors.ts";
import { DEFAULT_YTDLP_REPO, parseSha256Sums, resolveYtDlpSource } from "./sources.ts";
import { resolveTarget } from "./target.ts";
import { routeFetch } from "./test-helpers.ts";

const REPO = "https://example.test/ytdlp";
const TAG = "2026.10.08.123456";
const HASH_A = "a".repeat(64);
const HASH_B = "B".repeat(64);

const sums = [
  `${HASH_A}  yt-dlp.exe`,
  `${HASH_B} *yt-dlp_linux`,
  `${HASH_A}  yt-dlp_linux_aarch64`,
  `${HASH_A}  yt-dlp_macos`,
  "not a checksum line",
  "",
].join("\n");

const routes = (overrides: Record<string, () => Response> = {}) => ({
  [`${REPO}/releases/latest`]: () =>
    new Response(null, { status: 302, headers: { location: `${REPO}/releases/tag/${TAG}` } }),
  [`${REPO}/releases/download/${TAG}/SHA2-256SUMS`]: () => new Response(sums),
  ...overrides,
});

describe("parseSha256Sums", () => {
  it("reads both text and binary mode lines, lowercases, and skips junk", () => {
    const parsed = parseSha256Sums(sums);
    expect(parsed.get("yt-dlp.exe")).toBe(HASH_A);
    expect(parsed.get("yt-dlp_linux")).toBe(HASH_B.toLowerCase());
    expect(parsed.size).toBe(4);
  });
});

describe("resolveYtDlpSource", () => {
  it.each([
    ["win32", "x64", "yt-dlp.exe"],
    ["win32", "arm64", "yt-dlp.exe"],
    ["linux", "x64", "yt-dlp_linux"],
    ["linux", "arm64", "yt-dlp_linux_aarch64"],
    ["darwin", "x64", "yt-dlp_macos"],
    ["darwin", "arm64", "yt-dlp_macos"],
  ])("picks the %s %s asset", async (platform, arch, asset) => {
    const source = await resolveYtDlpSource(
      resolveTarget(platform, arch),
      routeFetch(routes()),
      REPO,
    );
    expect(source).toMatchObject({
      version: TAG,
      url: `${REPO}/releases/download/${TAG}/${asset}`,
      archive: "none",
    });
    expect(source.sha256).toHaveLength(64);
  });

  it("looks in yt-dlp's nightly repository by default", () => {
    expect(DEFAULT_YTDLP_REPO).toBe("https://github.com/yt-dlp/yt-dlp-nightly-builds");
  });

  it("reports a missing release as not-found", async () => {
    const fetchFn = routeFetch({});
    const error = await resolveYtDlpSource(resolveTarget("linux", "x64"), fetchFn, REPO).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("not-found");
  });

  it("reports an unreachable host as offline", async () => {
    const error = await resolveYtDlpSource(
      resolveTarget("linux", "x64"),
      async () => {
        throw new TypeError("fetch failed");
      },
      REPO,
    ).catch((e) => e);
    expect(error.kind).toBe("offline");
  });

  it("fails clearly when the redirect has no Location", async () => {
    const fetchFn = routeFetch(routes({ [`${REPO}/releases/latest`]: () => new Response("ok") }));
    const error = await resolveYtDlpSource(resolveTarget("linux", "x64"), fetchFn, REPO).catch(
      (e) => e,
    );
    expect(error.kind).toBe("no-source");
  });

  it("fails clearly when the checksum file lacks the asset", async () => {
    const fetchFn = routeFetch(
      routes({
        [`${REPO}/releases/download/${TAG}/SHA2-256SUMS`]: () => new Response(`${HASH_A}  other`),
      }),
    );
    const error = await resolveYtDlpSource(resolveTarget("linux", "x64"), fetchFn, REPO).catch(
      (e) => e,
    );
    expect(error.kind).toBe("no-source");
    expect(error.message).toContain("yt-dlp_linux");
  });
});
```

Create `packages/binary-resolver/src/lock.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ToolInstallError } from "./errors.ts";
import { ffmpegSource, type LockEntry, type ToolsLock, validateLock } from "./lock.ts";
import { resolveTarget } from "./target.ts";

const entry: LockEntry = {
  version: "7.1",
  url: "https://example.test/ffmpeg.tar.xz",
  sha256: "c".repeat(64),
  archive: "tar.xz",
  member: "bin/ffmpeg",
  license: "LGPL-2.1-or-later",
  buildInfo: "https://example.test/build",
};
const lock: ToolsLock = { schema: 1, ffmpeg: { "linux-x64": entry } };

describe("ffmpegSource", () => {
  it("returns the pinned build for the target", () => {
    expect(ffmpegSource(resolveTarget("linux", "x64"), lock)).toEqual({
      version: "7.1",
      url: entry.url,
      sha256: entry.sha256,
      archive: "tar.xz",
      member: "bin/ffmpeg",
    });
  });

  it("says so when no build is pinned for the target", () => {
    const error = (() => {
      try {
        return ffmpegSource(resolveTarget("darwin", "arm64"), lock);
      } catch (e) {
        return e;
      }
    })() as ToolInstallError;
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("unsupported");
    expect(error.message).toContain("darwin-arm64");
  });
});

describe("validateLock", () => {
  it("accepts a good lock", () => {
    expect(validateLock(lock)).toEqual([]);
  });

  it("reports a bad hash, a non-https URL, an unknown archive and a missing license", () => {
    const bad = {
      schema: 1,
      ffmpeg: {
        "linux-x64": {
          ...entry,
          sha256: "xyz",
          url: "http://example.test/x",
          archive: "rar",
          license: "",
        },
      },
    } as unknown as ToolsLock;
    const problems = validateLock(bad).join("\n");
    expect(problems).toContain("sha256");
    expect(problems).toContain("https");
    expect(problems).toContain("archive");
    expect(problems).toContain("license");
  });
});
```

- [ ] **Step 3: Run them to confirm they fail**

Run: `pnpm exec vitest run packages/binary-resolver/src/sources.test.ts packages/binary-resolver/src/lock.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

Create `packages/binary-resolver/src/sources.ts`:
```ts
import { httpError, ToolInstallError } from "./errors.ts";
import { request } from "./download-file.ts";
import type { ArchiveKind, FetchLike } from "./install-types.ts";
import { type Target, targetKey } from "./target.ts";

/** Where a tool comes from and what its download must hash to. */
export interface ToolSource {
  version: string;
  url: string;
  sha256: string;
  archive: ArchiveKind;
  /** File to take out of an archive, matched as a path suffix. */
  member?: string;
}

export const DEFAULT_YTDLP_REPO = "https://github.com/yt-dlp/yt-dlp-nightly-builds";

/** yt-dlp's standalone asset per target. Both macOS CPUs use the universal build. */
export const YTDLP_ASSETS: Record<string, string> = {
  "win32-x64": "yt-dlp.exe",
  "linux-x64": "yt-dlp_linux",
  "linux-arm64": "yt-dlp_linux_aarch64",
  "darwin-x64": "yt-dlp_macos",
  "darwin-arm64": "yt-dlp_macos",
};

/** Read a `SHA2-256SUMS` file: lines of `<hex>  <name>` or `<hex> *<name>`. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) sums.set(match[2] as string, (match[1] as string).toLowerCase());
  }
  return sums;
}

/** The tag of the newest release, read from the redirect of `<repo>/releases/latest`. */
async function latestTag(fetchFn: FetchLike, repoUrl: string): Promise<string> {
  const url = `${repoUrl}/releases/latest`;
  const response = await request(fetchFn, url, { redirect: "manual" });
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location) {
    const tag = new URL(location, url).pathname.split("/").filter(Boolean).at(-1);
    if (tag) return decodeURIComponent(tag);
  }
  if (response.status >= 400) throw httpError(url, response.status);
  throw new ToolInstallError(
    "no-source",
    `Could not find the latest yt-dlp release at ${url}.`,
    "Try again later, or install yt-dlp yourself and add it to PATH.",
  );
}

/** The newest yt-dlp nightly for this target, with the hash its checksum file promises. */
export async function resolveYtDlpSource(
  target: Target,
  fetchFn: FetchLike,
  repoUrl: string = DEFAULT_YTDLP_REPO,
): Promise<ToolSource> {
  const asset = YTDLP_ASSETS[targetKey(target)];
  if (!asset) {
    throw new ToolInstallError(
      "unsupported",
      `No yt-dlp build for ${targetKey(target)}.`,
      "Install yt-dlp yourself and add it to PATH.",
    );
  }
  const tag = await latestTag(fetchFn, repoUrl);
  const base = `${repoUrl}/releases/download/${tag}`;
  const sumsUrl = `${base}/SHA2-256SUMS`;
  const response = await request(fetchFn, sumsUrl);
  if (!response.ok) throw httpError(sumsUrl, response.status);
  const sha256 = parseSha256Sums(await response.text()).get(asset);
  if (!sha256) {
    throw new ToolInstallError(
      "no-source",
      `The checksum file for ${tag} has no entry for ${asset}.`,
      "Try again in a few minutes; the release may still be uploading.",
    );
  }
  return { version: tag, url: `${base}/${asset}`, sha256, archive: "none" };
}
```

Create `packages/binary-resolver/src/lock.ts`:
```ts
import { ToolInstallError } from "./errors.ts";
import type { ArchiveKind } from "./install-types.ts";
import lockData from "./tools.lock.json";
import type { ToolSource } from "./sources.ts";
import { type Target, targetKey } from "./target.ts";

/** One pinned ffmpeg build. Bumping ffmpeg means editing this file (see `pin-ffmpeg.mjs`). */
export interface LockEntry {
  version: string;
  url: string;
  sha256: string;
  archive: ArchiveKind;
  /** File to take out of the archive, matched as a path suffix. */
  member: string;
  /** Licence of this exact build, taken from the build's documentation, not guessed. */
  license: string;
  /** Page that documents how the build was configured. */
  buildInfo: string;
}

export interface ToolsLock {
  schema: 1;
  ffmpeg: Record<string, LockEntry>;
}

export const TOOLS_LOCK = lockData as unknown as ToolsLock;

const ARCHIVES = new Set<string>(["none", "zip", "tar.xz", "tar"]);

export function ffmpegSource(target: Target, lock: ToolsLock = TOOLS_LOCK): ToolSource {
  const entry = lock.ffmpeg[targetKey(target)];
  if (!entry) {
    throw new ToolInstallError(
      "unsupported",
      `No ffmpeg build is pinned for ${targetKey(target)}.`,
      "Install ffmpeg yourself and add it to PATH.",
    );
  }
  return {
    version: entry.version,
    url: entry.url,
    sha256: entry.sha256,
    archive: entry.archive,
    member: entry.member,
  };
}

/** Everything wrong with a lock, one line each. Empty when it is usable. */
export function validateLock(lock: ToolsLock): string[] {
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(lock.ffmpeg)) {
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) problems.push(`${key}: sha256 is not 64 hex digits`);
    if (!entry.url.startsWith("https://")) problems.push(`${key}: url must be https`);
    if (!ARCHIVES.has(entry.archive)) problems.push(`${key}: unknown archive "${entry.archive}"`);
    if (!entry.member) problems.push(`${key}: member is empty`);
    if (!entry.version) problems.push(`${key}: version is empty`);
    if (!entry.license) problems.push(`${key}: license is empty`);
    if (!entry.buildInfo) problems.push(`${key}: buildInfo is empty`);
  }
  return problems;
}
```

Add to `packages/binary-resolver/src/index.ts`: `export * from "./lock.ts";` and `export * from "./sources.ts";` (alphabetical).

- [ ] **Step 5: Run the tests**

Run: `pnpm exec biome check --write packages/binary-resolver && pnpm exec vitest run packages/binary-resolver && pnpm typecheck`
Expected: PASS. If `tsc` rejects the JSON import, check that `resolveJsonModule` is set in `tsconfig.base.json` and that the package `include` lists the JSON file.

- [ ] **Step 6: Commit message**

Output for the user:
```text
✨ binary-resolver: resolve yt-dlp nightly and pinned ffmpeg sources

Test: pnpm exec vitest run packages/binary-resolver
```

### Task 8: `installTool`

**Files:**
- Create: `packages/binary-resolver/src/install.ts`
- Create: `packages/binary-resolver/src/install.test.ts`
- Modify: `packages/binary-resolver/src/errors.ts` (export `ISSUES_URL`), `packages/binary-resolver/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 2 to 7.
- Produces:
  - `interface InstallDeps { fetch: FetchLike; fs: InstallFs; extract: (archive: string, dest: string, kind: ArchiveKind) => Promise<void>; now?: () => Date; lock?: ToolsLock; ytDlpRepoUrl?: string }`
  - `interface InstallRequest { tool: Tool; target: Target; dir: string; onProgress?: (p: InstallProgress) => void; signal?: AbortSignal }`
  - `installTool(request: InstallRequest, deps: InstallDeps): Promise<InstallResult>`

Order of work inside `installTool`: resolve source, download to `.<tool>.download`, verify SHA-256, (extract archive and pick the member), set mode `0o755`, rename into place, then update `manifest.json`. All temp names are removed at the end, success or not.

- [ ] **Step 1: Write the failing tests**

Create `packages/binary-resolver/src/install.test.ts`:
```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ToolInstallError } from "./errors.ts";
import { type InstallDeps, installTool } from "./install.ts";
import type { ToolsLock } from "./lock.ts";
import { memoryInstallFs, routeFetch, streamResponse } from "./test-helpers.ts";

const DIR = "/cache/bin";
const REPO = "https://example.test/ytdlp";
const TAG = "2026.10.08.1";
const NOW = new Date("2026-10-08T12:00:00.000Z");
const LINUX = { os: "linux", arch: "x64" } as const;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function ytDlpRoutes(asset: string, content: string, sums = `${sha(content)}  ${asset}\n`) {
  return {
    [`${REPO}/releases/latest`]: () =>
      new Response(null, { status: 302, headers: { location: `${REPO}/releases/tag/${TAG}` } }),
    [`${REPO}/releases/download/${TAG}/SHA2-256SUMS`]: () => new Response(sums),
    [`${REPO}/releases/download/${TAG}/${asset}`]: () => streamResponse(content),
  };
}

const noExtract: InstallDeps["extract"] = async () => {
  throw new Error("unexpected extract");
};

const lock: ToolsLock = {
  schema: 1,
  ffmpeg: {
    "linux-x64": {
      version: "7.1",
      url: "https://example.test/ffmpeg.tar.xz",
      sha256: sha("ARCHIVE"),
      archive: "tar.xz",
      member: "bin/ffmpeg",
      license: "LGPL-2.1-or-later",
      buildInfo: "https://example.test/build",
    },
  },
};

function deps(
  mem: ReturnType<typeof memoryInstallFs>,
  fetchFn: InstallDeps["fetch"],
  extra: Partial<InstallDeps> = {},
): InstallDeps {
  return {
    fetch: fetchFn,
    fs: mem.fs,
    extract: noExtract,
    now: () => NOW,
    ytDlpRepoUrl: REPO,
    ...extra,
  };
}

describe("installTool: yt-dlp", () => {
  it("downloads, verifies and installs, then records it in the manifest", async () => {
    const mem = memoryInstallFs();
    const phases: string[] = [];
    const result = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR, onProgress: (p) => phases.push(p.phase) },
      deps(mem, routeFetch(ytDlpRoutes("yt-dlp_linux", "BINARY"))),
    );
    expect(result).toMatchObject({ tool: "yt-dlp", version: TAG, sha256: sha("BINARY") });
    expect(mem.text(result.path)).toBe("BINARY");
    expect(mem.mode(result.path)).toBe(0o755);
    expect(JSON.parse(mem.text(`${DIR}/manifest.json`))["yt-dlp"]).toEqual({
      version: TAG,
      url: `${REPO}/releases/download/${TAG}/yt-dlp_linux`,
      sha256: sha("BINARY"),
      installedAt: NOW.toISOString(),
    });
    expect(mem.paths()).toEqual([`${DIR}/manifest.json`, `${DIR}/yt-dlp`]);
    expect([...new Set(phases)]).toEqual(["resolving", "downloading", "verifying", "installing"]);
  });

  it("rejects a checksum mismatch and leaves nothing behind", async () => {
    const mem = memoryInstallFs();
    const bad = ytDlpRoutes("yt-dlp_linux", "BINARY", `${"0".repeat(64)}  yt-dlp_linux\n`);
    const error = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(mem, routeFetch(bad)),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("checksum");
    expect(mem.paths()).toEqual([]);
  });

  it("leaves no partial file when the connection drops", async () => {
    const mem = memoryInstallFs();
    const routes = {
      ...ytDlpRoutes("yt-dlp_linux", "BINARY-CONTENT"),
      [`${REPO}/releases/download/${TAG}/yt-dlp_linux`]: () =>
        streamResponse("BINARY-CONTENT", 4, 8),
    };
    const error = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(mem, routeFetch(routes)),
    ).catch((e) => e);
    expect(error.kind).toBe("offline");
    expect(mem.paths()).toEqual([]);
  });

  it("reports a full disk", async () => {
    const mem = memoryInstallFs();
    mem.state.writeError = Object.assign(new Error("full"), { code: "ENOSPC" });
    const error = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(mem, routeFetch(ytDlpRoutes("yt-dlp_linux", "BINARY"))),
    ).catch((e) => e);
    expect(error.kind).toBe("disk-full");
    expect(mem.paths()).toEqual([]);
  });

  it("keeps other tools' manifest entries and replaces an older binary", async () => {
    const other = { version: "7.1", url: "u", sha256: "s", installedAt: "t" };
    const mem = memoryInstallFs({
      [`${DIR}/manifest.json`]: JSON.stringify({ ffmpeg: other }),
      [`${DIR}/ffmpeg`]: "FFMPEG",
      [`${DIR}/yt-dlp`]: "OLD",
    });
    await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(mem, routeFetch(ytDlpRoutes("yt-dlp_linux", "NEW"))),
    );
    expect(mem.text(`${DIR}/yt-dlp`)).toBe("NEW");
    expect(JSON.parse(mem.text(`${DIR}/manifest.json`)).ffmpeg).toEqual(other);
  });

  it("rebuilds a corrupt manifest from the files already in the cache", async () => {
    const mem = memoryInstallFs({
      [`${DIR}/manifest.json`]: "{not json",
      [`${DIR}/ffmpeg`]: "FFMPEG",
    });
    await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(mem, routeFetch(ytDlpRoutes("yt-dlp_linux", "NEW"))),
    );
    const manifest = JSON.parse(mem.text(`${DIR}/manifest.json`));
    expect(manifest["yt-dlp"].version).toBe(TAG);
    expect(manifest.ffmpeg).toMatchObject({ version: "unknown", sha256: sha("FFMPEG") });
  });

  it("uses .exe names on Windows", async () => {
    const mem = memoryInstallFs();
    const result = await installTool(
      { tool: "yt-dlp", target: { os: "win32", arch: "x64" }, dir: DIR },
      deps(mem, routeFetch(ytDlpRoutes("yt-dlp.exe", "EXE"))),
    );
    expect(mem.has(`${DIR}/yt-dlp.exe`)).toBe(true);
    expect(result.path.endsWith("yt-dlp.exe")).toBe(true);
  });

  it("works in a folder with spaces and non-ASCII characters", async () => {
    const mem = memoryInstallFs();
    const dir = "/Users/José Núñez/AppData/Local/MediaForge/bin";
    await installTool(
      { tool: "yt-dlp", target: LINUX, dir },
      deps(mem, routeFetch(ytDlpRoutes("yt-dlp_linux", "BINARY"))),
    );
    expect(mem.text(`${dir}/yt-dlp`)).toBe("BINARY");
  });
});

describe("installTool: ffmpeg from an archive", () => {
  const fetchFor = () =>
    routeFetch({ "https://example.test/ffmpeg.tar.xz": () => streamResponse("ARCHIVE") });

  it("extracts the pinned member and removes the temp files", async () => {
    const mem = memoryInstallFs();
    const extract: InstallDeps["extract"] = async (_archive, dest) => {
      await mem.fs.writeText(`${dest}/ffmpeg-n7.1-linux64/bin/ffmpeg`, "FFMPEG-BIN");
      await mem.fs.writeText(`${dest}/ffmpeg-n7.1-linux64/bin/ffprobe`, "PROBE");
    };
    const result = await installTool(
      { tool: "ffmpeg", target: LINUX, dir: DIR },
      deps(mem, fetchFor(), { lock, extract }),
    );
    expect(result.version).toBe("7.1");
    expect(mem.text(`${DIR}/ffmpeg`)).toBe("FFMPEG-BIN");
    expect(mem.mode(`${DIR}/ffmpeg`)).toBe(0o755);
    expect(mem.paths()).toEqual([`${DIR}/ffmpeg`, `${DIR}/manifest.json`]);
  });

  it("fails clearly when the archive lacks the member", async () => {
    const mem = memoryInstallFs();
    const extract: InstallDeps["extract"] = async (_archive, dest) => {
      await mem.fs.writeText(`${dest}/readme.txt`, "x");
    };
    const error = await installTool(
      { tool: "ffmpeg", target: LINUX, dir: DIR },
      deps(mem, fetchFor(), { lock, extract }),
    ).catch((e) => e);
    expect(error.kind).toBe("extract");
    expect(error.message).toContain("bin/ffmpeg");
    expect(mem.paths()).toEqual([]);
  });

  it("wraps an extractor failure and suggests checking tar", async () => {
    const mem = memoryInstallFs();
    const extract: InstallDeps["extract"] = async () => {
      throw new Error("tar: xz: Cannot exec");
    };
    const error = await installTool(
      { tool: "ffmpeg", target: LINUX, dir: DIR },
      deps(mem, fetchFor(), { lock, extract }),
    ).catch((e) => e);
    expect(error.kind).toBe("extract");
    expect(error.hint).toContain("tar");
    expect(mem.paths()).toEqual([]);
  });

  it("refuses a target with no pinned build", async () => {
    const mem = memoryInstallFs();
    const error = await installTool(
      { tool: "ffmpeg", target: { os: "darwin", arch: "arm64" }, dir: DIR },
      deps(mem, fetchFor(), { lock }),
    ).catch((e) => e);
    expect(error.kind).toBe("unsupported");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run packages/binary-resolver/src/install.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

In `packages/binary-resolver/src/errors.ts` change `const ISSUES_URL = ...` to `export const ISSUES_URL = ...`.

Create `packages/binary-resolver/src/install.ts`:
```ts
import { join } from "node:path";
import { downloadFile } from "./download-file.ts";
import { checksumError, fsError, ISSUES_URL, ToolInstallError } from "./errors.ts";
import type {
  ArchiveKind,
  FetchLike,
  InstallFs,
  InstallProgress,
  InstallResult,
} from "./install-types.ts";
import { ffmpegSource, type ToolsLock } from "./lock.ts";
import { repairManifest, writeManifest } from "./manifest.ts";
import { resolveYtDlpSource } from "./sources.ts";
import { binaryFileName, type Target } from "./target.ts";
import type { Tool } from "./version.ts";

export interface InstallDeps {
  fetch: FetchLike;
  fs: InstallFs;
  /** Unpack `archive` into the folder `dest`. The real one runs `tar`. */
  extract: (archive: string, dest: string, kind: ArchiveKind) => Promise<void>;
  now?: () => Date;
  lock?: ToolsLock;
  /** Where the newest yt-dlp nightly is looked up. Tests point this at a local server. */
  ytDlpRepoUrl?: string;
}

export interface InstallRequest {
  tool: Tool;
  target: Target;
  /** The cache folder. */
  dir: string;
  onProgress?: (progress: InstallProgress) => void;
  signal?: AbortSignal;
}

const EXECUTABLE = 0o755;

/** Run a file system step; any failure becomes an install error that names the path. */
async function io<T>(operation: () => Promise<T>, path: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw fsError(error, path);
  }
}

/**
 * Download a tool into the cache. The bytes are hashed while they arrive and compared with the
 * published SHA-256 before anything else happens: nothing is unpacked, marked executable or moved
 * into place unless the hash matches. Temp files are removed whether or not it works.
 */
export async function installTool(
  request: InstallRequest,
  deps: InstallDeps,
): Promise<InstallResult> {
  const { tool, target, dir } = request;
  const { fs } = deps;
  const report = (progress: Omit<InstallProgress, "tool">) =>
    request.onProgress?.({ tool, ...progress });

  report({ phase: "resolving" });
  const source =
    tool === "yt-dlp"
      ? await resolveYtDlpSource(target, deps.fetch, deps.ytDlpRepoUrl)
      : ffmpegSource(target, deps.lock);

  const download = join(dir, `.${tool}.download`);
  const unpacked = join(dir, `.${tool}.unpacked`);
  const staged = join(dir, `.${tool}.staged`);
  const finalPath = join(dir, binaryFileName(tool, target.os));

  try {
    await io(() => fs.mkdir(dir), dir);

    report({ phase: "downloading", received: 0 });
    const { sha256 } = await downloadFile({
      url: source.url,
      dest: download,
      fetch: deps.fetch,
      fs,
      signal: request.signal,
      onProgress: (received, total) =>
        report({ phase: "downloading", received, ...(total !== undefined && { total }) }),
    });

    report({ phase: "verifying" });
    if (sha256 !== source.sha256) throw checksumError(tool, source.sha256, sha256);

    if (source.archive === "none") {
      await io(() => fs.rename(download, staged), staged);
    } else {
      report({ phase: "extracting" });
      await io(async () => {
        await fs.rm(unpacked);
        await fs.mkdir(unpacked);
      }, unpacked);
      try {
        await deps.extract(download, unpacked, source.archive);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ToolInstallError(
          "extract",
          `Could not unpack the ${tool} download: ${detail}`,
          "Make sure `tar` is installed (on Linux it needs xz support), then try again.",
        );
      }
      const wanted = source.member ?? binaryFileName(tool, target.os);
      const files = await io(() => fs.listFiles(unpacked), unpacked);
      const member = files.find((file) => file === wanted || file.endsWith(`/${wanted}`));
      if (!member) {
        throw new ToolInstallError(
          "extract",
          `${wanted} was not found in the ${tool} download.`,
          `The upstream build changed. Please report it at ${ISSUES_URL}.`,
        );
      }
      await io(() => fs.rename(join(unpacked, member), staged), staged);
    }

    report({ phase: "installing" });
    // Bring the manifest in line with the files already in the cache (a corrupt one is rebuilt)
    // before this tool is added to it.
    const manifest = await repairManifest(fs, dir, target.os, deps.now);
    await io(() => fs.chmod(staged, EXECUTABLE), staged);
    await io(() => fs.rename(staged, finalPath), finalPath);

    manifest[tool] = {
      version: source.version,
      url: source.url,
      sha256,
      installedAt: (deps.now ?? (() => new Date()))().toISOString(),
    };
    await io(() => writeManifest(fs, dir, manifest), dir);
    return { tool, version: source.version, path: finalPath, sha256, url: source.url };
  } finally {
    await Promise.all([download, unpacked, staged].map((path) => fs.rm(path).catch(() => {})));
  }
}
```

Add `export * from "./install.ts";` to `packages/binary-resolver/src/index.ts`.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec biome check --write packages/binary-resolver && pnpm exec vitest run packages/binary-resolver && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit message**

Output for the user:
```text
✨ binary-resolver: install yt-dlp and ffmpeg into the cache with hash checks

Test: pnpm exec vitest run packages/binary-resolver
```

### Task 9: Real file system, fetch and `tar` adapters

**Files:**
- Create: `packages/binary-resolver/src/node-adapters.ts`
- Create: `packages/binary-resolver/src/node-adapters.test.ts`
- Modify: `packages/binary-resolver/src/index.ts`

**Interfaces:**
- Consumes: `InstallFs`, `FetchLike` (Task 3), `InstallDeps`, `installTool` (Task 8), `ToolsLock` (Task 7).
- Produces: `realInstallFs: InstallFs`, `nodeFetch: FetchLike`, `tarExtract: InstallDeps["extract"]`, `defaultInstallDeps(): Pick<InstallDeps, "fetch" | "fs" | "extract">`.

`tarExtract` runs `tar -xf <archive> -C <dest>`. Each OS unpacks the archive type it is given: Windows and macOS `tar` (bsdtar) read zip, Linux `tar` reads `.tar.xz` (it needs `xz`). On Windows it calls `%SystemRoot%\System32\tar.exe` directly, because a GNU `tar` earlier on PATH (Git for Windows) cannot read zip.

- [ ] **Step 1: Write the failing tests**

Create `packages/binary-resolver/src/node-adapters.test.ts`:
```ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTool } from "./install.ts";
import type { ToolsLock } from "./lock.ts";
import { defaultInstallDeps, realInstallFs, tarExtract } from "./node-adapters.ts";
import { resolveTarget, targetKey } from "./target.ts";
import { routeFetch } from "./test-helpers.ts";

const run = promisify(execFile);
let root: string;

// A folder name with spaces and non-ASCII letters, like some Windows user profiles.
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mf José Núñez "));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Build `archive.tar` containing pkg-1/bin/ffmpeg, using the system tar with relative paths. */
async function makeTar(content: string): Promise<string> {
  await mkdir(join(root, "src", "pkg-1", "bin"), { recursive: true });
  await writeFile(join(root, "src", "pkg-1", "bin", "ffmpeg"), content);
  await run("tar", ["-cf", "archive.tar", "-C", "src", "."], { cwd: root });
  return join(root, "archive.tar");
}

describe("realInstallFs", () => {
  it("writes in chunks, hashes, lists, renames and removes", async () => {
    const dir = join(root, "a", "b");
    await realInstallFs.mkdir(dir);
    const file = await realInstallFs.openWrite(join(dir, "x.bin"));
    await file.write(new TextEncoder().encode("hello "));
    await file.write(new TextEncoder().encode("world"));
    await file.close();

    expect(await realInstallFs.sha256File(join(dir, "x.bin"))).toBe(
      createHash("sha256").update("hello world").digest("hex"),
    );
    expect(await realInstallFs.listFiles(join(root, "a"))).toEqual(["b/x.bin"]);

    await realInstallFs.rename(join(dir, "x.bin"), join(dir, "y.bin"));
    expect(await realInstallFs.exists(join(dir, "x.bin"))).toBe(false);
    expect(await realInstallFs.readText(join(dir, "y.bin"))).toBe("hello world");

    await realInstallFs.rm(join(root, "a"));
    await realInstallFs.rm(join(root, "a"));
    expect(await realInstallFs.exists(join(root, "a"))).toBe(false);
  });
});

describe("tarExtract", () => {
  it("unpacks an archive into the destination", async () => {
    const archive = await makeTar("FFMPEG");
    const out = join(root, "out");
    await mkdir(out);
    await tarExtract(archive, out, "tar");
    expect(await realInstallFs.listFiles(out)).toContain("pkg-1/bin/ffmpeg");
  });

  it("rejects with tar's message when the archive is unreadable", async () => {
    await mkdir(join(root, "out"));
    await expect(tarExtract(join(root, "missing.tar"), join(root, "out"), "tar")).rejects.toThrow();
  });
});

describe("installTool with the real adapters", () => {
  it("installs ffmpeg from a tar archive into a folder with spaces and accents", async () => {
    const archive = await makeTar("REAL-FFMPEG");
    const bytes = await readFile(archive);
    const key = targetKey(resolveTarget());
    const lock: ToolsLock = {
      schema: 1,
      ffmpeg: {
        [key]: {
          version: "9.9",
          url: "https://example.test/ffmpeg.tar",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          archive: "tar",
          member: "bin/ffmpeg",
          license: "LGPL-2.1-or-later",
          buildInfo: "https://example.test",
        },
      },
    };
    const dir = join(root, "Mädia Förge", "bin");
    const result = await installTool(
      { tool: "ffmpeg", target: resolveTarget(), dir },
      {
        ...defaultInstallDeps(),
        fetch: routeFetch({ "https://example.test/ffmpeg.tar": () => new Response(bytes) }),
        lock,
      },
    );
    expect(await readFile(result.path, "utf8")).toBe("REAL-FFMPEG");
    expect((await realInstallFs.listFiles(dir)).sort()).toEqual([
      expect.stringMatching(/^ffmpeg(\.exe)?$/),
      "manifest.json",
    ]);
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm exec vitest run packages/binary-resolver/src/node-adapters.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `packages/binary-resolver/src/node-adapters.ts`:
```ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import type { InstallDeps } from "./install.ts";
import type { FetchLike, InstallFs } from "./install-types.ts";

export const realInstallFs: InstallFs = {
  mkdir: async (path) => void (await mkdir(path, { recursive: true })),
  openWrite: async (path) => {
    const handle = await open(path, "w");
    return {
      write: async (chunk) => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          offset += bytesWritten;
        }
      },
      close: () => handle.close(),
    };
  },
  rename,
  rm: (path) => rm(path, { recursive: true, force: true }),
  chmod,
  readText: (path) => readFile(path, "utf8"),
  writeText: (path, data) => writeFile(path, data, "utf8"),
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  listFiles: async (dir) => {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
  },
  sha256File: (path) =>
    new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      createReadStream(path)
        .on("data", (chunk) => hash.update(chunk))
        .on("error", reject)
        .on("end", () => resolve(hash.digest("hex")));
    }),
};

export const nodeFetch: FetchLike = (url, init) => fetch(url, init);

/** On Windows use the system bsdtar: it reads zip. Git for Windows' GNU tar does not. */
const tarCommand = (): string =>
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

export const tarExtract: InstallDeps["extract"] = (archive, dest) =>
  new Promise((resolve, reject) => {
    execFile(
      tarCommand(),
      ["-xf", archive, "-C", dest],
      { windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve();
      },
    );
  });

export const defaultInstallDeps = (): Pick<InstallDeps, "fetch" | "fs" | "extract"> => ({
  fetch: nodeFetch,
  fs: realInstallFs,
  extract: tarExtract,
});
```

Add `export * from "./node-adapters.ts";` to `packages/binary-resolver/src/index.ts`.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec biome check --write packages/binary-resolver && pnpm exec vitest run packages/binary-resolver && pnpm typecheck`
Expected: PASS. If the `makeTar` step fails because `tar` is missing on the machine, install it first; every supported OS ships one.

- [ ] **Step 5: Commit message**

Output for the user:
```text
✨ binary-resolver: add real file system, fetch and tar adapters

Test: pnpm exec vitest run packages/binary-resolver
```

### Task 10: Pin script and the real `tools.lock.json`

**Files:**
- Create: `tools/release/package.json`
- Create: `tools/release/pin-lib.mjs`
- Create: `tools/release/pin-lib.test.mjs`
- Create: `tools/release/pin-ffmpeg.mjs`
- Create: `packages/binary-resolver/src/tools-lock.test.ts`
- Modify: `packages/binary-resolver/src/tools.lock.json` (generated)
- Modify: `vitest.config.ts`, `package.json` (script `pin:ffmpeg`)

**Interfaces:**
- Consumes: the `LockEntry` shape from Task 7.
- Produces: `tools.lock.json` with `ffmpeg` entries for `win32-x64`, `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`. Pure helpers in `pin-lib.mjs`: `BTBN_TARGETS`, `RIEDL_TARGETS`, `selectBtbnAsset(names, target)`, `parseRiedlLocation(location, base)`, `renderLock(lock)`.

Plan decision: the spec asks to record the "configure flags" per build. The pin script records `buildInfo`, a page that documents how the build was configured (the FFmpeg-Builds release page; Martin Riedl's site). The exact `./configure` line is what `ffmpeg -buildconf` prints; the script does not run downloaded binaries, so it does not capture it.

- [ ] **Step 1: Register the tools package in the test run**

Create `tools/release/package.json`:
```json
{
  "name": "@mediaforge/release-tools",
  "version": "0.1.0",
  "private": true,
  "type": "module"
}
```
In `vitest.config.ts` change the projects line to `projects: ["packages/*", "apps/*", "tools/*"],`. In the root `package.json` `scripts`, add `"pin:ffmpeg": "node tools/release/pin-ffmpeg.mjs"`. Run `pnpm install` so the workspace sees the new package.

- [ ] **Step 2: Write the failing tests**

Create `tools/release/pin-lib.test.mjs`:
```js
import { describe, expect, it } from "vitest";
import {
  BTBN_TARGETS,
  parseRiedlLocation,
  renderLock,
  selectBtbnAsset,
} from "./pin-lib.mjs";

const names = [
  "checksums.sha256",
  "ffmpeg-master-latest-win64-gpl.zip",
  "ffmpeg-master-latest-win64-lgpl.zip",
  "ffmpeg-n7.1.2-6-g1234567-win64-gpl-7.1.zip",
  "ffmpeg-n7.1.2-6-g1234567-win64-lgpl-7.1.zip",
  "ffmpeg-n7.1.2-6-g1234567-win64-lgpl-shared-7.1.zip",
  "ffmpeg-n7.1.2-6-g1234567-linux64-lgpl-7.1.tar.xz",
  "ffmpeg-n7.1.2-6-g1234567-linuxarm64-lgpl-7.1.tar.xz",
  "ffmpeg-n7.1.2-6-g1234567-linuxarm64-lgpl-shared-7.1.tar.xz",
];

describe("selectBtbnAsset", () => {
  it("picks the versioned static LGPL build for each target", () => {
    expect(selectBtbnAsset(names, "win32-x64")).toEqual({
      name: "ffmpeg-n7.1.2-6-g1234567-win64-lgpl-7.1.zip",
      version: "7.1.2",
    });
    expect(selectBtbnAsset(names, "linux-x64").name).toBe(
      "ffmpeg-n7.1.2-6-g1234567-linux64-lgpl-7.1.tar.xz",
    );
    expect(selectBtbnAsset(names, "linux-arm64").name).toBe(
      "ffmpeg-n7.1.2-6-g1234567-linuxarm64-lgpl-7.1.tar.xz",
    );
  });

  it("prefers the highest version when a release has several", () => {
    const more = [...names, "ffmpeg-n8.0-3-gabcdef0-win64-lgpl-8.0.zip"];
    expect(selectBtbnAsset(more, "win32-x64").version).toBe("8.0");
  });

  it("fails with the candidate names when nothing matches", () => {
    expect(() => selectBtbnAsset(["ffmpeg-master-latest-win64-lgpl.zip"], "win32-x64")).toThrow(
      /win64/,
    );
  });

  it("describes how to unpack each target", () => {
    expect(BTBN_TARGETS["win32-x64"]).toMatchObject({ archive: "zip", member: "bin/ffmpeg.exe" });
    expect(BTBN_TARGETS["linux-x64"]).toMatchObject({ archive: "tar.xz", member: "bin/ffmpeg" });
  });
});

describe("parseRiedlLocation", () => {
  it("makes the redirect absolute and reads the build id from the path", () => {
    expect(
      parseRiedlLocation("/download/macos/arm64/1759999999_8.0.1/ffmpeg.zip", "https://ffmpeg.martin-riedl.de"),
    ).toEqual({
      url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1759999999_8.0.1/ffmpeg.zip",
      version: "1759999999_8.0.1",
    });
  });

  it("rejects a location without a build folder", () => {
    expect(() => parseRiedlLocation("/ffmpeg.zip", "https://ffmpeg.martin-riedl.de")).toThrow();
  });
});

describe("renderLock", () => {
  it("sorts keys and ends with a newline", () => {
    const text = renderLock({ schema: 1, ffmpeg: { "linux-x64": { b: 1, a: 2 }, "darwin-arm64": {} } });
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf("darwin-arm64")).toBeLessThan(text.indexOf("linux-x64"));
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
  });
});
```

Create `packages/binary-resolver/src/tools-lock.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { TOOLS_LOCK, validateLock } from "./lock.ts";

describe("tools.lock.json", () => {
  it("pins ffmpeg for every supported target", () => {
    expect(Object.keys(TOOLS_LOCK.ffmpeg).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ]);
  });

  it("is well formed", () => {
    expect(validateLock(TOOLS_LOCK)).toEqual([]);
  });

  it("uses LGPL builds on Windows and Linux and records that macOS builds are GPL", () => {
    for (const key of ["win32-x64", "linux-x64", "linux-arm64"]) {
      expect(TOOLS_LOCK.ffmpeg[key]?.license).toMatch(/^LGPL/);
    }
    for (const key of ["darwin-x64", "darwin-arm64"]) {
      expect(TOOLS_LOCK.ffmpeg[key]?.license).toMatch(/^GPL/);
    }
  });
});
```

- [ ] **Step 3: Run them to confirm they fail**

Run: `pnpm exec vitest run tools/release packages/binary-resolver/src/tools-lock.test.ts`
Expected: FAIL (`pin-lib.mjs` missing; lock is empty).

- [ ] **Step 4: Implement the pure helpers**

Create `tools/release/pin-lib.mjs`:
```js
// Pure helpers for pin-ffmpeg.mjs, kept apart so they can be tested without the network.

/** The static LGPL ffmpeg builds in yt-dlp/FFmpeg-Builds, and how to unpack each. */
export const BTBN_TARGETS = {
  "win32-x64": { suffix: "win64", archive: "zip", member: "bin/ffmpeg.exe" },
  "linux-x64": { suffix: "linux64", archive: "tar.xz", member: "bin/ffmpeg" },
  "linux-arm64": { suffix: "linuxarm64", archive: "tar.xz", member: "bin/ffmpeg" },
};

/** Martin Riedl's macOS release builds (GPL: libx264 and libx265 are enabled). */
export const RIEDL_HOST = "https://ffmpeg.martin-riedl.de";
export const RIEDL_TARGETS = {
  "darwin-x64": { arch: "amd64" },
  "darwin-arm64": { arch: "arm64" },
};

export const riedlRedirectUrl = (arch) =>
  `${RIEDL_HOST}/redirect/latest/macos/${arch}/release/ffmpeg.zip`;

const compareVersions = (a, b) => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * Pick the versioned, static, LGPL build for a target from a release's asset names. Shared builds,
 * GPL builds and the unversioned `master` builds are skipped. With several versions, the highest wins.
 */
export function selectBtbnAsset(names, target) {
  const { suffix, archive } = BTBN_TARGETS[target];
  const ext = archive === "zip" ? "zip" : "tar\\.xz";
  const pattern = new RegExp(`^ffmpeg-n(\\d+\\.\\d+(?:\\.\\d+)?)-.*-${suffix}-lgpl-\\d+\\.\\d+\\.${ext}$`);
  const matches = names
    .map((name) => ({ name, version: pattern.exec(name)?.[1] }))
    .filter((m) => m.version !== undefined);
  if (matches.length === 0) {
    const near = names.filter((n) => n.includes(suffix)).join(", ") || "(none)";
    throw new Error(`No static LGPL ${suffix} build found. Assets containing "${suffix}": ${near}`);
  }
  matches.sort((a, b) => compareVersions(b.version, a.version) || a.name.localeCompare(b.name));
  return matches[0];
}

/** Turn the redirect from the "latest" URL into the pinned download URL and its build id. */
export function parseRiedlLocation(location, base) {
  const url = new URL(location, base);
  const segments = url.pathname.split("/").filter(Boolean);
  const version = segments.at(-2);
  if (segments.length < 2 || !version) {
    throw new Error(`Unexpected redirect location: ${location}`);
  }
  return { url: url.toString(), version };
}

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
};

/** The lock file text: keys sorted so diffs show only what changed. */
export const renderLock = (lock) => `${JSON.stringify(sortKeys(lock), null, 2)}\n`;
```

- [ ] **Step 5: Implement the pin script**

Create `tools/release/pin-ffmpeg.mjs`:
```js
#!/usr/bin/env node
// Pin the ffmpeg builds MediaForge downloads: finds the files, downloads each one, hashes it and
// writes packages/binary-resolver/src/tools.lock.json.
//
//   node tools/release/pin-ffmpeg.mjs                 newest FFmpeg-Builds release with all builds
//   node tools/release/pin-ffmpeg.mjs --tag <tag>     a specific FFmpeg-Builds release
//   node tools/release/pin-ffmpeg.mjs --list          print the release's asset names and stop
//   node tools/release/pin-ffmpeg.mjs --dry-run       do everything except write the file
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  BTBN_TARGETS,
  parseRiedlLocation,
  RIEDL_HOST,
  RIEDL_TARGETS,
  renderLock,
  riedlRedirectUrl,
  selectBtbnAsset,
} from "./pin-lib.mjs";

const LOCK_PATH = fileURLToPath(
  new URL("../../packages/binary-resolver/src/tools.lock.json", import.meta.url),
);
const BTBN_API = "https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases";

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    list: { type: "boolean" },
    "dry-run": { type: "boolean" },
  },
});

const headers = {
  "user-agent": "mediaforge-pin-ffmpeg",
  accept: "application/vnd.github+json",
  ...(process.env.GITHUB_TOKEN && { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
};

async function getJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** Download a URL and return its SHA-256, without keeping the bytes. */
async function sha256Of(url) {
  const response = await fetch(url, { headers: { "user-agent": headers["user-agent"] } });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  console.error(`  hashed ${(bytes / 1024 / 1024).toFixed(1)} MB from ${url}`);
  return hash.digest("hex");
}

function hasAllBuilds(release) {
  const names = release.assets.map((asset) => asset.name);
  try {
    for (const target of Object.keys(BTBN_TARGETS)) selectBtbnAsset(names, target);
    return true;
  } catch {
    return false;
  }
}

async function findRelease() {
  if (values.tag) return getJson(`${BTBN_API}/tags/${encodeURIComponent(values.tag)}`);
  const releases = await getJson(`${BTBN_API}?per_page=20`);
  const release = releases.find(hasAllBuilds);
  if (!release) throw new Error("No recent FFmpeg-Builds release has all three static LGPL builds.");
  return release;
}

const release = await findRelease();
console.error(`FFmpeg-Builds release: ${release.tag_name}`);
if (values.list) {
  for (const asset of release.assets) console.log(asset.name);
  process.exit(0);
}

const names = release.assets.map((asset) => asset.name);
const ffmpeg = {};

for (const [target, rule] of Object.entries(BTBN_TARGETS)) {
  const { name, version } = selectBtbnAsset(names, target);
  const asset = release.assets.find((candidate) => candidate.name === name);
  console.error(`${target}: ${name}`);
  ffmpeg[target] = {
    version,
    url: asset.browser_download_url,
    sha256: await sha256Of(asset.browser_download_url),
    archive: rule.archive,
    member: rule.member,
    license: "LGPL-2.1-or-later",
    buildInfo: `https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/${release.tag_name}`,
  };
}

for (const [target, { arch }] of Object.entries(RIEDL_TARGETS)) {
  const redirect = await fetch(riedlRedirectUrl(arch), { redirect: "manual" });
  const location = redirect.headers.get("location");
  if (!location) throw new Error(`${target}: no redirect from ${riedlRedirectUrl(arch)}`);
  const { url, version } = parseRiedlLocation(location, RIEDL_HOST);
  console.error(`${target}: ${url}`);
  const sha256 = await sha256Of(url);
  // The site also publishes a checksum next to each file; the two must agree.
  const published = await fetch(`${url}.sha256`).then((r) => (r.ok ? r.text() : undefined));
  const publishedHash = published?.trim().split(/\s+/)[0]?.toLowerCase();
  if (publishedHash && publishedHash !== sha256) {
    throw new Error(`${target}: downloaded hash ${sha256} differs from published ${publishedHash}`);
  }
  ffmpeg[target] = {
    version,
    url,
    sha256,
    archive: "zip",
    member: "ffmpeg",
    license: "GPL-2.0-or-later",
    buildInfo: RIEDL_HOST,
  };
}

const text = renderLock({ schema: 1, ffmpeg });
if (values["dry-run"]) {
  console.log(text);
} else {
  await writeFile(LOCK_PATH, text);
  console.error(`Wrote ${LOCK_PATH}`);
}
```

- [ ] **Step 6: Run the helper tests, then generate the lock**

Run: `pnpm exec biome check --write tools/release packages/binary-resolver && pnpm exec vitest run tools/release`
Expected: PASS for `pin-lib.test.mjs`.

Then generate the real lock (needs network, downloads roughly 300 MB):
```bash
pnpm pin:ffmpeg
```
Expected: it prints the release tag and one line per target and writes `tools.lock.json`. If it reports "No static LGPL ... build found", run `pnpm pin:ffmpeg -- --list` to see the real asset names and adjust the `pattern` in `selectBtbnAsset` (and its test fixtures) to match; this is the one place that depends on upstream naming. If the Martin Riedl redirect has a different shape, adjust `parseRiedlLocation` and its test the same way.

- [ ] **Step 7: Verify the real lock and review it**

Run: `pnpm exec biome check --write packages/binary-resolver/src/tools.lock.json && pnpm exec vitest run packages/binary-resolver tools/release && pnpm typecheck`
Expected: PASS, including `tools-lock.test.ts`. Open `tools.lock.json` and check each URL ends in a pinned file (not a `latest` alias) and that `license` and `buildInfo` look right. If the macOS archive is not a zip that contains `ffmpeg` at its root, fix `member` / `archive` for those two entries in `pin-ffmpeg.mjs` and re-run.

- [ ] **Step 8: Commit message**

Output for the user:
```text
🔧 binary-resolver: pin ffmpeg builds per platform

Body: tools.lock.json records version, URL, SHA-256, archive layout, licence and a build-info link for each target. Windows and Linux use LGPL builds from yt-dlp/FFmpeg-Builds; macOS uses Martin Riedl's GPL builds, which users download from the upstream host.
Test: pnpm exec vitest run packages/binary-resolver tools/release
```

---

## Phase C: Desktop CLI (`apps/desktop`)

Run desktop tests with `pnpm exec vitest run apps/desktop`. `cli.test.ts` requires that help output never contains the whole words `host`, `install` or `uninstall`, so command summaries below avoid them.

### Task 11: Tool runtime (acquire, ensure, prompt, progress)

**Files:**
- Create: `apps/desktop/src/tool-runtime.ts`
- Create: `apps/desktop/src/test-runtime.ts` (fake `ToolRuntime` shared by the tests of Tasks 11 to 13)
- Create: `apps/desktop/src/tool-runtime.test.ts`
- Modify: `apps/desktop/src/binaries.ts`

**Interfaces:**
- Consumes: `installTool`, `defaultInstallDeps`, `cacheDir`, `resolveTarget`, `findOnPath`, `ToolInstallError`, `UnsupportedTargetError`, `BinaryNotFoundError`, `InstallProgress`, `InstallResult`, `ResolvedBinary`, `Tool` (all from `@mediaforge/binary-resolver`); `CliError`, `ExitCode`; `formatBytes` from `progress-view.ts`; `resolveTool`, `ResolveTool` from `binaries.ts`.
- Produces (all exported from `tool-runtime.ts`):
  - `YTDLP_REPO_ENV = "MEDIAFORGE_YTDLP_REPO_URL"`
  - `interface ToolRuntime { resolve: ResolveTool; install(tool: Tool, onProgress: (p: InstallProgress) => void): Promise<InstallResult>; platform: NodeJS.Platform; interactive: boolean; ask(question: string): Promise<boolean>; brew: { available(): Promise<boolean>; install(): Promise<void> } }`
  - `tryResolve(tool: Tool, resolve: ResolveTool): Promise<ResolvedBinary | undefined>`
  - `toCliError(error: unknown): unknown` (a `ToolInstallError` becomes a `CliError` with exit 4 for network kinds, 6 for file kinds, 1 otherwise; anything else is returned unchanged)
  - `missingToolError(tool: Tool): CliError` (message `"<tool> is missing.\nrun: mediaforge setup"`, exit 3)
  - `type AcquireOutcome`, `acquireTool(tool, rt, options: { yes: boolean; onProgress }): Promise<AcquireOutcome>`
  - `ensureTools(tools: Tool[], rt: ToolRuntime, onProgress): Promise<void>`
  - `askYesNo(question, input?, output?): Promise<boolean>`
  - `createInstallPrinter(write: (text: string) => void, inline: boolean): (p: InstallProgress) => void`
  - `defaultToolRuntime(env?): ToolRuntime`, `defaultEnsureTools(): (tools: Tool[]) => Promise<void>`

`binaries.ts` also changes: `resolveTool` passes `cacheDir(process.env)`, and `missingToolHint` leads with `Run: mediaforge setup`.

- [ ] **Step 1: Write the fake runtime and the failing tests**

Create `apps/desktop/src/test-runtime.ts` (a test helper, not imported by product code):
```ts
import { BinaryNotFoundError, type Tool } from "@mediaforge/binary-resolver";
import type { ToolRuntime } from "./tool-runtime.ts";

export interface RuntimeOptions {
  present?: Tool[];
  interactive?: boolean;
  answers?: boolean[];
  platform?: NodeJS.Platform;
  brew?: boolean;
  /** Make `brew install` succeed without putting ffmpeg on PATH. */
  brewLeavesNothing?: boolean;
  installError?: unknown;
}

/** A `ToolRuntime` that keeps its state in memory and records what happened. */
export function makeRuntime(options: RuntimeOptions = {}) {
  const present = new Set<Tool>(options.present ?? []);
  const answers = [...(options.answers ?? [])];
  const log = { installed: [] as Tool[], asked: [] as string[], brewRuns: 0 };
  const rt: ToolRuntime = {
    resolve: async (tool) => {
      if (present.has(tool)) return { tool, path: `/bin/${tool}`, source: "path", version: "1.0" };
      throw new BinaryNotFoundError(tool, ["PATH"]);
    },
    install: async (tool, onProgress) => {
      if (options.installError) throw options.installError;
      onProgress({ tool, phase: "downloading", received: 1 });
      present.add(tool);
      log.installed.push(tool);
      return { tool, version: "2026.10.08", path: `/cache/${tool}`, sha256: "s", url: "u" };
    },
    platform: options.platform ?? "linux",
    interactive: options.interactive ?? true,
    ask: async (question) => {
      log.asked.push(question);
      return answers.shift() ?? false;
    },
    brew: {
      available: async () => options.brew ?? false,
      install: async () => {
        log.brewRuns++;
        if (!options.brewLeavesNothing) present.add("ffmpeg");
      },
    },
  };
  return { rt, log, present };
}
```

Create `apps/desktop/src/tool-runtime.test.ts`:
```ts
import { PassThrough } from "node:stream";
import {
  type InstallProgress,
  ToolInstallError,
  UnsupportedTargetError,
} from "@mediaforge/binary-resolver";
import { describe, expect, it } from "vitest";
import { CliError, ExitCode } from "./exit-codes.ts";
import { makeRuntime } from "./test-runtime.ts";
import {
  acquireTool,
  askYesNo,
  createInstallPrinter,
  ensureTools,
  missingToolError,
  toCliError,
  tryResolve,
} from "./tool-runtime.ts";

const ignore = () => {};

describe("tryResolve", () => {
  it("returns undefined for a missing tool and rethrows anything else", async () => {
    const { rt } = makeRuntime();
    expect(await tryResolve("yt-dlp", rt.resolve)).toBeUndefined();
    await expect(
      tryResolve("yt-dlp", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("toCliError", () => {
  it.each([
    ["offline", ExitCode.Network],
    ["not-found", ExitCode.Network],
    ["rate-limit", ExitCode.Network],
    ["http", ExitCode.Network],
    ["checksum", ExitCode.Network],
    ["disk-full", ExitCode.FileSystem],
    ["permission", ExitCode.FileSystem],
    ["io", ExitCode.FileSystem],
    ["extract", ExitCode.FileSystem],
    ["unsupported", ExitCode.Failure],
    ["no-source", ExitCode.Failure],
  ] as const)("maps %s to exit code %i and keeps the hint", (kind, code) => {
    const mapped = toCliError(new ToolInstallError(kind, "It broke.", "Do this."));
    expect(mapped).toBeInstanceOf(CliError);
    expect((mapped as CliError).exitCode).toBe(code);
    expect((mapped as CliError).message).toBe("It broke.\nDo this.");
  });

  it("maps an unsupported platform to a plain failure and passes other errors through", () => {
    const mapped = toCliError(new UnsupportedTargetError("freebsd", "x64")) as CliError;
    expect(mapped.exitCode).toBe(ExitCode.Failure);
    const other = new Error("x");
    expect(toCliError(other)).toBe(other);
  });
});

describe("acquireTool", () => {
  const options = { yes: false, onProgress: ignore };

  it("does nothing when the tool is already available", async () => {
    const { rt, log } = makeRuntime({ present: ["yt-dlp"] });
    expect(await acquireTool("yt-dlp", rt, options)).toMatchObject({ status: "present" });
    expect(log.installed).toEqual([]);
  });

  it("downloads a missing tool", async () => {
    const { rt, log } = makeRuntime();
    expect(await acquireTool("yt-dlp", rt, options)).toMatchObject({
      status: "installed",
      version: "2026.10.08",
    });
    expect(log.installed).toEqual(["yt-dlp"]);
  });

  it("asks about Homebrew for ffmpeg on macOS and runs it only on yes", async () => {
    const yes = makeRuntime({ platform: "darwin", brew: true, answers: [true] });
    expect(await acquireTool("ffmpeg", yes.rt, options)).toMatchObject({ status: "homebrew" });
    expect(yes.log.brewRuns).toBe(1);
    expect(yes.log.installed).toEqual([]);

    const no = makeRuntime({ platform: "darwin", brew: true, answers: [false] });
    expect(await acquireTool("ffmpeg", no.rt, options)).toMatchObject({ status: "installed" });
    expect(no.log.brewRuns).toBe(0);
  });

  it("never asks or runs Homebrew with --yes or without a terminal", async () => {
    const yes = makeRuntime({ platform: "darwin", brew: true, answers: [true] });
    await acquireTool("ffmpeg", yes.rt, { yes: true, onProgress: ignore });
    expect(yes.log.asked).toEqual([]);
    expect(yes.log.brewRuns).toBe(0);

    const quiet = makeRuntime({ platform: "darwin", brew: true, interactive: false });
    await acquireTool("ffmpeg", quiet.rt, options);
    expect(quiet.log.asked).toEqual([]);
    expect(quiet.log.brewRuns).toBe(0);
  });

  it("does not offer Homebrew for yt-dlp, on Linux, or when brew is absent", async () => {
    for (const [tool, platform, brew] of [
      ["yt-dlp", "darwin", true],
      ["ffmpeg", "linux", true],
      ["ffmpeg", "darwin", false],
    ] as const) {
      const t = makeRuntime({ platform, brew });
      await acquireTool(tool, t.rt, options);
      expect(t.log.asked).toEqual([]);
    }
  });

  it("explains it when Homebrew finishes but ffmpeg is still not found", async () => {
    const { rt } = makeRuntime({
      platform: "darwin",
      brew: true,
      answers: [true],
      brewLeavesNothing: true,
    });
    const error = await acquireTool("ffmpeg", rt, options).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(ExitCode.MissingTool);
  });

  it("turns a failed download into a CliError with the right exit code", async () => {
    const { rt } = makeRuntime({
      installError: new ToolInstallError("checksum", "Checksum mismatch.", "Try again."),
    });
    const error = await acquireTool("yt-dlp", rt, options).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(ExitCode.Network);
    expect(error.message).toContain("Try again.");
  });
});

describe("ensureTools", () => {
  it("is silent when everything is there", async () => {
    const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg"] });
    await ensureTools(["yt-dlp", "ffmpeg"], rt, ignore);
    expect(log.asked).toEqual([]);
  });

  it("exits 3 with the setup hint, without asking, when there is no terminal", async () => {
    const { rt, log } = makeRuntime({ interactive: false });
    const error = await ensureTools(["yt-dlp"], rt, ignore).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(ExitCode.MissingTool);
    expect(error.message).toBe("yt-dlp is missing.\nrun: mediaforge setup");
    expect(log.asked).toEqual([]);
    expect(log.installed).toEqual([]);
  });

  it("asks in a terminal and downloads on yes", async () => {
    const { rt, log } = makeRuntime({ answers: [true] });
    await ensureTools(["yt-dlp"], rt, ignore);
    expect(log.asked).toEqual(["yt-dlp is missing. Download it now? (Y/N)"]);
    expect(log.installed).toEqual(["yt-dlp"]);
  });

  it("stops with exit 3 when the answer is no, and downloads nothing", async () => {
    const { rt, log } = makeRuntime({ answers: [false] });
    const error = await ensureTools(["yt-dlp", "ffmpeg"], rt, ignore).catch((e) => e);
    expect(error.exitCode).toBe(ExitCode.MissingTool);
    expect(log.installed).toEqual([]);
  });

  it("builds the same error as missingToolError", () => {
    expect(missingToolError("ffmpeg").message).toBe("ffmpeg is missing.\nrun: mediaforge setup");
  });
});

describe("askYesNo", () => {
  /** Types the lines one at a time, like a person, then closes the input. */
  function prompt(lines: string[]) {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (chunk) => {
      shown += chunk.toString();
    });
    const answer = askYesNo("Download now? (Y/N)", input, output);
    void (async () => {
      for (const line of lines) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        input.write(`${line}\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      input.end();
    })();
    return { answer, shown: () => shown };
  }

  it("accepts y and yes, and n and no, in any case", async () => {
    expect(await prompt(["y"]).answer).toBe(true);
    expect(await prompt(["YES"]).answer).toBe(true);
    expect(await prompt(["n"]).answer).toBe(false);
    expect(await prompt(["No"]).answer).toBe(false);
  });

  it("asks again after an unclear answer", async () => {
    const p = prompt(["maybe", "yes"]);
    expect(await p.answer).toBe(true);
    expect(p.shown().match(/Download now/g)).toHaveLength(2);
  });

  it("gives up with no after three unclear answers", async () => {
    expect(await prompt(["a", "b", "c"]).answer).toBe(false);
  });

  it("answers no instead of hanging when stdin closes", async () => {
    expect(await prompt([]).answer).toBe(false);
  });
});

describe("createInstallPrinter", () => {
  const progress = (phase: InstallProgress["phase"], extra = {}): InstallProgress => ({
    tool: "yt-dlp",
    phase,
    ...extra,
  });

  it("prints one line per phase without a terminal", () => {
    const out: string[] = [];
    const print = createInstallPrinter((t) => out.push(t), false);
    print(progress("resolving"));
    print(progress("downloading", { received: 0 }));
    print(progress("downloading", { received: 1024, total: 2048 }));
    print(progress("verifying"));
    expect(out.join("")).toBe(
      [
        "yt-dlp: looking up the latest version",
        "yt-dlp: downloading",
        "yt-dlp: verifying checksum",
        "",
      ].join("\n"),
    );
  });

  it("updates one line in place on a terminal, then moves on", () => {
    const out: string[] = [];
    const print = createInstallPrinter((t) => out.push(t), true);
    print(progress("downloading", { received: 0 }));
    print(progress("downloading", { received: 1048576, total: 2097152 }));
    print(progress("verifying"));
    const text = out.join("");
    expect(text).toContain("\ryt-dlp: downloading 1.0 MB of 2.0 MB");
    expect(text.endsWith("\nyt-dlp: verifying checksum\n")).toBe(true);
  });
});
```
- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run apps/desktop/src/tool-runtime.test.ts`
Expected: FAIL, cannot resolve `./tool-runtime.ts`.

- [ ] **Step 3: Implement the runtime**

Create `apps/desktop/src/tool-runtime.ts`:
```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  BinaryNotFoundError,
  cacheDir,
  defaultInstallDeps,
  findOnPath,
  type InstallProgress,
  type InstallResult,
  installTool,
  type ResolvedBinary,
  resolveTarget,
  type Tool,
  ToolInstallError,
  UnsupportedTargetError,
} from "@mediaforge/binary-resolver";
import { type ResolveTool, resolveTool } from "./binaries.ts";
import { CliError, ExitCode } from "./exit-codes.ts";
import { formatBytes } from "./progress-view.ts";

/** Points the yt-dlp lookup at another release server. Used by the release smoke test. */
export const YTDLP_REPO_ENV = "MEDIAFORGE_YTDLP_REPO_URL";

/** Everything the tool commands need from the outside world. Tests replace all of it. */
export interface ToolRuntime {
  resolve: ResolveTool;
  install: (tool: Tool, onProgress: (progress: InstallProgress) => void) => Promise<InstallResult>;
  platform: NodeJS.Platform;
  /** True when a person can answer: stdin and stderr are terminals. */
  interactive: boolean;
  ask: (question: string) => Promise<boolean>;
  brew: { available: () => Promise<boolean>; install: () => Promise<void> };
}

export async function tryResolve(
  tool: Tool,
  resolve: ResolveTool,
): Promise<ResolvedBinary | undefined> {
  try {
    return await resolve(tool);
  } catch (error) {
    if (error instanceof BinaryNotFoundError) return undefined;
    throw error;
  }
}

const NETWORK_KINDS = new Set(["offline", "not-found", "rate-limit", "http", "checksum"]);
const FILE_KINDS = new Set(["disk-full", "permission", "io", "extract"]);

/** Give a failed download the exit code and message the CLI prints. Other errors pass through. */
export function toCliError(error: unknown): unknown {
  if (error instanceof ToolInstallError) {
    const code = NETWORK_KINDS.has(error.kind)
      ? ExitCode.Network
      : FILE_KINDS.has(error.kind)
        ? ExitCode.FileSystem
        : ExitCode.Failure;
    return new CliError(`${error.message}\n${error.hint}`, code);
  }
  if (error instanceof UnsupportedTargetError) return new CliError(error.message, ExitCode.Failure);
  return error;
}

export const missingToolError = (tool: Tool): CliError =>
  new CliError(`${tool} is missing.\nrun: mediaforge setup`, ExitCode.MissingTool);

export type AcquireOutcome =
  | { tool: Tool; status: "present"; path: string; source: string; version?: string }
  | { tool: Tool; status: "installed"; path: string; version: string }
  | { tool: Tool; status: "homebrew"; path: string; version?: string };

export interface AcquireOptions {
  /** `--yes`: never ask, never run Homebrew. */
  yes: boolean;
  onProgress: (progress: InstallProgress) => void;
}

/** Make one tool available: use what is there, else (macOS ffmpeg) offer Homebrew, else download. */
export async function acquireTool(
  tool: Tool,
  rt: ToolRuntime,
  options: AcquireOptions,
): Promise<AcquireOutcome> {
  const existing = await tryResolve(tool, rt.resolve);
  if (existing) {
    return {
      tool,
      status: "present",
      path: existing.path,
      source: existing.source,
      ...(existing.version !== undefined && { version: existing.version }),
    };
  }

  const offerHomebrew =
    tool === "ffmpeg" &&
    rt.platform === "darwin" &&
    !options.yes &&
    rt.interactive &&
    (await rt.brew.available());
  if (offerHomebrew) {
    const useBrew = await rt.ask(
      "ffmpeg is missing. Install it with Homebrew (brew install ffmpeg)? (Y = Homebrew, N = download a pinned build)",
    );
    if (useBrew) {
      await rt.brew.install();
      const found = await tryResolve("ffmpeg", rt.resolve);
      if (!found) {
        throw new CliError(
          "Homebrew finished, but ffmpeg is still not on PATH.\nOpen a new terminal, or run: mediaforge setup",
          ExitCode.MissingTool,
        );
      }
      return {
        tool,
        status: "homebrew",
        path: found.path,
        ...(found.version !== undefined && { version: found.version }),
      };
    }
  }

  try {
    const result = await rt.install(tool, options.onProgress);
    return { tool, status: "installed", path: result.path, version: result.version };
  } catch (error) {
    throw toCliError(error);
  }
}

/**
 * Before work that needs tools: in a terminal, offer to download what is missing; otherwise stop
 * with exit 3 and `run: mediaforge setup`. Nothing downloads without a yes.
 */
export async function ensureTools(
  tools: Tool[],
  rt: ToolRuntime,
  onProgress: (progress: InstallProgress) => void,
): Promise<void> {
  for (const tool of tools) {
    if (await tryResolve(tool, rt.resolve)) continue;
    if (!rt.interactive) throw missingToolError(tool);
    if (!(await rt.ask(`${tool} is missing. Download it now? (Y/N)`))) throw missingToolError(tool);
    await acquireTool(tool, rt, { yes: false, onProgress });
  }
}

/** Ask a yes or no question. Unclear answers are asked again (three tries); closed input is no. */
export async function askYesNo(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<boolean> {
  const rl = createInterface({ input, output });
  const closed = new Promise<undefined>((resolve) => rl.once("close", () => resolve(undefined)));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const asked = rl.question(`${question} `).catch(() => undefined);
      const answer = await Promise.race([asked, closed]);
      if (answer === undefined) return false;
      const text = answer.trim().toLowerCase();
      if (text === "y" || text === "yes") return true;
      if (text === "n" || text === "no") return false;
    }
    return false;
  } finally {
    rl.close();
  }
}

const PHASE_LABELS = {
  resolving: "looking up the latest version",
  downloading: "downloading",
  verifying: "verifying checksum",
  extracting: "unpacking",
  installing: "installing",
} as const;

/**
 * Prints install progress: one line per phase, plus (with `inline`) a download counter that
 * updates in place. Without a terminal there are no control characters, so logs stay readable.
 */
export function createInstallPrinter(write: (text: string) => void, inline: boolean) {
  let counterOpen = false;
  return (progress: InstallProgress): void => {
    if (progress.phase === "downloading" && progress.received) {
      if (!inline) return;
      const total = progress.total ? ` of ${formatBytes(progress.total)}` : "";
      write(`\r${progress.tool}: downloading ${formatBytes(progress.received)}${total}   `);
      counterOpen = true;
      return;
    }
    if (counterOpen) {
      write("\n");
      counterOpen = false;
    }
    write(`${progress.tool}: ${PHASE_LABELS[progress.phase]}\n`);
  };
}

const brewAvailable = async () => (await findOnPath("brew")) !== undefined;

const brewInstallFfmpeg = () =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("brew", ["install", "ffmpeg"], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new CliError(`brew install ffmpeg failed (exit code ${code}).`, ExitCode.Failure)),
    );
  });

export function defaultToolRuntime(env: Record<string, string | undefined> = process.env): ToolRuntime {
  const dir = cacheDir(env);
  const repo = env[YTDLP_REPO_ENV];
  const deps = { ...defaultInstallDeps(), ...(repo && { ytDlpRepoUrl: repo }) };
  return {
    resolve: resolveTool,
    install: (tool, onProgress) =>
      installTool({ tool, target: resolveTarget(), dir, onProgress }, deps),
    platform: process.platform,
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    ask: (question) => askYesNo(question),
    brew: { available: brewAvailable, install: brewInstallFfmpeg },
  };
}

/** `ensureTools` wired to the real machine, printing progress on stderr. */
export function defaultEnsureTools(): (tools: Tool[]) => Promise<void> {
  return (tools) => {
    const rt = defaultToolRuntime();
    return ensureTools(
      tools,
      rt,
      createInstallPrinter((text) => process.stderr.write(text), rt.interactive),
    );
  };
}
```

- [ ] **Step 4: Update `binaries.ts`**

In `apps/desktop/src/binaries.ts`:
1. Add `cacheDir` to the import from `@mediaforge/binary-resolver`.
2. Replace `resolveTool` and its doc comment:
```ts
/** Resolve a tool using the standard order: env override, PATH, bundled, managed cache. */
export const resolveTool: ResolveTool = (tool) =>
  resolveBinary(tool, { bundledDir: defaultBinDir(), cacheDir: cacheDir(process.env) });
```
3. Replace `missingToolHint`:
```ts
/** How to fix a missing tool, for error messages. */
export function missingToolHint(tool: Tool, binDir: string): string {
  return [
    `Run: mediaforge setup (downloads ${tool}),`,
    `install ${tool} and add it to PATH,`,
    `set ${ENV_OVERRIDES[tool]} to its full path,`,
    `or place it in ${binDir}.`,
  ].join(" ");
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec biome check --write apps/desktop/src && pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS (existing doctor tests still find `MEDIAFORGE_FFMPEG_PATH` in the hint).

- [ ] **Step 6: Commit message**

Output for the user:
```text
✨ desktop: add tool runtime with download prompt and progress printer

Test: pnpm exec vitest run apps/desktop
```

### Task 12: `mediaforge setup`

**Files:**
- Create: `apps/desktop/src/tool-commands.ts`
- Create: `apps/desktop/src/tool-commands.test.ts`
- Modify: `apps/desktop/src/commands.ts`

**Interfaces:**
- Consumes: `ToolRuntime`, `acquireTool`, `createInstallPrinter`, `defaultToolRuntime`, `AcquireOutcome` (Task 11); `parseCommandArgs` (existing); `Io` from `commands.ts`; `ALL_TOOLS`, `Tool`.
- Produces: `parseToolList(value: string | undefined): Tool[]`, `setupUsage(): string`, `runSetup(args: string[], io: Io, rt?: ToolRuntime): Promise<ExitCode>`; registers the `setup` command. Task 13 adds `runUpdate` to the same file.

Behavior (spec section 2): `mediaforge setup [--yes] [--tools yt-dlp,ffmpeg]` downloads whatever is missing and prints a summary on stdout; progress goes to stderr. `--yes` skips prompts; on macOS without ffmpeg it asks about Homebrew first, and with `--yes` goes straight to the pinned download. A tool that is already available is left alone.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/tool-commands.test.ts`:
```ts
import { ToolInstallError } from "@mediaforge/binary-resolver";
import { describe, expect, it } from "vitest";
import { ExitCode } from "./exit-codes.ts";
import { makeRuntime } from "./test-runtime.ts";
import { parseToolList, runSetup } from "./tool-commands.ts";

function capture() {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (t: string) => {
        out += t;
      },
      stderr: (t: string) => {
        err += t;
      },
    },
    out: () => out,
    err: () => err,
  };
}

describe("parseToolList", () => {
  it("defaults to every tool", () => {
    expect(parseToolList(undefined)).toEqual(["yt-dlp", "ffmpeg"]);
  });

  it("reads a comma list, trims it and drops duplicates", () => {
    expect(parseToolList(" ffmpeg , ffmpeg ")).toEqual(["ffmpeg"]);
  });

  it("rejects unknown names and empty lists as usage errors", () => {
    expect(() => parseToolList("deno")).toThrow(/Unknown tool: deno/);
    expect(() => parseToolList(",")).toThrow(/Choose from/);
    try {
      parseToolList("deno");
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(ExitCode.Usage);
    }
  });
});

describe("runSetup", () => {
  it("changes nothing and says so when every tool is already available", async () => {
    const c = capture();
    const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg"] });
    expect(await runSetup(["--yes"], c.io, rt)).toBe(ExitCode.Ok);
    expect(log.installed).toEqual([]);
    expect(c.out()).toContain("already available");
    expect(c.out()).toContain("/bin/yt-dlp");
  });

  it("downloads what is missing, with progress on stderr and the summary on stdout", async () => {
    const c = capture();
    const { rt, log } = makeRuntime({ present: ["ffmpeg"] });
    expect(await runSetup(["--yes"], c.io, rt)).toBe(ExitCode.Ok);
    expect(log.installed).toEqual(["yt-dlp"]);
    expect(c.out()).toContain("yt-dlp  downloaded  2026.10.08  /cache/yt-dlp");
    expect(c.out()).toContain("ffmpeg  already available");
    expect(c.err()).toContain("yt-dlp: downloading");
    expect(c.out()).not.toContain("downloading");
  });

  it("limits the work to --tools", async () => {
    const c = capture();
    const { rt, log } = makeRuntime();
    await runSetup(["--yes", "--tools", "ffmpeg"], c.io, rt);
    expect(log.installed).toEqual(["ffmpeg"]);
  });

  it("goes straight to the pinned download on macOS with --yes", async () => {
    const c = capture();
    const { rt, log } = makeRuntime({ platform: "darwin", brew: true, answers: [true] });
    await runSetup(["--yes", "--tools", "ffmpeg"], c.io, rt);
    expect(log.asked).toEqual([]);
    expect(log.brewRuns).toBe(0);
    expect(log.installed).toEqual(["ffmpeg"]);
  });

  it("offers Homebrew on macOS without --yes and reports it", async () => {
    const c = capture();
    const { rt, log } = makeRuntime({ platform: "darwin", brew: true, answers: [true] });
    await runSetup(["--tools", "ffmpeg"], c.io, rt);
    expect(log.brewRuns).toBe(1);
    expect(c.out()).toContain("installed with Homebrew");
  });

  it("fails with the download's exit code and hint", async () => {
    const c = capture();
    const { rt } = makeRuntime({
      installError: new ToolInstallError("offline", "Could not reach github.com.", "Check your internet."),
    });
    const error = await runSetup(["--yes"], c.io, rt).catch((e) => e);
    expect(error.exitCode).toBe(ExitCode.Network);
    expect(error.message).toBe("Could not reach github.com.\nCheck your internet.");
  });

  it("prints help, and rejects unknown options and extra arguments", async () => {
    const c = capture();
    const { rt } = makeRuntime();
    expect(await runSetup(["--help"], c.io, rt)).toBe(ExitCode.Ok);
    expect(c.out()).toContain("Usage: mediaforge setup");
    await expect(runSetup(["--nope"], c.io, rt)).rejects.toMatchObject({ exitCode: ExitCode.Usage });
    await expect(runSetup(["extra"], c.io, rt)).rejects.toMatchObject({ exitCode: ExitCode.Usage });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run apps/desktop/src/tool-commands.test.ts`
Expected: FAIL, cannot resolve `./tool-commands.ts`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/tool-commands.ts`:
```ts
import { ALL_TOOLS, type Tool } from "@mediaforge/binary-resolver";
import type { Io } from "./commands.ts";
import { CliError, ExitCode } from "./exit-codes.ts";
import { parseCommandArgs } from "./parse.ts";
import {
  type AcquireOutcome,
  acquireTool,
  createInstallPrinter,
  defaultToolRuntime,
  type ToolRuntime,
} from "./tool-runtime.ts";

const SETUP_USAGE = "Usage: mediaforge setup [--yes] [--tools yt-dlp,ffmpeg]";

export function setupUsage(): string {
  return [
    SETUP_USAGE,
    "",
    "Download yt-dlp and ffmpeg when they are missing. Tools that are already available are left alone.",
    "",
    "Options:",
    "  -y, --yes            Do not ask questions. On macOS, skip the Homebrew offer.",
    "      --tools <list>   Only these tools, comma separated (default: yt-dlp,ffmpeg)",
    "  -h, --help           Show this help",
    "",
  ].join("\n");
}

/** Read `--tools`: a comma list of known tool names, or every tool when absent. */
export function parseToolList(value: string | undefined): Tool[] {
  if (value === undefined) return [...ALL_TOOLS];
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !ALL_TOOLS.includes(name as Tool));
  if (names.length === 0 || unknown.length > 0) {
    throw new CliError(
      `Unknown tool: ${unknown.join(", ") || "(none given)"}. Choose from: ${ALL_TOOLS.join(", ")}.\n${SETUP_USAGE}`,
      ExitCode.Usage,
    );
  }
  return [...new Set(names)] as Tool[];
}

function summaryLine(outcome: AcquireOutcome): string {
  const name = outcome.tool.padEnd(7);
  switch (outcome.status) {
    case "present":
      return `${name}  already available  ${outcome.version ?? "unknown version"}  (${outcome.source})  ${outcome.path}`;
    case "installed":
      return `${name}  downloaded  ${outcome.version}  ${outcome.path}`;
    case "homebrew":
      return `${name}  installed with Homebrew  ${outcome.path}`;
  }
}

const SETUP_OPTIONS = {
  yes: { type: "boolean", short: "y" },
  tools: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export async function runSetup(
  args: string[],
  io: Io,
  rt: ToolRuntime = defaultToolRuntime(),
): Promise<ExitCode> {
  const { values, positionals } = parseCommandArgs(args, SETUP_OPTIONS, SETUP_USAGE);
  if (values.help) {
    io.stdout(setupUsage());
    return ExitCode.Ok;
  }
  if (positionals.length > 0) {
    throw new CliError(`Unexpected argument: ${positionals[0]}\n${SETUP_USAGE}`, ExitCode.Usage);
  }

  const tools = parseToolList(values.tools);
  const onProgress = createInstallPrinter(io.stderr, rt.interactive);
  const lines: string[] = [];
  for (const tool of tools) {
    const outcome = await acquireTool(tool, rt, { yes: values.yes ?? false, onProgress });
    lines.push(summaryLine(outcome));
  }
  io.stdout(`${lines.join("\n")}\n`);
  return ExitCode.Ok;
}
```

In `apps/desktop/src/commands.ts` add `import { runSetup } from "./tool-commands.ts";` (keep imports sorted) and put these two entries into `COMMANDS` after `formats`:
```ts
  {
    name: "setup",
    summary: "Download missing yt-dlp and ffmpeg",
    run: (args, io) => runSetup(args, io),
  },
```
(`update` is added in Task 13.)

- [ ] **Step 4: Run the tests**

Run: `pnpm exec biome check --write apps/desktop/src && pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS, including `cli.test.ts` ("does not list browser host commands").

- [ ] **Step 5: Commit message**

Output for the user:
```text
✨ desktop: add the setup command to download yt-dlp and ffmpeg

Test: pnpm exec vitest run apps/desktop
```

### Task 13: `mediaforge update`

**Files:**
- Modify: `apps/desktop/src/tool-commands.ts`, `apps/desktop/src/tool-commands.test.ts`, `apps/desktop/src/commands.ts`

**Interfaces:**
- Consumes: `tryResolve`, `toCliError`, `createInstallPrinter`, `defaultToolRuntime`, `ToolRuntime` (Task 11).
- Produces: `updateUsage(): string`, `runUpdate(args: string[], io: Io, rt?: ToolRuntime): Promise<ExitCode>`; registers the `update` command.

Behavior: re-download the latest yt-dlp nightly into the cache and print old and new versions on stdout. It never touches ffmpeg. Plan decision (covers Review Focus 4): resolution puts env and PATH before the cache, so a PATH yt-dlp would silently shadow the update. After downloading, if the tool now resolves from anything other than the cache, print a `Note:` on stderr naming it.

- [ ] **Step 1: Write the failing tests**

Add to `apps/desktop/src/tool-commands.test.ts` (extend the imports with `runUpdate` from `./tool-commands.ts`, `BinaryNotFoundError` and `type Tool` from `@mediaforge/binary-resolver`, and `type ToolRuntime` from `./tool-runtime.ts`):
```ts
/** A runtime where yt-dlp's version and source change when `install` runs. */
function updatingRuntime(before: { version: string; source: "cache" | "path" } | undefined) {
  const state = { current: before, installed: [] as Tool[] };
  const base = makeRuntime();
  const rt: ToolRuntime = {
    ...base.rt,
    resolve: async (tool) => {
      if (tool === "yt-dlp" && state.current) {
        return {
          tool,
          path: state.current.source === "cache" ? "/cache/yt-dlp" : "/usr/bin/yt-dlp",
          source: state.current.source,
          version: state.current.version,
        };
      }
      throw new BinaryNotFoundError(tool, ["PATH"]);
    },
    install: async (tool) => {
      state.installed.push(tool);
      // A cache install only becomes the active copy if nothing earlier on the lookup order wins.
      if (state.current?.source !== "path") state.current = { version: "2026.10.08", source: "cache" };
      return { tool, version: "2026.10.08", path: "/cache/yt-dlp", sha256: "s", url: "u" };
    },
  };
  return { rt, state };
}

describe("runUpdate", () => {
  it("downloads the latest yt-dlp and prints the old and new versions", async () => {
    const c = capture();
    const { rt, state } = updatingRuntime({ version: "2026.01.01", source: "cache" });
    expect(await runUpdate([], c.io, rt)).toBe(ExitCode.Ok);
    expect(state.installed).toEqual(["yt-dlp"]);
    expect(c.out()).toBe("yt-dlp updated: 2026.01.01 to 2026.10.08\n");
    expect(c.err()).not.toContain("Note:");
  });

  it("works when yt-dlp was not there before", async () => {
    const c = capture();
    const { rt } = updatingRuntime(undefined);
    await runUpdate([], c.io, rt);
    expect(c.out()).toBe("yt-dlp updated: not installed to 2026.10.08\n");
  });

  it("says when the cached copy is already the latest", async () => {
    const c = capture();
    const { rt } = updatingRuntime({ version: "2026.10.08", source: "cache" });
    await runUpdate([], c.io, rt);
    expect(c.out()).toBe("yt-dlp is already up to date (2026.10.08)\n");
  });

  it("warns when a PATH yt-dlp is used before the downloaded copy", async () => {
    const c = capture();
    const { rt } = updatingRuntime({ version: "2025.01.01", source: "path" });
    expect(await runUpdate([], c.io, rt)).toBe(ExitCode.Ok);
    expect(c.err()).toContain("Note: the yt-dlp on your PATH (/usr/bin/yt-dlp)");
    expect(c.err()).toContain("no effect");
  });

  it("never touches ffmpeg", async () => {
    const c = capture();
    const { rt, state } = updatingRuntime(undefined);
    await runUpdate([], c.io, rt);
    expect(state.installed).not.toContain("ffmpeg");
  });

  it("fails with the download's exit code", async () => {
    const c = capture();
    const { rt } = makeRuntime({
      installError: new ToolInstallError("checksum", "Checksum mismatch.", "Try again."),
    });
    await expect(runUpdate([], c.io, rt)).rejects.toMatchObject({ exitCode: ExitCode.Network });
  });

  it("prints help and rejects arguments", async () => {
    const c = capture();
    const { rt } = makeRuntime();
    expect(await runUpdate(["--help"], c.io, rt)).toBe(ExitCode.Ok);
    expect(c.out()).toContain("Usage: mediaforge update");
    await expect(runUpdate(["x"], c.io, rt)).rejects.toMatchObject({ exitCode: ExitCode.Usage });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run apps/desktop/src/tool-commands.test.ts`
Expected: FAIL, `runUpdate` is not exported.

- [ ] **Step 3: Implement**

In `apps/desktop/src/tool-commands.ts` extend the import from `./tool-runtime.ts` with `toCliError` and `tryResolve`, add `import type { InstallResult } from "@mediaforge/binary-resolver";` (merge with the existing import from that package), and append:
```ts
const UPDATE_USAGE = "Usage: mediaforge update";

export function updateUsage(): string {
  return [
    UPDATE_USAGE,
    "",
    "Download the latest yt-dlp nightly build into MediaForge's tool folder.",
    "ffmpeg is never changed by this command.",
    "",
    "Options:",
    "  -h, --help   Show this help",
    "",
  ].join("\n");
}

const WHO_WINS = {
  env: "MEDIAFORGE_YTDLP_PATH",
  path: "the yt-dlp on your PATH",
  bundled: "the yt-dlp in the bundled folder",
} as const;

export async function runUpdate(
  args: string[],
  io: Io,
  rt: ToolRuntime = defaultToolRuntime(),
): Promise<ExitCode> {
  const { values, positionals } = parseCommandArgs(
    args,
    { help: { type: "boolean", short: "h" } },
    UPDATE_USAGE,
  );
  if (values.help) {
    io.stdout(updateUsage());
    return ExitCode.Ok;
  }
  if (positionals.length > 0) {
    throw new CliError(`Unexpected argument: ${positionals[0]}\n${UPDATE_USAGE}`, ExitCode.Usage);
  }

  const before = await tryResolve("yt-dlp", rt.resolve);
  let result: InstallResult;
  try {
    result = await rt.install("yt-dlp", createInstallPrinter(io.stderr, rt.interactive));
  } catch (error) {
    throw toCliError(error);
  }
  const after = await tryResolve("yt-dlp", rt.resolve);

  io.stdout(
    before?.source === "cache" && before.version === result.version
      ? `yt-dlp is already up to date (${result.version})\n`
      : `yt-dlp updated: ${before?.version ?? "not installed"} to ${result.version}\n`,
  );
  if (after && after.source !== "cache") {
    io.stderr(
      `Note: ${WHO_WINS[after.source]} (${after.path}) is used before the downloaded copy, so this update has no effect on downloads. Remove it, or unset the variable, to use the downloaded one.\n`,
    );
  }
  return ExitCode.Ok;
}
```
In `commands.ts` import `runUpdate` too and add after `setup`:
```ts
  {
    name: "update",
    summary: "Update yt-dlp to the latest nightly",
    run: (args, io) => runUpdate(args, io),
  },
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec biome check --write apps/desktop/src && pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit message**

Output for the user:
```text
✨ desktop: add the update command for yt-dlp

Test: pnpm exec vitest run apps/desktop
```

### Task 14: Lazy first run in `download` and `formats`

**Files:**
- Modify: `apps/desktop/src/download.ts`, `apps/desktop/src/formats.ts`
- Modify: `apps/desktop/src/download.test.ts`

**Interfaces:**
- Consumes: `defaultEnsureTools` (Task 11).
- Produces: `DownloadDeps.ensureTools?: (tools: Tool[]) => Promise<void>` and `FormatsDeps.ensureTools?: (tools: Tool[]) => Promise<void>`. `runDownload` calls it with `["yt-dlp", "ffmpeg"]` and `runFormats` with `["yt-dlp"]`, after the arguments are validated and before any work starts. `fetchMediaInfo` (used by the interactive app) does not call it, so the interactive app never prompts on stdin mid-render.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/download.test.ts`, change the import `import { ExitCode } from "./exit-codes.ts";` to `import { CliError, ExitCode } from "./exit-codes.ts";`, then add inside `describe("runDownload", ...)`:
```ts
  it("makes sure the tools exist first and stops when one is missing", async () => {
    const t = setup(succeed);
    const asked: string[][] = [];
    t.deps.ensureTools = async (tools) => {
      asked.push(tools);
      throw new CliError("yt-dlp is missing.\nrun: mediaforge setup", ExitCode.MissingTool);
    };
    await expect(runDownload(["https://example.com/v"], t.io, t.deps)).rejects.toMatchObject({
      exitCode: ExitCode.MissingTool,
      message: "yt-dlp is missing.\nrun: mediaforge setup",
    });
    expect(asked).toEqual([["yt-dlp", "ffmpeg"]]);
    expect(t.seenArgs).toEqual([]);
  });

  it("does not check tools when the arguments are already wrong", async () => {
    const t = setup(succeed);
    let called = false;
    t.deps.ensureTools = async () => {
      called = true;
    };
    await expect(
      runDownload(["https://example.com/v", "-p", "nope"], t.io, t.deps),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage });
    expect(called).toBe(false);
  });
```
Find the existing `runFormats` tests in the same file and add one next to them. Use the same `FormatsDeps` shape those tests already build (`{ resolve, run }`) and add `ensureTools`:
```ts
  it("makes sure yt-dlp exists before listing formats", async () => {
    const asked: string[][] = [];
    const deps = {
      resolve: found,
      run: async () => ({ exitCode: 0 }),
      ensureTools: async (tools: Tool[]) => {
        asked.push(tools);
        throw new CliError("yt-dlp is missing.\nrun: mediaforge setup", ExitCode.MissingTool);
      },
    };
    await expect(
      runFormats(["https://example.com/v"], { stdout: () => {}, stderr: () => {} }, deps),
    ).rejects.toMatchObject({ exitCode: ExitCode.MissingTool });
    expect(asked).toEqual([["yt-dlp"]]);
  });
```
(Place it inside whichever `describe` already holds the `runFormats` tests; `Tool` and `found` are already imported or defined at the top of the file.)

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm exec vitest run apps/desktop/src/download.test.ts`
Expected: FAIL (`ensureTools` is not part of the deps types and is never called).

- [ ] **Step 3: Implement**

In `apps/desktop/src/download.ts`:
1. Add `import type { Tool } from "@mediaforge/binary-resolver";` and `import { defaultEnsureTools } from "./tool-runtime.ts";` (sorted).
2. In `DownloadDeps` add:
```ts
  /**
   * Make sure the tools exist before work starts. In a terminal it offers to download them;
   * otherwise it fails with exit 3 and `run: mediaforge setup`.
   */
  ensureTools?: (tools: Tool[]) => Promise<void>;
```
3. In `defaultDownloadDeps` add the line `ensureTools: defaultEnsureTools(),` after `env: process.env,`.
4. In `runDownload`, right after the `if (!profile) { ... }` block and before `const view = createProgressView(...)`, add:
```ts
  await deps.ensureTools?.(["yt-dlp", "ffmpeg"]);
```

In `apps/desktop/src/formats.ts`:
1. Add `import { defaultEnsureTools } from "./tool-runtime.ts";` and make sure `type Tool` is imported from `@mediaforge/binary-resolver` (add the import if the file has none).
2. In `FormatsDeps` add `ensureTools?: (tools: Tool[]) => Promise<void>;`.
3. Change `defaultFormatsDeps` to:
```ts
const defaultFormatsDeps = (): FormatsDeps => ({
  resolve: resolveTool,
  run: runProcess,
  ensureTools: defaultEnsureTools(),
});
```
4. In `runFormats`, after the `positionals.length !== 1` check and before `const info = await fetchMediaInfo(...)`, add `await deps.ensureTools?.(["yt-dlp"]);`.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec biome check --write apps/desktop/src && pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Try it for real**

Run (Git Bash, from the repo root):
```bash
MEDIAFORGE_CACHE_DIR="$PWD/out/cache-try" PATH="/usr/bin" pnpm --filter @mediaforge/desktop start setup --yes --tools yt-dlp
```
Expected: a real nightly yt-dlp is downloaded into `out/cache-try`, with a progress counter, and the summary prints `downloaded`. Run it again: it prints `already available` and downloads nothing. Then `rm -rf out/cache-try`. (Skip this step if the machine is offline; the unit tests already cover the logic.)

- [ ] **Step 6: Commit message**

Output for the user:
```text
✨ desktop: offer to download missing tools on first use

Body: In a terminal, download and formats ask before fetching yt-dlp or ffmpeg. Without a terminal they exit 3 with "run: mediaforge setup". Nothing downloads silently.
Test: pnpm exec vitest run apps/desktop
```

### Task 15: JavaScript runtime detection for yt-dlp

**Files:**
- Create: `apps/desktop/src/js-runtime.ts`
- Create: `apps/desktop/src/js-runtime.test.ts`
- Modify: `apps/desktop/src/engine/args.ts`, `apps/desktop/src/engine/engine.ts`, `apps/desktop/src/engine/progress.ts`
- Modify: `apps/desktop/src/engine/engine-parts.test.ts`, `apps/desktop/src/engine/engine.test.ts`
- Modify: `apps/desktop/src/doctor.ts`, `apps/desktop/src/doctor.test.ts`
- Modify: `apps/desktop/src/download.ts`, `apps/desktop/src/formats.ts`

**Interfaces:**
- Consumes: `findOnPath`, `FindOnPathOptions` (Task 5).
- Produces:
  - `type JsRuntimeName = "deno" | "node" | "quickjs" | "bun"`, `interface JsRuntime { name; path: string; version?: string }`
  - `detectJsRuntime(options?: FindOnPathOptions & { run?: (path: string, args: string[]) => Promise<string> }): Promise<JsRuntime | undefined>`
  - `jsRuntimeArgs(runtime: JsRuntime | undefined): string[]` (Deno needs no flag because yt-dlp enables it itself; the others give `["--js-runtimes", "<name>:<path>"]`)
  - `detectJsRuntimeArgs(): Promise<string[]>` (detects once per process)
  - `buildYtDlpArgs` input gains `jsRuntimeArgs?: string[]`; `EngineOptions.jsRuntimeArgs?: () => Promise<string[]>` (default: none); `FormatsDeps.jsRuntimeArgs?: () => Promise<string[]>`
  - `doctor --json` gains `jsRuntime: { found: boolean; name?; path?; version? }`

Context: yt-dlp needs a JavaScript runtime for full YouTube support. Deno is enabled by default; Node 20 or newer, QuickJS and Bun must be switched on with `--js-runtimes <name>:<path>`. The packaged MediaForge binary cannot serve as that runtime. Detection order is Deno, Node, QuickJS (`qjs`), Bun. When none is found, `doctor` and a failed YouTube download say so; the exit code of `doctor` does not change.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/js-runtime.test.ts`:
```ts
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectJsRuntime, jsRuntimeArgs } from "./js-runtime.ts";

const BIN = join("/", "opt", "bin");

function detect(outputs: Record<string, string | Error>) {
  const ran: string[] = [];
  return {
    ran,
    run: () =>
      detectJsRuntime({
        env: { PATH: BIN },
        platform: "linux",
        isExecutable: async (path) => path.startsWith(BIN) && path.slice(BIN.length + 1) in outputs,
        run: async (path) => {
          ran.push(path);
          const output = outputs[path.slice(BIN.length + 1)];
          if (output instanceof Error) throw output;
          return output as string;
        },
      }),
  };
}

describe("detectJsRuntime", () => {
  it("prefers Deno", async () => {
    const t = detect({ deno: "deno 2.1.4 (stable)\nv8 13.0", node: "v22.1.0" });
    expect(await t.run()).toEqual({
      name: "deno",
      path: join(BIN, "deno"),
      version: "deno 2.1.4 (stable)",
    });
  });

  it("uses Node 20 or newer when there is no Deno", async () => {
    const found = await detect({ node: "v22.1.0" }).run();
    expect(found).toMatchObject({ name: "node", version: "v22.1.0" });
  });

  it("skips Node older than 20", async () => {
    expect(await detect({ node: "v18.19.0" }).run()).toBeUndefined();
  });

  it("accepts QuickJS without running it, then Bun", async () => {
    const quick = detect({ qjs: "unused" });
    expect(await quick.run()).toEqual({ name: "quickjs", path: join(BIN, "qjs") });
    expect(quick.ran).toEqual([]);
    expect(await detect({ bun: "1.1.0" }).run()).toMatchObject({ name: "bun" });
  });

  it("skips a runtime whose version command fails", async () => {
    const found = await detect({ deno: new Error("boom"), node: "v22.0.0" }).run();
    expect(found?.name).toBe("node");
  });

  it("returns undefined when there is none", async () => {
    expect(await detect({}).run()).toBeUndefined();
  });

  it("searches every PATH entry", async () => {
    const found = await detectJsRuntime({
      env: { PATH: ["/a", "/b"].join(delimiter) },
      platform: "linux",
      isExecutable: async (path) => path === join("/b", "deno"),
      run: async () => "deno 2.0.0",
    });
    expect(found?.path).toBe(join("/b", "deno"));
  });
});

describe("jsRuntimeArgs", () => {
  it("needs no flag for Deno or when nothing was found", () => {
    expect(jsRuntimeArgs(undefined)).toEqual([]);
    expect(jsRuntimeArgs({ name: "deno", path: "/bin/deno" })).toEqual([]);
  });

  it("enables the other runtimes by name and path", () => {
    expect(jsRuntimeArgs({ name: "node", path: "/usr/bin/node" })).toEqual([
      "--js-runtimes",
      "node:/usr/bin/node",
    ]);
    expect(jsRuntimeArgs({ name: "quickjs", path: "/usr/bin/qjs" })).toEqual([
      "--js-runtimes",
      "quickjs:/usr/bin/qjs",
    ]);
  });
});
```

Add to `apps/desktop/src/engine/engine-parts.test.ts`, inside `describe("buildYtDlpArgs", ...)`:
```ts
  it("adds JS runtime flags before the options end, and none by default", () => {
    const profile = getProfile("best") as OutputProfile;
    const withRuntime = buildYtDlpArgs({
      request: { candidate, profileId: "best" },
      profile,
      workDir: "/work",
      ffmpegPath: "/bin/ffmpeg",
      jsRuntimeArgs: ["--js-runtimes", "node:/usr/bin/node"],
    });
    const at = withRuntime.indexOf("--js-runtimes");
    expect(withRuntime[at + 1]).toBe("node:/usr/bin/node");
    expect(at).toBeLessThan(withRuntime.indexOf("--"));
    expect(build("best")).not.toContain("--js-runtimes");
  });
```
and inside `describe("classifyFailure", ...)`:
```ts
  it("adds a JS runtime hint when yt-dlp warned that none was found", () => {
    const failure = classifyFailure(
      [
        "WARNING: [youtube] abc: No supported JavaScript runtime could be found. Only deno is enabled by default.",
        "ERROR: [youtube] abc: Requested format is not available",
      ],
      1,
    );
    expect(failure.message).toContain("Requested format is not available");
    expect(failure.message).toContain("install Deno or Node.js 20 or newer");
    expect(classifyFailure(["ERROR: something odd"], 1).message).toBe("something odd");
  });
```

Add to `apps/desktop/src/engine/engine.test.ts`, inside `describe("DownloadEngine", ...)`:
```ts
  it("passes the detected JS runtime flags to yt-dlp", async () => {
    const { fs } = fakeFs();
    let seen: string[] = [];
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      jsRuntimeArgs: async () => ["--js-runtimes", "node:/usr/bin/node"],
      run: runner(async (h, _s, args) => {
        seen = args;
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/T.mp4`);
        return 0;
      }),
    });
    await engine.whenSettled(engine.submit(request()).id);
    expect(seen[seen.indexOf("--js-runtimes") + 1]).toBe("node:/usr/bin/node");
  });
```

In `apps/desktop/src/doctor.test.ts`: add `const noRuntime = async () => undefined;` below the `missing` helper, pass `noRuntime` as a fifth argument to each of the four existing `runDoctor(...)` calls (for example `runDoctor([], c.io, found, "/bin", noRuntime)`), and add inside `describe("runDoctor", ...)`:
```ts
  it("reports the JS runtime it found, in text and in JSON", async () => {
    const runtime = async () => ({ name: "node" as const, path: "/usr/bin/node", version: "v22.1.0" });
    const text = capture();
    await runDoctor([], text.io, found, "/bin", runtime);
    expect(text.out()).toContain("js runtime  node  v22.1.0  /usr/bin/node");

    const json = capture();
    await runDoctor(["--json"], json.io, found, "/bin", runtime);
    expect(JSON.parse(json.out()).jsRuntime).toEqual({
      found: true,
      name: "node",
      path: "/usr/bin/node",
      version: "v22.1.0",
    });
  });

  it("warns, without failing, when there is no JS runtime", async () => {
    const c = capture();
    expect(await runDoctor([], c.io, found, "/bin", noRuntime)).toBe(ExitCode.Ok);
    expect(c.out()).toContain("js runtime  NOT FOUND (optional)");
    expect(c.out()).toContain("Deno");
    const json = capture();
    await runDoctor(["--json"], json.io, found, "/bin", noRuntime);
    expect(JSON.parse(json.out()).jsRuntime).toEqual({ found: false });
  });
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm exec vitest run apps/desktop`
Expected: FAIL (`js-runtime.ts` is missing; new engine, args, classify and doctor cases fail).

- [ ] **Step 3: Implement detection**

Create `apps/desktop/src/js-runtime.ts`:
```ts
import { execFileText, type FindOnPathOptions, findOnPath } from "@mediaforge/binary-resolver";

export type JsRuntimeName = "deno" | "node" | "quickjs" | "bun";

export interface JsRuntime {
  name: JsRuntimeName;
  path: string;
  version?: string;
}

interface Candidate {
  name: JsRuntimeName;
  exe: string;
  /** Arguments that print the version. Omitted when finding the file is enough. */
  versionArgs?: string[];
  accepts?: (output: string) => boolean;
}

const nodeMajor = (output: string): number => Number(/^v?(\d+)/.exec(output.trim())?.[1] ?? 0);

/** In yt-dlp's own priority order. Node must be 20 or newer. */
const CANDIDATES: Candidate[] = [
  { name: "deno", exe: "deno", versionArgs: ["--version"] },
  { name: "node", exe: "node", versionArgs: ["--version"], accepts: (v) => nodeMajor(v) >= 20 },
  { name: "quickjs", exe: "qjs" },
  { name: "bun", exe: "bun", versionArgs: ["--version"] },
];

const defaultRun = (path: string, args: string[]) => execFileText(path, args);

export interface DetectOptions extends FindOnPathOptions {
  /** Run `<path> <args>` and return stdout. Throws if it cannot run. */
  run?: (path: string, args: string[]) => Promise<string>;
}

/** The first JavaScript runtime on PATH that yt-dlp can use, or undefined. */
export async function detectJsRuntime(options: DetectOptions = {}): Promise<JsRuntime | undefined> {
  const run = options.run ?? defaultRun;
  for (const candidate of CANDIDATES) {
    const path = await findOnPath(candidate.exe, options);
    if (!path) continue;
    if (!candidate.versionArgs) return { name: candidate.name, path };
    let output: string;
    try {
      output = await run(path, candidate.versionArgs);
    } catch {
      continue;
    }
    if (candidate.accepts && !candidate.accepts(output)) continue;
    const version = output.trim().split(/\r?\n/)[0]?.trim();
    return { name: candidate.name, path, ...(version && { version }) };
  }
  return undefined;
}

/** yt-dlp enables Deno by itself; every other runtime has to be switched on by name and path. */
export function jsRuntimeArgs(runtime: JsRuntime | undefined): string[] {
  if (!runtime || runtime.name === "deno") return [];
  return ["--js-runtimes", `${runtime.name}:${runtime.path}`];
}

let cached: Promise<string[]> | undefined;

/** The flags for this machine, detected once per process. */
export const detectJsRuntimeArgs = (): Promise<string[]> => {
  cached ??= detectJsRuntime().then(jsRuntimeArgs);
  return cached;
};
```

- [ ] **Step 4: Wire it into the engine, the formats lookup and the failure text**

`apps/desktop/src/engine/args.ts`: add to `BuildArgsInput`:
```ts
  /** `--js-runtimes ...` flags from `jsRuntimeArgs()`; empty when yt-dlp can find its own. */
  jsRuntimeArgs?: string[];
```
destructure `jsRuntimeArgs` in `buildYtDlpArgs({ ... })` and put `...(jsRuntimeArgs ?? []),` right after `"--no-playlist",` in the returned array.

`apps/desktop/src/engine/engine.ts`:
1. In `EngineOptions` add:
```ts
  /** Extra yt-dlp flags that enable a JavaScript runtime. Default: none. */
  jsRuntimeArgs?: () => Promise<string[]>;
```
2. Add a field `readonly #jsRuntimeArgs: () => Promise<string[]>;` and in the constructor `this.#jsRuntimeArgs = options.jsRuntimeArgs ?? (async () => []);`.
3. In `#execute`, after `const ffmpeg = await requireTool("ffmpeg", this.#resolve);` add `const jsRuntimeArgs = await this.#jsRuntimeArgs();`, and pass `jsRuntimeArgs,` inside the object given to `buildYtDlpArgs({ ... })`.

`apps/desktop/src/engine/progress.ts`: replace `classifyFailure` and add a constant above it:
```ts
const JS_RUNTIME_MISSING = /no supported javascript runtime/i;
const JS_RUNTIME_HINT = " (YouTube needs a JavaScript runtime: install Deno or Node.js 20 or newer.)";

/** Map yt-dlp's stderr to one of our exit codes plus a readable message. */
export function classifyFailure(stderr: string[], processExitCode: number | null): Failure {
  const text = stderr.join("\n");
  const errorLine = [...stderr].reverse().find((l) => l.startsWith("ERROR:"));
  const base =
    errorLine?.replace(/^ERROR:\s*/, "").trim() ||
    stderr.at(-1)?.trim() ||
    `yt-dlp exited with code ${processExitCode}`;
  const message = JS_RUNTIME_MISSING.test(text) ? `${base}${JS_RUNTIME_HINT}` : base;

  if (UNSUPPORTED.test(text)) return { exitCode: ExitCode.UnsupportedSite, message };
  if (FILESYSTEM.test(text)) return { exitCode: ExitCode.FileSystem, message };
  if (NETWORK.test(text)) return { exitCode: ExitCode.Network, message };
  return { exitCode: ExitCode.Failure, message };
}
```

`apps/desktop/src/download.ts`: import `detectJsRuntimeArgs` from `./js-runtime.ts` and change `createEngine` in `defaultDownloadDeps` to:
```ts
  createEngine: (onUpdate, options) =>
    new DownloadEngine({ onUpdate, jsRuntimeArgs: detectJsRuntimeArgs, ...options }),
```

`apps/desktop/src/formats.ts`: import `detectJsRuntimeArgs`; add `jsRuntimeArgs?: () => Promise<string[]>;` to `FormatsDeps`; add `jsRuntimeArgs: detectJsRuntimeArgs,` to `defaultFormatsDeps`; and change the yt-dlp argument list in `fetchMediaInfo` to:
```ts
    [
      "-J",
      "--no-playlist",
      "--no-warnings",
      ...((await deps.jsRuntimeArgs?.()) ?? []),
      "-S",
      FORMAT_SORT,
      "--",
      url,
    ],
```

- [ ] **Step 5: Report it in `doctor`**

Replace `apps/desktop/src/doctor.ts` with:
```ts
import { parseArgs } from "node:util";
import { ALL_TOOLS, BinaryNotFoundError, type Tool } from "@mediaforge/binary-resolver";
import { defaultBinDir, missingToolHint, type ResolveTool, resolveTool } from "./binaries.ts";
import type { Io } from "./commands.ts";
import { CliError, ExitCode } from "./exit-codes.ts";
import { detectJsRuntime, type JsRuntime } from "./js-runtime.ts";

export interface ToolReport {
  tool: Tool;
  found: boolean;
  version?: string;
  source?: string;
  path?: string;
  error?: string;
}

export interface JsRuntimeReport {
  found: boolean;
  name?: string;
  path?: string;
  version?: string;
}

async function inspect(tool: Tool, resolve: ResolveTool): Promise<ToolReport> {
  try {
    const { version, source, path } = await resolve(tool);
    return { tool, found: true, version, source, path };
  } catch (error) {
    if (error instanceof BinaryNotFoundError) return { tool, found: false, error: error.message };
    throw error;
  }
}

/** Look up every tool the app needs. */
export const inspectTools = (resolve: ResolveTool = resolveTool): Promise<ToolReport[]> =>
  Promise.all(ALL_TOOLS.map((tool) => inspect(tool, resolve)));

const reportRuntime = (runtime: JsRuntime | undefined): JsRuntimeReport =>
  runtime
    ? {
        found: true,
        name: runtime.name,
        path: runtime.path,
        ...(runtime.version !== undefined && { version: runtime.version }),
      }
    : { found: false };

function formatReport(reports: ToolReport[], runtime: JsRuntimeReport, binDir: string): string {
  const lines = reports.flatMap((r) => {
    if (r.found) {
      return [`${r.tool.padEnd(7)}  ${r.version ?? "unknown version"}  (${r.source})  ${r.path}`];
    }
    return [
      `${r.tool.padEnd(7)}  NOT FOUND`,
      `         ${r.error}`,
      `         ${missingToolHint(r.tool, binDir)}`,
    ];
  });
  if (runtime.found) {
    lines.push(`js runtime  ${runtime.name}  ${runtime.version ?? "unknown version"}  ${runtime.path}`);
  } else {
    lines.push(
      "js runtime  NOT FOUND (optional)",
      "            YouTube downloads may offer fewer formats. Install Deno (https://deno.com) or Node.js 20 or newer.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runDoctor(
  args: string[],
  io: Io,
  resolve: ResolveTool = resolveTool,
  binDir: string = defaultBinDir(),
  detect: () => Promise<JsRuntime | undefined> = () => detectJsRuntime(),
): Promise<ExitCode> {
  let json: boolean;
  try {
    json =
      parseArgs({ args, options: { json: { type: "boolean" } }, strict: true }).values.json ??
      false;
  } catch (error) {
    throw new CliError(
      `${error instanceof Error ? error.message : String(error)}\nUsage: mediaforge doctor [--json]`,
      ExitCode.Usage,
    );
  }

  const [reports, runtime] = await Promise.all([inspectTools(resolve), detect()]);
  const jsRuntime = reportRuntime(runtime);
  const ok = reports.every((r) => r.found);
  io.stdout(
    json
      ? `${JSON.stringify({ ok, tools: reports, jsRuntime }, null, 2)}\n`
      : formatReport(reports, jsRuntime, binDir),
  );
  return ok ? ExitCode.Ok : ExitCode.MissingTool;
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm exec biome check --write apps/desktop/src && pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Check it for real**

Run: `pnpm --filter @mediaforge/desktop start doctor`
Expected: the tool lines plus a `js runtime` line (your Node 22 on PATH appears as `node`). After the YouTube manual test in Task 25 the runbook records the result.

- [ ] **Step 8: Commit message**

Output for the user:
```text
✨ desktop: detect a JavaScript runtime for yt-dlp and report it in doctor

Test: pnpm exec vitest run apps/desktop
```

### Task 16: Stale-extractor errors point to `mediaforge update`

**Files:**
- Create: `apps/desktop/src/stale-extractor.ts`
- Create: `apps/desktop/src/stale-extractor.test.ts`
- Modify: `apps/desktop/src/download.ts`, `apps/desktop/src/formats.ts`, `apps/desktop/src/download.test.ts`

**Interfaces:**
- Produces: `isStaleExtractorError(message: string | undefined): boolean`, `withUpdateHint(message: string): string` (appends a line `run: mediaforge update` when the message looks stale), `UPDATE_HINT = "run: mediaforge update"`.

Plan decision (the spec fixes the patterns "during planning"): a failure is stale-extractor when its message matches `unable to extract`, `confirm you are on the latest version`, `yt-dlp -U`, `please report this issue`, `nsig extraction failed`, `signature extraction failed`, or `http error 403`. The 403 case matches the hint the interactive app already shows ("Updating yt-dlp usually fixes this").

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/stale-extractor.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isStaleExtractorError, UPDATE_HINT, withUpdateHint } from "./stale-extractor.ts";

describe("isStaleExtractorError", () => {
  it.each([
    "[youtube] abc: Unable to extract initial data; please report this issue on https://github.com/yt-dlp/yt-dlp/issues",
    "Confirm you are on the latest version using yt-dlp -U",
    "nsig extraction failed: Some formats may be missing",
    "Signature extraction failed: Some formats may be missing",
    "unable to download video data: HTTP Error 403: Forbidden",
  ])("recognises %s", (message) => {
    expect(isStaleExtractorError(message)).toBe(true);
  });

  it.each([
    "Unsupported URL: https://example.com",
    "[Errno 28] No space left on device",
    "unable to download video data: HTTP Error 404: Not Found",
    "Video unavailable",
    "",
  ])("ignores %s", (message) => {
    expect(isStaleExtractorError(message)).toBe(false);
  });

  it("ignores a missing message", () => {
    expect(isStaleExtractorError(undefined)).toBe(false);
  });
});

describe("withUpdateHint", () => {
  it("appends the hint on its own line for stale-looking errors only", () => {
    expect(withUpdateHint("Unable to extract title")).toBe(`Unable to extract title\n${UPDATE_HINT}`);
    expect(withUpdateHint("Video unavailable")).toBe("Video unavailable");
    expect(UPDATE_HINT).toBe("run: mediaforge update");
  });
});
```

In `apps/desktop/src/download.test.ts`, add inside `describe("runDownload", ...)`:
```ts
  it("suggests mediaforge update when the failure looks like a stale extractor", async () => {
    const t = setup(async (_c, _a, h) => {
      h.onStderrLine("ERROR: [generic] Unable to extract title; please report this issue");
      return { exitCode: 1 };
    });
    await expect(runDownload(["https://example.com/v"], t.io, t.deps)).rejects.toMatchObject({
      message: expect.stringContaining("\nrun: mediaforge update"),
    });
  });

  it("does not suggest it for other failures", async () => {
    const t = setup(async (_c, _a, h) => {
      h.onStderrLine("ERROR: Unsupported URL: https://example.com/v");
      return { exitCode: 1 };
    });
    const error = await runDownload(["https://example.com/v"], t.io, t.deps).catch((e) => e);
    expect(error.message).not.toContain("mediaforge update");
  });
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm exec vitest run apps/desktop/src/stale-extractor.test.ts apps/desktop/src/download.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/stale-extractor.ts`:
```ts
/** Errors that usually mean yt-dlp's site code is out of date, so a newer build would fix them. */
const STALE_EXTRACTOR = [
  /unable to extract/i,
  /confirm you are on the latest version/i,
  /yt-dlp -U\b/,
  /please report this issue/i,
  /(nsig|signature) extraction failed/i,
  /http error 403/i,
];

export const UPDATE_HINT = "run: mediaforge update";

export const isStaleExtractorError = (message: string | undefined): boolean =>
  message !== undefined && STALE_EXTRACTOR.some((pattern) => pattern.test(message));

/** Add `run: mediaforge update` under an error that an update would probably fix. */
export const withUpdateHint = (message: string): string =>
  isStaleExtractorError(message) ? `${message}\n${UPDATE_HINT}` : message;
```

In `apps/desktop/src/download.ts` import `withUpdateHint` from `./stale-extractor.ts` and change the last line of `runDownload` to:
```ts
  throw new CliError(
    withUpdateHint(job?.error ?? "Download failed."),
    job?.errorKind ?? ExitCode.Failure,
  );
```
In `apps/desktop/src/formats.ts` import it too and change the failure branch of `fetchMediaInfo` to `throw new CliError(withUpdateHint(failure.message), failure.exitCode);`.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec biome check --write apps/desktop/src && pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit message**

Output for the user:
```text
✨ desktop: point stale-extractor failures to mediaforge update

Test: pnpm exec vitest run apps/desktop
```

### Task 17: Interactive app offers to download missing tools

**Files:**
- Create: `apps/desktop/src/interactive/install-progress.ts`
- Create: `apps/desktop/src/interactive/install-progress.test.ts`
- Modify: `apps/desktop/src/tool-runtime.ts` (export `PHASE_LABELS`)
- Modify: `apps/desktop/src/interactive/deps.ts`, `apps/desktop/src/interactive/start.tsx`, `apps/desktop/src/interactive/App.tsx`
- Modify: `apps/desktop/src/interactive/screens/SetupScreen.tsx`
- Modify: `apps/desktop/src/interactive/App.test.tsx`

**Interfaces:**
- Consumes: `installTool` via `defaultToolRuntime().install` (Task 11), `ToolInstallError`, `InstallProgress`, `InstallResult`, `Tool`.
- Produces:
  - `AppDeps.installTool: (tool: Tool, onProgress: (progress: InstallProgress) => void) => Promise<InstallResult>`
  - `describeInstallFailure(error: unknown): string`, `describeInstallProgress(p: InstallProgress): string`, `installPercent(p: InstallProgress): number | undefined`
  - `SetupScreen` props `{ onBack: () => void; onReady?: () => void }`; with `onReady` it is the "tools are missing, download them first?" prompt
  - Screen `{ name: "setup"; prompt?: boolean }` in `App.tsx`

Behavior (spec: "the same prompt as a screen, with a progress bar"): choosing "Download media" on Home first checks the tools. If any is missing, the Setup screen opens with the choice "Download missing tools" first. It shows a progress bar per download; on success "Continue" opens the link screen. "Check setup" from Home also offers the download. A failure shows the message and hint and keeps the choice available. Esc is ignored while a download runs.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/interactive/install-progress.test.ts`:
```ts
import { ToolInstallError } from "@mediaforge/binary-resolver";
import { describe, expect, it } from "vitest";
import {
  describeInstallFailure,
  describeInstallProgress,
  installPercent,
} from "./install-progress.ts";

describe("installPercent", () => {
  it("is the share downloaded, and unknown without a total or outside the download", () => {
    expect(installPercent({ tool: "yt-dlp", phase: "downloading", received: 50, total: 200 })).toBe(25);
    expect(installPercent({ tool: "yt-dlp", phase: "downloading", received: 50 })).toBeUndefined();
    expect(installPercent({ tool: "yt-dlp", phase: "verifying" })).toBeUndefined();
  });
});

describe("describeInstallProgress", () => {
  it("shows bytes while downloading and the phase otherwise", () => {
    expect(
      describeInstallProgress({ tool: "ffmpeg", phase: "downloading", received: 1048576, total: 2097152 }),
    ).toBe("ffmpeg: downloading 1.0 MB of 2.0 MB");
    expect(describeInstallProgress({ tool: "ffmpeg", phase: "downloading", received: 0 })).toBe(
      "ffmpeg: downloading",
    );
    expect(describeInstallProgress({ tool: "yt-dlp", phase: "verifying" })).toBe(
      "yt-dlp: verifying checksum",
    );
  });
});

describe("describeInstallFailure", () => {
  it("joins an install error's message and hint, and falls back to any error's message", () => {
    expect(describeInstallFailure(new ToolInstallError("offline", "Could not reach x.", "Try again."))).toBe(
      "Could not reach x. Try again.",
    );
    expect(describeInstallFailure(new Error("boom"))).toBe("boom");
    expect(describeInstallFailure("odd")).toBe("odd");
  });
});
```

In `apps/desktop/src/interactive/App.test.tsx`:
1. Add to the imports: `import { type Tool, ToolInstallError } from "@mediaforge/binary-resolver";` (merge with the existing `import type { Tool }` line) and keep `Tool` type-only if Biome asks.
2. Extend `Options` with:
```ts
  /** Tools that start out missing. The default `installTool` removes a tool from this set. */
  missing?: Tool[];
  installTool?: AppDeps["installTool"];
```
3. In `setup()`, before `const deps: AppDeps = {`, add:
```ts
  const missing = new Set<Tool>(options.missing ?? []);
  const installed: Tool[] = [];
```
Replace the `inspectTools:` property with:
```ts
    inspectTools:
      options.tools ??
      (async () => [
        missing.has("yt-dlp")
          ? { tool: "yt-dlp", found: false, error: "yt-dlp not found" }
          : { tool: "yt-dlp", found: true, version: "2026.1.1", source: "path", path: "/bin/yt-dlp" },
        missing.has("ffmpeg")
          ? { tool: "ffmpeg", found: false, error: "ffmpeg not found" }
          : { tool: "ffmpeg", found: true, version: "9.0", source: "bundled", path: "/bin/ffmpeg" },
      ]),
    installTool:
      options.installTool ??
      (async (tool) => {
        installed.push(tool);
        missing.delete(tool);
        return { tool, version: "1", path: `/cache/${tool}`, sha256: "s", url: "u" };
      }),
```
and return `installed` from `setup`: `return { app, deps, store, seenArgs, opened, engineOptions, installed };`.
4. Add a new `describe` block after `describe("check setup", ...)`:
```tsx
describe("missing tools", () => {
  it("offers to download them before the first download, then continues", async () => {
    const t = setup({ missing: ["yt-dlp", "ffmpeg"] });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download missing tools");
    expect(t.app.lastFrame()).toContain("yt-dlp and ffmpeg");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Continue");
    expect(t.installed).toEqual(["yt-dlp", "ffmpeg"]);
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    t.app.unmount();
  });

  it("shows the reason and keeps the choice when a download fails", async () => {
    const t = setup({
      missing: ["yt-dlp"],
      installTool: async () => {
        throw new ToolInstallError(
          "offline",
          "Could not reach github.com.",
          "Check your internet connection, then try again.",
        );
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download missing tools");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Could not reach github.com.");
    expect(t.app.lastFrame()).toContain("Check your internet connection");
    expect(t.app.lastFrame()).toContain("Download missing tools");
    expect(t.app.lastFrame()).not.toContain("Continue");
    t.app.unmount();
  });

  it("is also offered from Check setup, without a Continue choice", async () => {
    const t = setup({ missing: ["ffmpeg"] });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.down, KEY.down, KEY.enter);
    await waitFor(t.app, "Download missing tools");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Everything is ready.");
    expect(t.installed).toEqual(["ffmpeg"]);
    expect(t.app.lastFrame()).not.toContain("Continue");
    t.app.unmount();
  });

  it("goes straight to the link screen when nothing is missing", async () => {
    const t = setup();
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    expect(t.installed).toEqual([]);
    t.app.unmount();
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm exec vitest run apps/desktop/src/interactive`
Expected: FAIL (`install-progress.ts` missing, `installTool` not in `AppDeps`).

- [ ] **Step 3: Implement the helpers and the dependency**

In `apps/desktop/src/tool-runtime.ts` change `const PHASE_LABELS = {` to `export const PHASE_LABELS = {`.

Create `apps/desktop/src/interactive/install-progress.ts`:
```ts
import { type InstallProgress, ToolInstallError } from "@mediaforge/binary-resolver";
import { formatBytes } from "../progress-view.ts";
import { PHASE_LABELS } from "../tool-runtime.ts";

/** Share of the download done, or undefined when the size is unknown or it is another phase. */
export function installPercent(progress: InstallProgress): number | undefined {
  return progress.phase === "downloading" && progress.total
    ? ((progress.received ?? 0) / progress.total) * 100
    : undefined;
}

/** One line for the screen: "ffmpeg: downloading 1.0 MB of 2.0 MB". */
export function describeInstallProgress(progress: InstallProgress): string {
  if (progress.phase !== "downloading" || !progress.received) {
    return `${progress.tool}: ${PHASE_LABELS[progress.phase]}`;
  }
  const total = progress.total ? ` of ${formatBytes(progress.total)}` : "";
  return `${progress.tool}: downloading ${formatBytes(progress.received)}${total}`;
}

/** The message and what to do about it, in one sentence for the screen. */
export function describeInstallFailure(error: unknown): string {
  if (error instanceof ToolInstallError) return `${error.message} ${error.hint}`;
  return error instanceof Error ? error.message : String(error);
}
```

In `apps/desktop/src/interactive/deps.ts` import the types and add the field:
```ts
import type { InstallProgress, InstallResult, Tool } from "@mediaforge/binary-resolver";
```
```ts
  /** Download one tool into MediaForge's tool folder, reporting progress as it goes. */
  installTool: (tool: Tool, onProgress: (progress: InstallProgress) => void) => Promise<InstallResult>;
```
In `apps/desktop/src/interactive/start.tsx` import `defaultToolRuntime` from `../tool-runtime.ts` and add to `realDeps()`:
```ts
    installTool: (tool, onProgress) => defaultToolRuntime().install(tool, onProgress),
```

- [ ] **Step 4: Replace the Setup screen**

Replace `apps/desktop/src/interactive/screens/SetupScreen.tsx` with:
```tsx
import type { InstallProgress } from "@mediaforge/binary-resolver";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { missingToolHint } from "../../binaries.ts";
import type { ToolReport } from "../../doctor.ts";
import { Frame } from "../components/Frame.tsx";
import { Menu, type MenuItem } from "../components/Menu.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { useDeps } from "../deps.ts";
import {
  describeInstallFailure,
  describeInstallProgress,
  installPercent,
} from "../install-progress.ts";
import { COLORS, ICONS } from "../theme.ts";

type Choice = "install" | "continue" | "again" | "back";

export interface SetupScreenProps {
  onBack: () => void;
  /** Set when the user came here because a tool is missing before a download. Adds "Continue". */
  onReady?: () => void;
}

export function SetupScreen({ onBack, onReady }: SetupScreenProps) {
  const deps = useDeps();
  const [reports, setReports] = useState<ToolReport[]>();
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<InstallProgress>();
  const [failure, setFailure] = useState<string>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the check on demand
  useEffect(() => {
    let live = true;
    setReports(undefined);
    deps.inspectTools().then((r) => live && setReports(r));
    return () => {
      live = false;
    };
  }, [deps, attempt]);

  const missing = reports?.filter((r) => !r.found) ?? [];
  const allFound = reports !== undefined && missing.length === 0;

  const downloadMissing = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      for (const report of missing) await deps.installTool(report.tool, setProgress);
    } catch (error) {
      setFailure(describeInstallFailure(error));
    }
    setProgress(undefined);
    setBusy(false);
    setAttempt((n) => n + 1);
  };

  const items: MenuItem<Choice>[] = [];
  if (missing.length > 0) {
    items.push({
      value: "install",
      icon: ICONS.download,
      label: "Download missing tools",
      hint: missing.map((r) => r.tool).join(" and "),
    });
  }
  if (onReady && allFound) items.push({ value: "continue", icon: ICONS.ok, label: "Continue" });
  items.push(
    { value: "again", icon: ICONS.retry, label: "Check again" },
    { value: "back", icon: ICONS.back, label: "Back" },
  );
  const initial: Choice = missing.length > 0 ? "install" : onReady ? "continue" : "back";

  const onSelect = (choice: Choice) => {
    if (choice === "install") void downloadMissing();
    else if (choice === "continue") onReady?.();
    else if (choice === "again") setAttempt((n) => n + 1);
    else onBack();
  };

  return (
    <Frame
      crumbs={onReady ? ["Home", "Download", "Tools"] : ["Home", "Check setup"]}
      icon={onReady ? ICONS.download : ICONS.setup}
      tone={reports && !allFound ? "warn" : "accent"}
      title={onReady ? "Download the tools first" : "Check setup"}
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Back"],
      ]}
    >
      {!reports ? (
        <Spinner label="Looking for yt-dlp and ffmpeg..." />
      ) : (
        <Box flexDirection="column">
          {reports.map((r) => (
            <Box key={r.tool} flexDirection="column" marginBottom={1}>
              <Text color={r.found ? COLORS.ok : COLORS.error} bold>
                {r.found ? ICONS.ok : ICONS.error} {r.tool}
                <Text color={COLORS.muted} bold={false}>
                  {r.found ? `  ${r.version ?? "unknown version"}  (${r.source})` : "  not found"}
                </Text>
              </Text>
              {r.found ? (
                <Text color={COLORS.muted}>{`  ${r.path}`}</Text>
              ) : (
                <Text color={COLORS.muted}>{`  ${missingToolHint(r.tool, deps.binDir)}`}</Text>
              )}
            </Box>
          ))}
          <Text color={allFound ? COLORS.ok : COLORS.warn}>
            {allFound
              ? "Everything is ready."
              : "Some tools are missing. Downloads will not work until they are set up."}
          </Text>
          {failure ? <Text color={COLORS.error}>{failure}</Text> : null}
        </Box>
      )}
      {busy ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{progress ? describeInstallProgress(progress) : "Starting..."}</Text>
          <ProgressBar percent={progress ? installPercent(progress) : undefined} width={30} />
        </Box>
      ) : reports ? (
        <Box marginTop={1}>
          <Menu<Choice>
            key={`${attempt}-${missing.length}`}
            initial={initial}
            onBack={onBack}
            onSelect={onSelect}
            items={items}
          />
        </Box>
      ) : null}
    </Frame>
  );
}
```

- [ ] **Step 5: Route Home to it**

In `apps/desktop/src/interactive/App.tsx`:
1. Change the Screen member `| { name: "setup" }` to `| { name: "setup"; prompt?: boolean }`.
2. In `HomeScreen`'s `onPick`, replace `else if (choice === "download") nav.push({ name: "link" });` with:
```tsx
              else if (choice === "download") {
                // Check the tools first; if one is missing, offer to download it before the link.
                void deps
                  .inspectTools()
                  .then((reports) =>
                    nav.push(
                      reports.every((r) => r.found) ? { name: "link" } : { name: "setup", prompt: true },
                    ),
                  );
              }
```
3. Replace the `case "setup":` body with:
```tsx
        return (
          <SetupScreen
            onBack={nav.back}
            onReady={screen.prompt ? () => nav.replace({ name: "link" }) : undefined}
          />
        );
```

- [ ] **Step 6: Run the tests**

Run: `pnpm exec biome check --write apps/desktop/src && pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS, including the existing "check setup" tests. If a pre-existing App test now fails because Home's download pick is asynchronous, add `await waitFor(...)` for the next screen at that point.

- [ ] **Step 7: Commit message**

Output for the user:
```text
✨ desktop: offer to download missing tools in the interactive app

Test: pnpm exec vitest run apps/desktop
```

### Task 18: "Update yt-dlp and retry" in the interactive app

**Files:**
- Create: `apps/desktop/src/interactive/screens/UpdateScreen.tsx`
- Modify: `apps/desktop/src/interactive/screens/ResultScreen.tsx`, `apps/desktop/src/interactive/App.tsx`, `apps/desktop/src/interactive/App.test.tsx`

**Interfaces:**
- Consumes: `isStaleExtractorError` (Task 16), `AppDeps.installTool`, `describeInstallFailure`, `describeInstallProgress`, `installPercent` (Task 17).
- Produces: `ResultAction` gains `"update"`; the failed-download screen shows "Update yt-dlp and retry" below "Try again" when the error looks stale; screen `{ name: "update"; plan: Plan; draft: Draft }`; `UpdateScreen` props `{ onDone: () => void; onBack: () => void }`.

The spec: the offer defaults to No and is never automatic. "Try again" stays the first, highlighted choice; the update runs only when the user selects it. Batch results are out of scope (the spec names the single-download error screen).

- [ ] **Step 1: Write the failing tests**

Add to `apps/desktop/src/interactive/App.test.tsx`, inside the `describe("missing tools", ...)` block's sibling, a new block:
```tsx
describe("stale extractor", () => {
  const STALE =
    "ERROR: [generic] Unable to extract title; please report this issue on https://github.com/yt-dlp/yt-dlp/issues . Confirm you are on the latest version using yt-dlp -U";
  const SKIP_QUESTIONS = { askQuality: false, askFolder: false, quality: "mp4-720p" } as const;

  it("offers to update yt-dlp, and retries the download after the update", async () => {
    let calls = 0;
    const t = setup({
      settings: SKIP_QUESTIONS,
      runner: async (c, a, h, s) => {
        calls++;
        if (calls === 1) {
          h.onStderrLine(STALE);
          return { exitCode: 1 };
        }
        return succeed(c, a, h, s);
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download failed");
    const failed = t.app.lastFrame() ?? "";
    expect(failed).toContain("Update yt-dlp and retry");
    // Nothing happens until the user picks it: "Try again" is the highlighted choice.
    expect(t.installed).toEqual([]);
    expect(failed).toMatch(/► .*Try again/);

    await moveTo(t.app, "Update yt-dlp and retry");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download complete");
    expect(t.installed).toEqual(["yt-dlp"]);
    expect(calls).toBe(2);
    t.app.unmount();
  });

  it("does not offer the update for failures that an update would not fix", async () => {
    const t = setup({
      settings: SKIP_QUESTIONS,
      runner: async (_c, _a, h) => {
        h.onStderrLine("ERROR: [Errno 28] No space left on device");
        return { exitCode: 1 };
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download failed");
    expect(t.app.lastFrame()).not.toContain("Update yt-dlp and retry");
    t.app.unmount();
  });

  it("shows why the update failed and lets the user go back", async () => {
    const t = setup({
      settings: SKIP_QUESTIONS,
      runner: async (_c, _a, h) => {
        h.onStderrLine(STALE);
        return { exitCode: 1 };
      },
      installTool: async () => {
        throw new ToolInstallError("offline", "Could not reach github.com.", "Check your internet connection, then try again.");
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download failed");
    await moveTo(t.app, "Update yt-dlp and retry");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Could not reach github.com.");
    await press(t.app, KEY.esc);
    await waitFor(t.app, "Download failed");
    t.app.unmount();
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm exec vitest run apps/desktop/src/interactive/App.test.tsx`
Expected: FAIL (no "Update yt-dlp and retry" choice).

- [ ] **Step 3: Implement**

Create `apps/desktop/src/interactive/screens/UpdateScreen.tsx`:
```tsx
import type { InstallProgress } from "@mediaforge/binary-resolver";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { useDeps } from "../deps.ts";
import {
  describeInstallFailure,
  describeInstallProgress,
  installPercent,
} from "../install-progress.ts";
import { COLORS, ICONS } from "../theme.ts";

type Choice = "again" | "back";

export interface UpdateScreenProps {
  /** Called once yt-dlp is updated. */
  onDone: () => void;
  onBack: () => void;
}

/** Downloads the latest yt-dlp, then hands control back so the download can be retried. */
export function UpdateScreen({ onDone, onBack }: UpdateScreenProps) {
  const deps = useDeps();
  const [progress, setProgress] = useState<InstallProgress>();
  const [failure, setFailure] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  // The callback changes on every render; keep the latest one without restarting the update.
  const done = useRef(onDone);
  done.current = onDone;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` restarts the update
  useEffect(() => {
    let live = true;
    setFailure(undefined);
    deps.installTool("yt-dlp", (p) => live && setProgress(p)).then(
      () => live && done.current(),
      (error) => live && setFailure(describeInstallFailure(error)),
    );
    return () => {
      live = false;
    };
  }, [deps, attempt]);

  return (
    <Frame
      crumbs={["Home", "Download", "Update yt-dlp"]}
      icon={ICONS.download}
      tone={failure ? "error" : "accent"}
      title="Updating yt-dlp"
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Back"],
      ]}
    >
      {failure ? (
        <Box flexDirection="column">
          <Text color={COLORS.error}>{failure}</Text>
          <Box marginTop={1}>
            <Menu<Choice>
              onBack={onBack}
              onSelect={(choice) => (choice === "again" ? setAttempt((n) => n + 1) : onBack())}
              items={[
                { value: "again", icon: ICONS.retry, label: "Try again" },
                { value: "back", icon: ICONS.back, label: "Back" },
              ]}
            />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text>{progress ? describeInstallProgress(progress) : "Starting..."}</Text>
          <ProgressBar percent={progress ? installPercent(progress) : undefined} width={30} />
        </Box>
      )}
    </Frame>
  );
}
```

`apps/desktop/src/interactive/screens/ResultScreen.tsx`:
1. Import `isStaleExtractorError` from `../../stale-extractor.ts` and change `ResultAction` to `"open" | "again" | "retry" | "update" | "quality" | "home" | "quit"`.
2. In the failed branch, replace the `items={[ ... ]}` of the second `Menu` with:
```tsx
        items={[
          { value: "retry", icon: ICONS.retry, label: "Try again", hint: "same link and choices" },
          ...(isStaleExtractorError(job.error)
            ? [
                {
                  value: "update" as const,
                  icon: ICONS.download,
                  label: "Update yt-dlp and retry",
                  hint: "downloads the latest nightly",
                },
              ]
            : []),
          { value: "quality", icon: ICONS.format, label: "Choose a different quality" },
          { value: "again", icon: ICONS.link, label: "Use a different link" },
          ...FOOTER_ITEMS,
        ]}
```

`apps/desktop/src/interactive/App.tsx`:
1. Import `UpdateScreen` from `./screens/UpdateScreen.tsx`.
2. Add to the Screen union: `| { name: "update"; plan: Plan; draft: Draft }`.
3. In `onResult`, add before the `quality` branch:
```tsx
    else if (action === "update") {
      nav.push({ name: "update", plan: state.plan, draft: state.draft });
    }
```
(keep the existing `else if` chain intact; insert it right after the `retry` branch).
4. Add a case to the screen switch, before `case "batch":`:
```tsx
      case "update":
        return (
          <UpdateScreen
            onBack={nav.back}
            onDone={() =>
              nav.replace({
                name: "download",
                plan: screen.plan,
                draft: screen.draft,
                run: ++runCounter.current,
              })
            }
          />
        );
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec biome check --write apps/desktop/src && pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS. The earlier retry test ("shows the error, a hint, and retries with the same choices", 403 error) now sees an extra "Update yt-dlp and retry" row; it still presses Enter on the first row, "Try again".

- [ ] **Step 5: Phase C check**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green. Fix anything Biome reports without ignore comments.

- [ ] **Step 6: Commit message**

Output for the user:
```text
✨ desktop: offer "Update yt-dlp and retry" after a stale-extractor failure

Test: pnpm exec vitest run apps/desktop
```

---

## Phase D: Build, release pipeline, installers and docs

Do not start this phase until `docs/superpowers/spike-pkg-sea.md` records a passing decision (Task 1). Tasks 19 to 22 read the packaging mode from `tools/release/targets.mjs`, so a fallback to Node 24 Standard changes that one file.

### Task 19: Version injection, release targets, binary build and checksums

**Files:**
- Modify: `apps/desktop/src/version.ts`, `apps/desktop/build.mjs`, `package.json`
- Create: `tools/release/targets.mjs`, `tools/release/targets.test.mjs`
- Create: `tools/release/build-binaries.mjs`
- Create: `tools/release/checksums.mjs`, `tools/release/checksums.test.mjs`

**Interfaces:**
- Produces:
  - `VERSION` in `apps/desktop/src/version.ts` is the build-time `__MEDIAFORGE_VERSION__` (set from the git tag) and falls back to `"0.1.0"` in dev and tests
  - `targets.mjs`: `PKG_NODE`, `PKG_MODE_ARGS`, `TARGETS: { key; file; runner }[]`, `pkgTarget(target)`, `pkgArgs(target, entry, outFile)`
  - `build-binaries.mjs [--out <dir>] [--target <key>]`: writes `<dir>/mediaforge-<os>-<arch>[.exe]`
  - `checksums.mjs`: `formatSha256Sums(entries)`, `sha256OfFile(path)`, `checksumDir(dir)`; CLI `node tools/release/checksums.mjs <dir> [--out <file>]`

- [ ] **Step 1: Write the failing tests**

Create `tools/release/targets.test.mjs`:
```js
import { describe, expect, it } from "vitest";
import { PKG_MODE_ARGS, PKG_NODE, pkgArgs, pkgTarget, TARGETS } from "./targets.mjs";

describe("TARGETS", () => {
  it("lists the five supported targets with unique keys and files", () => {
    expect(TARGETS.map((t) => t.key)).toEqual([
      "win-x64",
      "linux-x64",
      "linux-arm64",
      "macos-x64",
      "macos-arm64",
    ]);
    expect(new Set(TARGETS.map((t) => t.file)).size).toBe(5);
  });

  it("names the files the installers look for", () => {
    for (const target of TARGETS) {
      expect(target.file).toBe(`mediaforge-${target.key}${target.key.startsWith("win") ? ".exe" : ""}`);
    }
  });
});

describe("pkgArgs", () => {
  it("combines the entry, the packaging mode, the target and the output", () => {
    const target = TARGETS[0];
    expect(pkgTarget(target)).toBe(`${PKG_NODE}-win-x64`);
    expect(pkgArgs(target, "dist/main.js", "out/x.exe")).toEqual([
      "dist/main.js",
      ...PKG_MODE_ARGS,
      "--targets",
      `${PKG_NODE}-win-x64`,
      "--output",
      "out/x.exe",
    ]);
  });
});
```

Create `tools/release/checksums.test.mjs`:
```js
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checksumDir, formatSha256Sums, sha256OfFile } from "./checksums.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mf-sums-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("formatSha256Sums", () => {
  it("writes '<hash>  <name>' lines sorted by name", () => {
    expect(
      formatSha256Sums([
        { name: "b", sha256: "2" },
        { name: "a", sha256: "1" },
      ]),
    ).toBe("1  a\n2  b\n");
  });
});

describe("checksumDir", () => {
  it("hashes every file except an existing SHA256SUMS", async () => {
    await writeFile(join(dir, "mediaforge-linux-x64"), "AAA");
    await writeFile(join(dir, "install.sh"), "BBB");
    await writeFile(join(dir, "SHA256SUMS"), "old");
    expect(await sha256OfFile(join(dir, "install.sh"))).toBe(sha("BBB"));
    expect(await checksumDir(dir)).toBe(
      `${sha("BBB")}  install.sh\n${sha("AAA")}  mediaforge-linux-x64\n`,
    );
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm exec vitest run tools/release/targets.test.mjs tools/release/checksums.test.mjs`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

Create `tools/release/targets.mjs`:
```js
// The release targets, shared by the build, the smoke tests and the publish step.
//
// Packaging mode: docs/superpowers/spike-pkg-sea.md records which mode passed. If it chose Node 24
// in Standard mode, set PKG_NODE to "node24" and PKG_MODE_ARGS to [] here and nowhere else.
export const PKG_NODE = "node22";
export const PKG_MODE_ARGS = ["--sea"];

/**
 * key: pkg's platform-arch name, also the suffix of the release file.
 * file: the release asset name the installers download.
 * runner: the GitHub runner that smoke-tests it natively. Keep in sync with release.yml
 * (workflows.test.mjs checks this).
 */
export const TARGETS = [
  { key: "win-x64", file: "mediaforge-win-x64.exe", runner: "windows-latest" },
  { key: "linux-x64", file: "mediaforge-linux-x64", runner: "ubuntu-24.04" },
  { key: "linux-arm64", file: "mediaforge-linux-arm64", runner: "ubuntu-24.04-arm" },
  { key: "macos-x64", file: "mediaforge-macos-x64", runner: "macos-15-intel" },
  { key: "macos-arm64", file: "mediaforge-macos-arm64", runner: "macos-15" },
];

export const pkgTarget = (target) => `${PKG_NODE}-${target.key}`;

export const pkgArgs = (target, entry, outFile) => [
  entry,
  ...PKG_MODE_ARGS,
  "--targets",
  pkgTarget(target),
  "--output",
  outFile,
];
```

Create `tools/release/build-binaries.mjs`:
```js
#!/usr/bin/env node
// Build the release binaries from apps/desktop/dist/main.js with pkg.
// Run `pnpm --filter @mediaforge/desktop build` first (set MEDIAFORGE_VERSION to stamp the version).
//
//   node tools/release/build-binaries.mjs [--out out/release] [--target linux-x64]
//
// pkg's "enhanced SEA" mode (the only one that runs this ESM bundle, which uses top-level await)
// is selected by giving pkg a package.json instead of a .js file. So the bundle is staged next to
// a minimal package.json and that package.json is the entry. See docs/superpowers/spike-pkg-sea.md.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pkgArgs, TARGETS } from "./targets.mjs";

/** Copy the bundle and a package.json into `dir`; returns the package.json path to give pkg. */
function stage(dir) {
  mkdirSync(dir, { recursive: true });
  copyFileSync("apps/desktop/dist/main.js", join(dir, "main.js"));
  const manifest = join(dir, "package.json");
  writeFileSync(
    manifest,
    `${JSON.stringify({ name: "mediaforge", version: "0.1.0", type: "module", bin: "main.js" }, null, 2)}\n`,
  );
  return manifest;
}

const { values } = parseArgs({
  options: { out: { type: "string", default: "out/release" }, target: { type: "string" } },
});

const selected = values.target ? TARGETS.filter((t) => t.key === values.target) : TARGETS;
if (selected.length === 0) {
  console.error(`Unknown target: ${values.target}. Choose from: ${TARGETS.map((t) => t.key).join(", ")}`);
  process.exit(2);
}

mkdirSync(values.out, { recursive: true });
const entry = stage(join("out", "stage"));
for (const target of selected) {
  console.error(`Building ${target.file}`);
  const result = spawnSync(
    "pnpm",
    ["exec", "pkg", ...pkgArgs(target, entry, join(values.out, target.file))],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
```

Create `tools/release/checksums.mjs`:
```js
#!/usr/bin/env node
// Write a SHA256SUMS file for every file in a folder.
//
//   node tools/release/checksums.mjs <dir> [--out <file>]     (default: <dir>/SHA256SUMS)
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** `<hash>  <name>` lines sorted by name, ending with a newline. */
export function formatSha256Sums(entries) {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, sha256 }) => `${sha256}  ${name}\n`)
    .join("");
}

export function sha256OfFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export async function checksumDir(dir, skip = ["SHA256SUMS"]) {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries.filter((e) => e.isFile() && !skip.includes(e.name)).map((e) => e.name);
  return formatSha256Sums(
    await Promise.all(names.map(async (name) => ({ name, sha256: await sha256OfFile(join(dir, name)) }))),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    options: { out: { type: "string" } },
    allowPositionals: true,
  });
  const dir = positionals[0];
  if (!dir) {
    console.error("Usage: checksums.mjs <dir> [--out <file>]");
    process.exit(2);
  }
  const text = await checksumDir(dir);
  await writeFile(values.out ?? join(dir, "SHA256SUMS"), text);
  process.stdout.write(text);
}
```

Replace `apps/desktop/src/version.ts` with:
```ts
/** Set by the build (`MEDIAFORGE_VERSION`, taken from the release tag). Absent in dev and tests. */
declare const __MEDIAFORGE_VERSION__: string | undefined;

export const VERSION: string =
  typeof __MEDIAFORGE_VERSION__ === "string" ? __MEDIAFORGE_VERSION__ : "0.1.0";
```

In `apps/desktop/build.mjs` add near the top, after the import:
```js
// The release workflow sets MEDIAFORGE_VERSION from the git tag, so the binary reports its release.
const version = process.env.MEDIAFORGE_VERSION;
```
and extend `define` to:
```js
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.DEV": '"false"',
    ...(version && { __MEDIAFORGE_VERSION__: JSON.stringify(version) }),
  },
```
The spike (`docs/superpowers/spike-pkg-sea.md`) found that `build.mjs` keeps `format: "esm"` and the `createRequire` banner unchanged (a CJS bundle is impossible because Ink and `main.ts` use top-level await); only the staging step in `build-binaries.mjs` above is new. Read the spike document for anything its later sections add.

Fix the last `promisify(execFile)` in the product code, which breaks inside the packaged binary (see Task 5). In `apps/desktop/src/interactive/clipboard.ts` delete the imports of `execFile` and `promisify` and the line `const execFileAsync = promisify(execFile);`, import `execFileText` from `@mediaforge/binary-resolver`, and replace `defaultRun` with:
```ts
const defaultRun: RunCommand = (command, args) =>
  execFileText(command, args, { timeoutMs: 4000, maxBuffer: 1 << 20 });
```
Then run `grep -rn "promisify" packages apps --include=*.ts --include=*.tsx` and confirm no `promisify(execFile)` is left in source (other uses of `promisify` are fine).

In the root `package.json` `scripts` add `"release:build": "node tools/release/build-binaries.mjs"` and `"release:checksums": "node tools/release/checksums.mjs"`.

- [ ] **Step 4: Run the tests, then build one binary**

Run:
```bash
pnpm exec biome check --write tools apps/desktop package.json
pnpm exec vitest run tools/release apps/desktop && pnpm typecheck
MEDIAFORGE_VERSION=0.1.0-local pnpm --filter @mediaforge/desktop build
pnpm release:build -- --target win-x64 --out out/release
./out/release/mediaforge-win-x64.exe --version
```
Expected: tests PASS; the binary prints `0.1.0-local`. (On Linux or macOS use that platform's target.)

- [ ] **Step 5: Commit message**

Output for the user:
```text
📦️ desktop: stamp the release version and build binaries for all targets

Test: pnpm exec vitest run tools/release apps/desktop
```

### Task 20: Smoke server and smoke script

**Files:**
- Create: `tools/release/smoke-server.mjs`, `tools/release/smoke-server.test.mjs`
- Create: `tools/release/smoke.sh`

**Interfaces:**
- Consumes: `TARGETS` (Task 19), `resolveYtDlpSource`, `installTool`, `defaultInstallDeps`, `resolveTarget` from `packages/binary-resolver/src/index.ts`.
- Produces: `createSmokeServer(): http.Server`, `FAKE_TAG`; `smoke.sh <binary> [expected-version]`.

`smoke-server.mjs` is a tiny local stand-in for GitHub: `/repo/...` looks like a yt-dlp nightly repository, `/release/...` is a fake MediaForge release (`SHA256SUMS` plus the five binaries), `/corrupt/...` is the same release with binaries that do not match `SHA256SUMS`. The smoke script and the installer tests (Tasks 23 and 24) use it, so the real upstream is never contacted (spec section 3, step 3).

- [ ] **Step 1: Write the failing test**

Create `tools/release/smoke-server.test.mjs`:
```js
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultInstallDeps,
  installTool,
  resolveTarget,
  resolveYtDlpSource,
} from "../../packages/binary-resolver/src/index.ts";
import { createSmokeServer, FAKE_TAG } from "./smoke-server.mjs";
import { TARGETS } from "./targets.mjs";

const sha = (data) => createHash("sha256").update(data).digest("hex");
let server;
let base;

beforeAll(async () => {
  server = createSmokeServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("fake yt-dlp repository", () => {
  it.each([
    ["win32", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "arm64"],
  ])("is understood by the real client for %s %s", async (platform, arch) => {
    const source = await resolveYtDlpSource(resolveTarget(platform, arch), fetch, `${base}/repo`);
    expect(source.version).toBe(FAKE_TAG);
    expect(source.url.startsWith(`${base}/repo/releases/download/${FAKE_TAG}/`)).toBe(true);
  });

  it("can be installed from by the real installer, into a folder with spaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mf smoke "));
    try {
      const result = await installTool(
        { tool: "yt-dlp", target: resolveTarget(), dir },
        { ...defaultInstallDeps(), ytDlpRepoUrl: `${base}/repo` },
      );
      expect(result.version).toBe(FAKE_TAG);
      expect(await readFile(result.path, "utf8")).toBe("not a real yt-dlp\n");
      expect(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"))["yt-dlp"].version).toBe(
        FAKE_TAG,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("fake MediaForge release", () => {
  it("serves SHA256SUMS that match every binary", async () => {
    const sums = await (await fetch(`${base}/release/SHA256SUMS`)).text();
    for (const target of TARGETS) {
      const body = Buffer.from(await (await fetch(`${base}/release/${target.file}`)).arrayBuffer());
      expect(sums).toContain(`${sha(body)}  ${target.file}`);
    }
  });

  it("serves binaries that do not match under /corrupt", async () => {
    const sums = await (await fetch(`${base}/corrupt/SHA256SUMS`)).text();
    const target = TARGETS[1];
    const body = Buffer.from(await (await fetch(`${base}/corrupt/${target.file}`)).arrayBuffer());
    expect(sums).not.toContain(sha(body));
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run tools/release/smoke-server.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the server**

Create `tools/release/smoke-server.mjs`:
```js
#!/usr/bin/env node
// A tiny local stand-in for GitHub, for the release smoke test and the installer tests.
//
//   node tools/release/smoke-server.mjs [port]      (default port 8765)
//
//   /repo/...      a yt-dlp nightly repository: the "latest" redirect, SHA2-256SUMS and assets
//   /release/...   a MediaForge release: SHA256SUMS and the five binaries
//   /corrupt/...   the same release, but the binaries do not match SHA256SUMS
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { TARGETS } from "./targets.mjs";

export const FAKE_TAG = "2099.01.01.000000";
const YTDLP_ASSETS = ["yt-dlp.exe", "yt-dlp_linux", "yt-dlp_linux_aarch64", "yt-dlp_macos"];
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const ytDlpBody = Buffer.from("not a real yt-dlp\n");
const releaseBody = (file) => Buffer.from(`fake mediaforge binary: ${file}\n`);
const corruptBody = Buffer.from("corrupt\n");

export function createSmokeServer() {
  const ytDlpSums = YTDLP_ASSETS.map((asset) => `${sha256(ytDlpBody)}  ${asset}\n`).join("");
  const releaseSums = TARGETS.map((t) => `${sha256(releaseBody(t.file))}  ${t.file}\n`).join("");
  const downloads = `/repo/releases/download/${FAKE_TAG}/`;

  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const send = (status, body, headers = {}) => {
      response.writeHead(status, headers);
      response.end(body);
    };

    if (path === "/repo/releases/latest") {
      return send(302, "", { location: `/repo/releases/tag/${FAKE_TAG}` });
    }
    if (path === `${downloads}SHA2-256SUMS`) return send(200, ytDlpSums);
    if (path.startsWith(downloads) && YTDLP_ASSETS.includes(path.slice(downloads.length))) {
      return send(200, ytDlpBody);
    }
    for (const base of ["/release/", "/corrupt/"]) {
      if (path === `${base}SHA256SUMS`) return send(200, releaseSums);
      const target = TARGETS.find((t) => path === `${base}${t.file}`);
      if (target) return send(200, base === "/release/" ? releaseBody(target.file) : corruptBody);
    }
    return send(404, "not found");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 8765);
  createSmokeServer().listen(port, "127.0.0.1", () => {
    console.error(`smoke server on http://127.0.0.1:${port}`);
  });
}
```

- [ ] **Step 4: Write the smoke script**

Create `tools/release/smoke.sh`:
```bash
#!/usr/bin/env bash
# Smoke-test a built mediaforge binary on the machine it was built for.
#
#   tools/release/smoke.sh <path-to-binary> [expected-version]
#
# Checks --version, --help and `doctor --json`, then runs `setup --yes --tools yt-dlp` against a
# local fake yt-dlp repository (never the real upstream) and checks the cache and its manifest.
set -euo pipefail

bin="$1"
expected="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
port=8765

# Node and the binary are native programs; on Windows Git Bash they need Windows-style paths.
native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

cache="$(mktemp -d)"
node "$(native "$here/smoke-server.mjs")" "$port" &
server=$!
trap 'kill "$server" 2>/dev/null || true; rm -rf "$cache"' EXIT

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$port/repo/releases/latest" -o /dev/null 2>/dev/null; then break; fi
  sleep 0.2
done

version="$("$bin" --version)"
echo "version: $version"
if [ -n "$expected" ] && [ "$version" != "$expected" ]; then
  echo "expected version $expected" >&2
  exit 1
fi

"$bin" --help >/dev/null

# doctor exits 0 when both tools are found and 3 when one is missing; both are fine here.
set +e
"$bin" doctor --json >"$cache/doctor.json"
code=$?
set -e
if [ "$code" -ne 0 ] && [ "$code" -ne 3 ]; then
  echo "doctor exited with $code" >&2
  exit 1
fi
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$(native "$cache/doctor.json")"

# Regression guard for "tools look not runnable inside the packaged binary" (pkg patches execFile,
# see Task 5): offer the binary itself as a fake yt-dlp and ffmpeg. It answers --version, so
# doctor must find both, in the bundled folder.
ext=""
case "$bin" in *.exe) ext=".exe" ;; esac
mkdir -p "$cache/fakebin" "$cache/empty"
cp "$bin" "$cache/fakebin/yt-dlp$ext"
cp "$bin" "$cache/fakebin/ffmpeg$ext"
MEDIAFORGE_BIN_DIR="$(native "$cache/fakebin")" PATH="$(native "$cache/empty")" \
  "$bin" doctor --json >"$cache/doctor-fake.json"
node -e '
const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const bad = report.tools.filter((t) => !t.found || t.source !== "bundled");
if (!report.ok || bad.length > 0) {
  console.error("doctor did not find the runnable fake tools:", JSON.stringify(report.tools));
  process.exit(1);
}
' "$(native "$cache/doctor-fake.json")"

# Setup against the fake repository, with an empty PATH so a yt-dlp on this machine cannot hide it.
mkdir -p "$cache/empty" "$cache/tools"
MEDIAFORGE_CACHE_DIR="$(native "$cache/tools")" \
  MEDIAFORGE_YTDLP_REPO_URL="http://127.0.0.1:$port/repo" \
  PATH="$(native "$cache/empty")" \
  "$bin" setup --yes --tools yt-dlp

node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1] + "/manifest.json", "utf8"));
if (manifest["yt-dlp"]?.version !== "2099.01.01.000000") {
  console.error("manifest does not record yt-dlp:", manifest);
  process.exit(1);
}
const names = fs.readdirSync(process.argv[1]).sort();
console.log("cache holds:", names.join(", "));
if (names.some((name) => name.startsWith("."))) {
  console.error("temp files were left behind");
  process.exit(1);
}
' "$(native "$cache/tools")"

echo "smoke OK"
```

- [ ] **Step 5: Run it**

Run:
```bash
pnpm exec biome check --write tools/release
pnpm exec vitest run tools/release
bash tools/release/smoke.sh ./out/release/mediaforge-win-x64.exe 0.1.0-local
```
Expected: tests PASS; the smoke script prints the version, `cache holds: manifest.json, yt-dlp.exe` and `smoke OK`. (Use the binary built in Task 19 for your OS. If `shellcheck` is installed, also run `shellcheck tools/release/smoke.sh`.)

- [ ] **Step 6: Commit message**

Output for the user:
```text
👷 desktop: add a local fake release server and a binary smoke test

Test: pnpm exec vitest run tools/release; bash tools/release/smoke.sh <binary>
```

### Task 21: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:** none. The `install-scripts-*` jobs call `tools/release/test-install.sh` and `test-install.ps1`, which Tasks 23 and 24 create; the jobs fail until then, so commit this workflow together with those tasks or accept a red run in between.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:
```yaml
name: CI

on:
  pull_request:
  push:
    branches: [master]

permissions:
  contents: read

jobs:
  check:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - run: npm install -g pnpm@11
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm lint

  install-scripts-unix:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, macos-15]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - name: shellcheck
        if: runner.os == 'Linux'
        run: shellcheck install/install.sh tools/release/smoke.sh tools/release/test-install.sh
      - name: install.sh against a local fake release
        run: bash tools/release/test-install.sh

  install-scripts-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - name: PSScriptAnalyzer
        shell: pwsh
        run: |
          Install-Module PSScriptAnalyzer -Force -Scope CurrentUser
          Invoke-ScriptAnalyzer -Path install/install.ps1 -Severity Error,Warning -ExcludeRule PSAvoidUsingWriteHost -EnableExit
      - name: install.ps1 against a local fake release
        shell: pwsh
        run: ./tools/release/test-install.ps1
```

- [ ] **Step 2: Check what can be checked locally**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: PASS (these are the commands the `check` job runs). The workflow itself runs for the first time on GitHub.

- [ ] **Step 3: Commit message**

Output for the user:
```text
👷 add CI workflow for typecheck, tests, lint and installer checks

Test: open a pull request and watch the CI workflow
```

### Task 22: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `tools/release/workflows.test.mjs`

**Interfaces:**
- Consumes: `TARGETS` (Task 19), `build-binaries.mjs`, `smoke.sh`, `checksums.mjs`, `install/install.sh`, `install/install.ps1`.
- Produces: on a pushed tag `v*`: a GitHub Release with the five binaries, `SHA256SUMS`, `install.sh` and `install.ps1`. Tags containing `-` (for example `v0.1.0-rc.1`) are published as pre-releases.

Pipeline (spec section 3): check (tag matches `apps/desktop` version, typecheck, tests, lint), build five binaries on one Linux runner, smoke-test each on its native runner (macOS binaries are ad-hoc codesigned first, on the macOS runner), then stamp the installers with the tag, write `SHA256SUMS` and publish. A last job runs the published installers on native runners. Release notes are GitHub's generated notes (plan decision for the spec's "changelog from commit titles": `gh release create --generate-notes`).

- [ ] **Step 1: Write the failing test**

Create `tools/release/workflows.test.mjs`:
```js
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TARGETS } from "./targets.mjs";

const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");

describe("release.yml", () => {
  it("smoke-tests every target on the runner targets.mjs names", () => {
    const rows = [...workflow.matchAll(/target: ([\w-]+), runner: ([\w.-]+), file: ([\w.-]+)/g)].map(
      (m) => ({ key: m[1], runner: m[2], file: m[3] }),
    );
    expect(rows).toEqual(TARGETS);
  });

  it("only runs for version tags", () => {
    expect(workflow).toMatch(/tags:\s*\n\s*- "v\*"/);
  });

  it("stamps both installers with the tag", () => {
    expect(workflow).toContain("install/install.sh");
    expect(workflow).toContain("install/install.ps1");
    expect(workflow).toContain("__RELEASE_TAG__");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run tools/release/workflows.test.mjs`
Expected: FAIL (the file does not exist).

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/release.yml`:
```yaml
name: Release

on:
  push:
    tags:
      - "v*"

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - run: npm install -g pnpm@11
      - run: pnpm install --frozen-lockfile
      - name: The tag matches the app version
        run: |
          tag="${GITHUB_REF_NAME#v}"
          base="${tag%%-*}"
          version="$(node -p "require('./apps/desktop/package.json').version")"
          if [ "$base" != "$version" ]; then
            echo "Tag $GITHUB_REF_NAME does not match the apps/desktop version $version" >&2
            exit 1
          fi
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm lint

  build:
    needs: check
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - run: npm install -g pnpm@11
      - run: pnpm install --frozen-lockfile
      - name: Bundle the app, stamped with the tag
        run: MEDIAFORGE_VERSION="${GITHUB_REF_NAME#v}" pnpm --filter @mediaforge/desktop build
      - name: Build the five binaries
        run: node tools/release/build-binaries.mjs --out out/release
      - uses: actions/upload-artifact@v4
        with:
          name: raw-binaries
          path: out/release
          if-no-files-found: error

  verify-binaries:
    needs: build
    strategy:
      fail-fast: true
      matrix:
        include:
          - { target: win-x64, runner: windows-latest, file: mediaforge-win-x64.exe }
          - { target: linux-x64, runner: ubuntu-24.04, file: mediaforge-linux-x64 }
          - { target: linux-arm64, runner: ubuntu-24.04-arm, file: mediaforge-linux-arm64 }
          - { target: macos-x64, runner: macos-15-intel, file: mediaforge-macos-x64 }
          - { target: macos-arm64, runner: macos-15, file: mediaforge-macos-arm64 }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - uses: actions/download-artifact@v4
        with:
          name: raw-binaries
          path: raw
      - name: Prepare the binary
        shell: bash
        run: |
          chmod +x "raw/${{ matrix.file }}"
          if [ "$RUNNER_OS" = "macOS" ]; then
            codesign --force --sign - "raw/${{ matrix.file }}"
          fi
      - name: Smoke test
        shell: bash
        run: bash tools/release/smoke.sh "raw/${{ matrix.file }}" "${GITHUB_REF_NAME#v}"
      - uses: actions/upload-artifact@v4
        with:
          name: final-${{ matrix.target }}
          path: raw/${{ matrix.file }}
          if-no-files-found: error

  publish:
    needs: verify-binaries
    runs-on: ubuntu-24.04
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - uses: actions/download-artifact@v4
        with:
          pattern: final-*
          merge-multiple: true
          path: release
      - name: Stamp the installers with this tag
        run: |
          sed "s/__RELEASE_TAG__/${GITHUB_REF_NAME}/g" install/install.sh > release/install.sh
          sed "s/__RELEASE_TAG__/${GITHUB_REF_NAME}/g" install/install.ps1 > release/install.ps1
      - name: Write SHA256SUMS
        run: node tools/release/checksums.mjs release --out release/SHA256SUMS
      - name: Create the release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          flags=""
          case "$GITHUB_REF_NAME" in *-*) flags="--prerelease" ;; esac
          gh release create "$GITHUB_REF_NAME" release/* --title "$GITHUB_REF_NAME" --generate-notes $flags

  verify-install:
    needs: publish
    strategy:
      fail-fast: false
      matrix:
        runner: [ubuntu-24.04, ubuntu-24.04-arm, macos-15-intel, macos-15]
    runs-on: ${{ matrix.runner }}
    steps:
      - name: Install from the published release
        shell: bash
        run: |
          curl -fsSL "https://github.com/${GITHUB_REPOSITORY}/releases/download/${GITHUB_REF_NAME}/install.sh" -o install.sh
          sh install.sh --skip-tools
          export PATH="$HOME/.local/bin:$PATH"
          test "$(mediaforge --version)" = "${GITHUB_REF_NAME#v}"
          mediaforge setup --yes --tools yt-dlp
          mediaforge doctor --json || test $? -eq 3

  verify-install-windows:
    needs: publish
    runs-on: windows-latest
    steps:
      - name: Install from the published release
        shell: pwsh
        run: |
          $url = "https://github.com/$env:GITHUB_REPOSITORY/releases/download/$env:GITHUB_REF_NAME/install.ps1"
          Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile install.ps1
          ./install.ps1 -SkipTools
          $exe = Join-Path $env:LOCALAPPDATA 'MediaForge\mediaforge.exe'
          $expected = $env:GITHUB_REF_NAME.Substring(1)
          $version = & $exe --version
          if ($version -ne $expected) { throw "Expected version $expected but got $version" }
          & $exe setup --yes --tools yt-dlp
          if ($LASTEXITCODE -ne 0) { throw "setup failed with exit code $LASTEXITCODE" }
```

- [ ] **Step 4: Run the test**

Run: `pnpm exec vitest run tools/release/workflows.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit message**

Output for the user:
```text
👷 add release workflow that builds, smoke-tests and publishes the binaries

Body: A v* tag builds five binaries on one Linux runner, smoke-tests each natively, ad-hoc signs macOS, writes SHA256SUMS and publishes a GitHub Release. Tags with a dash are pre-releases.
Test: push a tag such as v0.1.0-rc.1 (see docs/releasing.md)
```

### Task 23: `install.sh`

**Files:**
- Create: `install/install.sh`
- Create: `tools/release/test-install.sh`

**Interfaces:**
- Consumes: the release layout (`SHA256SUMS`, `mediaforge-<os>-<arch>`), `smoke-server.mjs` (`/release` and `/corrupt`).
- Produces: `install.sh [--skip-tools]`. Environment variables (also the test hooks): `MEDIAFORGE_RELEASE_TAG`, `MEDIAFORGE_RELEASE_BASE_URL`, `MEDIAFORGE_INSTALL_DIR`. The release workflow replaces the placeholder `__RELEASE_TAG__` with the tag, so `releases/download/vX.Y.Z/install.sh` installs exactly `vX.Y.Z`.

Behavior (spec section 3): detect OS and CPU, fetch `SHA256SUMS` and the matching binary, verify the hash, abort on mismatch, install to `~/.local/bin/mediaforge`, add that folder to PATH if missing, run `mediaforge setup --yes` unless `--skip-tools`. No sudo, nothing outside the home folder.

- [ ] **Step 1: Write the failing end-to-end test**

Create `tools/release/test-install.sh`:
```bash
#!/usr/bin/env bash
# End-to-end test of install/install.sh against a local fake release.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d)"
port=8766

node "$here/smoke-server.mjs" "$port" &
server=$!
trap 'kill "$server" 2>/dev/null || true; rm -rf "$tmp"' EXIT

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$port/release/SHA256SUMS" -o /dev/null 2>/dev/null; then break; fi
  sleep 0.2
done

export HOME="$tmp/home"
mkdir -p "$HOME"
export SHELL=/bin/bash
export MEDIAFORGE_RELEASE_TAG=v9.9.9
export MEDIAFORGE_INSTALL_DIR="$tmp/bin dir"
export MEDIAFORGE_RELEASE_BASE_URL="http://127.0.0.1:$port/release"

profile="$HOME/.bashrc"
if [ "$(uname -s)" = "Darwin" ]; then profile="$HOME/.bash_profile"; fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

sh "$root/install/install.sh" --skip-tools
[ -x "$tmp/bin dir/mediaforge" ] || fail "the binary was not installed"
grep -q "fake mediaforge binary" "$tmp/bin dir/mediaforge" || fail "wrong binary content"
grep -qF "$tmp/bin dir" "$profile" || fail "PATH was not updated"

# A second run replaces the binary and does not add the PATH line twice.
sh "$root/install/install.sh" --skip-tools
[ "$(grep -cF "$tmp/bin dir" "$profile")" = "1" ] || fail "the PATH line was added twice"

# A download that does not match SHA256SUMS is refused and the installed binary is left alone.
before="$(cat "$tmp/bin dir/mediaforge")"
if MEDIAFORGE_RELEASE_BASE_URL="http://127.0.0.1:$port/corrupt" \
  sh "$root/install/install.sh" --skip-tools 2>"$tmp/err"; then
  fail "a corrupt download was accepted"
fi
grep -q "checksum mismatch" "$tmp/err" || fail "no checksum message: $(cat "$tmp/err")"
[ "$(cat "$tmp/bin dir/mediaforge")" = "$before" ] || fail "the installed binary changed"

# An unknown option is rejected, and so is a copy that is not tied to a release.
if sh "$root/install/install.sh" --nope 2>/dev/null; then fail "an unknown option was accepted"; fi
if env -u MEDIAFORGE_RELEASE_TAG sh "$root/install/install.sh" --skip-tools 2>"$tmp/err"; then
  fail "an unstamped installer ran"
fi
grep -q "not tied to a release" "$tmp/err" || fail "no unstamped message"

echo "install.sh OK"
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bash tools/release/test-install.sh`
Expected: FAIL (`install/install.sh` does not exist).

- [ ] **Step 3: Write the installer**

Create `install/install.sh`:
```sh
#!/bin/sh
# MediaForge installer for Linux and macOS.
#
#   curl -fsSL https://github.com/N-Berns/mediaforge/releases/latest/download/install.sh | sh
#   curl -fsSL https://github.com/N-Berns/mediaforge/releases/latest/download/install.sh | sh -s -- --skip-tools
#
# It downloads the mediaforge binary for this computer from the GitHub release this script
# belongs to, checks its SHA-256 against the release's SHA256SUMS, puts it in ~/.local/bin (adding
# that folder to your PATH if needed) and, unless you pass --skip-tools, runs
# `mediaforge setup --yes` to download yt-dlp and ffmpeg.
# It never uses sudo and writes nothing outside your home folder. It is short; read it first if
# you like.
set -eu

REPO="N-Berns/mediaforge"
# The release workflow replaces the placeholder with the release tag when it publishes this file.
TAG="${MEDIAFORGE_RELEASE_TAG:-__RELEASE_TAG__}"
INSTALL_DIR="${MEDIAFORGE_INSTALL_DIR:-$HOME/.local/bin}"
SKIP_TOOLS=0

say() { printf '%s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --skip-tools) SKIP_TOOLS=1 ;;
    -h | --help)
      say "Usage: install.sh [--skip-tools]"
      exit 0
      ;;
    *) fail "unknown option: $arg" ;;
  esac
done

case "$TAG" in
  __RELEASE*) fail "this copy of install.sh is not tied to a release. Download it from https://github.com/$REPO/releases" ;;
esac
BASE_URL="${MEDIAFORGE_RELEASE_BASE_URL:-https://github.com/$REPO/releases/download/$TAG}"

command -v curl >/dev/null 2>&1 || fail "curl is required"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) fail "unsupported operating system: $os (supported: Linux, macOS)" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported CPU: $arch (supported: x86_64, arm64)" ;;
esac
asset="mediaforge-$os-$arch"

if command -v sha256sum >/dev/null 2>&1; then
  hash_of() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  hash_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is required to verify the download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "Downloading $asset ($TAG)..."
curl -fsSL "$BASE_URL/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "could not download $BASE_URL/SHA256SUMS"
curl -fsSL "$BASE_URL/$asset" -o "$tmp/$asset" || fail "could not download $BASE_URL/$asset"

expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
actual="$(hash_of "$tmp/$asset")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed."

# Copy next to the final name and rename, so an interrupted install never leaves a half-written binary.
mkdir -p "$INSTALL_DIR"
cp "$tmp/$asset" "$INSTALL_DIR/.mediaforge.new"
chmod 755 "$INSTALL_DIR/.mediaforge.new"
mv -f "$INSTALL_DIR/.mediaforge.new" "$INSTALL_DIR/mediaforge"
say "Installed $INSTALL_DIR/mediaforge"

profile_file() {
  case "${SHELL:-}" in
    */zsh) printf '%s' "$HOME/.zshrc" ;;
    */bash)
      if [ "$os" = "macos" ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi
      ;;
    *) printf '%s' "$HOME/.profile" ;;
  esac
}

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    profile="$(profile_file)"
    if [ -f "$profile" ] && grep -qF "$INSTALL_DIR" "$profile"; then
      :
    else
      printf '\n# Added by the MediaForge installer\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >>"$profile"
      say "Added $INSTALL_DIR to your PATH in $profile. Open a new terminal to use it."
    fi
    ;;
esac

if [ "$SKIP_TOOLS" -eq 0 ]; then
  say "Setting up yt-dlp and ffmpeg..."
  "$INSTALL_DIR/mediaforge" setup --yes || say "Tool setup did not finish. Run 'mediaforge setup' when you are online."
fi

say "MediaForge $TAG is ready. Run: mediaforge"
```

- [ ] **Step 4: Run the test, and shellcheck if available**

Run:
```bash
bash tools/release/test-install.sh
shellcheck install/install.sh tools/release/smoke.sh tools/release/test-install.sh
```
Expected: `install.sh OK`; shellcheck prints nothing. (CI runs both; if `shellcheck` is not installed locally, skip it.)

- [ ] **Step 5: Commit message**

Output for the user:
```text
✨ add install.sh for Linux and macOS

Body: Detects OS and CPU, verifies the binary against SHA256SUMS, installs to ~/.local/bin, adds it to PATH and runs setup unless --skip-tools. No sudo.
Test: bash tools/release/test-install.sh
```

### Task 24: `install.ps1`

**Files:**
- Create: `install/install.ps1`
- Create: `tools/release/test-install.ps1`

**Interfaces:**
- Consumes: same release layout and test server as Task 23.
- Produces: `install.ps1 [-SkipTools]`; the same three environment hooks as `install.sh`. Windows on ARM installs the x64 binary (it runs under emulation).

- [ ] **Step 1: Write the failing end-to-end test**

Create `tools/release/test-install.ps1`:
```powershell
# End-to-end test of install/install.ps1 against a local fake release (run on Windows).
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$port = 8767
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("mf-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

function Assert-That($condition, $message) {
    if (-not $condition) { throw "FAIL: $message" }
}

$server = Start-Process node -ArgumentList @((Join-Path $here 'smoke-server.mjs'), $port) -PassThru -WindowStyle Hidden
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
try {
    for ($i = 0; $i -lt 50; $i++) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/release/SHA256SUMS" | Out-Null
            break
        } catch { Start-Sleep -Milliseconds 200 }
    }

    $installDir = Join-Path $tmp 'Media Forge'
    $exe = Join-Path $installDir 'mediaforge.exe'
    $env:MEDIAFORGE_RELEASE_TAG = 'v9.9.9'
    $env:MEDIAFORGE_INSTALL_DIR = $installDir
    $env:MEDIAFORGE_RELEASE_BASE_URL = "http://127.0.0.1:$port/release"
    $installer = Join-Path $root 'install\install.ps1'

    & $installer -SkipTools
    Assert-That (Test-Path $exe) 'the binary was not installed'
    Assert-That ((Get-Content -Raw $exe) -match 'fake mediaforge binary') 'wrong binary content'
    $entries = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';'
    Assert-That ($entries -contains $installDir) 'the user PATH was not updated'

    # A second run replaces the binary and does not add the PATH entry twice.
    & $installer -SkipTools
    $entries = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';'
    Assert-That (@($entries | Where-Object { $_ -eq $installDir }).Count -eq 1) 'the PATH entry was added twice'

    # A download that does not match SHA256SUMS is refused and the installed binary is left alone.
    $before = Get-Content -Raw $exe
    $env:MEDIAFORGE_RELEASE_BASE_URL = "http://127.0.0.1:$port/corrupt"
    $refused = $false
    try { & $installer -SkipTools } catch { $refused = $_.Exception.Message -match 'Checksum mismatch' }
    Assert-That $refused 'a corrupt download was not refused with a checksum message'
    Assert-That ((Get-Content -Raw $exe) -eq $before) 'the installed binary changed'

    # A binary that is in use cannot be replaced; the message says so and the old file stays.
    $env:MEDIAFORGE_RELEASE_BASE_URL = "http://127.0.0.1:$port/release"
    $lock = [IO.File]::Open($exe, 'Open', 'Read', 'None')
    try {
        $message = ''
        try { & $installer -SkipTools } catch { $message = $_.Exception.Message }
        Assert-That ($message -match 'Could not replace') 'no message for a binary in use'
    } finally { $lock.Dispose() }

    Write-Output 'install.ps1 OK'
} finally {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    [Environment]::SetEnvironmentVariable('Path', $userPath, 'User')
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run (PowerShell): `./tools/release/test-install.ps1`
Expected: FAIL (`install\install.ps1` does not exist).

- [ ] **Step 3: Write the installer**

Create `install/install.ps1`:
```powershell
<#
.SYNOPSIS
Installs MediaForge for the current user (Windows).

.DESCRIPTION
Downloads mediaforge.exe from the GitHub release this script belongs to, checks its SHA-256
against the release's SHA256SUMS, puts it in %LOCALAPPDATA%\MediaForge (adding that folder to your
user PATH) and, unless -SkipTools is given, runs `mediaforge setup --yes` to download yt-dlp and
ffmpeg. No administrator rights are needed and nothing outside your user profile is changed.
It is short; read it first if you like.

.PARAMETER SkipTools
Do not download yt-dlp and ffmpeg now. Run `mediaforge setup` later.

.EXAMPLE
irm https://github.com/N-Berns/mediaforge/releases/latest/download/install.ps1 | iex

.EXAMPLE
& ([scriptblock]::Create((irm https://github.com/N-Berns/mediaforge/releases/latest/download/install.ps1))) -SkipTools
#>
[CmdletBinding()]
param(
    [switch]$SkipTools
)

$ErrorActionPreference = 'Stop'
# The progress bar makes Invoke-WebRequest very slow on Windows PowerShell 5.1.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'N-Berns/mediaforge'
# The release workflow replaces the placeholder with the release tag when it publishes this file.
$Tag = if ($env:MEDIAFORGE_RELEASE_TAG) { $env:MEDIAFORGE_RELEASE_TAG } else { '__RELEASE_TAG__' }
if ($Tag -like '__RELEASE*') {
    throw "This copy of install.ps1 is not tied to a release. Download it from https://github.com/$Repo/releases"
}
$BaseUrl = if ($env:MEDIAFORGE_RELEASE_BASE_URL) { $env:MEDIAFORGE_RELEASE_BASE_URL } else { "https://github.com/$Repo/releases/download/$Tag" }
$InstallDir = if ($env:MEDIAFORGE_INSTALL_DIR) { $env:MEDIAFORGE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'MediaForge' }
$Asset = 'mediaforge-win-x64.exe'

# Windows on ARM runs the x64 build under emulation.
$cpu = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($cpu -ne 'X64' -and $cpu -ne 'Arm64') {
    throw "Unsupported CPU: $cpu (supported: x64, and ARM64 through emulation)"
}

$Temp = Join-Path ([IO.Path]::GetTempPath()) ('mediaforge-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
    Write-Host "Downloading $Asset ($Tag)..."
    $sumsFile = Join-Path $Temp 'SHA256SUMS'
    $downloaded = Join-Path $Temp $Asset
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHA256SUMS" -OutFile $sumsFile
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$Asset" -OutFile $downloaded

    $expected = $null
    foreach ($line in (Get-Content -LiteralPath $sumsFile)) {
        $parts = $line.Trim() -split '\s+', 2
        if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $Asset) { $expected = $parts[0].ToLowerInvariant() }
    }
    if (-not $expected) { throw "SHA256SUMS has no entry for $Asset." }
    $actual = (Get-FileHash -LiteralPath $downloaded -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "Checksum mismatch for $Asset (expected $expected, got $actual). Nothing was installed."
    }

    # Copy next to the final name and rename, so an interrupted install never leaves a half-written file.
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $staged = Join-Path $InstallDir 'mediaforge.exe.new'
    $target = Join-Path $InstallDir 'mediaforge.exe'
    Copy-Item -LiteralPath $downloaded -Destination $staged -Force
    try {
        Move-Item -LiteralPath $staged -Destination $target -Force
    } catch {
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
        throw "Could not replace $target. Close any running MediaForge window and try again. ($($_.Exception.Message))"
    }
    Write-Host "Installed $target"
} finally {
    Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @()
if ($userPath) { $entries = @($userPath -split ';' | Where-Object { $_ }) }
if ($entries -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $InstallDir) -join ';'), 'User')
    $env:Path = "$env:Path;$InstallDir"
    Write-Host "Added $InstallDir to your user PATH. Open a new terminal to use it everywhere."
}

if (-not $SkipTools) {
    Write-Host 'Setting up yt-dlp and ffmpeg...'
    & (Join-Path $InstallDir 'mediaforge.exe') setup --yes
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Tool setup did not finish. Run 'mediaforge setup' when you are online."
    }
}

Write-Host "MediaForge $Tag is ready. Run: mediaforge"
```

- [ ] **Step 4: Run the test**

Run (PowerShell): `./tools/release/test-install.ps1`
Expected: `install.ps1 OK`. If PSScriptAnalyzer is installed, also run:
```powershell
Invoke-ScriptAnalyzer -Path install/install.ps1 -Severity Error,Warning -ExcludeRule PSAvoidUsingWriteHost
```
Expected: no output.

- [ ] **Step 5: Commit message**

Output for the user:
```text
✨ add install.ps1 for Windows

Body: Verifies mediaforge.exe against SHA256SUMS, installs to %LOCALAPPDATA%\MediaForge, adds it to the user PATH and runs setup unless -SkipTools. Needs no administrator rights.
Test: ./tools/release/test-install.ps1
```

### Task 25: License, documentation and cleanup

**Files:**
- Create: `LICENSE`, `docs/releasing.md`
- Modify: `README.md`, `docs/desktop-cli-checklist.md`
- Delete: `apps/desktop/spike/`, `.github/workflows/spike-pkg.yml`

**Interfaces:** none.

- [ ] **Step 1: MIT license**

Create `LICENSE`:
```text
MIT License

Copyright (c) 2026 N-Berns

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: README**

Edit `README.md`:

1. Replace the `> **Status:**` paragraph with:
```markdown
> **Status:** early release (v0.1.0). The desktop CLI is available as a download for Windows, Linux and macOS. The browser extension, the native messaging host and the Android app are planned and not yet built. `apps/chrome`, `apps/edge`, `apps/firefox` and `apps/android` are empty placeholders.
```
2. Insert this section before `## Requirements` (and rename that heading to `## Requirements (development)`). The block uses four backticks because it contains fenced examples itself:
````markdown
## Install

Windows (PowerShell):

```powershell
irm https://github.com/N-Berns/mediaforge/releases/latest/download/install.ps1 | iex
```

Linux and macOS:

```sh
curl -fsSL https://github.com/N-Berns/mediaforge/releases/latest/download/install.sh | sh
```

The installer downloads one `mediaforge` program, checks it against the release's `SHA256SUMS`, puts it in `%LOCALAPPDATA%\MediaForge` (Windows) or `~/.local/bin` (Linux, macOS), adds that folder to your PATH, and then runs `mediaforge setup --yes` to download yt-dlp and ffmpeg. It needs no administrator rights and uses no `sudo`.

**These one-line commands run a script from this repository on your computer with your own permissions.** If you prefer to read it first, save it and run it yourself:

```sh
curl -fsSL https://github.com/N-Berns/mediaforge/releases/latest/download/install.sh -o install.sh
less install.sh
sh install.sh
```

```powershell
Invoke-WebRequest https://github.com/N-Berns/mediaforge/releases/latest/download/install.ps1 -OutFile install.ps1
Get-Content install.ps1
./install.ps1
```

- Skip the tool download with `--skip-tools` (`sh -s -- --skip-tools` when piping) or `-SkipTools` (`& ([scriptblock]::Create((irm <url>))) -SkipTools`).
- Pin a version by replacing `latest/download` with `download/vX.Y.Z` in the URL.
- Supported: Windows x64 (Windows on ARM runs it through emulation), Linux x64 and arm64, macOS x64 and arm64.
- **Windows:** the program is not code-signed yet, so Windows SmartScreen or Defender may warn about it. This is expected for early releases.
- **macOS:** the program is ad-hoc signed, not notarized. If you download the binary with a browser instead of the installer and macOS refuses to open it, run `xattr -d com.apple.quarantine ./mediaforge-macos-*`.
- **ffmpeg licence:** on Windows and Linux MediaForge downloads an LGPL build of ffmpeg. On macOS it downloads Martin Riedl's release build (a GPL build) from his server; MediaForge does not redistribute it. `tools.lock.json` records the version, source, SHA-256 and licence of every build.
- **Remove it:** delete the program, MediaForge's tool folder (`%LOCALAPPDATA%\MediaForge\bin`, `~/.local/share/mediaforge`, or `~/Library/Application Support/MediaForge`), its settings file, and the PATH line the installer added.
````
3. In the commands table of the `## Desktop CLI` section add two rows after `formats`:
```markdown
| `setup`    | Download yt-dlp and ffmpeg when they are missing. Options: `-y/--yes`, `--tools yt-dlp,ffmpeg`.   |
| `update`   | Download the latest yt-dlp nightly into MediaForge's tool folder. Never changes ffmpeg.             |
```
and change the `doctor` row to: `Check that yt-dlp and ffmpeg are found, and whether a JavaScript runtime is available. \`--json\` for scripts.`
4. Replace the `### yt-dlp and ffmpeg` section's numbered list with:
```markdown
1. `MEDIAFORGE_YTDLP_PATH` / `MEDIAFORGE_FFMPEG_PATH` (full path to the executable).
2. `PATH` (ffmpeg 5.0 or newer).
3. The bundled directory: `MEDIAFORGE_BIN_DIR`, else `bin/` next to the executable, else the repo-root `bin/` when run through Node.
4. MediaForge's tool folder, filled by `mediaforge setup`. Override its location with `MEDIAFORGE_CACHE_DIR`.

If a tool is missing, the interactive menu and `download` / `formats` in a terminal offer to download it. Without a terminal they exit with code 3 and print `run: mediaforge setup`. Nothing downloads without a yes. `mediaforge update` fetches the latest yt-dlp nightly; if a `yt-dlp` on your PATH comes first, it says so.

**YouTube** needs a JavaScript runtime for all formats: install [Deno](https://deno.com) or Node.js 20 or newer. `doctor` shows whether one was found.
```
5. In `## Tooling` add the bullet: `- **@yao-pkg/pkg** builds the single-file binaries; **GitHub Actions** builds, tests and publishes them (see [docs/releasing.md](docs/releasing.md)).`
6. Add `- Release process: [docs/releasing.md](docs/releasing.md).` to `## Contributing`.

- [ ] **Step 3: Release runbook**

Create `docs/releasing.md`:
```markdown
# Releasing the desktop CLI

A release is a git tag. Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`, which builds five binaries, smoke-tests each on its own OS, and publishes a GitHub Release with `SHA256SUMS`, `install.sh` and `install.ps1`.

## Before tagging

1. Set the version in `apps/desktop/package.json` and the fallback in `apps/desktop/src/version.ts` to `X.Y.Z`. The workflow fails if the tag (without a `-suffix`) differs from the package version.
2. `pnpm typecheck && pnpm test && pnpm lint` are green on `master`.
3. If you want newer ffmpeg builds, run `pnpm pin:ffmpeg`, review the diff of `packages/binary-resolver/src/tools.lock.json` (URLs, licences), and commit it.
4. Run the manual checks below on your own machine with a locally built binary.

## Rehearse with a pre-release

Push `vX.Y.Z-rc.1`. A tag with a dash is published as a pre-release. Watch every job. If `verify-install` fails, fix the cause, delete the pre-release and its tag on GitHub, and push `-rc.2`.

## Release

Push `vX.Y.Z`. Check the Releases page: five binaries, `SHA256SUMS`, `install.sh`, `install.ps1` and generated notes. The `verify-install` jobs run the published installers on Linux, macOS and Windows.

## Manual checks (not automated)

- YouTube without a JavaScript runtime: with no Deno, Node or Bun on PATH, download a YouTube link. It should work with fewer formats and the failure text should mention a JavaScript runtime if it fails.
- YouTube with a runtime: install Deno or Node 20+, repeat. All formats should appear.
- Interactive menu in a real terminal on each OS: render, arrow keys, a short download.
- Windows: download the `.exe` in a browser and check what SmartScreen says; note it in the release notes if it blocks.
- macOS: run the installer on Apple Silicon without Homebrew and check `mediaforge setup` downloads ffmpeg.

## Known limits

- Windows is unsigned and macOS is ad-hoc signed. Windows code signing and Apple Developer ID plus notarization are planned before v1.0.
- yt-dlp updates are manual (`mediaforge update`). There are no background checks.
- The macOS ffmpeg comes from one third-party server. If it disappears, switch to Homebrew only or a self-built LGPL ffmpeg and update `tools.lock.json`.
```

- [ ] **Step 4: Checklist**

In `docs/desktop-cli-checklist.md`, section "2. Binary setup", replace the four unchecked lines (release script, ffmpeg LGPL, self-update, per-platform artifacts) with:
```markdown
- [x] Tools are downloaded on demand from upstream with SHA-256 verification into a per-user cache (`mediaforge setup`, `mediaforge update`); not bundled in the release
- [x] ffmpeg: LGPL build pinned for Windows and Linux; macOS uses a pinned GPL build downloaded from its upstream host (see `tools.lock.json` and the README)
- [x] Self-update of yt-dlp into the user data dir (`mediaforge update`, nightly channel)
- [x] Per-platform release artifacts: win-x64, linux-x64, linux-arm64, macos-x64, macos-arm64
```
and in "6. Release" tick the three items, rewriting the first as `- [x] Single-file binary per platform, installers (install.sh, install.ps1) and SHA256SUMS`, `- [x] Versioning from the git tag; release notes are GitHub's generated notes`, `- [x] README section for desktop CLI usage`. Add under it:
```markdown
- [ ] Windows code signing and macOS Developer ID plus notarization (before v1.0)
- [ ] Manage a Deno download so YouTube works without a separate JavaScript runtime
- [ ] winget, Scoop and Homebrew packages
```

- [ ] **Step 5: Remove the spike**

Run:
```bash
rm -rf apps/desktop/spike
rm -f .github/workflows/spike-pkg.yml
```
Keep `docs/superpowers/spike-pkg-sea.md`.

- [ ] **Step 6: Final checks**

Run:
```bash
pnpm exec biome check --write .
pnpm typecheck && pnpm test && pnpm lint
bash tools/release/test-install.sh
```
Expected: all green. Fix every Biome finding without ignore comments.

- [ ] **Step 7: Commit messages**

Output two messages for the user (do not run `git commit`):
```text
📝 add MIT license, install docs and the release runbook

Test: read README.md "Install" and docs/releasing.md
```
```text
🔥 remove the pkg packaging spike code

Body: The result stays in docs/superpowers/spike-pkg-sea.md.
Test: pnpm typecheck && pnpm lint
```

---

## After the plan: first release

1. User merges the work (their commits and PR, per `CLAUDE.md`).
2. Follow `docs/releasing.md`: push `v0.1.0-rc.1`, fix what the real runners find, then push `v0.1.0`.
3. Run the manual checks in the runbook, especially YouTube with and without a JavaScript runtime and the Windows SmartScreen behavior.

