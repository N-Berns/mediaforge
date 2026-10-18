# Browser Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Firefox-first (Chromium-ready) MV3 extension that detects media, asks the local MediaForge core to probe and download it, and shows progress, with the desktop-side additions it needs.

**Architecture:** `apps/extension` is a thin client of the existing core: a background script owns one native-messaging port (`connectNative`) to the relay, a detector turns `webRequest` responses into candidates, a controller turns popup and overlay commands into protocol messages, and a popup plus a content-script overlay render state. The desktop gains `media.probe`/`media.info`, request-context forwarding to yt-dlp, and Firefox relay detection.

**Tech Stack:** TypeScript (ESM, `.ts` import specifiers), esbuild, Vitest 5, Zod 4, WebExtensions MV3 (`@types/firefox-webext-browser` for types only), pnpm workspace, Biome.

**Spec:** [docs/superpowers/specs/2026-10-14-browser-extension-design.md](../specs/2026-10-14-browser-extension-design.md) (builds on [2026-10-13-extension-core-architecture-design.md](../specs/2026-10-13-extension-core-architecture-design.md))

## Global Constraints

- Firefox first; the same code builds for Chromium through a manifest transform. Windows is the verified platform.
- No framework in the extension UI: hand-written DOM modules. The extension makes no network calls; its only outbound channel is the native port.
- Permissions: `webRequest`, `nativeMessaging`, `storage`, `tabs`, `cookies`, host permission `<all_urls>`. Nothing else.
- Native host name `com.mediaforge.host`; Firefox add-on ID `mediaforge@n-berns`. Both live in `@mediaforge/shared-protocol` as constants.
- Cookie header: read at click time, sent once, never put in `storage`, never persisted or echoed by the core, never in `jobs.snapshot`, progress frames, error text, or logs.
- Host to extension frames stay at or under 1 MiB; `media.info` carries at most 50 formats.
- Protocol version stays 2; new message types are additive.
- Replies: the first frame for `download.start` may already be `downloading`; never assume `queued`.
- A request with no reply in 15 s is a visible error (probes: 45 s).
- Do not run `git commit` unless the user explicitly asks in the current request; each task ends by printing a commit message (CLAUDE.md format, gitmoji from its set, no `Co-Authored-By`).
- Run `pnpm exec biome check --write <paths>` on files created through Bash. Before finishing: `pnpm typecheck`, `pnpm test`, `node_modules/.bin/biome check .` (`pnpm lint` is rewritten to eslint by a local wrapper).
- Do not suppress Biome rules with ignore comments.
- Typecheck-forced type adjustments are allowed without changing behavior; report them.

## Review Focus

- The cookie value must not appear in `jobs.snapshot`, progress frames, error messages, or thrown error text (Task 3).
- A `variantId` the core never returned for that URL is rejected, never passed to yt-dlp (Task 2).
- A probe result from the Generic extractor is reported as `unsupported-site` (Task 2).
- Header injection: CR, LF, NUL or an over-long value in `context` is rejected (Task 3).
- The relay recognizes Firefox's argv (manifest path, add-on ID) and does not treat an ordinary command with a `.json` argument as relay mode (Task 4).
- HLS/DASH segments and range fetches never become candidates; tiny progressive responses (tracking pixels) are ignored (Task 7).
- After the background is suspended and woken, a tab's candidates survive (Task 7).
- After the port drops mid-download, state resyncs with `jobs.list` and does not duplicate jobs (Task 6).
- The overlay trusts only `sender.tab`, never page-supplied data, and its button lives in a closed shadow root (Task 10).
- Opening the popup on a `about:` or `moz-extension:` page shows no items and no error (Task 9).

## File Structure

| Path | Responsibility |
| --- | --- |
| `packages/shared-protocol/src/host.ts` | `NATIVE_HOST_NAME`, `FIREFOX_ADDON_ID`. |
| `packages/shared-protocol/src/schemas.ts`, `messages.ts` | `media.probe`/`media.info`, `askQuality` on extension settings. |
| `apps/desktop/src/core/probe.ts` | Map yt-dlp info to `media.info`, selector for a picked format, probe limiter. |
| `apps/desktop/src/core/service.ts`, `run-core.ts` | Handle `media.probe`, resolve `variantId`, forward context, wire the real probe. |
| `apps/desktop/src/engine/args.ts`, `engine.ts` | `RequestContext`, validation, yt-dlp flags, redaction. |
| `apps/desktop/src/cli.ts`, `main.ts` | Firefox relay argv detection. |
| `apps/extension/` | New app: manifest, build, background, popup, overlay. |
| `tools/dev/register-native-host.mjs` | Dev-time Firefox native host registration. |

---

### Task 1: Protocol additions and shared constants

**Files:**
- Create: `packages/shared-protocol/src/host.ts`
- Modify: `packages/shared-protocol/src/index.ts`, `schemas.ts`, `messages.ts`
- Test: `packages/shared-protocol/src/parse.test.ts`

**Interfaces:**
- Produces: `NATIVE_HOST_NAME = "com.mediaforge.host"`, `FIREFOX_ADDON_ID = "mediaforge@n-berns"`; `ProbedFormatSchema`, `ProbedMediaSchema`; types `ProbedFormat`, `ProbedMedia`; `ExtensionSettingsSchema` gains `askQuality: boolean`; messages `MediaProbeMessage` (`media.probe {url}`) and `MediaInfoMessage` (`media.info` ProbedMedia).

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared-protocol/src/parse.test.ts`:

```ts
describe("media probe", () => {
  const v = PROTOCOL_VERSION;

  it("accepts media.probe with an http url and rejects a bad one", () => {
    const ok = parseExtensionMessage({
      v,
      id: "1",
      type: "media.probe",
      payload: { url: "https://example.com/watch?v=1" },
    });
    expect(ok.ok).toBe(true);
    const bad = parseExtensionMessage({ v, id: "1", type: "media.probe", payload: { url: "nope" } });
    expect(bad.ok).toBe(false);
  });

  it("accepts media.info with formats", () => {
    const result = parseHostMessage({
      v,
      id: "1",
      type: "media.info",
      payload: {
        url: "https://example.com/watch?v=1",
        title: "A video",
        durationSec: 61,
        formats: [
          { id: "137", label: "1080p", height: 1080, container: "mp4", hasVideo: true, hasAudio: false },
          { id: "140", label: "Audio 128 kbps", hasVideo: false, hasAudio: true, approxBytes: 1000 },
        ],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("requires askQuality on settings.value and allows it on settings.set", () => {
    const missing = parseHostMessage({
      v,
      id: "1",
      type: "settings.value",
      payload: { extensionUi: "overlay", keepRunning: false },
    });
    expect(missing.ok).toBe(false);
    const set = parseExtensionMessage({
      v,
      id: "1",
      type: "settings.set",
      payload: { askQuality: false },
    });
    expect(set.ok).toBe(true);
  });

  it("exposes the fixed host and add-on identifiers", () => {
    expect(NATIVE_HOST_NAME).toBe("com.mediaforge.host");
    expect(FIREFOX_ADDON_ID).toBe("mediaforge@n-berns");
  });
});
```

Add `import { FIREFOX_ADDON_ID, NATIVE_HOST_NAME } from "./host.ts";` to the file's imports. In the existing `settings.value` fixture of the "protocol v2" block, add `askQuality: true` to its payload.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/shared-protocol`
Expected: FAIL (`host.ts` missing, `media.probe` unknown).

- [ ] **Step 3: Implement**

`packages/shared-protocol/src/host.ts`:

```ts
/** Name the browser uses to find the native messaging host. Fixed so the installer can register it. */
export const NATIVE_HOST_NAME = "com.mediaforge.host";

/** Firefox add-on ID. The native host manifest allows only this ID. */
export const FIREFOX_ADDON_ID = "mediaforge@n-berns";
```

`index.ts`: add `export * from "./host.ts";`.

`schemas.ts`: before the compile-time guarantee block add:

```ts
export const ProbedFormatSchema = z.object({
  id: z.string(),
  label: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  container: z.string().optional(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  approxBytes: z.number().nonnegative().optional(),
});

/** What the core learned about a page URL from yt-dlp. */
export const ProbedMediaSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  thumbnail: z.string().optional(),
  durationSec: z.number().nonnegative().optional(),
  formats: z.array(ProbedFormatSchema),
});

export type ProbedFormat = z.infer<typeof ProbedFormatSchema>;
export type ProbedMedia = z.infer<typeof ProbedMediaSchema>;
```

and add `askQuality: z.boolean(),` to `ExtensionSettingsSchema` (after `keepRunning`).

`messages.ts`: import `ProbedMediaSchema`; add

```ts
export const MediaProbeMessage = message("media.probe", z.object({ url: z.url() }));
export const MediaInfoMessage = message("media.info", ProbedMediaSchema);
```

and append `MediaProbeMessage` to the `ExtensionToHostMessage` union and `MediaInfoMessage` to the `HostToExtensionMessage` union.

- [ ] **Step 4: Run to verify pass and fix fixtures**

Run: `pnpm exec vitest run packages/shared-protocol apps/desktop/src/core && pnpm typecheck`
Expected: shared-protocol PASS. `apps/desktop/src/core/service.ts` now fails typecheck because `settings.value` needs `askQuality`: in `#sendSettings` add `askQuality: s.askQuality,` to the payload. Existing service tests use `toMatchObject` and keep passing.

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write packages/shared-protocol/src apps/desktop/src/core/service.ts`
Print: `✨ shared-protocol: add media.probe, media.info and askQuality`.

---

### Task 2: Core probe and format selection

**Files:**
- Create: `apps/desktop/src/core/probe.ts`
- Modify: `apps/desktop/src/formats.ts` (add `extractor_key?: string` to `MediaInfo`), `apps/desktop/src/interactive/format-choices.ts` (export `resolutionName`), `apps/desktop/src/core/service.ts`, `apps/desktop/src/core/run-core.ts`
- Test: `apps/desktop/src/core/probe.test.ts`, `apps/desktop/src/core/service.test.ts`

**Interfaces:**
- Consumes: `fetchMediaInfo`, `FormatsDeps`, `MediaInfo`, `RawFormat` (`../formats.ts`); `usableFormats`, `isVideo`, `isAudio`, `sizeOf`, `resolutionName` (`../interactive/format-choices.ts`; type-only UI imports are erased, no ink at runtime); `ProbedMedia` (`@mediaforge/shared-protocol`).
- Produces:
  - `class UnsupportedSiteError extends Error`
  - `toProbedMedia(url: string, info: MediaInfo): ProbedMedia` (throws `UnsupportedSiteError` when `info.extractor_key === "Generic"`; best-first, at most 50 formats, duplicates by label+container+flags removed)
  - `interface KnownFormat { id: string; hasVideo: boolean; hasAudio: boolean }`, `selectorFor(f: KnownFormat): string`
  - `createProbeLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T>`
  - `CoreServiceDeps.probe(url: string): Promise<ProbedMedia>`; `RunCoreDeps.createProbe?: (provisioner: Provisioner) => (url: string) => Promise<ProbedMedia>`.

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/core/probe.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MediaInfo } from "../formats.ts";
import { createProbeLimiter, selectorFor, toProbedMedia, UnsupportedSiteError } from "./probe.ts";

const info: MediaInfo = {
  title: "Clip",
  duration: 61,
  extractor_key: "Youtube",
  // yt-dlp lists formats worst to best.
  formats: [
    { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 128, filesize: 1000 },
    { format_id: "18", ext: "mp4", width: 640, height: 360, vcodec: "avc1", acodec: "mp4a", filesize: 5000 },
    { format_id: "137", ext: "mp4", width: 1920, height: 1080, vcodec: "avc1", acodec: "none", filesize: 9000 },
    { format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none" },
  ],
};

describe("toProbedMedia", () => {
  it("lists usable formats best first and drops storyboards", () => {
    const media = toProbedMedia("https://example.com/w", info);
    expect(media.url).toBe("https://example.com/w");
    expect(media.title).toBe("Clip");
    expect(media.durationSec).toBe(61);
    expect(media.formats.map((f) => f.id)).toEqual(["137", "18", "140"]);
    expect(media.formats[0]).toMatchObject({
      label: "1080p",
      height: 1080,
      container: "mp4",
      hasVideo: true,
      hasAudio: false,
      approxBytes: 9000,
    });
  });

  it("treats the Generic extractor as unsupported", () => {
    expect(() => toProbedMedia("https://x.test/", { ...info, extractor_key: "Generic" })).toThrow(
      UnsupportedSiteError,
    );
  });

  it("keeps at most 50 formats", () => {
    const many: MediaInfo = {
      extractor_key: "Vimeo",
      formats: Array.from({ length: 80 }, (_, i) => ({
        format_id: `f${i}`,
        ext: "mp4",
        height: 100 + i,
        width: 200 + i,
        vcodec: "avc1",
        acodec: "mp4a",
      })),
    };
    expect(toProbedMedia("https://x.test/", many).formats).toHaveLength(50);
  });
});

describe("selectorFor", () => {
  it("adds best audio to video-only formats", () => {
    expect(selectorFor({ id: "137", hasVideo: true, hasAudio: false })).toBe("137+ba/137");
    expect(selectorFor({ id: "18", hasVideo: true, hasAudio: true })).toBe("18");
    expect(selectorFor({ id: "140", hasVideo: false, hasAudio: true })).toBe("140");
  });
});

describe("createProbeLimiter", () => {
  it("runs at most N tasks at once", async () => {
    const limit = createProbeLimiter(2);
    let running = 0;
    let peak = 0;
    const task = () =>
      limit(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });
});
```

Append to `apps/desktop/src/core/service.test.ts` (reuse its `setup()`; extend `setup()` options and deps so `probe` is injectable, defaulting to a function that returns `{ url, formats: [] }`):

```ts
describe("media.probe and variantId", () => {
  const media = {
    url: "https://example.com/watch",
    title: "Clip",
    formats: [
      { id: "137", label: "1080p", hasVideo: true, hasAudio: false },
      { id: "140", label: "Audio 128 kbps", hasVideo: false, hasAudio: true },
    ],
  };

  it("replies media.info", async () => {
    const t = setup({ probe: async () => media });
    await t.send("media.probe", { url: media.url }, "p1");
    expect(t.sent[0]).toMatchObject({ id: "p1", type: "media.info", payload: { title: "Clip" } });
  });

  it("maps an unsupported probe to unsupported-site and a non-http url to invalid-url", async () => {
    const { UnsupportedSiteError } = await import("./probe.ts");
    const t = setup({
      probe: async () => {
        throw new UnsupportedSiteError("nope");
      },
    });
    await t.send("media.probe", { url: media.url });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "unsupported-site" } });
    t.sent.length = 0;
    await t.send("media.probe", { url: "ftp://example.com/x" });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "invalid-url" } });
  });

  it("downloads a probed variant with the resolved selector", async () => {
    const t = setup({ probe: async () => media });
    await t.send("media.probe", { url: media.url });
    t.sent.length = 0;
    await t.send("download.start", {
      candidate: { ...candidate, url: media.url, pageUrl: media.url },
      profileId: "best",
      variantId: "137",
    });
    expect(t.fake.submitOptions[0]).toMatchObject({ formatSelector: "137+ba/137" });
  });

  it("switches an audio-only pick to the audio profile", async () => {
    const t = setup({ probe: async () => media });
    await t.send("media.probe", { url: media.url });
    await t.send("download.start", {
      candidate: { ...candidate, url: media.url, pageUrl: media.url },
      profileId: "best",
      variantId: "140",
    });
    expect((t.fake.submitted[0] as { profileId: string }).profileId).toBe("audio-m4a");
  });

  it("rejects a variantId the core never returned", async () => {
    const t = setup({ probe: async () => media });
    await t.send("download.start", {
      candidate: { ...candidate, url: media.url, pageUrl: media.url },
      profileId: "best",
      variantId: "999",
    });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "unknown-variant" } });
    expect(t.fake.submitted).toHaveLength(0);
  });
});
```

(`fakeEngine().submit` must also record its second argument into `submitOptions`; update the fake to `submit: (request, options) => { ...; submitOptions.push(options); ... }` and return `submitOptions` from `fakeEngine`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/desktop/src/core/probe.test.ts apps/desktop/src/core/service.test.ts`
Expected: FAIL (`probe.ts` missing; `media.probe` unsupported).

- [ ] **Step 3: Implement**

`formats.ts`: add to `MediaInfo`: `/** yt-dlp's extractor name, e.g. "Youtube" or "Generic". */ extractor_key?: string;`. `format-choices.ts`: change `function resolutionName` to `export function resolutionName`.

`apps/desktop/src/core/probe.ts`:

```ts
import type { ProbedFormat, ProbedMedia } from "@mediaforge/shared-protocol";
import type { MediaInfo, RawFormat } from "../formats.ts";
import {
  isAudio,
  isVideo,
  resolutionName,
  sizeOf,
  usableFormats,
} from "../interactive/format-choices.ts";

/** `media.info` stays well under the 1 MiB host message cap with this many formats. */
export const MAX_FORMATS = 50;

/** The page is not a site yt-dlp has its own extractor for. */
export class UnsupportedSiteError extends Error {
  override name = "UnsupportedSiteError";
}

export interface KnownFormat {
  id: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

function labelOf(f: RawFormat): string {
  if (isVideo(f)) return resolutionName(f);
  return f.abr ? `Audio ${Math.round(f.abr)} kbps` : "Audio";
}

function toFormat(f: RawFormat, duration: number | undefined): ProbedFormat {
  const size = sizeOf(f, duration);
  return {
    id: f.format_id as string,
    label: labelOf(f),
    ...(f.width && { width: f.width }),
    ...(f.height && { height: f.height }),
    ...(f.ext && { container: f.ext }),
    hasVideo: isVideo(f),
    hasAudio: isAudio(f),
    ...(size && { approxBytes: Math.round(size.bytes) }),
  };
}

/** Turn yt-dlp's JSON into the `media.info` payload. Best format first. */
export function toProbedMedia(url: string, info: MediaInfo): ProbedMedia {
  if (info.extractor_key === "Generic") {
    throw new UnsupportedSiteError("MediaForge has no extractor for this page.");
  }
  // yt-dlp lists formats worst to best.
  const seen = new Set<string>();
  const formats: ProbedFormat[] = [];
  for (const raw of usableFormats(info).reverse()) {
    const format = toFormat(raw, info.duration);
    const key = [format.label, format.container, format.hasVideo, format.hasAudio].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    formats.push(format);
    if (formats.length === MAX_FORMATS) break;
  }
  return {
    url,
    ...(info.title && { title: info.title }),
    ...(info.duration !== undefined && { durationSec: info.duration }),
    formats,
  };
}

/** The yt-dlp `-f` value for one probed format: silent video gets the best audio added. */
export const selectorFor = (f: KnownFormat): string =>
  f.hasVideo && !f.hasAudio ? `${f.id}+ba/${f.id}` : f.id;

/** Run at most `max` tasks at once; the rest wait their turn. */
export function createProbeLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
```

`service.ts`:
1. Imports: `selectorFor`, `UnsupportedSiteError`, `KnownFormat` from `./probe.ts`; `CliError`, `ExitCode` from `../exit-codes.ts`; `type ProbedMedia` from `@mediaforge/shared-protocol`.
2. `CoreServiceDeps` gains `probe(url: string): Promise<ProbedMedia>;`.
3. Field `readonly #formats = new Map<string, Map<string, KnownFormat>>();` and constant `const MAX_PROBED_URLS = 64;`.
4. In `#dispatch` add before the default case:

```ts
      case "media.probe":
        return this.#probe(state, message);
```

5. Methods:

```ts
  async #probe(
    state: ClientState,
    message: Extract<ExtensionToHostMessage, { type: "media.probe" }>,
  ): Promise<void> {
    const url = message.payload.url;
    if (!/^https?:\/\//i.test(url)) {
      this.#error(state, message.id, "invalid-url", "Only http and https links can be probed.");
      return;
    }
    try {
      const media = await this.#deps.probe(url);
      this.#remember(url, media);
      this.#reply(state, message.id, "media.info", media);
    } catch (error) {
      const { code, text } = describeProbeError(error);
      this.#error(state, message.id, code, text);
    }
  }

  #remember(url: string, media: ProbedMedia): void {
    this.#formats.delete(url);
    this.#formats.set(
      url,
      new Map(
        media.formats.map((f) => [
          f.id,
          { id: f.id, hasVideo: f.hasVideo, hasAudio: f.hasAudio } satisfies KnownFormat,
        ]),
      ),
    );
    while (this.#formats.size > MAX_PROBED_URLS) {
      const oldest = this.#formats.keys().next().value;
      if (oldest === undefined) break;
      this.#formats.delete(oldest);
    }
  }
```

and at module level:

```ts
function describeProbeError(error: unknown): { code: string; text: string } {
  const text = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  if (error instanceof UnsupportedSiteError) return { code: "unsupported-site", text };
  if (error instanceof CliError) {
    if (error.exitCode === ExitCode.UnsupportedSite) return { code: "unsupported-site", text };
    if (error.exitCode === ExitCode.MissingTool) return { code: "setup-incomplete", text };
    if (error.exitCode === ExitCode.Network) return { code: "network", text };
  }
  return { code: "probe-failed", text };
}
```

6. In `#start`, after the profile/outputDir/filename validation and before `submit`, resolve the variant:

```ts
    let formatSelector: string | undefined;
    let profileId = request.profileId;
    if (request.variantId !== undefined) {
      const known = this.#formats.get(request.candidate.url)?.get(request.variantId);
      if (!known) {
        this.#error(state, message.id, "unknown-variant", "That format was not offered for this link.");
        return;
      }
      formatSelector = selectorFor(known);
      if (known.hasAudio && !known.hasVideo) profileId = "audio-m4a";
    }
```

and call `this.#engine.submit({ ...request, profileId, ...(outputDir && { outputDir }) }, { ...(formatSelector && { formatSelector }) })` (keep every other field as it is today).

`run-core.ts`:
- `RunCoreDeps` gains `createProbe?: (provisioner: Provisioner) => (url: string) => Promise<ProbedMedia>;`.
- When constructing the service pass `probe: deps.createProbe?.(provisioner) ?? (async () => { throw new Error("Probing is not available."); })`.
- In `runDefaultCore` add:

```ts
    createProbe: (provisioner) => {
      const limit = createProbeLimiter(2);
      const formats: FormatsDeps = {
        resolve: async (tool) => {
          await provisioner.ready();
          return resolveTool(tool);
        },
        run: runProcess,
        jsRuntimeArgs: detectJsRuntimeArgs,
      };
      return (url) => limit(async () => toProbedMedia(url, await fetchMediaInfo(url, formats)));
    },
```

with imports `fetchMediaInfo`, `type FormatsDeps` from `../formats.ts`, `runProcess` from `../engine/process.ts`, `createProbeLimiter`, `toProbedMedia` from `./probe.ts`, `type ProbedMedia` from shared-protocol. Leave `ensureTools` unset: the core never prompts.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS. Update any other test `setup()` that constructs `CoreServiceDeps` to pass `probe`.

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write apps/desktop/src`
Print: `✨ desktop: add media.probe and format selection to the core`.

---

### Task 3: Request context forwarding

**Files:**
- Modify: `apps/desktop/src/engine/args.ts`, `apps/desktop/src/engine/engine.ts`, `apps/desktop/src/core/service.ts`
- Test: `apps/desktop/src/engine/args.test.ts` (create if absent; follow the nearest existing engine test file's imports), `apps/desktop/src/engine/engine.test.ts`, `apps/desktop/src/core/service.test.ts`

**Interfaces:**
- Produces: `RequestContext` (`referer?`, `userAgent?`, `cookies?`, `headers?: Record<string,string>`); `contextError(context): string | undefined`; `contextArgs(context?): string[]`; `contextSecrets(context?): string[]`; `redactSecrets(text: string, secrets: string[]): string`; `BuildArgsInput.context?`; `SubmitOptions.context?`.

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/engine/args.test.ts` (create; add this block, or append if the file exists):

```ts
import { describe, expect, it } from "vitest";
import { contextArgs, contextError, contextSecrets, redactSecrets } from "./args.ts";

describe("request context", () => {
  it("builds yt-dlp flags without a shell", () => {
    expect(
      contextArgs({
        referer: "https://example.com/watch",
        userAgent: "UA/1.0",
        cookies: "a=1; b=2",
        headers: { Origin: "https://example.com" },
      }),
    ).toEqual([
      "--referer",
      "https://example.com/watch",
      "--user-agent",
      "UA/1.0",
      "--add-header",
      "Cookie:a=1; b=2",
      "--add-header",
      "Origin:https://example.com",
    ]);
    expect(contextArgs(undefined)).toEqual([]);
  });

  it("rejects line breaks, NUL, oversized values and bad or forbidden header names", () => {
    expect(contextError({ cookies: "a=1\r\nX-Evil: 1" })).toMatch(/line break/);
    expect(contextError({ userAgent: "a\0b" })).toMatch(/line break/);
    expect(contextError({ referer: `https://x/${"a".repeat(9000)}` })).toMatch(/too long/);
    expect(contextError({ headers: { "bad name": "x" } })).toMatch(/Invalid header name/);
    expect(contextError({ headers: { Host: "evil" } })).toMatch(/not allowed/);
    expect(contextError({ referer: "https://x/", cookies: "a=1" })).toBeUndefined();
  });

  it("lists secrets and redacts them", () => {
    const secrets = contextSecrets({ cookies: "session=abc123", headers: { Authorization: "Bearer tok-999" } });
    expect(secrets).toEqual(["session=abc123", "Bearer tok-999"]);
    expect(redactSecrets("failed with session=abc123 and Bearer tok-999", secrets)).toBe(
      "failed with [redacted] and [redacted]",
    );
    expect(redactSecrets("short", ["abc"])).toBe("short");
  });
});
```

Append to `engine.test.ts`, using that file's existing fake-runner helpers: a test that submits a job with `{ context: { cookies: "session=abc123def" } }` and a runner whose stderr contains `ERROR: 403 for Cookie: session=abc123def` and exit code 1, then asserts `job.error` does not contain `abc123def`, the argv passed to the runner contains `--add-header` and `Cookie:session=abc123def`, and the job object (`engine.get(id)`) has no `context` key anywhere (`JSON.stringify(job)` does not contain `abc123def`).

Append to `service.test.ts`:

```ts
describe("context", () => {
  it("passes a valid context to the engine, never into the job", async () => {
    const t = setup();
    await t.send("download.start", {
      candidate,
      profileId: "best",
      context: { referer: "https://example.com/", cookies: "session=abc123def" },
    });
    expect(t.fake.submitOptions[0]).toMatchObject({
      context: { cookies: "session=abc123def" },
    });
    t.sent.length = 0;
    await t.send("jobs.list");
    expect(JSON.stringify(t.sent)).not.toContain("abc123def");
  });

  it("rejects a context with a line break", async () => {
    const t = setup();
    await t.send("download.start", {
      candidate,
      profileId: "best",
      context: { cookies: "a=1\r\nX: y" },
    });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "invalid-context" } });
    expect(t.fake.submitted).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/desktop/src/engine apps/desktop/src/core/service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`args.ts`: add (exports):

```ts
/** What a sniffed stream needs to be fetched the way the browser fetched it. */
export interface RequestContext {
  referer?: string;
  userAgent?: string;
  cookies?: string;
  headers?: Record<string, string>;
}

const MAX_CONTEXT_VALUE = 8192;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "cookie",
  "referer",
  "user-agent",
]);

/** Why this context must not be used, or undefined when it is safe to pass to yt-dlp. */
export function contextError(context: RequestContext): string | undefined {
  const values = [
    context.referer,
    context.userAgent,
    context.cookies,
    ...Object.values(context.headers ?? {}),
  ];
  for (const value of values) {
    if (value === undefined) continue;
    if (value.length > MAX_CONTEXT_VALUE) return "A request header value is too long.";
    if (/[\r\n\0]/.test(value)) return "A request header value contains a line break.";
  }
  for (const name of Object.keys(context.headers ?? {})) {
    if (!HEADER_NAME.test(name)) return `Invalid header name: ${name}`;
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) return `Header not allowed: ${name}`;
  }
  return undefined;
}

export function contextArgs(context: RequestContext | undefined): string[] {
  if (!context) return [];
  const args: string[] = [];
  if (context.referer) args.push("--referer", context.referer);
  if (context.userAgent) args.push("--user-agent", context.userAgent);
  if (context.cookies) args.push("--add-header", `Cookie:${context.cookies}`);
  for (const [name, value] of Object.entries(context.headers ?? {})) {
    args.push("--add-header", `${name}:${value}`);
  }
  return args;
}

/** Values that must never reach a record, a log or an error message. */
export function contextSecrets(context: RequestContext | undefined): string[] {
  if (!context) return [];
  return [context.cookies, ...Object.values(context.headers ?? {})].filter(
    (value): value is string => Boolean(value),
  );
}

const MIN_SECRET_LENGTH = 6;

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join("[redacted]");
  }
  return out;
}
```

In `BuildArgsInput` add `context?: RequestContext;` and, in `buildYtDlpArgs`, destructure `context` and insert `...contextArgs(context),` immediately before `"--paths"`.

`engine.ts`: `SubmitOptions` gains `context?: RequestContext;` (import the type from `./args.ts`). Store it on the private `Entry` (`context: options.context`), pass `context: entry.context` into the single `buildYtDlpArgs({...})` call, and wherever the engine builds a failure message for the job (`job.error`, including the stderr tail text and any text from a thrown error) wrap it with `redactSecrets(message, contextSecrets(entry.context))`. The job object and `onUpdate` snapshots must not receive the context.

`service.ts` in `#start`: destructure `context` from the payload instead of discarding it, validate with `contextError(context)` right after the filename/outputDir checks (reply `error{code:"invalid-context"}` and return), and pass `{ ...(formatSelector && { formatSelector }), ...(context && { context }) }` as the submit options.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write apps/desktop/src`
Print: `🔒️ desktop: forward request context to yt-dlp and redact its secrets`.

---

### Task 4: Firefox relay detection

**Files:**
- Modify: `apps/desktop/src/cli.ts`, `apps/desktop/src/main.ts`
- Test: `apps/desktop/src/cli.test.ts`

**Interfaces:**
- Consumes: `NATIVE_HOST_NAME` (`@mediaforge/shared-protocol`).
- Produces: `isRelayArgv(argv: string[]): boolean` (true for `--native-host`, a `chrome-extension://` or `moz-extension://` first argument, or a first argument that is a path ending in `com.mediaforge.host.json` followed by a second argument).

- [ ] **Step 1: Write the failing tests**

Append to `cli.test.ts`:

```ts
describe("isRelayArgv", () => {
  it("accepts Chrome, the explicit flag, and Firefox's manifest path plus add-on id", () => {
    expect(isRelayArgv(["--native-host"])).toBe(true);
    expect(isRelayArgv(["chrome-extension://abc/", "--parent-window=1"])).toBe(true);
    expect(
      isRelayArgv([
        "C:\\Users\\n\\AppData\\Local\\MediaForge\\com.mediaforge.host.json",
        "mediaforge@n-berns",
      ]),
    ).toBe(true);
    expect(isRelayArgv(["/home/n/.mozilla/native-messaging-hosts/com.mediaforge.host.json", "id"])).toBe(
      true,
    );
  });

  it("does not treat ordinary commands or other json files as relay mode", () => {
    expect(isRelayArgv(["download", "com.mediaforge.host.json"])).toBe(false);
    expect(isRelayArgv(["settings.json", "x"])).toBe(false);
    expect(isRelayArgv(["com.mediaforge.host.json"])).toBe(false);
    expect(isRelayArgv([])).toBe(false);
  });

  it("run() starts the relay for Firefox's argv", async () => {
    let called = 0;
    await run(["C:\\x\\com.mediaforge.host.json", "mediaforge@n-berns"], io, {
      relay: async () => {
        called++;
        return 0;
      },
    });
    expect(called).toBe(1);
  });
});
```

(Import `isRelayArgv` from `./cli.ts`; reuse the file's existing `io` helper or define `const io = { stdout: () => {}, stderr: () => {} };`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/desktop/src/cli.test.ts`
Expected: FAIL (`isRelayArgv` missing).

- [ ] **Step 3: Implement**

`cli.ts`: import `NATIVE_HOST_NAME` from `@mediaforge/shared-protocol` and add:

```ts
const HOST_MANIFEST_FILE = `${NATIVE_HOST_NAME}.json`.toLowerCase();

/**
 * True when the browser started this program as its native messaging host. Chrome passes the
 * extension origin; Firefox passes the host manifest path and then the add-on id.
 */
export function isRelayArgv(argv: string[]): boolean {
  const [first, second] = argv;
  if (isRelayInvocation(first)) return true;
  if (typeof first !== "string" || typeof second !== "string") return false;
  const base = first.split(/[\\/]/).pop()?.toLowerCase();
  return base === HOST_MANIFEST_FILE;
}
```

In `run()` replace the mode check `first === "--core" || isRelayInvocation(first)` with `first === "--core" || isRelayArgv(argv)`. In `main.ts` replace both uses of `isRelayInvocation(process.argv[2])` with `isRelayArgv(process.argv.slice(2))` and update the import. Keep `isRelayInvocation` exported (tests and existing callers).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write apps/desktop/src`
Print: `✨ desktop: start the relay for Firefox's native host arguments`.

---

### Task 5: Extension scaffold, manifest and build

**Files:**
- Create: `apps/extension/package.json`, `tsconfig.json`, `vitest.config.ts`, `build.mjs`, `src/manifest.ts`, `src/manifest.test.ts`, `src/popup/popup.html`, `src/popup/popup.css`, `src/background/index.ts` (placeholder export so the build resolves; replaced in Task 8), `src/popup/index.ts` (placeholder), `src/content/overlay.ts` (placeholder)
- Modify: root `tsconfig.json` (add `{ "path": "apps/extension" }`), root `.gitignore` (add `apps/extension/dist` and `apps/extension/.dev`)
- Remove: the empty folders `apps/chrome`, `apps/edge`, `apps/firefox` (`rmdir`; leave `apps/android`)

**Interfaces:**
- Produces: `type Target = "firefox" | "chromium"`; `buildManifest(target: Target, version: string): Record<string, unknown>`; `pnpm --filter @mediaforge/extension build [--target firefox|chromium]` writing `apps/extension/dist/<target>/`.

- [ ] **Step 1: Write the failing test**

`apps/extension/src/manifest.test.ts`:

```ts
import { FIREFOX_ADDON_ID } from "@mediaforge/shared-protocol";
import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest.ts";

describe("buildManifest", () => {
  it("builds an MV3 Firefox manifest with an event page and the add-on id", () => {
    const m = buildManifest("firefox", "0.3.0") as Record<string, any>;
    expect(m.manifest_version).toBe(3);
    expect(m.version).toBe("0.3.0");
    expect(m.background).toEqual({ scripts: ["background.js"] });
    expect(m.browser_specific_settings.gecko.id).toBe(FIREFOX_ADDON_ID);
    expect(m.background.service_worker).toBeUndefined();
  });

  it("builds a Chromium manifest with a service worker and no gecko block", () => {
    const m = buildManifest("chromium", "0.3.0") as Record<string, any>;
    expect(m.background).toEqual({ service_worker: "background.js" });
    expect(m.browser_specific_settings).toBeUndefined();
  });

  it("asks for exactly the agreed permissions", () => {
    const m = buildManifest("firefox", "0.3.0") as Record<string, any>;
    expect([...m.permissions].sort()).toEqual(
      ["cookies", "nativeMessaging", "storage", "tabs", "webRequest"].sort(),
    );
    expect(m.host_permissions).toEqual(["<all_urls>"]);
  });

  it("injects the overlay as a content script and sets the popup", () => {
    const m = buildManifest("firefox", "0.3.0") as Record<string, any>;
    expect(m.content_scripts[0].js).toEqual(["overlay.js"]);
    expect(m.action.default_popup).toBe("popup.html");
  });
});
```

- [ ] **Step 2: Create the package files**

`apps/extension/package.json`:

```json
{
  "name": "@mediaforge/extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@mediaforge/extension-core": "workspace:*",
    "@mediaforge/media-profiles": "workspace:*",
    "@mediaforge/shared-protocol": "workspace:*",
    "@mediaforge/shared-types": "workspace:*"
  },
  "devDependencies": {
    "esbuild": "^0.28.2"
  },
  "scripts": {
    "build": "node build.mjs"
  }
}
```

Then run `pnpm add -D @types/firefox-webext-browser --filter @mediaforge/extension` and `pnpm install`.

`apps/extension/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": ".tsbuild",
    "types": ["firefox-webext-browser"]
  },
  "include": ["src"],
  "references": [
    { "path": "../../packages/extension-core" },
    { "path": "../../packages/media-profiles" },
    { "path": "../../packages/shared-protocol" },
    { "path": "../../packages/shared-types" }
  ]
}
```

`apps/extension/vitest.config.ts`: copy `apps/desktop/vitest.config.ts` and change only the project name to `extension`.

`apps/extension/src/manifest.ts`:

```ts
import { FIREFOX_ADDON_ID } from "@mediaforge/shared-protocol";

export type Target = "firefox" | "chromium";

/** Build the manifest for one browser. The two differ only in how the background script runs. */
export function buildManifest(target: Target, version: string): Record<string, unknown> {
  const base = {
    manifest_version: 3,
    name: "MediaForge",
    version,
    description: "Send the video and audio on a page to MediaForge on this computer.",
    permissions: ["webRequest", "nativeMessaging", "storage", "tabs", "cookies"],
    host_permissions: ["<all_urls>"],
    action: { default_title: "MediaForge", default_popup: "popup.html" },
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["overlay.js"],
        all_frames: true,
        run_at: "document_idle",
      },
    ],
  };
  if (target === "firefox") {
    return {
      ...base,
      background: { scripts: ["background.js"] },
      browser_specific_settings: { gecko: { id: FIREFOX_ADDON_ID, strict_min_version: "115.0" } },
    };
  }
  return { ...base, background: { service_worker: "background.js" } };
}
```

`apps/extension/build.mjs`:

```js
// Bundles the extension into dist/<target>/: background.js, popup.js, overlay.js, popup.html,
// popup.css and manifest.json. Usage: node build.mjs [--target firefox|chromium]
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const arg = process.argv.indexOf("--target");
const target = arg >= 0 ? process.argv[arg + 1] : "firefox";
if (target !== "firefox" && target !== "chromium") throw new Error(`Unknown target: ${target}`);

const out = `dist/${target}`;
await mkdir(out, { recursive: true });

await build({
  entryPoints: {
    background: "src/background/index.ts",
    popup: "src/popup/index.ts",
    overlay: "src/content/overlay.ts",
  },
  outdir: out,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: target === "firefox" ? "firefox115" : "chrome120",
  logLevel: "info",
});

await copyFile("src/popup/popup.html", `${out}/popup.html`);
await copyFile("src/popup/popup.css", `${out}/popup.css`);

// The manifest is built from the TypeScript source so tests and the build share one definition.
const { buildManifest } = await import("./src/manifest.ts");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await writeFile(
  `${out}/manifest.json`,
  `${JSON.stringify(buildManifest(target, pkg.version), null, 2)}\n`,
);
```

Note: Node 22 can import `.ts` only with type stripping; if `await import("./src/manifest.ts")` fails, run the build with `node --experimental-strip-types build.mjs` in the `build` script instead (the repo already requires Node 22; check `apps/desktop/build.mjs` for how it avoids this and mirror it).

`src/popup/popup.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MediaForge</title>
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <div id="app" role="main"></div>
    <script src="popup.js"></script>
  </body>
</html>
```

`src/popup/popup.css`:

```css
:root { color-scheme: light dark; }
body { width: 340px; margin: 0; font: 13px/1.4 system-ui, sans-serif; }
#app { padding: 12px; display: grid; gap: 10px; }
.banner { padding: 8px 10px; border-radius: 6px; background: Canvas; border: 1px solid GrayText; }
.banner[data-tone="warn"] { border-color: #b26a00; }
.banner[data-tone="error"] { border-color: #b00020; }
.row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
.row .sub { color: GrayText; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { font: inherit; padding: 4px 10px; }
progress { width: 100%; }
.toggle { display: flex; gap: 8px; align-items: center; }
h2 { font-size: 12px; margin: 0; color: GrayText; text-transform: uppercase; letter-spacing: .04em; }
```

Placeholders (each exports nothing meaningful yet): `src/background/index.ts`, `src/popup/index.ts`, `src/content/overlay.ts` each contain `export {};`.

- [ ] **Step 3: Remove placeholder folders, wire the workspace**

Run: `rmdir apps/chrome apps/edge apps/firefox` (they are empty). Add the root `tsconfig.json` reference and the `.gitignore` entries.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/extension && pnpm typecheck && pnpm --filter @mediaforge/extension build`
Expected: manifest tests PASS; typecheck clean; `apps/extension/dist/firefox/` contains `manifest.json`, `background.js`, `popup.js`, `overlay.js`, `popup.html`, `popup.css`.

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write apps/extension tsconfig.json`
Print: `✨ extension: scaffold the MV3 extension with a Firefox/Chromium manifest build`.

---

### Task 6: Native client

**Files:**
- Create: `apps/extension/src/background/native-client.ts`
- Test: `apps/extension/src/background/native-client.test.ts`

**Interfaces:**
- Consumes: `PROTOCOL_VERSION`, `parseHostMessage`, `HostToExtensionMessage`, `ExtensionToHostMessage` (`@mediaforge/shared-protocol`).
- Produces:
  - `interface NativePort { postMessage(m: unknown): void; onMessage: { addListener(cb: (m: unknown) => void): void }; onDisconnect: { addListener(cb: () => void): void }; disconnect(): void }`
  - `type ConnectionState = { kind: "connecting" } | { kind: "not-installed" } | { kind: "unavailable"; message: string } | { kind: "incompatible" } | { kind: "setting-up"; tool?: string; percent?: number } | { kind: "ready" }`
  - `class NativeRequestError extends Error { code: string }`
  - `createNativeClient(options: NativeClientOptions): NativeClient` with `state()`, `onState(l)`, `onPush(l)`, `request(type, payload)`, `start()`, `stop()`.

- [ ] **Step 1: Write the failing tests**

`apps/extension/src/background/native-client.test.ts`:

```ts
import { PROTOCOL_VERSION } from "@mediaforge/shared-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeClient, type NativePort } from "./native-client.ts";

function fakePort() {
  const messageListeners: Array<(m: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const sent: any[] = [];
  const port: NativePort = {
    postMessage: (m) => void sent.push(m),
    onMessage: { addListener: (cb) => void messageListeners.push(cb) },
    onDisconnect: { addListener: (cb) => void disconnectListeners.push(cb) },
    disconnect: () => disconnectListeners.forEach((cb) => cb()),
  };
  return {
    port,
    sent,
    receive: (m: unknown) => messageListeners.forEach((cb) => cb(m)),
    drop: () => disconnectListeners.forEach((cb) => cb()),
  };
}

const frame = (id: string, type: string, payload: unknown) => ({
  v: PROTOCOL_VERSION,
  id,
  type,
  payload,
});

const ack = (id: string, setup = "ready") =>
  frame(id, "hello.ack", {
    hostVersion: "0.3.0",
    ytDlp: { available: true },
    ffmpeg: { available: true },
    setup,
    keepRunning: false,
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(options: { connect?: () => NativePort } = {}) {
  const ports: ReturnType<typeof fakePort>[] = [];
  const client = createNativeClient({
    connect:
      options.connect ??
      (() => {
        const p = fakePort();
        ports.push(p);
        return p.port;
      }),
    extensionVersion: "0.1.0",
    browser: "firefox",
    retryDelaysMs: [0, 1000, 2000],
  });
  return { client, ports };
}

describe("native client", () => {
  it("says hello, becomes ready on ack, then subscribes and lists jobs", () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    expect(client.state().kind).toBe("connecting");
    expect(p.sent[0]).toMatchObject({ type: "hello", payload: { browser: "firefox" } });
    p.receive(ack(p.sent[0].id));
    expect(client.state().kind).toBe("ready");
    expect(p.sent.map((m) => m.type)).toEqual(["hello", "jobs.subscribe", "jobs.list"]);
  });

  it("is not-installed when connect throws or the port drops before any reply", () => {
    const thrown = setup({
      connect: () => {
        throw new Error("No such native application");
      },
    });
    thrown.client.start();
    expect(thrown.client.state().kind).toBe("not-installed");

    const dropped = setup();
    dropped.client.start();
    (dropped.ports[0] as ReturnType<typeof fakePort>).drop();
    expect(dropped.client.state().kind).toBe("not-installed");
  });

  it("shows setting-up from hello.ack and setup.progress, then ready", () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive(ack(p.sent[0].id, "installing"));
    expect(client.state().kind).toBe("setting-up");
    p.receive(frame("x", "setup.progress", { state: "installing", tool: "ffmpeg", percent: 40 }));
    expect(client.state()).toEqual({ kind: "setting-up", tool: "ffmpeg", percent: 40 });
    p.receive(frame("y", "setup.progress", { state: "ready" }));
    expect(client.state().kind).toBe("ready");
  });

  it("correlates replies by id and rejects error replies with their code", async () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive(ack(p.sent[0].id));
    const ok = client.request("settings.get", {});
    const settingsId = p.sent.at(-1).id;
    p.receive(
      frame(settingsId, "settings.value", {
        extensionUi: "overlay",
        keepRunning: false,
        askQuality: true,
      }),
    );
    await expect(ok).resolves.toMatchObject({ type: "settings.value" });

    const bad = client.request("media.probe", { url: "https://x.test/" });
    const badId = p.sent.at(-1).id;
    p.receive(
      frame("e", "error", { code: "unsupported-site", message: "no", replyTo: badId }),
    );
    await expect(bad).rejects.toMatchObject({ code: "unsupported-site" });
  });

  it("times out a request with no reply", async () => {
    const { client, ports } = setup();
    client.start();
    (ports[0] as ReturnType<typeof fakePort>).receive(
      ack(((ports[0] as ReturnType<typeof fakePort>).sent[0] as { id: string }).id),
    );
    const pending = client.request("jobs.list", {}, { timeoutMs: 100 });
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
  });

  it("reconnects after a drop, resyncs jobs, and rejects in-flight requests", async () => {
    const { client, ports } = setup();
    client.start();
    const first = ports[0] as ReturnType<typeof fakePort>;
    first.receive(ack(first.sent[0].id));
    const inflight = client.request("jobs.list", {});
    const assertion = expect(inflight).rejects.toMatchObject({ code: "disconnected" });
    first.drop();
    await assertion;
    expect(client.state().kind).toBe("connecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(ports).toHaveLength(2);
    const second = ports[1] as ReturnType<typeof fakePort>;
    second.receive(ack(second.sent[0].id));
    expect(client.state().kind).toBe("ready");
    expect(second.sent.map((m) => m.type)).toEqual(["hello", "jobs.subscribe", "jobs.list"]);
  });

  it("marks an older core incompatible when it rejects hello", () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive(
      frame("e", "error", { code: "invalid-message", message: "v", replyTo: p.sent[0].id }),
    );
    expect(client.state().kind).toBe("incompatible");
  });

  it("reports unavailable when the relay says the core could not start", () => {
    const { client, ports } = setup();
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive(frame("r", "error", { code: "core-unavailable", message: "could not start" }));
    expect(client.state()).toMatchObject({ kind: "unavailable" });
  });

  it("forwards every valid frame to push listeners and ignores invalid ones", () => {
    const { client, ports } = setup();
    const seen: string[] = [];
    client.onPush((m) => seen.push(m.type));
    client.start();
    const p = ports[0] as ReturnType<typeof fakePort>;
    p.receive({ nonsense: true });
    p.receive(frame("a", "download.progress", { jobId: "j", status: "downloading", progress: { bytesDownloaded: 1 } }));
    expect(seen).toEqual(["download.progress"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/extension/src/background/native-client.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `native-client.ts`**

```ts
import {
  type ExtensionToHostMessage,
  type HostToExtensionMessage,
  PROTOCOL_VERSION,
  parseHostMessage,
} from "@mediaforge/shared-protocol";

export interface NativePort {
  postMessage(message: unknown): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
  disconnect(): void;
}

export type ConnectionState =
  | { kind: "connecting" }
  | { kind: "not-installed" }
  | { kind: "unavailable"; message: string }
  | { kind: "incompatible" }
  | { kind: "setting-up"; tool?: string; percent?: number }
  | { kind: "ready" };

export class NativeRequestError extends Error {
  override name = "NativeRequestError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface NativeClientOptions {
  /** Open the native port. Throws when the host is not registered. */
  connect: () => NativePort;
  extensionVersion: string;
  browser: "firefox" | "chrome" | "edge";
  /** Delay before reconnect attempt N, last value repeats. */
  retryDelaysMs?: number[];
  defaultTimeoutMs?: number;
}

type MessageType = ExtensionToHostMessage["type"];

export interface NativeClient {
  state(): ConnectionState;
  onState(listener: (state: ConnectionState) => void): () => void;
  /** Every valid frame from the core, including replies. */
  onPush(listener: (message: HostToExtensionMessage) => void): () => void;
  request(
    type: MessageType,
    payload: unknown,
    options?: { timeoutMs?: number },
  ): Promise<HostToExtensionMessage>;
  start(): void;
  stop(): void;
}

const DEFAULT_RETRY_MS = [0, 1000, 2000, 4000, 8000, 16000, 30000];

interface Pending {
  resolve: (m: HostToExtensionMessage) => void;
  reject: (e: NativeRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createNativeClient(options: NativeClientOptions): NativeClient {
  const retry = options.retryDelaysMs ?? DEFAULT_RETRY_MS;
  const defaultTimeout = options.defaultTimeoutMs ?? 15000;
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const pushListeners = new Set<(m: HostToExtensionMessage) => void>();
  const pending = new Map<string, Pending>();

  let state: ConnectionState = { kind: "connecting" };
  let port: NativePort | undefined;
  let stopped = true;
  let attempt = 0;
  let heardFromCore = false;
  let helloId = "";
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let counter = 0;

  const setState = (next: ConnectionState) => {
    state = next;
    for (const l of stateListeners) l(next);
  };
  const newId = () => `ext-${++counter}-${Date.now()}`;
  const send = (type: MessageType, payload: unknown, id = newId()) => {
    port?.postMessage({ v: PROTOCOL_VERSION, id, type, payload });
    return id;
  };

  const failAll = (code: string, message: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new NativeRequestError(code, message));
      pending.delete(id);
    }
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    const delay = retry[Math.min(attempt, retry.length - 1)] ?? 30000;
    attempt++;
    retryTimer = setTimeout(open, delay);
  };

  function open() {
    if (stopped) return;
    heardFromCore = false;
    if (state.kind !== "unavailable") setState({ kind: "connecting" });
    try {
      port = options.connect();
    } catch {
      port = undefined;
      setState({ kind: "not-installed" });
      scheduleReconnect();
      return;
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    helloId = send("hello", { extensionVersion: options.extensionVersion, browser: options.browser });
  }

  function onDisconnect() {
    port = undefined;
    failAll("disconnected", "The connection to MediaForge closed.");
    if (!heardFromCore) setState({ kind: "not-installed" });
    else if (state.kind !== "unavailable") setState({ kind: "connecting" });
    scheduleReconnect();
  }

  function afterAck(m: Extract<HostToExtensionMessage, { type: "hello.ack" }>) {
    attempt = 0;
    if (m.payload.setup === "ready") setState({ kind: "ready" });
    else if (m.payload.setup === "installing") setState({ kind: "setting-up" });
    else setState({ kind: "unavailable", message: "MediaForge could not finish its setup." });
    send("jobs.subscribe", {});
    send("jobs.list", {});
  }

  function onMessage(raw: unknown) {
    const parsed = parseHostMessage(raw);
    if (!parsed.ok) return;
    const message = parsed.value;
    heardFromCore = true;

    if (message.type === "hello.ack" && message.id === helloId) afterAck(message);
    else if (message.type === "setup.progress") {
      const p = message.payload;
      if (p.state === "installing") {
        setState({
          kind: "setting-up",
          ...(p.tool && { tool: p.tool }),
          ...(p.percent !== undefined && { percent: p.percent }),
        });
      } else if (p.state === "ready") setState({ kind: "ready" });
      else setState({ kind: "unavailable", message: p.error ?? "MediaForge setup failed." });
    } else if (message.type === "error") {
      const { code, replyTo } = message.payload;
      if (replyTo === helloId && code === "invalid-message") setState({ kind: "incompatible" });
      else if (code === "core-unavailable" || code === "core-disconnected") {
        setState({ kind: "unavailable", message: message.payload.message });
      }
    }

    const waiting = pending.get(message.type === "error" ? (message.payload.replyTo ?? "") : message.id);
    if (waiting) {
      const key = message.type === "error" ? (message.payload.replyTo as string) : message.id;
      pending.delete(key);
      clearTimeout(waiting.timer);
      if (message.type === "error") {
        waiting.reject(new NativeRequestError(message.payload.code, message.payload.message));
      } else waiting.resolve(message);
    }
    for (const l of pushListeners) l(message);
  }

  return {
    state: () => state,
    onState(listener) {
      stateListeners.add(listener);
      return () => void stateListeners.delete(listener);
    },
    onPush(listener) {
      pushListeners.add(listener);
      return () => void pushListeners.delete(listener);
    },
    request(type, payload, opts) {
      if (!port) {
        return Promise.reject(new NativeRequestError("not-connected", "MediaForge is not connected."));
      }
      return new Promise((resolve, reject) => {
        const id = newId();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new NativeRequestError("timeout", "MediaForge did not answer in time."));
        }, opts?.timeoutMs ?? defaultTimeout);
        pending.set(id, { resolve, reject, timer });
        send(type, payload, id);
      });
    },
    start() {
      stopped = false;
      attempt = 0;
      open();
    },
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      failAll("stopped", "The extension is shutting down.");
      port?.disconnect();
      port = undefined;
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/extension && pnpm typecheck`
Expected: PASS. Adjust only types if the compiler forces it.

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write apps/extension/src`
Print: `✨ extension: add the native messaging client with reconnect and state`.

---

### Task 7: Detector, tab store and job mirror

**Files:**
- Create: `apps/extension/src/background/tab-store.ts`, `detector.ts`, `job-mirror.ts`
- Test: matching `*.test.ts` files

**Interfaces:**
- Consumes: `classifyRequest`, `createCandidate`, `dedupeCandidates` (`@mediaforge/extension-core`); `MediaCandidate` (`@mediaforge/shared-types`); `HostToExtensionMessage` (`@mediaforge/shared-protocol`).
- Produces:
  - `interface SessionArea { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(key: string): Promise<void> }`
  - `createTabStore(area: SessionArea): { list(tabId: number): Promise<MediaCandidate[]>; add(tabId: number, c: MediaCandidate): Promise<void>; clear(tabId: number): Promise<void>; find(tabId: number, id: string): Promise<MediaCandidate | undefined> }`
  - `createDetector(deps: { store: TabStore; getTab(tabId: number): Promise<{ url?: string; title?: string } | undefined>; now?: () => number }): { handle(details: ResponseDetails): Promise<void> }`
  - `interface MirrorJob { id: string; title?: string; status: string; percent?: number; speed?: number; outputPath?: string; error?: string; cancelled?: boolean; updatedAt: number }`
  - `createJobMirror(): { apply(m: HostToExtensionMessage): boolean; noteTitle(jobId: string, title: string): void; list(): MirrorJob[] }` (`apply` returns true when something changed).

- [ ] **Step 1: Write the failing tests**

`tab-store.test.ts`:

```ts
import type { MediaCandidate } from "@mediaforge/shared-types";
import { describe, expect, it } from "vitest";
import { createTabStore, type SessionArea } from "./tab-store.ts";

function memoryArea(): SessionArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => void Object.assign(data, items),
    remove: async (key) => void delete data[key],
  };
}

const c = (url: string, source: MediaCandidate["source"] = "network"): MediaCandidate => ({
  id: url,
  pageUrl: "https://example.com/watch",
  url,
  kind: "video",
  streamType: "progressive",
  source,
  variants: [],
  detectedAt: 1,
});

describe("tab store", () => {
  it("adds, dedupes and finds candidates per tab", async () => {
    const store = createTabStore(memoryArea());
    await store.add(1, c("https://cdn.test/a.mp4"));
    await store.add(1, c("https://cdn.test/a.mp4?range=0-10"));
    await store.add(2, c("https://cdn.test/b.mp4"));
    expect((await store.list(1)).map((x) => x.url)).toEqual(["https://cdn.test/a.mp4"]);
    expect((await store.find(2, "https://cdn.test/b.mp4"))?.url).toBe("https://cdn.test/b.mp4");
  });

  it("survives a restart because it mirrors to the session area", async () => {
    const area = memoryArea();
    await createTabStore(area).add(7, c("https://cdn.test/a.mp4"));
    const reborn = createTabStore(area);
    expect((await reborn.list(7)).map((x) => x.url)).toEqual(["https://cdn.test/a.mp4"]);
  });

  it("clears a tab", async () => {
    const area = memoryArea();
    const store = createTabStore(area);
    await store.add(3, c("https://cdn.test/a.mp4"));
    await store.clear(3);
    expect(await store.list(3)).toEqual([]);
    expect(Object.keys(area.data)).toEqual([]);
  });
});
```

`detector.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDetector } from "./detector.ts";
import { createTabStore, type SessionArea } from "./tab-store.ts";

const area = (): SessionArea => {
  const data: Record<string, unknown> = {};
  return {
    get: async (k) => (k in data ? { [k]: data[k] } : {}),
    set: async (i) => void Object.assign(data, i),
    remove: async (k) => void delete data[k],
  };
};

function setup() {
  const store = createTabStore(area());
  const detector = createDetector({
    store,
    getTab: async () => ({ url: "https://example.com/watch", title: "A page" }),
    now: () => 5,
  });
  return { store, detector };
}

const details = (url: string, contentType?: string, extra: Record<string, unknown> = {}) => ({
  url,
  tabId: 1,
  statusCode: 200,
  responseHeaders: contentType ? [{ name: "Content-Type", value: contentType }] : [],
  ...extra,
});

describe("detector", () => {
  it("records a progressive video by content type", async () => {
    const { store, detector } = setup();
    await detector.handle(details("https://cdn.test/v", "video/mp4"));
    const [c] = await store.list(1);
    expect(c).toMatchObject({
      url: "https://cdn.test/v",
      pageUrl: "https://example.com/watch",
      pageTitle: "A page",
      streamType: "progressive",
      source: "network",
      detectedAt: 5,
    });
  });

  it("records HLS and DASH manifests", async () => {
    const { store, detector } = setup();
    await detector.handle(details("https://cdn.test/master.m3u8"));
    await detector.handle(details("https://cdn.test/manifest.mpd"));
    expect((await store.list(1)).map((c) => c.streamType).sort()).toEqual(["dash", "hls"]);
  });

  it("ignores segments, range fetches, tiny files, non-media, background requests and errors", async () => {
    const { store, detector } = setup();
    await detector.handle(details("https://cdn.test/seg-1.ts"));
    await detector.handle(details("https://cdn.test/v.mp4?range=0-100"));
    await detector.handle(
      details("https://cdn.test/pixel.mp4", "video/mp4", {
        responseHeaders: [
          { name: "Content-Type", value: "video/mp4" },
          { name: "Content-Length", value: "300" },
        ],
      }),
    );
    await detector.handle(details("https://cdn.test/page.html", "text/html"));
    await detector.handle({ ...details("https://cdn.test/v.mp4", "video/mp4"), tabId: -1 });
    await detector.handle({ ...details("https://cdn.test/v.mp4", "video/mp4"), statusCode: 404 });
    expect(await store.list(1)).toEqual([]);
  });

  it("accepts a 206 partial response for a progressive file", async () => {
    const { store, detector } = setup();
    await detector.handle({ ...details("https://cdn.test/v.mp4", "video/mp4"), statusCode: 206 });
    expect(await store.list(1)).toHaveLength(1);
  });
});
```

`job-mirror.test.ts`:

```ts
import { PROTOCOL_VERSION, type HostToExtensionMessage } from "@mediaforge/shared-protocol";
import { describe, expect, it } from "vitest";
import { createJobMirror } from "./job-mirror.ts";

const msg = (type: string, payload: unknown, id = "i"): HostToExtensionMessage =>
  ({ v: PROTOCOL_VERSION, id, type, payload }) as HostToExtensionMessage;

describe("job mirror", () => {
  it("tracks progress, completion and failure", () => {
    const m = createJobMirror();
    m.noteTitle("j1", "My clip");
    expect(
      m.apply(
        msg("download.progress", {
          jobId: "j1",
          status: "downloading",
          progress: { bytesDownloaded: 50, totalBytes: 100, percent: 50, speed: 10 },
        }),
      ),
    ).toBe(true);
    expect(m.list()[0]).toMatchObject({ id: "j1", title: "My clip", status: "downloading", percent: 50 });
    m.apply(msg("download.completed", { jobId: "j1", outputPath: "C:\\v.mp4" }));
    expect(m.list()[0]).toMatchObject({ status: "completed", outputPath: "C:\\v.mp4" });
    m.apply(msg("download.failed", { jobId: "j2", error: "boom" }));
    m.apply(msg("download.failed", { jobId: "j3", error: "Cancelled.", cancelled: true }));
    expect(m.list().find((j) => j.id === "j3")).toMatchObject({ status: "cancelled" });
  });

  it("replaces its view from a snapshot and takes titles from candidates", () => {
    const m = createJobMirror();
    m.apply(
      msg("jobs.snapshot", {
        jobs: [
          {
            id: "a",
            request: {
              candidate: {
                id: "c",
                pageUrl: "https://x/",
                pageTitle: "Title A",
                url: "https://x/",
                kind: "video",
                streamType: "progressive",
                source: "dom",
                variants: [],
                detectedAt: 1,
              },
              profileId: "best",
            },
            status: "queued",
            progress: { bytesDownloaded: 0 },
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    );
    expect(m.list()).toHaveLength(1);
    expect(m.list()[0]).toMatchObject({ id: "a", title: "Title A", status: "queued" });
    m.apply(msg("jobs.snapshot", { jobs: [] }));
    expect(m.list()).toEqual([]);
  });

  it("ignores unrelated messages", () => {
    expect(createJobMirror().apply(msg("setup.progress", { state: "ready" }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/extension/src/background`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`tab-store.ts`:

```ts
import { dedupeCandidates } from "@mediaforge/extension-core";
import type { MediaCandidate } from "@mediaforge/shared-types";

/** `browser.storage.session`, or a fake in tests. */
export interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface TabStore {
  list(tabId: number): Promise<MediaCandidate[]>;
  add(tabId: number, candidate: MediaCandidate): Promise<void>;
  clear(tabId: number): Promise<void>;
  find(tabId: number, id: string): Promise<MediaCandidate | undefined>;
}

const keyOf = (tabId: number) => `candidates:${tabId}`;

export function createTabStore(area: SessionArea): TabStore {
  const memory = new Map<number, MediaCandidate[]>();
  // One chain per tab so two quick responses cannot overwrite each other's write.
  const chains = new Map<number, Promise<unknown>>();

  const load = async (tabId: number): Promise<MediaCandidate[]> => {
    const cached = memory.get(tabId);
    if (cached) return cached;
    const stored = (await area.get(keyOf(tabId)))[keyOf(tabId)];
    const list = Array.isArray(stored) ? (stored as MediaCandidate[]) : [];
    memory.set(tabId, list);
    return list;
  };

  const queue = <T>(tabId: number, task: () => Promise<T>): Promise<T> => {
    const next = (chains.get(tabId) ?? Promise.resolve()).then(task, task);
    chains.set(
      tabId,
      next.catch(() => {}),
    );
    return next;
  };

  return {
    list: (tabId) => queue(tabId, async () => [...(await load(tabId))]),
    find: (tabId, id) =>
      queue(tabId, async () => (await load(tabId)).find((c) => c.id === id)),
    add: (tabId, candidate) =>
      queue(tabId, async () => {
        const merged = dedupeCandidates([...(await load(tabId)), candidate]);
        memory.set(tabId, merged);
        await area.set({ [keyOf(tabId)]: merged });
      }),
    clear: (tabId) =>
      queue(tabId, async () => {
        memory.delete(tabId);
        await area.remove(keyOf(tabId));
      }),
  };
}
```

`detector.ts`:

```ts
import { classifyRequest, createCandidate } from "@mediaforge/extension-core";
import type { TabStore } from "./tab-store.ts";

export interface ResponseDetails {
  url: string;
  tabId: number;
  statusCode: number;
  type?: string;
  responseHeaders?: Array<{ name: string; value?: string }>;
}

export interface DetectorDeps {
  store: TabStore;
  getTab(tabId: number): Promise<{ url?: string; title?: string } | undefined>;
  now?: () => number;
}

/** Progressive responses smaller than this are tracking pixels and placeholders, not media. */
const MIN_PROGRESSIVE_BYTES = 100_000;

const header = (details: ResponseDetails, name: string): string | undefined =>
  details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;

export function createDetector(deps: DetectorDeps) {
  return {
    async handle(details: ResponseDetails): Promise<void> {
      if (details.tabId < 0) return;
      if (details.statusCode !== 200 && details.statusCode !== 206) return;
      if (details.type === "ping" || details.type === "beacon") return;

      const classification = classifyRequest(details.url, header(details, "content-type"));
      if (!classification) return;

      const length = Number(header(details, "content-length"));
      if (
        classification.streamType === "progressive" &&
        Number.isFinite(length) &&
        length > 0 &&
        length < MIN_PROGRESSIVE_BYTES
      ) {
        return;
      }

      const tab = await deps.getTab(details.tabId);
      if (!tab?.url) return;
      await deps.store.add(
        details.tabId,
        createCandidate({
          url: details.url,
          pageUrl: tab.url,
          ...(tab.title && { pageTitle: tab.title }),
          source: "network",
          classification,
          ...(header(details, "content-type") && {
            mime: header(details, "content-type")?.split(";")[0]?.trim() as string,
          }),
          ...(deps.now && { detectedAt: deps.now() }),
        }),
      );
    },
  };
}
```

`job-mirror.ts`:

```ts
import type { HostToExtensionMessage } from "@mediaforge/shared-protocol";

export interface MirrorJob {
  id: string;
  title?: string;
  status: string;
  percent?: number;
  speed?: number;
  outputPath?: string;
  error?: string;
  updatedAt: number;
}

export type JobMirrorApi = ReturnType<typeof createJobMirror>;

export function createJobMirror() {
  const jobs = new Map<string, MirrorJob>();
  const titles = new Map<string, string>();

  const merge = (id: string, patch: Partial<MirrorJob>) => {
    const title = patch.title ?? titles.get(id) ?? jobs.get(id)?.title;
    jobs.set(id, {
      ...(jobs.get(id) ?? { id, status: "queued", updatedAt: 0 }),
      ...patch,
      id,
      ...(title && { title }),
      updatedAt: Date.now(),
    });
  };

  return {
    noteTitle(jobId: string, title: string): void {
      titles.set(jobId, title);
      const existing = jobs.get(jobId);
      if (existing) jobs.set(jobId, { ...existing, title });
    },
    list(): MirrorJob[] {
      return [...jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    apply(message: HostToExtensionMessage): boolean {
      switch (message.type) {
        case "jobs.snapshot": {
          jobs.clear();
          for (const job of message.payload.jobs) {
            const title = job.request.candidate.pageTitle ?? job.request.candidate.url;
            jobs.set(job.id, {
              id: job.id,
              title,
              status: job.status,
              ...(job.progress.percent !== undefined && { percent: job.progress.percent }),
              ...(job.progress.speed !== undefined && { speed: job.progress.speed }),
              ...(job.outputPath && { outputPath: job.outputPath }),
              ...(job.error && { error: job.error }),
              updatedAt: job.updatedAt,
            });
          }
          return true;
        }
        case "download.progress": {
          const { jobId, status, progress } = message.payload;
          merge(jobId, {
            status,
            ...(progress.percent !== undefined && { percent: progress.percent }),
            ...(progress.speed !== undefined && { speed: progress.speed }),
          });
          return true;
        }
        case "download.completed":
          merge(message.payload.jobId, {
            status: "completed",
            percent: 100,
            outputPath: message.payload.outputPath,
          });
          return true;
        case "download.failed":
          merge(message.payload.jobId, {
            status: message.payload.cancelled ? "cancelled" : "failed",
            error: message.payload.error,
          });
          return true;
        default:
          return false;
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/extension && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write apps/extension/src`
Print: `✨ extension: detect media responses and keep per-tab and job state`.

---

### Task 8: Background controller and wiring

**Files:**
- Create: `apps/extension/src/background/controller.ts`, `controller.test.ts`
- Modify: `apps/extension/src/background/index.ts`

**Interfaces:**
- Consumes: `NativeClient`, `ConnectionState`, `NativeRequestError` (Task 6); `TabStore`, `JobMirror` (Task 7); `DEFAULT_PROFILE_ID` (`@mediaforge/media-profiles`).
- Produces:
  - Commands (runtime messages from popup and overlay):
    `{ kind: "getState"; tabId: number; pageUrl?: string }`, `{ kind: "probe"; tabId: number; url: string }`,
    `{ kind: "download"; tabId: number; source: { type: "candidate"; id: string } | { type: "page"; url: string; title?: string }; variantId?: string }`,
    `{ kind: "cancel"; jobId: string }`, `{ kind: "setSetting"; key: "extensionUi" | "keepRunning" | "askQuality"; value: string | boolean }`,
    `{ kind: "overlayConfig" }`, `{ kind: "overlayDownload" }` (tab taken from `sender.tab`).
  - `PopupState = { connection: ConnectionState; settings?: ExtensionSettings; candidates: MediaCandidate[]; jobs: MirrorJob[]; probe: ProbeView }` where `ProbeView = { state: "idle" } | { state: "loading" } | { state: "ready"; media: ProbedMedia } | { state: "unsupported" } | { state: "error"; message: string }`.
  - `DownloadResult = { status: "started"; jobId: string } | { status: "needs-picker"; media: ProbedMedia } | { status: "nothing" } | { status: "error"; message: string }`.
  - `createController(deps: ControllerDeps): { handle(command, sender: { tab?: { id?: number; url?: string; title?: string } }): Promise<unknown> }`; `ControllerDeps` carries `client`, `store`, `mirror`, `getCookies(url): Promise<string>`, `userAgent: string`, `now(): number`.

- [ ] **Step 1: Write the failing tests**

`controller.test.ts` (uses a scripted fake client):

```ts
import type { MediaCandidate } from "@mediaforge/shared-types";
import { PROTOCOL_VERSION, type HostToExtensionMessage } from "@mediaforge/shared-protocol";
import { describe, expect, it } from "vitest";
import { createController } from "./controller.ts";
import { createJobMirror } from "./job-mirror.ts";
import type { ConnectionState } from "./native-client.ts";
import { createTabStore, type SessionArea } from "./tab-store.ts";

const area = (): SessionArea => {
  const d: Record<string, unknown> = {};
  return {
    get: async (k) => (k in d ? { [k]: d[k] } : {}),
    set: async (i) => void Object.assign(d, i),
    remove: async (k) => void delete d[k],
  };
};

const reply = (type: string, payload: unknown, id = "r"): HostToExtensionMessage =>
  ({ v: PROTOCOL_VERSION, id, type, payload }) as HostToExtensionMessage;

const candidate: MediaCandidate = {
  id: "https://cdn.test/v.mp4",
  pageUrl: "https://example.com/watch",
  pageTitle: "A page",
  url: "https://cdn.test/v.mp4",
  kind: "video",
  streamType: "progressive",
  source: "network",
  variants: [],
  detectedAt: 1,
};

const media = {
  url: "https://example.com/watch",
  title: "Clip",
  formats: [
    { id: "137", label: "1080p", hasVideo: true, hasAudio: false },
    { id: "18", label: "360p", hasVideo: true, hasAudio: true },
  ],
};

function setup(options: { askQuality?: boolean; quality?: string; probeFails?: string } = {}) {
  const requests: Array<{ type: string; payload: any }> = [];
  const state: ConnectionState = { kind: "ready" };
  const client = {
    state: () => state,
    onState: () => () => {},
    onPush: () => () => {},
    start() {},
    stop() {},
    async request(type: string, payload: any) {
      requests.push({ type, payload });
      if (type === "settings.get") {
        return reply("settings.value", {
          extensionUi: "overlay",
          keepRunning: false,
          askQuality: options.askQuality ?? false,
          ...(options.quality && { quality: options.quality }),
        });
      }
      if (type === "media.probe") {
        if (options.probeFails) {
          const { NativeRequestError } = await import("./native-client.ts");
          throw new NativeRequestError(options.probeFails, "no");
        }
        return reply("media.info", media);
      }
      if (type === "download.start") {
        return reply("download.progress", {
          jobId: "job-1",
          status: "downloading",
          progress: { bytesDownloaded: 0 },
        });
      }
      return reply("settings.value", { extensionUi: "overlay", keepRunning: false, askQuality: false });
    },
  };
  const store = createTabStore(area());
  const mirror = createJobMirror();
  const controller = createController({
    client: client as never,
    store,
    mirror,
    getCookies: async () => "session=abc123def",
    userAgent: "UA/1.0",
    now: () => 9,
  });
  return { controller, store, mirror, requests };
}

const sender = { tab: { id: 1, url: "https://example.com/watch", title: "A page" } };

describe("controller", () => {
  it("downloads a sniffed candidate with context and the saved quality", async () => {
    const t = setup({ quality: "mp4-1080p" });
    await t.store.add(1, candidate);
    const result = await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "candidate", id: candidate.id } },
      sender,
    );
    expect(result).toEqual({ status: "started", jobId: "job-1" });
    const start = t.requests.find((r) => r.type === "download.start");
    expect(start?.payload).toMatchObject({
      profileId: "mp4-1080p",
      candidate: { url: candidate.url },
      context: {
        referer: "https://example.com/watch",
        userAgent: "UA/1.0",
        cookies: "session=abc123def",
      },
    });
    expect(t.mirror.list()[0]).toMatchObject({ id: "job-1", title: "A page" });
  });

  it("downloads a page URL without sending cookies", async () => {
    const t = setup();
    const result = await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "page", url: media.url, title: "Clip" } },
      sender,
    );
    expect(result).toEqual({ status: "started", jobId: "job-1" });
    const start = t.requests.find((r) => r.type === "download.start");
    expect(start?.payload.context).toBeUndefined();
    expect(start?.payload.candidate.url).toBe(media.url);
  });

  it("asks for a quality when askQuality is on, then downloads the picked variant", async () => {
    const t = setup({ askQuality: true });
    const first = await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "page", url: media.url } },
      sender,
    );
    expect(first).toMatchObject({ status: "needs-picker" });
    expect(t.requests.some((r) => r.type === "download.start")).toBe(false);
    const second = await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "page", url: media.url }, variantId: "137" },
      sender,
    );
    expect(second).toEqual({ status: "started", jobId: "job-1" });
    expect(t.requests.find((r) => r.type === "download.start")?.payload.variantId).toBe("137");
  });

  it("builds popup state with candidates and the probe result", async () => {
    const t = setup();
    await t.store.add(1, candidate);
    await t.controller.handle({ kind: "probe", tabId: 1, url: media.url }, sender);
    const state = (await t.controller.handle({ kind: "getState", tabId: 1, pageUrl: media.url }, sender)) as any;
    expect(state.connection.kind).toBe("ready");
    expect(state.candidates).toHaveLength(1);
    expect(state.probe).toMatchObject({ state: "ready", media: { title: "Clip" } });
  });

  it("maps an unsupported probe to the unsupported view and caches probe results", async () => {
    const t = setup({ probeFails: "unsupported-site" });
    await t.controller.handle({ kind: "probe", tabId: 1, url: media.url }, sender);
    const state = (await t.controller.handle({ kind: "getState", tabId: 1, pageUrl: media.url }, sender)) as any;
    expect(state.probe).toEqual({ state: "unsupported" });
    const before = t.requests.filter((r) => r.type === "media.probe").length;
    await t.controller.handle({ kind: "probe", tabId: 1, url: media.url }, sender);
    expect(t.requests.filter((r) => r.type === "media.probe").length).toBe(before);
  });

  it("overlay download prefers the probed page, else the newest sniffed candidate, else nothing", async () => {
    const supported = setup();
    expect(await supported.controller.handle({ kind: "overlayDownload" }, sender)).toEqual({
      status: "started",
      jobId: "job-1",
    });

    const sniffedOnly = setup({ probeFails: "unsupported-site" });
    await sniffedOnly.store.add(1, candidate);
    expect(await sniffedOnly.controller.handle({ kind: "overlayDownload" }, sender)).toEqual({
      status: "started",
      jobId: "job-1",
    });

    const empty = setup({ probeFails: "unsupported-site" });
    expect(await empty.controller.handle({ kind: "overlayDownload" }, sender)).toEqual({
      status: "nothing",
    });
  });

  it("answers overlayConfig from the extensionUi setting", async () => {
    const t = setup();
    expect(await t.controller.handle({ kind: "overlayConfig" }, sender)).toEqual({ enabled: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/extension/src/background/controller.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `controller.ts`**

```ts
import { DEFAULT_PROFILE_ID } from "@mediaforge/media-profiles";
import type { ExtensionSettings, ProbedMedia } from "@mediaforge/shared-protocol";
import type { MediaCandidate } from "@mediaforge/shared-types";
import type { JobMirrorApi, MirrorJob } from "./job-mirror.ts";
import { type ConnectionState, type NativeClient, NativeRequestError } from "./native-client.ts";
import type { TabStore } from "./tab-store.ts";

export type ProbeView =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; media: ProbedMedia }
  | { state: "unsupported" }
  | { state: "error"; message: string };

export interface PopupState {
  connection: ConnectionState;
  settings?: ExtensionSettings;
  candidates: MediaCandidate[];
  jobs: MirrorJob[];
  probe: ProbeView;
}

export type DownloadResult =
  | { status: "started"; jobId: string }
  | { status: "needs-picker"; media: ProbedMedia }
  | { status: "nothing" }
  | { status: "error"; message: string };

export type Command =
  | { kind: "getState"; tabId: number; pageUrl?: string }
  | { kind: "probe"; tabId: number; url: string }
  | {
      kind: "download";
      tabId: number;
      source: { type: "candidate"; id: string } | { type: "page"; url: string; title?: string };
      variantId?: string;
    }
  | { kind: "cancel"; jobId: string }
  | { kind: "setSetting"; key: "extensionUi" | "keepRunning" | "askQuality"; value: string | boolean }
  | { kind: "overlayConfig" }
  | { kind: "overlayDownload" };

export interface Sender {
  tab?: { id?: number; url?: string; title?: string };
}

export interface ControllerDeps {
  client: NativeClient;
  store: TabStore;
  mirror: JobMirrorApi;
  /** The Cookie header value for a URL. Called at click time only. */
  getCookies(url: string): Promise<string>;
  userAgent: string;
  now(): number;
}

const PROBE_TIMEOUT_MS = 45_000;

export function createController(deps: ControllerDeps) {
  const probes = new Map<string, ProbeView>();
  let settings: ExtensionSettings | undefined;

  const loadSettings = async (): Promise<ExtensionSettings | undefined> => {
    if (settings) return settings;
    try {
      const reply = await deps.client.request("settings.get", {});
      if (reply.type === "settings.value") settings = reply.payload;
    } catch {
      // The popup shows the connection banner; settings come back with the next state read.
    }
    return settings;
  };

  const probe = async (url: string): Promise<ProbeView> => {
    const cached = probes.get(url);
    if (cached && cached.state !== "loading") return cached;
    probes.set(url, { state: "loading" });
    let view: ProbeView;
    try {
      const reply = await deps.client.request("media.probe", { url }, { timeoutMs: PROBE_TIMEOUT_MS });
      view =
        reply.type === "media.info"
          ? { state: "ready", media: reply.payload }
          : { state: "error", message: "Unexpected reply." };
    } catch (error) {
      view =
        error instanceof NativeRequestError && error.code === "unsupported-site"
          ? { state: "unsupported" }
          : {
              state: "error",
              message: error instanceof Error ? error.message : String(error),
            };
    }
    // Transient failures are not cached, so the next open tries again.
    if (view.state === "ready" || view.state === "unsupported") probes.set(url, view);
    else probes.delete(url);
    return view;
  };

  const pageCandidate = (url: string, title: string | undefined): MediaCandidate => ({
    id: url,
    pageUrl: url,
    ...(title && { pageTitle: title }),
    url,
    kind: "video",
    streamType: "progressive",
    source: "dom",
    variants: [],
    detectedAt: deps.now(),
  });

  const start = async (
    candidate: MediaCandidate,
    options: { variantId?: string; withContext: boolean },
  ): Promise<DownloadResult> => {
    const s = await loadSettings();
    const profileId = s?.quality ?? DEFAULT_PROFILE_ID;
    let context: Record<string, string> | undefined;
    if (options.withContext) {
      const cookies = await deps.getCookies(candidate.url).catch(() => "");
      context = {
        referer: candidate.pageUrl,
        userAgent: deps.userAgent,
        ...(cookies && { cookies }),
      };
    }
    try {
      const reply = await deps.client.request("download.start", {
        candidate,
        profileId,
        ...(options.variantId && { variantId: options.variantId }),
        ...(context && { context }),
      });
      if (reply.type !== "download.progress") return { status: "error", message: "Unexpected reply." };
      const jobId = reply.payload.jobId;
      deps.mirror.noteTitle(jobId, candidate.pageTitle ?? candidate.url);
      deps.mirror.apply(reply);
      return { status: "started", jobId };
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  };

  const downloadPage = async (
    url: string,
    title: string | undefined,
    variantId: string | undefined,
  ): Promise<DownloadResult> => {
    const view = await probe(url);
    if (view.state !== "ready") return { status: "nothing" };
    const s = await loadSettings();
    if (s?.askQuality && !variantId && view.media.formats.length > 1) {
      return { status: "needs-picker", media: view.media };
    }
    return start(pageCandidate(url, title ?? view.media.title), {
      ...(variantId && { variantId }),
      withContext: false,
    });
  };

  return {
    async handle(command: Command, sender: Sender): Promise<unknown> {
      switch (command.kind) {
        case "getState": {
          const s = await loadSettings();
          const state: PopupState = {
            connection: deps.client.state(),
            ...(s && { settings: s }),
            candidates: await deps.store.list(command.tabId),
            jobs: deps.mirror.list(),
            probe: command.pageUrl ? (probes.get(command.pageUrl) ?? { state: "idle" }) : { state: "idle" },
          };
          return state;
        }
        case "probe":
          return probe(command.url);
        case "download": {
          if (command.source.type === "candidate") {
            const found = await deps.store.find(command.tabId, command.source.id);
            if (!found) return { status: "nothing" } satisfies DownloadResult;
            return start(found, { withContext: true });
          }
          return downloadPage(command.source.url, command.source.title, command.variantId);
        }
        case "cancel": {
          try {
            await deps.client.request("download.cancel", { jobId: command.jobId });
          } catch {
            // The job may have just finished; the next progress frame shows the truth.
          }
          return { ok: true };
        }
        case "setSetting": {
          try {
            const reply = await deps.client.request("settings.set", { [command.key]: command.value });
            if (reply.type === "settings.value") settings = reply.payload;
            return { ok: true, settings };
          } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
          }
        }
        case "overlayConfig": {
          const s = await loadSettings();
          return { enabled: (s?.extensionUi ?? "overlay") === "overlay" };
        }
        case "overlayDownload": {
          const tab = sender.tab;
          if (!tab?.id || !tab.url) return { status: "nothing" } satisfies DownloadResult;
          const view = await probe(tab.url);
          if (view.state === "ready") return downloadPage(tab.url, tab.title, undefined);
          const newest = (await deps.store.list(tab.id)).sort(
            (a, b) => b.detectedAt - a.detectedAt,
          )[0];
          if (!newest) return { status: "nothing" } satisfies DownloadResult;
          return start(newest, { withContext: true });
        }
      }
    },
    /** Called when a settings.value arrives from anywhere, so the cache stays current. */
    noteSettings(value: ExtensionSettings): void {
      settings = value;
    },
  };
}

export type Controller = ReturnType<typeof createController>;
```

`background/index.ts` (replaces the placeholder). Top-level, synchronous listener registration so a woken event page handles the event that woke it:

```ts
import { createDetector } from "./detector.ts";
import { createController, type Command } from "./controller.ts";
import { createJobMirror } from "./job-mirror.ts";
import { createNativeClient } from "./native-client.ts";
import { createTabStore } from "./tab-store.ts";
import { NATIVE_HOST_NAME } from "@mediaforge/shared-protocol";

const api = (globalThis as { browser?: typeof browser; chrome?: typeof browser }).browser ??
  (globalThis as { chrome: typeof browser }).chrome;

const client = createNativeClient({
  connect: () => api.runtime.connectNative(NATIVE_HOST_NAME) as never,
  extensionVersion: api.runtime.getManifest().version,
  browser: typeof (globalThis as { browser?: unknown }).browser === "undefined" ? "chrome" : "firefox",
});

const store = createTabStore(api.storage.session as never);
const mirror = createJobMirror();
const detector = createDetector({
  store,
  getTab: async (tabId) => {
    try {
      const tab = await api.tabs.get(tabId);
      return { ...(tab.url && { url: tab.url }), ...(tab.title && { title: tab.title }) };
    } catch {
      return undefined;
    }
  },
});
const controller = createController({
  client,
  store,
  mirror,
  userAgent: navigator.userAgent,
  now: () => Date.now(),
  getCookies: async (url) => {
    const cookies = await api.cookies.getAll({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  },
});

api.webRequest.onHeadersReceived.addListener(
  (details) => void detector.handle(details as never),
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) void store.clear(tabId);
});
api.tabs.onRemoved.addListener((tabId) => void store.clear(tabId));

client.onPush((message) => {
  if (message.type === "settings.value") controller.noteSettings(message.payload);
  if (mirror.apply(message)) void api.runtime.sendMessage({ kind: "stateChanged" }).catch(() => {});
});
client.onState(() => void api.runtime.sendMessage({ kind: "stateChanged" }).catch(() => {}));

api.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const command = raw as Command;
  if (!command || typeof command !== "object" || !("kind" in command)) return false;
  void controller
    .handle(command, sender as never)
    .then(sendResponse, (e) => sendResponse({ status: "error", message: String(e) }));
  return true;
});

client.start();
```

(`webRequest.onHeadersReceived` details include `tabId`, `url`, `statusCode`, `type`, `responseHeaders`. On Chromium add `"extraHeaders"` is not needed for response headers read.) Adjust only types if the compiler forces it.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/extension && pnpm typecheck && pnpm --filter @mediaforge/extension build`
Expected: PASS; build succeeds.

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write apps/extension/src`
Print: `✨ extension: add the background controller and wire the event page`.

---

### Task 9: Popup

**Files:**
- Create: `apps/extension/src/popup/model.ts`, `model.test.ts`
- Modify: `apps/extension/src/popup/index.ts`

**Interfaces:**
- Consumes: `PopupState`, `DownloadResult`, `Command` (Task 8).
- Produces: `buildPopupModel(state: PopupState | undefined, picker?: ProbedMedia): PopupModel`:
  `PopupModel = { banner?: { tone: "info" | "warn" | "error"; text: string; link?: { label: string; href: string } }; items: ItemModel[]; picker?: { title: string; formats: Array<{ id: string; label: string; detail: string }> }; jobs: JobRow[]; toggles: { overlay: boolean; keepRunning: boolean } | undefined }`.
  `ItemModel = { key: string; title: string; detail: string; action: { type: "candidate"; id: string } | { type: "page"; url: string; title?: string } }`.
  `JobRow = { id: string; title: string; status: string; percentText: string; active: boolean; error?: string }`.

- [ ] **Step 1: Write the failing tests**

`model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PopupState } from "../background/controller.ts";
import { buildPopupModel } from "./model.ts";

const base: PopupState = {
  connection: { kind: "ready" },
  settings: { extensionUi: "overlay", keepRunning: false, askQuality: false },
  candidates: [],
  jobs: [],
  probe: { state: "idle" },
};

describe("buildPopupModel", () => {
  it("shows an install banner when the host is missing", () => {
    const m = buildPopupModel({ ...base, connection: { kind: "not-installed" } });
    expect(m.banner?.tone).toBe("warn");
    expect(m.banner?.text).toMatch(/install MediaForge/i);
    expect(m.items).toEqual([]);
  });

  it("shows setup progress", () => {
    const m = buildPopupModel({ ...base, connection: { kind: "setting-up", tool: "ffmpeg", percent: 40.4 } });
    expect(m.banner?.text).toMatch(/Setting up MediaForge/);
    expect(m.banner?.text).toMatch(/40%/);
  });

  it("asks for an update when the core is incompatible, and reports unavailable", () => {
    expect(buildPopupModel({ ...base, connection: { kind: "incompatible" } }).banner?.text).toMatch(
      /Update MediaForge/,
    );
    expect(
      buildPopupModel({ ...base, connection: { kind: "unavailable", message: "no" } }).banner?.tone,
    ).toBe("error");
  });

  it("lists the probed page first, then sniffed candidates, with readable details", () => {
    const m = buildPopupModel({
      ...base,
      candidates: [
        {
          id: "c1",
          pageUrl: "https://e.test/",
          url: "https://cdn.test/v.m3u8",
          kind: "video",
          streamType: "hls",
          source: "network",
          variants: [],
          detectedAt: 1,
        },
      ],
      probe: {
        state: "ready",
        media: { url: "https://e.test/", title: "Clip", durationSec: 125, formats: [] },
      },
    });
    expect(m.items.map((i) => i.action.type)).toEqual(["page", "candidate"]);
    expect(m.items[0]?.title).toBe("Clip");
    expect(m.items[0]?.detail).toMatch(/2:05/);
    expect(m.items[1]?.detail).toMatch(/HLS/);
  });

  it("builds a picker with sizes when one is needed", () => {
    const m = buildPopupModel(base, {
      url: "https://e.test/",
      title: "Clip",
      formats: [{ id: "137", label: "1080p", container: "mp4", hasVideo: true, hasAudio: false, approxBytes: 5_242_880 }],
    });
    expect(m.picker?.formats[0]).toMatchObject({ id: "137", label: "1080p" });
    expect(m.picker?.formats[0]?.detail).toMatch(/mp4/);
    expect(m.picker?.formats[0]?.detail).toMatch(/5\.0 MB|5 MB/);
  });

  it("describes jobs and marks active ones", () => {
    const m = buildPopupModel({
      ...base,
      jobs: [
        { id: "a", title: "One", status: "downloading", percent: 42.2, updatedAt: 2 },
        { id: "b", title: "Two", status: "failed", error: "boom", updatedAt: 1 },
      ],
    });
    expect(m.jobs[0]).toMatchObject({ id: "a", percentText: "42%", active: true });
    expect(m.jobs[1]).toMatchObject({ id: "b", active: false, error: "boom" });
  });

  it("exposes the two toggles from settings, and nothing before settings arrive", () => {
    expect(buildPopupModel(base).toggles).toEqual({ overlay: true, keepRunning: false });
    expect(buildPopupModel({ ...base, settings: undefined }).toggles).toBeUndefined();
  });

  it("handles no state at all", () => {
    expect(buildPopupModel(undefined).items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/extension/src/popup`
Expected: FAIL.

- [ ] **Step 3: Implement `model.ts` and `index.ts`**

`model.ts`:

```ts
import type { ProbedMedia } from "@mediaforge/shared-protocol";
import type { PopupState } from "../background/controller.ts";

export interface ItemModel {
  key: string;
  title: string;
  detail: string;
  action: { type: "candidate"; id: string } | { type: "page"; url: string; title?: string };
}

export interface JobRow {
  id: string;
  title: string;
  status: string;
  percentText: string;
  active: boolean;
  error?: string;
}

export interface PopupModel {
  banner?: { tone: "info" | "warn" | "error"; text: string; link?: { label: string; href: string } };
  items: ItemModel[];
  picker?: {
    title: string;
    formats: Array<{ id: string; label: string; detail: string }>;
  };
  jobs: JobRow[];
  toggles?: { overlay: boolean; keepRunning: boolean };
}

const INSTALL_URL = "https://github.com/N-Berns/mediaforge/releases/latest";

function duration(seconds: number | undefined): string {
  if (seconds === undefined) return "";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

const ACTIVE = new Set(["queued", "downloading", "processing"]);

export function buildPopupModel(state: PopupState | undefined, picker?: ProbedMedia): PopupModel {
  const model: PopupModel = { items: [], jobs: [] };
  if (!state) return model;

  switch (state.connection.kind) {
    case "not-installed":
      model.banner = {
        tone: "warn",
        text: "Install MediaForge to download from this browser.",
        link: { label: "Get MediaForge", href: INSTALL_URL },
      };
      return model;
    case "incompatible":
      model.banner = {
        tone: "warn",
        text: "Update MediaForge: this extension is newer than the app on your computer.",
        link: { label: "Get MediaForge", href: INSTALL_URL },
      };
      return model;
    case "unavailable":
      model.banner = { tone: "error", text: state.connection.message };
      return model;
    case "connecting":
      model.banner = { tone: "info", text: "Connecting to MediaForge…" };
      return model;
    case "setting-up": {
      const pct = state.connection.percent;
      model.banner = {
        tone: "info",
        text: `Setting up MediaForge…${pct !== undefined ? ` ${Math.round(pct)}%` : ""}`,
      };
      break;
    }
    case "ready":
      break;
  }

  if (state.probe.state === "ready") {
    const { media } = state.probe;
    model.items.push({
      key: `page:${media.url}`,
      title: media.title ?? "This page",
      detail: ["Page video", duration(media.durationSec)].filter(Boolean).join(" · "),
      action: { type: "page", url: media.url, ...(media.title && { title: media.title }) },
    });
  }
  for (const c of state.candidates) {
    const kind = c.streamType === "progressive" ? "File" : c.streamType.toUpperCase();
    const container = c.variants[0]?.container ?? "";
    model.items.push({
      key: `candidate:${c.id}`,
      title: c.pageTitle ?? c.url,
      detail: [kind, container, c.kind].filter(Boolean).join(" · "),
      action: { type: "candidate", id: c.id },
    });
  }

  if (picker) {
    model.picker = {
      title: picker.title ?? "Choose a quality",
      formats: picker.formats.map((f) => ({
        id: f.id,
        label: f.label,
        detail: [f.container, f.approxBytes ? megabytes(f.approxBytes) : "", f.hasVideo ? "" : "audio only"]
          .filter(Boolean)
          .join(" · "),
      })),
    };
  }

  model.jobs = state.jobs.map((j) => ({
    id: j.id,
    title: j.title ?? j.id,
    status: j.status,
    percentText: j.percent !== undefined ? `${Math.round(j.percent)}%` : "",
    active: ACTIVE.has(j.status),
    ...(j.error && { error: j.error }),
  }));

  if (state.settings) {
    model.toggles = {
      overlay: state.settings.extensionUi === "overlay",
      keepRunning: state.settings.keepRunning,
    };
  }
  return model;
}
```

`index.ts` (DOM rendering; thin and manually verified). Text is set with `textContent` only; never `innerHTML`:

```ts
import type { PopupState } from "../background/controller.ts";
import { buildPopupModel, type PopupModel } from "./model.ts";
import type { ProbedMedia } from "@mediaforge/shared-protocol";

const api = (globalThis as { browser?: typeof browser; chrome?: typeof browser }).browser ??
  (globalThis as { chrome: typeof browser }).chrome;

const app = document.getElementById("app") as HTMLElement;
let tabId = -1;
let tabUrl = "";
let picker: { media: ProbedMedia; source: { type: "page"; url: string; title?: string } } | undefined;

const send = <T>(command: unknown): Promise<T> => api.runtime.sendMessage(command) as Promise<T>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { text?: string; className?: string; attrs?: Record<string, string> } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.text !== undefined) node.textContent = props.text;
  if (props.className) node.className = props.className;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const child of children) node.append(child);
  return node;
}

function render(model: PopupModel): void {
  const nodes: Node[] = [];
  if (model.banner) {
    const banner = el("div", { className: "banner", text: model.banner.text, attrs: { "data-tone": model.banner.tone } });
    if (model.banner.link) {
      const link = el("a", { text: model.banner.link.label, attrs: { href: model.banner.link.href, target: "_blank", rel: "noreferrer" } });
      banner.append(" ", link);
    }
    nodes.push(banner);
  }

  if (model.picker && picker) {
    nodes.push(el("h2", { text: model.picker.title }));
    for (const f of model.picker.formats) {
      const button = el("button", { text: "Download" });
      button.addEventListener("click", () => void download(picker?.source as never, f.id));
      nodes.push(
        el("div", { className: "row" }, el("div", {}, el("div", { text: f.label }), el("div", { className: "sub", text: f.detail })), button),
      );
    }
  } else {
    if (model.items.length > 0) nodes.push(el("h2", { text: "On this page" }));
    for (const item of model.items) {
      const button = el("button", { text: "Download" });
      button.addEventListener("click", () => void download(item.action));
      nodes.push(
        el("div", { className: "row" }, el("div", {}, el("div", { text: item.title }), el("div", { className: "sub", text: item.detail })), button),
      );
    }
  }

  if (model.jobs.length > 0) nodes.push(el("h2", { text: "Downloads" }));
  for (const job of model.jobs) {
    const row = el("div", {}, el("div", { className: "row" }, el("div", { text: job.title }), el("div", { text: job.error ?? (job.percentText || job.status) })));
    if (job.active) {
      const bar = el("progress", { attrs: { max: "100", value: job.percentText ? String(parseInt(job.percentText, 10)) : "0" } });
      const cancel = el("button", { text: "Cancel" });
      cancel.addEventListener("click", () => void send({ kind: "cancel", jobId: job.id }));
      row.append(bar, cancel);
    }
    nodes.push(row);
  }

  if (model.toggles) {
    nodes.push(toggle("Download button on videos", model.toggles.overlay, (v) => setting("extensionUi", v ? "overlay" : "popup")));
    nodes.push(toggle("Keep MediaForge running", model.toggles.keepRunning, (v) => setting("keepRunning", v)));
  }
  app.replaceChildren(...nodes);
}

function toggle(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
  const input = el("input", { attrs: { type: "checkbox" } });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return el("label", { className: "toggle" }, input, el("span", { text: label }));
}

async function setting(key: string, value: string | boolean): Promise<void> {
  await send({ kind: "setSetting", key, value });
  await refresh();
}

async function download(
  source: { type: "candidate"; id: string } | { type: "page"; url: string; title?: string },
  variantId?: string,
): Promise<void> {
  const result = await send<{ status: string; media?: ProbedMedia; message?: string }>({
    kind: "download",
    tabId,
    source,
    ...(variantId && { variantId }),
  });
  if (result.status === "needs-picker" && result.media && source.type === "page") {
    picker = { media: result.media, source };
  } else {
    picker = undefined;
  }
  await refresh(result.status === "error" ? result.message : undefined);
}

async function refresh(errorText?: string): Promise<void> {
  const state = await send<PopupState>({ kind: "getState", tabId, pageUrl: tabUrl });
  const model = buildPopupModel(state, picker?.media);
  if (errorText) model.banner = { tone: "error", text: errorText };
  render(model);
}

async function init(): Promise<void> {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? -1;
  tabUrl = tab?.url ?? "";
  if (tabId >= 0) {
    await refresh();
    if (/^https?:\/\//i.test(tabUrl)) {
      await send({ kind: "probe", tabId, url: tabUrl });
      await refresh();
    }
  } else {
    render(buildPopupModel(undefined));
  }
  api.runtime.onMessage.addListener((message: unknown) => {
    if ((message as { kind?: string })?.kind === "stateChanged") void refresh();
  });
}

void init();
```

Note: `probe` is sent only for http(s) tabs, so `about:` and `moz-extension:` pages show no items and no error (Review Focus).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/extension && pnpm typecheck && pnpm --filter @mediaforge/extension build`
Expected: PASS; build succeeds.

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write apps/extension/src`
Print: `✨ extension: add the toolbar popup`.

---

### Task 10: Overlay content script

**Files:**
- Create: `apps/extension/src/content/overlay-logic.ts`, `overlay-logic.test.ts`
- Modify: `apps/extension/src/content/overlay.ts`

**Interfaces:**
- Produces: `isWorthOverlay(rect: { width: number; height: number }, hidden: boolean): boolean`; `placeButton(rect: { top: number; left: number; width: number; height: number }, scroll: { x: number; y: number }, button: { width: number; height: number }): { top: number; left: number }`; the content script messages `{ kind: "overlayConfig" }` and `{ kind: "overlayDownload" }` only.

- [ ] **Step 1: Write the failing tests**

`overlay-logic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isWorthOverlay, placeButton } from "./overlay-logic.ts";

describe("isWorthOverlay", () => {
  it("accepts a real player and rejects tiny or hidden elements", () => {
    expect(isWorthOverlay({ width: 640, height: 360 }, false)).toBe(true);
    expect(isWorthOverlay({ width: 120, height: 80 }, false)).toBe(false);
    expect(isWorthOverlay({ width: 640, height: 360 }, true)).toBe(false);
  });
});

describe("placeButton", () => {
  it("puts the button in the top-right corner of the element, in page coordinates", () => {
    expect(
      placeButton(
        { top: 100, left: 50, width: 640, height: 360 },
        { x: 0, y: 200 },
        { width: 90, height: 28 },
      ),
    ).toEqual({ top: 308, left: 590 - 8 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/extension/src/content`
Expected: FAIL.

- [ ] **Step 3: Implement**

`overlay-logic.ts`:

```ts
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;
const INSET = 8;

export function isWorthOverlay(rect: { width: number; height: number }, hidden: boolean): boolean {
  return !hidden && rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT;
}

/** Top-right corner of the element, inset a little, in document coordinates. */
export function placeButton(
  rect: { top: number; left: number; width: number; height: number },
  scroll: { x: number; y: number },
  button: { width: number; height: number },
): { top: number; left: number } {
  return {
    top: rect.top + scroll.y + INSET,
    left: rect.left + scroll.x + rect.width - button.width - INSET,
  };
}
```

`overlay.ts`:

```ts
import { isWorthOverlay, placeButton } from "./overlay-logic.ts";

const api = (globalThis as { browser?: typeof browser; chrome?: typeof browser }).browser ??
  (globalThis as { chrome: typeof browser }).chrome;

// The host element carries no page-visible text; the button lives in a closed shadow root so page
// styles and scripts cannot reach it. The only data sent to the background is the command kind;
// the background takes the tab from the message sender, never from the page.
let host: HTMLElement | undefined;
let button: HTMLButtonElement | undefined;
let target: HTMLMediaElement | undefined;
let enabled = false;

function ensureButton(): HTMLButtonElement {
  if (button && host) return button;
  host = document.createElement("div");
  host.style.cssText = "position:absolute;z-index:2147483647;top:0;left:0;";
  const root = host.attachShadow({ mode: "closed" });
  button = document.createElement("button");
  button.textContent = "Download";
  button.style.cssText =
    "font:600 12px system-ui,sans-serif;padding:5px 10px;border:0;border-radius:6px;background:#1a73e8;color:#fff;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.4);";
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (!button) return;
    button.textContent = "Sending…";
    const result = (await api.runtime
      .sendMessage({ kind: "overlayDownload" })
      .catch(() => ({ status: "error" }))) as { status: string };
    button.textContent =
      result.status === "started" ? "Started" : result.status === "needs-picker" ? "Open MediaForge" : "Nothing found";
    setTimeout(() => {
      if (button) button.textContent = "Download";
    }, 2000);
  });
  root.append(button);
  document.documentElement.append(host);
  return button;
}

function hide(): void {
  host?.remove();
  host = undefined;
  button = undefined;
  target = undefined;
}

function show(media: HTMLMediaElement): void {
  const rect = media.getBoundingClientRect();
  const hidden = getComputedStyle(media).visibility === "hidden" || media.offsetParent === null;
  if (!isWorthOverlay(rect, hidden)) {
    if (target === media) hide();
    return;
  }
  const b = ensureButton();
  target = media;
  const pos = placeButton(
    rect,
    { x: window.scrollX, y: window.scrollY },
    { width: b.offsetWidth || 90, height: b.offsetHeight || 28 },
  );
  if (host) {
    host.style.top = `${pos.top}px`;
    host.style.left = `${pos.left}px`;
  }
}

function onPointer(event: Event): void {
  if (!enabled) return;
  const media = (event.target as Element | null)?.closest?.("video, audio") as
    | HTMLMediaElement
    | null
    | undefined;
  if (media) show(media);
}

async function init(): Promise<void> {
  const config = (await api.runtime
    .sendMessage({ kind: "overlayConfig" })
    .catch(() => ({ enabled: false }))) as { enabled: boolean };
  enabled = config.enabled;
  if (!enabled) return;
  document.addEventListener("mouseover", onPointer, { passive: true, capture: true });
  window.addEventListener("scroll", () => target && show(target), { passive: true });
}

void init();
```

Note: the overlay appears on hover over a media element, which also keeps it out of the way on pages with many players. A setting change takes effect on the next page load; the popup toggle copy does not promise otherwise.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/extension && pnpm typecheck && pnpm --filter @mediaforge/extension build`
Expected: PASS; build succeeds.

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write apps/extension/src`
Print: `✨ extension: add the in-page download button`.

---

### Task 11: Dev registration script, checklist and spec sync

**Files:**
- Create: `tools/dev/register-native-host.mjs`, `tools/dev/register-native-host.test.mjs`, `docs/superpowers/manual-checklist-extension.md`
- Modify: `docs/superpowers/specs/2026-10-14-browser-extension-design.md` (record the two plan deviations below)

**Interfaces:**
- Produces: `buildHostManifest({ exePath, addonId, hostName }): object`; CLI `node tools/dev/register-native-host.mjs [--exe <path>] [--uninstall]`.

- [ ] **Step 1: Write the failing test**

`tools/dev/register-native-host.test.mjs`:

```js
import { describe, expect, it } from "vitest";
import { buildHostManifest, buildWrapperCmd } from "./register-native-host.mjs";

describe("buildHostManifest", () => {
  it("allows only the MediaForge add-on and points at the executable", () => {
    expect(
      buildHostManifest({
        exePath: "C:\\mf\\host.cmd",
        addonId: "mediaforge@n-berns",
        hostName: "com.mediaforge.host",
      }),
    ).toEqual({
      name: "com.mediaforge.host",
      description: "MediaForge native messaging host",
      path: "C:\\mf\\host.cmd",
      type: "stdio",
      allowed_extensions: ["mediaforge@n-berns"],
    });
  });
});

describe("buildWrapperCmd", () => {
  it("runs the built CLI in relay mode and forwards the browser's arguments", () => {
    const cmd = buildWrapperCmd({ nodePath: "C:\\node\\node.exe", mainJs: "C:\\r\\apps\\desktop\\dist\\main.js" });
    expect(cmd).toContain('"C:\\node\\node.exe" "C:\\r\\apps\\desktop\\dist\\main.js" --native-host');
    expect(cmd).toContain("%*");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tools/dev`
Expected: FAIL.

- [ ] **Step 3: Implement `tools/dev/register-native-host.mjs`**

```js
// Registers MediaForge as a Firefox native messaging host for development, until the installer
// (sub-project 4) does it. Windows only.
//   node tools/dev/register-native-host.mjs            # uses the built CLI through node
//   node tools/dev/register-native-host.mjs --exe C:\path\MediaForge.exe
//   node tools/dev/register-native-host.mjs --uninstall
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.mediaforge.host";
const ADDON_ID = "mediaforge@n-berns";
const REG_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;

export function buildHostManifest({ exePath, addonId, hostName }) {
  return {
    name: hostName,
    description: "MediaForge native messaging host",
    path: exePath,
    type: "stdio",
    allowed_extensions: [addonId],
  };
}

/** A manifest `path` cannot carry arguments, so development uses a small wrapper script. */
export function buildWrapperCmd({ nodePath, mainJs }) {
  return `@echo off\r\n"${nodePath}" "${mainJs}" --native-host %*\r\n`;
}

function main() {
  const args = process.argv.slice(2);
  if (process.platform !== "win32") throw new Error("This dev script supports Windows only.");

  if (args.includes("--uninstall")) {
    try {
      execFileSync("reg.exe", ["delete", REG_KEY, "/f"], { stdio: "inherit" });
    } catch {
      console.log("Nothing to remove.");
    }
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(here, "..", "..");
  const outDir = join(repo, "apps", "extension", ".dev");
  mkdirSync(outDir, { recursive: true });

  const exeArg = args.indexOf("--exe");
  let hostPath;
  if (exeArg >= 0) {
    hostPath = resolve(args[exeArg + 1]);
  } else {
    hostPath = join(outDir, "mediaforge-host.cmd");
    writeFileSync(
      hostPath,
      buildWrapperCmd({
        nodePath: process.execPath,
        mainJs: join(repo, "apps", "desktop", "dist", "main.js"),
      }),
    );
  }

  const manifestPath = join(outDir, `${HOST_NAME}.json`);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(buildHostManifest({ exePath: hostPath, addonId: ADDON_ID, hostName: HOST_NAME }), null, 2)}\n`,
  );
  execFileSync("reg.exe", ["add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], {
    stdio: "inherit",
  });
  console.log(`Registered ${HOST_NAME} -> ${hostPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
```

`docs/superpowers/manual-checklist-extension.md`:

```markdown
# Extension manual checklist (Firefox)

Run after `pnpm --filter @mediaforge/desktop build`, `pnpm --filter @mediaforge/extension build`,
and `node tools/dev/register-native-host.mjs`. Load `apps/extension/dist/firefox/manifest.json`
from `about:debugging` as a temporary add-on.

- [ ] Popup on a normal page with the core stopped: banner shows "Connecting…", then the core
      starts and the banner disappears (no console window appears).
- [ ] With the host unregistered (`--uninstall`): popup shows "Install MediaForge".
- [ ] First run with no tools in the cache folder: "Setting up MediaForge… N%" counts up, then clears.
- [ ] A page with a plain `<video src=*.mp4>`: item appears in the popup and downloads to the
      Video folder; progress and completion show in the popup.
- [ ] A YouTube watch page: "Page video" appears with the title and duration; a download starts.
- [ ] With `askQuality` on: a picker with sizes appears; the chosen format is downloaded.
- [ ] A site yt-dlp does not know, with an HLS stream: the HLS item appears and downloads; a 403
      stream that needs cookies downloads (login required site).
- [ ] The overlay button appears on hover over a large video, works, and is absent after turning
      the toggle off and reloading the page.
- [ ] Close the popup mid-download, reopen: the job is still listed with progress.
- [ ] Leave the browser idle for 5 minutes with the popup closed, reopen: candidates for the open
      tab are still listed (event page suspension).
- [ ] Kill `MediaForge` (core) mid-download: popup reconnects and lists jobs; no duplicates.
- [ ] `about:blank` and `about:addons`: popup shows no items and no error.
- [ ] A private window with the add-on not allowed: nothing is detected.
- [ ] Inspect `storage.session` and the core's config folder: no cookie value is stored anywhere.
```

- [ ] **Step 4: Sync the spec**

In `docs/superpowers/specs/2026-10-14-browser-extension-design.md` update these three points so spec and plan agree: (1) the detector note says "notes Referer and User-Agent it saw", change to "the Referer is the tab's page URL and the User-Agent is the browser's, taken at click time; request headers are not captured"; (2) add the `unavailable` state to the Errors table (relay says the core could not start: "MediaForge could not be started"); (3) add `askQuality` to the settings the extension may read and write.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm exec vitest run && pnpm typecheck && node_modules/.bin/biome check .`
Expected: all PASS.

- [ ] **Step 6: Print commit message**

Print: `🔨 tools: add a dev script to register the Firefox native host`.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| Layout, esbuild, manifest per browser | 5 |
| Native client, states, reconnect, timeouts | 6 |
| Detector, tab store, session mirror | 7 |
| Job mirror, resync after reconnect | 6 (resync via jobs.list on ack), 7 |
| Controller, click flow with askQuality, probe cache | 8 |
| `media.probe`/`media.info`, generic excluded, variant resolution | 1, 2 |
| Context forwarding, validation, redaction | 3 |
| Firefox relay detection | 4 |
| Popup banners, items, picker, jobs, toggles | 9 |
| Overlay | 10 |
| Dev registration and manual checklist | 11 |

**Deviations from the spec, recorded in Task 11:** Referer is the page URL and User-Agent the browser's (request headers are not captured); an `unavailable` connection state is added; `askQuality` joins the extension-readable settings.

**Known limits:** the Chromium target builds but its host registration and ID are sub-project 4; overlay setting changes apply on next page load; probes run without cookies.

**Placeholder scan:** none.

**Type consistency:** `PopupState`, `ProbeView`, `Command`, `DownloadResult` are defined once in `controller.ts` (Task 8) and imported by the popup (Task 9). `ProbedMedia` and `ProbedFormat` come from shared-protocol (Task 1). `RequestContext` is defined in `engine/args.ts` (Task 3) and validated by the core service; the extension sends the same four field names as plain JSON.
