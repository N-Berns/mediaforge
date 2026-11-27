# Downloads Manager, Phase 3a: Units, Speed Unit and Bandwidth Limits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sizes and speeds use decimal units everywhere in the exe, the user picks bytes or bits per second, and the core caps download speed with a global preset split across running jobs plus per-job overrides, set from the Settings screen.

**Architecture:** `shared-types` gains runtime unit helpers (`formatBytes`, `formatRate`, `parseRate`) and the preset types. The engine passes `--limit-rate` and can restart a running yt-dlp without clients seeing it. A new `Bandwidth` controller in the core works out each downloading job's cap from the settings and the job overrides, and restarts running jobs 3 s after the last change. The Settings screen gets a speed unit row and a Bandwidth limit screen.

**Tech Stack:** TypeScript (Node 24, ESM), zod 4 (in `shared-protocol` only), vitest, Ink 8 + React 19, Biome, pnpm workspaces.

**Spec:** [docs/superpowers/specs/2026-10-15-downloads-manager-design.md](../specs/2026-10-15-downloads-manager-design.md), sections Bandwidth, Units, Protocol (`download.setLimit`, settings fields) and Desktop changes (Settings screen). Phase 3 is split in three plans: **3a** (this one), **3b** (the manager screen, keyboard only, and attention), **3c** (mouse). Phases 1 and 2 are done.

## Decisions taken in this plan

E1 to E5 were confirmed by the user on 2026-10-16. E6 to E12 are this plan's recommended answers; change any of them before execution starts.

| #              | Question                                    | This plan does                                                                                                                                                                                                                    | Why                                                                                                      |
| -------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| E1 (confirmed) | Relay sends `limits` in `settings.set`      | Error code `forbidden`. The relay may set `speedUnit` and `limitPreset`.                                                                                                                                                          | Spec: preset values are edited in the exe only.                                                          |
| E2 (confirmed) | How the user types "unlimited"              | An empty field or `0` saves `null`. The field hint says "Empty or 0 for no limit".                                                                                                                                                | Fast to type, and impossible to mistake for a real limit.                                                |
| E3 (confirmed) | Settings layout                             | Rows "Speed unit" (Enter toggles) and "Bandwidth limit" (opens a screen: the four presets with their values; Enter makes one active, `e` edits its value).                                                                        | One place for everything about limits.                                                                   |
| E4 (confirmed) | What clients see during a limit restart     | Nothing: the status stays `downloading`, the job keeps its slot, no `download.paused`.                                                                                                                                            | A limit change must not look like the user paused anything.                                              |
| E5 (confirmed) | Where the speed unit applies in the exe     | Everywhere: menu screens and the `mediaforge download` progress line.                                                                                                                                                             | Spec: "Applies to the exe and the popup."                                                                |
| E6             | `download.setLimit` and roles               | Allowed for relay and terminal connections. Completed and cancelled jobs fail with "Finished downloads have no limit."; unknown ids with "No such download.".                                                                     | Only `jobs.trash` is terminal only (phase 2, D3). A finished job has nothing to limit.                   |
| E7             | Telling clients about a new override        | After `download.setLimit`, subscribers get a fresh `jobs.snapshot`, as after a removal.                                                                                                                                           | Progress pushes do not carry `limitOverride`; the snapshot already does.                                 |
| E8             | New settings fields in the protocol         | `speedUnit`, `limitPreset` and `limits` are optional in `ExtensionSettingsSchema`. The core always sends them.                                                                                                                    | `PROTOCOL_VERSION` stays 3. A phase 4 popup talking to a phase 2 core must still parse `settings.value`. |
| E9             | Smallest share of the global cap            | `max(1, floor(G / n))` bytes per second.                                                                                                                                                                                          | yt-dlp rejects a rate of 0.                                                                              |
| E10            | Largest accepted rate                       | 1 PB/s (`1e15` bytes per second), in `parseRate` and in `sanitizeSettings`.                                                                                                                                                       | The largest unit the spec names.                                                                         |
| E11            | Which values `parseRate` reads              | A number (`.` or `,` decimals), an optional prefix (`k M G T P`, any case), an optional unit: `B/s` or `B` for bytes, `bps`, `b/s`, `bit/s` or `b` for bits. No unit means the current speed unit. No prefix and no unit means M. | Covers `5`, `5 MB/s`, `40 Mbps`, `500k`. `B` and `b` differ by case, as in the units shown.              |
| E12            | A restart that lands just as yt-dlp exits 0 | The download completes normally.                                                                                                                                                                                                  | Same rule as a pause in phase 2 (review focus 1).                                                        |

## Global Constraints

- Platforms: Windows and Linux. No macOS-specific code.
- Byte convention: decimal (×1000) for sizes and speeds: kB, MB, GB, TB, PB and kbps, Mbps, Gbps, Tbps, Pbps.
- `formatBytes(bytes)`: B, kB, MB, GB, TB, PB in ×1000 steps.
- `formatRate(bytesPerSec, unit)`: with `bytes`, B/s to PB/s; with `bits`, bps, kbps, Mbps, Gbps, Tbps, Pbps, all in ×1000 steps.
- Both formatters pick the largest unit whose value is at least 1. One decimal under 100, none from 100 up (`6.1 MB/s`, `48.8 Mbps`, `120 Mbps`). Whole bytes and bits show no decimal.
- `parseRate(text, unit)`: reads `5`, `5 MB/s`, `40 Mbps`; a bare number uses the current unit's M prefix.
- The existing `formatBytes` in `apps/desktop/src/progress-view.ts` (×1024, labeled KB) is replaced; all its callers switch to decimal sizes.
- Setting `speedUnit: "bytes" | "bits"`, default `bytes`.
- Settings `limitPreset: "high" | "med" | "low" | "custom"`, default `"high"`. `limits` in bytes per second, `null` = unlimited: high `null`, med `5_000_000`, low `1_000_000`, custom `null`.
- Global split: the active preset's value G is divided evenly across running jobs that have no override: each gets `floor(G / n)`. Unlimited means no `--limit-rate`.
- Per-job override `limitOverride: "high" | "med" | "low" | "custom"`: that preset's value is the job's own cap, outside the global split.
- When a running job's cap changes (preset change, override change, a job starting or finishing), the core restarts it with the new `--limit-rate` (pause, then resume; no data is lost). Restarts are debounced by 3 s so a burst of changes restarts each job once. Jobs in `processing` (ffmpeg) are not limited or restarted.
- Values are stored in bytes per second. The UI shows and accepts them in the chosen speed unit.
- `download.setLimit` `{ jobIds: string[], preset: Preset | null }`: sets or clears the per-job override. Batch reply: `jobs.result` `{ failed: Array<{ jobId, message }> }`.
- `ExtensionSettingsSchema` gains `speedUnit`, `limitPreset` and `limits`, so `settings.get`, `settings.set` and `settings.value` carry them.
- Paths and arguments are passed as process arguments, never interpolated into scripts.
- Repo rules: never run `git commit`. Each task's last step prints a commit message for the user, in the format from `CLAUDE.md`. Run `pnpm exec biome check --write <paths>` on files changed through Bash. Run `pnpm lint` before finishing.

## Review Focus

1. **A limit restart racing a pause, a cancel or the end of the download.** A pause or cancel during a restart wins; a restart that lands after yt-dlp exited 0 still completes the job; the work folder is never removed by a restart. Tests in Task 4.
2. **A burst of changes (several jobs starting, then a preset change).** Each running job restarts at most once, 3 s after the last change, and a job whose cap ends up unchanged is not restarted. Tests in Task 5.
3. **A job that moves to `processing` while a restart is pending.** It is not restarted and its ffmpeg step is not killed. Test in Task 5.
4. **Rounding at unit boundaries.** `999.96 kB` shows as `1.0 MB`, `99.96 MB` as `100 MB`, never `1000 kB` or `100.0 MB`. Tests in Task 1.
5. **A hand-edited `config.json` with bad limits** (negative, text, huge, unknown preset). Each bad value falls back to its default; the rest of the file still loads. Test in Task 2.

---

## File Structure

| File                                                                       | Status | Responsibility                                                                            |
| -------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `packages/shared-types/src/units.ts`                                       | Create | `SpeedUnit`, `LimitPreset`, `Limits`, defaults, `formatBytes`, `formatRate`, `parseRate`. |
| `packages/shared-types/src/units.test.ts`                                  | Create | Unit helper tests.                                                                        |
| `packages/shared-types/src/index.ts`                                       | Modify | Export the runtime helpers.                                                               |
| `packages/shared-types/src/download.ts`                                    | Modify | `DownloadJob.limitOverride`.                                                              |
| `packages/shared-protocol/src/schemas.ts`                                  | Modify | Settings fields, `limitOverride`, `LimitPresetSchema`.                                    |
| `packages/shared-protocol/src/messages.ts`                                 | Modify | `download.setLimit`.                                                                      |
| `packages/shared-protocol/src/parse.test.ts`                               | Modify | Tests for the new shapes.                                                                 |
| `apps/desktop/src/settings.ts`                                             | Modify | `speedUnit`, `limitPreset`, `limits` with sanitizing.                                     |
| `apps/desktop/src/progress-view.ts`                                        | Modify | Drop the ×1024 `formatBytes`; the progress line takes a speed unit.                       |
| `apps/desktop/src/interactive/hints.ts`                                    | Modify | `describeProgress(p, unit)`.                                                              |
| `apps/desktop/src/interactive/speed-unit.ts`                               | Create | `SpeedUnitContext` and `useSpeedUnit()`.                                                  |
| `apps/desktop/src/engine/args.ts`                                          | Modify | `--limit-rate`.                                                                           |
| `apps/desktop/src/engine/engine.ts`                                        | Modify | `setRate`, `applyRate`, invisible restart.                                                |
| `apps/desktop/src/core/bandwidth.ts`                                       | Create | `planRates` and the debounced `Bandwidth` controller.                                     |
| `apps/desktop/src/core/service.ts`                                         | Modify | Settings fields, `download.setLimit`, `limitOverride` rows, the controller.               |
| `apps/desktop/src/core/run-core.ts`, `apps/desktop/src/core/in-process.ts` | Modify | Initial bandwidth settings.                                                               |
| `apps/desktop/src/interactive/components/Menu.tsx`                         | Modify | `onHighlight`.                                                                            |
| `apps/desktop/src/interactive/screens/BandwidthScreen.tsx`                 | Create | The four presets, use and edit.                                                           |
| `apps/desktop/src/interactive/screens/SettingsScreen.tsx`                  | Modify | Speed unit and Bandwidth limit rows.                                                      |
| `docs/desktop-cli-checklist.md`                                            | Modify | Manual checks for phase 3a.                                                               |

---

### Task 1: Unit helpers in shared-types

**Files:**

- Create: `packages/shared-types/src/units.ts`
- Create: `packages/shared-types/src/units.test.ts`
- Modify: `packages/shared-types/src/index.ts`

**Interfaces:**

- Consumes: nothing.
- Produces (all exported from `@mediaforge/shared-types`):
  - `type SpeedUnit = "bytes" | "bits"`
  - `type LimitPreset = "high" | "med" | "low" | "custom"`
  - `type Limits = Record<LimitPreset, number | null>`
  - `const LIMIT_PRESETS: readonly LimitPreset[]` (`["high", "med", "low", "custom"]`)
  - `const DEFAULT_LIMITS: Readonly<Limits>`
  - `const MAX_RATE = 1e15`
  - `formatBytes(bytes: number): string`
  - `formatRate(bytesPerSec: number, unit: SpeedUnit): string`
  - `formatLimit(bytesPerSec: number | null, unit: SpeedUnit): string` (`"no limit"` for `null`)
  - `type ParsedRate = { ok: true; bytesPerSec: number | null } | { ok: false; error: string }`
  - `parseRate(text: string, unit: SpeedUnit): ParsedRate`

- [ ] **Step 1: Write the failing tests**

`packages/shared-types/src/units.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  formatBytes,
  formatLimit,
  formatRate,
  parseRate,
} from "./units.ts";

describe("formatBytes", () => {
  it("uses decimal steps and the largest unit that is at least 1", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1000)).toBe("1.0 kB");
    expect(formatBytes(1536)).toBe("1.5 kB");
    expect(formatBytes(5_000_000)).toBe("5.0 MB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.2 MB");
    expect(formatBytes(412_000_000)).toBe("412 MB");
    expect(formatBytes(1e12)).toBe("1.0 TB");
    expect(formatBytes(2.5e15)).toBe("2.5 PB");
  });

  it("shows one decimal under 100 and none from 100 up", () => {
    expect(formatBytes(99_940_000)).toBe("99.9 MB");
    expect(formatBytes(99_960_000)).toBe("100 MB");
    expect(formatBytes(100_000_000)).toBe("100 MB");
  });

  it("moves to the next unit when rounding reaches 1000", () => {
    expect(formatBytes(999.6)).toBe("1.0 kB");
    expect(formatBytes(999_960)).toBe("1.0 MB");
    expect(formatBytes(999_400)).toBe("999 kB");
  });

  it("stays in PB above the largest unit", () => {
    expect(formatBytes(5e18)).toBe("5000 PB");
  });
});

describe("formatRate", () => {
  it("shows bytes per second", () => {
    expect(formatRate(512, "bytes")).toBe("512 B/s");
    expect(formatRate(6_100_000, "bytes")).toBe("6.1 MB/s");
    expect(formatRate(120_000_000, "bytes")).toBe("120 MB/s");
  });

  it("shows bits per second, eight bits to a byte", () => {
    expect(formatRate(100, "bits")).toBe("800 bps");
    expect(formatRate(125, "bits")).toBe("1.0 kbps");
    expect(formatRate(6_100_000, "bits")).toBe("48.8 Mbps");
    expect(formatRate(15_000_000, "bits")).toBe("120 Mbps");
    expect(formatRate(1.25e14, "bits")).toBe("1.0 Pbps");
  });
});

describe("formatLimit", () => {
  it("says no limit for null and formats the rest", () => {
    expect(formatLimit(null, "bytes")).toBe("no limit");
    expect(formatLimit(DEFAULT_LIMITS.med, "bytes")).toBe("5.0 MB/s");
    expect(formatLimit(DEFAULT_LIMITS.med, "bits")).toBe("40.0 Mbps");
  });
});

describe("parseRate", () => {
  it("reads a bare number with the current unit's M prefix", () => {
    expect(parseRate("5", "bytes")).toEqual({
      ok: true,
      bytesPerSec: 5_000_000,
    });
    expect(parseRate("40", "bits")).toEqual({
      ok: true,
      bytesPerSec: 5_000_000,
    });
    expect(parseRate(" 2,5 ", "bytes")).toEqual({
      ok: true,
      bytesPerSec: 2_500_000,
    });
  });

  it("reads a prefix and a unit", () => {
    expect(parseRate("5 MB/s", "bits")).toEqual({
      ok: true,
      bytesPerSec: 5_000_000,
    });
    expect(parseRate("40 Mbps", "bytes")).toEqual({
      ok: true,
      bytesPerSec: 5_000_000,
    });
    expect(parseRate("500k", "bytes")).toEqual({
      ok: true,
      bytesPerSec: 500_000,
    });
    expect(parseRate("500 kb/s", "bytes")).toEqual({
      ok: true,
      bytesPerSec: 62_500,
    });
    expect(parseRate("1.5gB", "bits")).toEqual({
      ok: true,
      bytesPerSec: 1_500_000_000,
    });
    expect(parseRate("800 B/s", "bits")).toEqual({
      ok: true,
      bytesPerSec: 800,
    });
    expect(parseRate("2 Mbit/s", "bytes")).toEqual({
      ok: true,
      bytesPerSec: 250_000,
    });
  });

  it("reads empty and 0 as unlimited", () => {
    expect(parseRate("", "bytes")).toEqual({ ok: true, bytesPerSec: null });
    expect(parseRate("   ", "bits")).toEqual({ ok: true, bytesPerSec: null });
    expect(parseRate("0", "bytes")).toEqual({ ok: true, bytesPerSec: null });
    expect(parseRate("0 Mbps", "bytes")).toEqual({
      ok: true,
      bytesPerSec: null,
    });
  });

  it("rejects text it cannot read, rates under 1 B/s and rates over 1 PB/s", () => {
    expect(parseRate("fast", "bytes")).toEqual({
      ok: false,
      error: "Type a speed such as 5, 5 MB/s or 40 Mbps.",
    });
    expect(parseRate("-5", "bytes").ok).toBe(false);
    expect(parseRate("5 MB/h", "bytes").ok).toBe(false);
    expect(parseRate("1 b", "bits")).toEqual({
      ok: false,
      error: "The smallest limit is 1 B/s.",
    });
    expect(parseRate("2 PB/s", "bytes")).toEqual({
      ok: false,
      error: "The largest limit is 1 PB/s.",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/shared-types`
Expected: FAIL, `Failed to resolve import "./units.ts"`.

- [ ] **Step 3: Implement**

`packages/shared-types/src/units.ts`:

```ts
/** How speeds are shown: bytes per second (MB/s) or bits per second (Mbps). */
export type SpeedUnit = "bytes" | "bits";

/** The global bandwidth presets; a job's override names one of them too. */
export type LimitPreset = "high" | "med" | "low" | "custom";

/** Each preset's cap in bytes per second. `null` means unlimited. */
export type Limits = Record<LimitPreset, number | null>;

export const LIMIT_PRESETS: readonly LimitPreset[] = [
  "high",
  "med",
  "low",
  "custom",
];

export const DEFAULT_LIMITS: Readonly<Limits> = {
  high: null,
  med: 5_000_000,
  low: 1_000_000,
  custom: null,
};

/** The highest limit accepted: 1 PB/s, in bytes per second. */
export const MAX_RATE = 1e15;

const PREFIXES = ["", "k", "M", "G", "T", "P"] as const;

/** One decimal under 100, none from 100 up, none for whole bytes or bits. */
const rounded = (value: number, prefix: number): string =>
  prefix === 0 || value >= 99.95 ? String(Math.round(value)) : value.toFixed(1);

/** Scale by 1000 to the largest prefix that keeps the value at least 1. */
function scale(value: number): { text: string; prefix: string } {
  let v = Math.max(0, value);
  let prefix = 0;
  while (v >= 1000 && prefix < PREFIXES.length - 1) {
    v /= 1000;
    prefix += 1;
  }
  let text = rounded(v, prefix);
  // Rounding can reach the next step: 999.96 kB shows as "1.0 MB", not "1000 kB".
  if (Number(text) >= 1000 && prefix < PREFIXES.length - 1) {
    prefix += 1;
    text = rounded(v / 1000, prefix);
  }
  return { text, prefix: PREFIXES[prefix] ?? "" };
}

/** "512 B", "1.5 kB", "412 MB". */
export function formatBytes(bytes: number): string {
  const { text, prefix } = scale(bytes);
  return `${text} ${prefix}B`;
}

/** "6.1 MB/s" with `bytes`, "48.8 Mbps" with `bits`. */
export function formatRate(bytesPerSec: number, unit: SpeedUnit): string {
  if (unit === "bits") {
    const { text, prefix } = scale(bytesPerSec * 8);
    return `${text} ${prefix}bps`;
  }
  const { text, prefix } = scale(bytesPerSec);
  return `${text} ${prefix}B/s`;
}

/** A preset value for display: "no limit" or a rate. */
export function formatLimit(
  bytesPerSec: number | null,
  unit: SpeedUnit,
): string {
  return bytesPerSec === null ? "no limit" : formatRate(bytesPerSec, unit);
}

export type ParsedRate =
  | { ok: true; bytesPerSec: number | null }
  | { ok: false; error: string };

/** Number, optional prefix, optional unit. `B` and `b` differ by case on purpose. */
const RATE =
  /^(\d+(?:[.,]\d+)?)\s*([kKmMgGtTpP])?\s*(B\/s|B|bps|b\/s|bit\/s|b)?$/;

const PREFIX_POWER: Record<string, number> = { k: 1, m: 2, g: 3, t: 4, p: 5 };

/**
 * Read a limit typed by the user. Empty or 0 means unlimited (`null`). Without a unit the current
 * one is used; without a prefix and a unit, M (`5` is 5 MB/s or 5 Mbps).
 */
export function parseRate(text: string, unit: SpeedUnit): ParsedRate {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, bytesPerSec: null };
  const match = RATE.exec(trimmed);
  if (!match)
    return { ok: false, error: "Type a speed such as 5, 5 MB/s or 40 Mbps." };
  const [, digits = "", prefix, suffix] = match;
  const value = Number(digits.replace(",", "."));
  if (value === 0) return { ok: true, bytesPerSec: null };
  const bits = suffix === undefined ? unit === "bits" : !suffix.startsWith("B");
  const power = prefix
    ? (PREFIX_POWER[prefix.toLowerCase()] ?? 0)
    : suffix
      ? 0
      : 2;
  const bytesPerSec = Math.round((value * 1000 ** power) / (bits ? 8 : 1));
  if (bytesPerSec < 1)
    return { ok: false, error: "The smallest limit is 1 B/s." };
  if (bytesPerSec > MAX_RATE)
    return { ok: false, error: "The largest limit is 1 PB/s." };
  return { ok: true, bytesPerSec };
}
```

`packages/shared-types/src/index.ts`: add the runtime export (keep the type-only lines):

```ts
export type * from "./download.ts";
export type * from "./media.ts";
export type * from "./profile.ts";
export type * from "./steps.ts";
export * from "./units.ts";
```

- [ ] **Step 4: Run the tests and the type check**

Run: `pnpm exec vitest run packages/shared-types && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit message for the user**

```markdown
✨ shared-types: add decimal size and speed formatting and rate parsing

## Description

The exe shows sizes in ×1024 steps labeled KB, and there is no way to
show speeds in bits or to read a speed typed by the user. The manager,
the bandwidth settings and the popup all need the same rules.

Adds formatBytes and formatRate in ×1000 steps (bytes or bits per
second), parseRate for limits typed as 5, 5 MB/s or 40 Mbps, and the
bandwidth preset types and defaults.

## Test

pnpm exec vitest run packages/shared-types
```

---

### Task 2: Settings and protocol carry speed unit and limits

**Files:**

- Modify: `packages/shared-types/src/download.ts`
- Modify: `packages/shared-protocol/src/schemas.ts`
- Modify: `packages/shared-protocol/src/messages.ts`
- Modify: `packages/shared-protocol/src/parse.test.ts`
- Modify: `apps/desktop/src/settings.ts`
- Test: `apps/desktop/src/settings.test.ts`, `apps/desktop/src/core/service.test.ts`
- Modify: `apps/desktop/src/core/service.ts` (`#sendSettings`, `#setSettings` only)

**Interfaces:**

- Consumes: `LimitPreset`, `Limits`, `SpeedUnit`, `DEFAULT_LIMITS`, `LIMIT_PRESETS`, `MAX_RATE` (Task 1).
- Produces:
  - `DownloadJob.limitOverride?: LimitPreset`
  - `LimitPresetSchema`, `LimitsSchema`, `SpeedUnitSchema` in `shared-protocol/src/schemas.ts`
  - `DownloadSetLimitMessage` (`download.setLimit`, payload `{ jobIds: string[]; preset: LimitPreset | null }`)
  - `Settings.speedUnit: SpeedUnit`, `Settings.limitPreset: LimitPreset`, `Settings.limits: Limits` in `apps/desktop/src/settings.ts`
  - `settings.value` always carries `speedUnit`, `limitPreset`, `limits`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared-protocol/src/parse.test.ts`:

```ts
describe("bandwidth messages", () => {
  const frame = (type: string, payload: unknown) => ({
    v: PROTOCOL_VERSION,
    id: "r",
    type,
    payload,
  });

  it("accepts download.setLimit with a preset or null, and rejects other presets", () => {
    expect(
      parseExtensionMessage(
        frame("download.setLimit", { jobIds: ["a"], preset: "low" }),
      ).ok,
    ).toBe(true);
    expect(
      parseExtensionMessage(
        frame("download.setLimit", { jobIds: ["a"], preset: null }),
      ).ok,
    ).toBe(true);
    expect(
      parseExtensionMessage(
        frame("download.setLimit", { jobIds: ["a"], preset: "max" }),
      ).ok,
    ).toBe(false);
    expect(
      parseExtensionMessage(
        frame("download.setLimit", { jobIds: [], preset: null }),
      ).ok,
    ).toBe(false);
  });

  it("carries speedUnit, limitPreset and limits in settings, all optional", () => {
    const limits = {
      high: null,
      med: 5_000_000,
      low: 1_000_000,
      custom: 250_000,
    };
    expect(
      parseExtensionMessage(
        frame("settings.set", {
          speedUnit: "bits",
          limitPreset: "med",
          limits,
        }),
      ).ok,
    ).toBe(true);
    expect(
      parseExtensionMessage(
        frame("settings.set", { limits: { ...limits, med: -1 } }),
      ).ok,
    ).toBe(false);
    expect(
      parseExtensionMessage(frame("settings.set", { speedUnit: "nibbles" })).ok,
    ).toBe(false);
    const value = {
      extensionUi: "popup",
      keepRunning: false,
      askQuality: true,
    };
    expect(parseHostMessage(frame("settings.value", value)).ok).toBe(true);
    expect(
      parseHostMessage(
        frame("settings.value", {
          ...value,
          speedUnit: "bytes",
          limitPreset: "high",
          limits,
        }),
      ).ok,
    ).toBe(true);
  });

  it("carries a job's limit override", () => {
    const job = {
      id: "a",
      request: { candidate, profileId: "best" },
      status: "downloading",
      progress: { bytesDownloaded: 0 },
      createdAt: 1,
      updatedAt: 1,
      limitOverride: "low",
    };
    expect(parseHostMessage(frame("jobs.snapshot", { jobs: [job] })).ok).toBe(
      true,
    );
    expect(
      parseHostMessage(
        frame("jobs.snapshot", { jobs: [{ ...job, limitOverride: "x" }] }),
      ).ok,
    ).toBe(false);
  });
});
```

Append to `apps/desktop/src/settings.test.ts` (inside its top-level `describe` for `sanitizeSettings`, or as a new `describe`):

```ts
describe("bandwidth settings", () => {
  it("defaults to bytes, the High preset and the built-in values", () => {
    const s = sanitizeSettings({});
    expect(s.speedUnit).toBe("bytes");
    expect(s.limitPreset).toBe("high");
    expect(s.limits).toEqual({
      high: null,
      med: 5_000_000,
      low: 1_000_000,
      custom: null,
    });
  });

  it("keeps valid values and replaces each bad one with its default", () => {
    const s = sanitizeSettings({
      speedUnit: "bits",
      limitPreset: "custom",
      limits: { high: 1e16, med: "fast", low: -3, custom: 250_000.7 },
    });
    expect(s.speedUnit).toBe("bits");
    expect(s.limitPreset).toBe("custom");
    expect(s.limits).toEqual({
      high: null,
      med: 5_000_000,
      low: 1_000_000,
      custom: 250_000,
    });
  });

  it("ignores an unknown unit, preset or limits shape", () => {
    const s = sanitizeSettings({
      speedUnit: "nibbles",
      limitPreset: "max",
      limits: [1, 2],
    });
    expect(s.speedUnit).toBe("bytes");
    expect(s.limitPreset).toBe("high");
    expect(s.limits).toEqual(DEFAULT_SETTINGS.limits);
  });

  it("keeps an explicit null (no limit) for any preset", () => {
    expect(sanitizeSettings({ limits: { med: null } }).limits.med).toBeNull();
  });
});
```

Append to `apps/desktop/src/core/service.test.ts` (near the existing `settings.set` tests):

```ts
describe("bandwidth settings over the protocol", () => {
  it("sends speedUnit, limitPreset and limits in settings.value", async () => {
    const t = await setup({
      settings: { speedUnit: "bits", limitPreset: "low" },
    });
    await t.send("settings.get");
    expect(t.sent[0]).toMatchObject({
      type: "settings.value",
      payload: {
        speedUnit: "bits",
        limitPreset: "low",
        limits: { high: null, med: 5_000_000, low: 1_000_000, custom: null },
      },
    });
  });

  it("lets the relay change the unit and the preset", async () => {
    const t = await setup();
    await t.send("settings.set", { speedUnit: "bits", limitPreset: "med" });
    expect(t.sent[0]).toMatchObject({
      type: "settings.value",
      payload: { limitPreset: "med" },
    });
    expect(await t.settings.load()).toMatchObject({
      speedUnit: "bits",
      limitPreset: "med",
    });
  });

  it("refuses preset values from the relay and saves nothing", async () => {
    const t = await setup();
    const limits = { high: 1, med: 1, low: 1, custom: 1 };
    await t.send("settings.set", { limitPreset: "med", limits });
    expect(t.sent[0]).toMatchObject({
      type: "error",
      payload: { code: "forbidden", replyTo: "req" },
    });
    expect((await t.settings.load()).limitPreset).toBe("high");
  });

  it("lets a terminal change the preset values", async () => {
    const t = await setup({ role: "terminal" });
    const limits = {
      high: null,
      med: 2_000_000,
      low: 500_000,
      custom: 100_000,
    };
    await t.send("settings.set", { limits });
    expect((await t.settings.load()).limits).toEqual(limits);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/shared-protocol apps/desktop/src/settings.test.ts apps/desktop/src/core/service.test.ts`
Expected: FAIL: `download.setLimit` unknown, `speedUnit` undefined, no `forbidden` frame.

- [ ] **Step 3: Implement the types and schemas**

`packages/shared-types/src/download.ts`: import the preset type and add the field at the end of `DownloadJob`:

```ts
import type { LimitPreset } from "./units.ts";
```

```ts
  /** The CLI exit code matching a failure. */
  errorKind?: number;
  /** This job's own speed cap, outside the global split. */
  limitOverride?: LimitPreset;
}
```

`packages/shared-protocol/src/schemas.ts`: after `JobOriginSchema`, add:

```ts
export const LimitPresetSchema = z.enum(["high", "med", "low", "custom"]);
export const SpeedUnitSchema = z.enum(["bytes", "bits"]);
/** Bytes per second per preset; null is unlimited. 1e15 is 1 PB/s. */
export const LimitsSchema = z.object({
  high: z.number().int().positive().max(1e15).nullable(),
  med: z.number().int().positive().max(1e15).nullable(),
  low: z.number().int().positive().max(1e15).nullable(),
  custom: z.number().int().positive().max(1e15).nullable(),
});
```

Add to `DownloadJobSchema`, after `errorKind`:

```ts
  limitOverride: LimitPresetSchema.optional(),
```

Extend `ExtensionSettingsSchema`:

```ts
export const ExtensionSettingsSchema = z.object({
  extensionUi: z.enum(["popup", "overlay"]),
  keepRunning: z.boolean(),
  askQuality: z.boolean(),
  folder: z.string().optional(),
  quality: z.string().optional(),
  // Optional so a newer popup still reads settings from a phase 2 core; the core always sends them.
  speedUnit: SpeedUnitSchema.optional(),
  limitPreset: LimitPresetSchema.optional(),
  limits: LimitsSchema.optional(),
});
```

`packages/shared-protocol/src/messages.ts`: import `LimitPresetSchema` from `./schemas.ts` with the others, then add after `DownloadResumeMessage`:

```ts
/** Set (a preset) or clear (null) the speed cap of each job, outside the global split. */
export const DownloadSetLimitMessage = message(
  "download.setLimit",
  jobIds.extend({ preset: LimitPresetSchema.nullable() }),
);
```

Add `DownloadSetLimitMessage` to the `ExtensionToHostMessage` union, after `DownloadResumeMessage`.

- [ ] **Step 4: Implement the desktop settings**

`apps/desktop/src/settings.ts`: import the helpers and extend the interface, defaults and sanitizer.

```ts
import {
  DEFAULT_LIMITS,
  LIMIT_PRESETS,
  type LimitPreset,
  type Limits,
  MAX_RATE,
  type SpeedUnit,
} from "@mediaforge/shared-types";
```

Add to `Settings`:

```ts
/** Show speeds in bytes (MB/s) or bits (Mbps) per second. */
speedUnit: SpeedUnit;
/** The global bandwidth preset in use. */
limitPreset: LimitPreset;
/** Each preset's cap in bytes per second; null is unlimited. */
limits: Limits;
```

Add to `DEFAULT_SETTINGS`:

```ts
  speedUnit: "bytes",
  limitPreset: "high",
  limits: { ...DEFAULT_LIMITS },
```

Above `sanitizeSettings`, add:

```ts
const isPreset = (value: unknown): value is LimitPreset =>
  LIMIT_PRESETS.includes(value as LimitPreset);

/** Each preset on its own: a whole positive number up to 1 PB/s, or null; else its default. */
function sanitizeLimits(raw: unknown): Limits {
  const o =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const limits = { ...DEFAULT_LIMITS };
  for (const preset of LIMIT_PRESETS) {
    const value = o[preset];
    if (value === null) limits[preset] = null;
    else if (typeof value === "number" && value >= 1 && value <= MAX_RATE) {
      limits[preset] = Math.floor(value);
    }
  }
  return limits;
}
```

In `sanitizeSettings`, add to the object literal:

```ts
    speedUnit: o.speedUnit === "bits" ? "bits" : "bytes",
    limitPreset: isPreset(o.limitPreset) ? o.limitPreset : DEFAULT_SETTINGS.limitPreset,
    limits: sanitizeLimits(o.limits),
```

`memorySettingsStore` spreads `DEFAULT_SETTINGS`, whose `limits` object is shared: change its first line to copy it:

```ts
let current: Settings = {
  ...DEFAULT_SETTINGS,
  limits: { ...DEFAULT_SETTINGS.limits },
  ...initial,
};
```

- [ ] **Step 5: Implement the service side**

`apps/desktop/src/core/service.ts`, `#sendSettings`: add the three fields to the payload:

```ts
this.#reply(state, id, "settings.value", {
  extensionUi: s.extensionUi,
  keepRunning: s.keepRunning,
  askQuality: s.askQuality,
  speedUnit: s.speedUnit,
  limitPreset: s.limitPreset,
  limits: s.limits,
  ...(s.folder && { folder: s.folder }),
  ...(s.quality && { quality: s.quality }),
});
```

`#setSettings`: refuse `limits` from the relay before anything is saved. Add as the first statement:

```ts
// Preset values are edited in MediaForge itself; the popup only picks the preset.
if (state.role !== "terminal" && message.payload.limits !== undefined) {
  this.#forbidden(state, message.id);
  return;
}
```

Add a `case "download.setLimit":` to `#dispatch` that answers `unsupported` for now, so the `never` check compiles; Task 6 replaces it:

```ts
      case "download.setLimit":
        return this.#error(state, message.id, "unsupported", "Not available yet.");
```

- [ ] **Step 6: Run the tests and the type check**

Run: `pnpm exec vitest run packages/shared-protocol apps/desktop/src/settings.test.ts apps/desktop/src/core/service.test.ts && pnpm typecheck`
Expected: PASS. If `apps/extension` fails to type-check because a test builds an `ExtensionSettings` literal, nothing is needed: the new fields are optional.

- [ ] **Step 7: Commit message for the user**

```markdown
✨ shared-protocol: carry the speed unit, bandwidth presets and job limits

## Description

The popup and the exe need to read and change the speed unit and the
bandwidth preset, and the manager needs to cap single jobs.

settings.get, settings.set and settings.value carry speedUnit,
limitPreset and limits (optional in the schema, so a newer popup still
reads a phase 2 core). download.setLimit sets or clears a job's
override, and jobs carry limitOverride. The relay may pick the unit
and the preset but gets forbidden for preset values, which are edited
in MediaForge only. Bad values in config.json fall back one by one.

## Test

pnpm exec vitest run packages/shared-protocol apps/desktop/src/settings.test.ts apps/desktop/src/core/service.test.ts
```

---

### Task 3: Decimal sizes and the speed unit across the exe

**Files:**

- Modify: `apps/desktop/src/progress-view.ts`
- Modify: `apps/desktop/src/download.ts`
- Modify: `apps/desktop/src/interactive/hints.ts`
- Create: `apps/desktop/src/interactive/speed-unit.ts`
- Modify: `apps/desktop/src/interactive/App.tsx`
- Modify: `apps/desktop/src/interactive/screens/DownloadScreen.tsx`
- Modify: `apps/desktop/src/interactive/screens/ResultScreen.tsx`
- Modify: `apps/desktop/src/interactive/screens/SettingsScreen.tsx` (one prop only)
- Modify (import only): `apps/desktop/src/formats.ts`, `apps/desktop/src/interactive/format-choices.ts`, `apps/desktop/src/interactive/install-progress.ts`, `apps/desktop/src/interactive/screens/AboutScreen.tsx`, `apps/desktop/src/self-update.ts`, `apps/desktop/src/tool-runtime.ts`
- Test: `apps/desktop/src/download.test.ts`, `apps/desktop/src/interactive/logic.test.ts`, `apps/desktop/src/interactive/install-progress.test.ts`, `apps/desktop/src/tool-runtime.test.ts`, `apps/desktop/src/interactive/App.test.tsx`

**Interfaces:**

- Consumes: `formatBytes`, `formatRate`, `SpeedUnit` (Task 1); `Settings.speedUnit` (Task 2).
- Produces:
  - `formatProgressLine(job: EngineJob, unit?: SpeedUnit): string` (default `"bytes"`)
  - `createProgressView({ write, isTTY, quiet, speedUnit? })`
  - `describeProgress(p: DownloadProgress, unit?: SpeedUnit): string` (default `"bytes"`)
  - `activeDetail(job: EngineJob | undefined, unit?: SpeedUnit): string`
  - `SpeedUnitContext: React.Context<SpeedUnit>`, `useSpeedUnit(): SpeedUnit` in `interactive/speed-unit.ts`
  - `SettingsScreen` prop `onSaved?: (settings: Settings) => void`

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/download.test.ts`: remove `formatBytes` from the `./progress-view.ts` import, and replace the `"formats bytes and durations"` and `"describes downloading with whatever is known"` tests with:

```ts
it("formats durations", () => {
  expect(formatDuration(12)).toBe("12s");
  expect(formatDuration(65)).toBe("1m 05s");
  expect(formatDuration(3720)).toBe("1h 02m");
});

it("describes downloading with whatever is known, in decimal units", () => {
  expect(
    formatProgressLine(
      job({
        progress: {
          bytesDownloaded: 1,
          percent: 42.5,
          speed: 2048,
          etaSec: 12,
        },
      }),
    ),
  ).toBe("downloading  42.5%  2.0 kB/s  ETA 12s");
  expect(formatProgressLine(job({ progress: { bytesDownloaded: 2048 } }))).toBe(
    "downloading  2.0 kB",
  );
  expect(formatProgressLine(job({ status: "processing" }))).toBe("processing");
});

it("shows the speed in bits when asked", () => {
  expect(
    formatProgressLine(
      job({ progress: { bytesDownloaded: 1, speed: 6_100_000 } }),
      "bits",
    ),
  ).toBe("downloading  1 B  48.8 Mbps");
});
```

Add to `describe("runDownload")` in the same file. `setup(run, env, isTTY, saved)` is the file's helper; on a TTY the view writes every update, not only status changes:

```ts
it("shows the progress line in the saved speed unit", async () => {
  const t = setup(
    async (_c, args, h) => {
      h.onStdoutLine("MFPROGRESS 50 100 NA 6100000 5");
      // Past the core's 250 ms progress throttle, so this update reaches the CLI.
      await new Promise((resolve) => setTimeout(resolve, 300));
      h.onStdoutLine("MFPROGRESS 60 100 NA 6100000 4");
      h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip.mp4`);
      return { exitCode: 0 };
    },
    {},
    true,
    { speedUnit: "bits" },
  );
  await runDownload(["https://example.com/v"], t.io, t.deps);
  expect(t.err()).toContain("48.8 Mbps");
});
```

`apps/desktop/src/interactive/logic.test.ts`: change the expectations of `"summarises progress with whatever is known"` and `"shows bytes and speed under the overall bar while downloading"`:

```ts
expect(describeProgress({ bytesDownloaded: 1024 })).toBe("1.0 kB");
expect(
  describeProgress({
    bytesDownloaded: 1024,
    totalBytes: 2048,
    speed: 512,
    etaSec: 2,
  }),
).toBe("1.0 kB of 2.0 kB · 512 B/s · ETA 2s");
expect(describeProgress({ bytesDownloaded: 1024, speed: 512 }, "bits")).toBe(
  "1.0 kB · 4.1 kbps",
);
```

```ts
    ).toBe("1.0 kB of 2.0 kB");
```

`apps/desktop/src/interactive/install-progress.test.ts`: `"ffmpeg: downloading 1.0 MB of 2.1 MB"`.

`apps/desktop/src/tool-runtime.test.ts`: `"\r  yt-dlp  [############------------]  50%  1.0 MB of 2.1 MB"`.

`apps/desktop/src/interactive/App.test.tsx`: in the test that expects `"5.0 MB"` after "Download complete", expect `"5.2 MB"` (the fake file is 5 × 1024 × 1024 bytes). Add a new test to the download tests:

```ts
it("shows the download speed in the saved unit", async () => {
  let finish: () => void = () => {};
  const t = setup({
    settings: { ...SKIP_QUESTIONS, speedUnit: "bits" },
    runner: async (_c, args, h) => {
      h.onStdoutLine("MFPROGRESS 1000 2000000 NA 6100000 5");
      // Past the core's 250 ms progress throttle, so this update reaches the screen.
      await tick(300);
      h.onStdoutLine("MFPROGRESS 2000 2000000 NA 6100000 4");
      // Stay downloading until the test has looked at the screen.
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip.mp4`);
      return { exitCode: 0 };
    },
  });
  await startDownload(t);
  await waitFor(t.app, "48.8 Mbps");
  finish();
  await waitFor(t.app, "Download complete");
  t.app.unmount();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop`
Expected: FAIL on the changed expectations (`1.0 KB` vs `1.0 kB`, etc.) and the two new speed unit tests.

- [ ] **Step 3: Implement**

`apps/desktop/src/progress-view.ts`: delete the local `formatBytes`, import the shared helpers, and pass the unit through:

```ts
import {
  formatBytes,
  formatRate,
  type SpeedUnit,
} from "@mediaforge/shared-types";
import type { EngineJob } from "./engine/index.ts";
```

```ts
/** One-line description of a job's current state. */
export function formatProgressLine(
  job: EngineJob,
  unit: SpeedUnit = "bytes",
): string {
  if (job.status === "downloading") {
    const { percent, bytesDownloaded, speed, etaSec } = job.progress;
    return [
      "downloading",
      percent !== undefined
        ? `${percent.toFixed(1)}%`
        : formatBytes(bytesDownloaded),
      speed !== undefined && formatRate(speed, unit),
      etaSec !== undefined && `ETA ${formatDuration(etaSec)}`,
    ]
      .filter(Boolean)
      .join("  ");
  }
  return job.status;
}

export interface ProgressViewOptions {
  write: (text: string) => void;
  isTTY: boolean;
  quiet: boolean;
  /** Bytes or bits per second. Default bytes. */
  speedUnit?: SpeedUnit;
}
```

In `createProgressView`, destructure `speedUnit = "bytes"` and call `formatProgressLine(job, speedUnit)` in both places.

The new test above expects `"downloading  1 B  48.8 Mbps"`: with no percent the line shows the bytes so far, which is what the code does.

`apps/desktop/src/download.ts`: pass the setting:

```ts
const view = createProgressView({
  write: io.stderr,
  isTTY: deps.isTTY,
  quiet: values.quiet ?? false,
  speedUnit: settings.speedUnit,
});
```

`apps/desktop/src/interactive/hints.ts`:

```ts
import {
  type DownloadProgress,
  formatBytes,
  formatRate,
  type SpeedUnit,
} from "@mediaforge/shared-types";
import { ExitCode } from "../exit-codes.ts";
import type { MediaInfo } from "../formats.ts";
import { formatDuration } from "../progress-view.ts";
import { SUPPORTED_SITES_URL } from "../sites.ts";
```

```ts
/** "12.3 MB of 40.0 MB · 3.2 MB/s · ETA 12s" from whatever is known. */
export function describeProgress(
  p: DownloadProgress,
  unit: SpeedUnit = "bytes",
): string {
  return [
    p.totalBytes
      ? `${formatBytes(p.bytesDownloaded)} of ${formatBytes(p.totalBytes)}`
      : formatBytes(p.bytesDownloaded),
    p.speed !== undefined && formatRate(p.speed, unit),
    p.etaSec !== undefined && `ETA ${formatDuration(p.etaSec)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
```

Remove `export { formatBytes };` from `hints.ts`. In `ResultScreen.tsx`, import `formatBytes` from `@mediaforge/shared-types` and `failureHint` from `../hints.ts`.

`apps/desktop/src/interactive/speed-unit.ts`:

```ts
import type { SpeedUnit } from "@mediaforge/shared-types";
import { createContext, useContext } from "react";

/** The saved speed unit. App loads it at start and updates it when Settings saves a new one. */
export const SpeedUnitContext = createContext<SpeedUnit>("bytes");

export const useSpeedUnit = (): SpeedUnit => useContext(SpeedUnitContext);
```

`apps/desktop/src/interactive/App.tsx`: hold the unit, load it once, and provide it.

```ts
import type { SpeedUnit } from "@mediaforge/shared-types";
import { SpeedUnitContext } from "./speed-unit.ts";
```

Inside `App`, next to the other state:

```ts
const [speedUnit, setSpeedUnit] = useState<SpeedUnit>("bytes");
useEffect(() => {
  let live = true;
  deps.download.settings
    .load()
    .then((s) => live && setSpeedUnit(s.speedUnit))
    .catch(() => {});
  return () => {
    live = false;
  };
}, [deps]);
```

The settings case:

```tsx
      case "settings":
        return <SettingsScreen onBack={nav.back} onSaved={(s) => setSpeedUnit(s.speedUnit)} />;
```

The returned tree:

```tsx
return (
  <DepsContext.Provider value={deps}>
    <SpeedUnitContext.Provider value={speedUnit}>
      <NoticeContext.Provider value={notices}>{body}</NoticeContext.Provider>
    </SpeedUnitContext.Provider>
  </DepsContext.Provider>
);
```

`SettingsScreen.tsx`: accept `onSaved` and call it after a successful save:

```tsx
export function SettingsScreen({
  onBack,
  onSaved,
}: {
  onBack: () => void;
  /** Told about every saved change, so the app can follow the speed unit. */
  onSaved?: (settings: Settings) => void;
}) {
```

In `save`, after `setSettings(next);` add `onSaved?.(next);`.

`DownloadScreen.tsx`:

```ts
export function activeDetail(
  job: EngineJob | undefined,
  unit: SpeedUnit = "bytes",
): string {
  const active = job?.steps?.find((s) => s.state === "active");
  if (active?.progress) return describeProgress(active.progress, unit);
  if (active) return `${STEP_ACTIONS[active.kind]}…`;
  return job && job.status !== "queued"
    ? describeProgress(job.progress, unit)
    : " ";
}
```

In the `DownloadScreen` component body add `const speedUnit = useSpeedUnit();` and render `{activeDetail(job, speedUnit)}`. Import `useSpeedUnit` from `../speed-unit.ts` and `type SpeedUnit` from `@mediaforge/shared-types`.

Import-only changes: in `formats.ts`, `format-choices.ts`, `install-progress.ts`, `AboutScreen.tsx`, `self-update.ts` and `tool-runtime.ts`, replace the `formatBytes` import from `progress-view.ts` with `import { formatBytes } from "@mediaforge/shared-types";`. Keep any other names those files import from `progress-view.ts`.

- [ ] **Step 4: Run the tests and the type check**

Run: `pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS. Any other failure that only differs by `KB` vs `kB` or a ×1024 vs ×1000 value is this change: update its expectation to the decimal value and mention it in the commit message.

- [ ] **Step 5: Commit message for the user**

```markdown
✨ desktop: show sizes in decimal units and speeds in the chosen unit

## Description

Sizes were shown in ×1024 steps labeled KB, which matches neither the
browser nor the file manager, and speeds could only be read in bytes.

Every size in the exe now uses ×1000 steps (kB, MB, GB), and speeds
follow the speedUnit setting in the menu's download screen and on the
mediaforge download progress line. A 5 MiB file now reads 5.2 MB.

## Test

pnpm exec vitest run apps/desktop
```

---

### Task 4: Speed caps and invisible restarts in the engine

**Files:**

- Modify: `apps/desktop/src/engine/args.ts`
- Modify: `apps/desktop/src/engine/engine.ts`
- Test: `apps/desktop/src/engine/args.test.ts`, `apps/desktop/src/engine/engine.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces:
  - `BuildArgsInput.limitRate?: number` (bytes per second; adds `--limit-rate <n>`)
  - `DownloadEngine.setRate(id: string, bytesPerSec: number | undefined): void`
  - `DownloadEngine.applyRate(id: string): boolean`

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/engine/args.test.ts` (`candidate` and `getProfile` are already defined and imported in the file):

```ts
describe("speed cap", () => {
  const input = {
    request: { candidate, profileId: "best" },
    profile: getProfile("best") as never,
    workDir: "/w",
    ffmpegPath: "/bin/ffmpeg",
  };

  it("caps the speed with --limit-rate in whole bytes per second", () => {
    const args = buildYtDlpArgs({ ...input, limitRate: 2_500_000.9 });
    expect(args[args.indexOf("--limit-rate") + 1]).toBe("2500000");
    expect(buildYtDlpArgs(input)).not.toContain("--limit-rate");
  });
});
```

`apps/desktop/src/engine/engine.test.ts`, new `describe` at the end:

```ts
describe("speed caps", () => {
  const rateOf = (args: string[]) =>
    args.includes("--limit-rate")
      ? args[args.indexOf("--limit-rate") + 1]
      : undefined;

  it("passes the rate set before the job starts", async () => {
    const { fs } = fakeFs();
    const seen: (string | undefined)[] = [];
    const engine: DownloadEngine = new DownloadEngine({
      resolve: found,
      fs,
      // A cap set while the job reports "downloading" is in place before yt-dlp starts.
      onUpdate: (job) =>
        job.status === "downloading" && engine.setRate(job.id, 1_000_000),
      run: runner(async (h, _s, args) => {
        seen.push(rateOf(args));
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/T.mp4`);
        return 0;
      }),
    });
    await engine.whenSettled(engine.submit(request()).id);
    expect(seen).toEqual(["1000000"]);
  });

  it("restarts a downloading job with its new rate, unseen by clients", async () => {
    const { fs, removed } = fakeFs();
    const statuses: string[] = [];
    const runs: (string | undefined)[] = [];
    let first = true;
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      onUpdate: (job) => statuses.push(job.status),
      run: runner(async (h, signal, args) => {
        runs.push(rateOf(args));
        if (first) {
          first = false;
          return waitForAbort(signal);
        }
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/T.mp4`);
        return 0;
      }),
    });
    const { id } = engine.submit(request());
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(engine.applyRate(id)).toBe(false); // same rate: nothing to do
    engine.setRate(id, 500_000);
    expect(engine.applyRate(id)).toBe(true);
    const job = await engine.whenSettled(id);
    expect(job?.status).toBe("completed");
    expect(job?.id).toBe(id);
    expect(runs).toEqual([undefined, "500000"]);
    // Clients only ever see it downloading, then completed: never paused or queued again.
    const afterStart = statuses.slice(statuses.indexOf("downloading"));
    expect(new Set(afterStart)).toEqual(new Set(["downloading", "completed"]));
    // Only the final cleanup removes the work folder, never the restart.
    expect(removed).toHaveLength(1);
  });

  it("does not restart a queued or processing job", async () => {
    const { fs } = fakeFs();
    let release: () => void = () => {};
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      maxConcurrent: 1,
      run: runner(async (h) => {
        h.onStdoutLine("MFPOST started");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return 1;
      }),
    });
    const a = engine.submit(request()).id;
    const b = engine.submit(request()).id;
    await vi.waitFor(() => expect(engine.get(a)?.status).toBe("processing"));
    engine.setRate(a, 1);
    engine.setRate(b, 1);
    expect(engine.applyRate(a)).toBe(false);
    expect(engine.applyRate(b)).toBe(false);
    // Cancel b while it still waits, so it never runs the held script.
    engine.cancel(b);
    release();
    await engine.whenSettled(a);
  });

  it("lets a pause during a restart win", async () => {
    const { fs } = fakeFs();
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      run: runner(async (_h, signal) => waitForAbort(signal)),
    });
    const { id } = engine.submit(request());
    await vi.waitFor(() => expect(engine.get(id)?.status).toBe("downloading"));
    await vi.waitFor(() => {
      engine.setRate(id, 1000);
      expect(engine.applyRate(id)).toBe(true);
    });
    expect(engine.pause(id)).toBe(true);
    await vi.waitFor(() => expect(engine.get(id)?.status).toBe("paused"));
  });

  it("completes a job whose restart landed after yt-dlp exited 0", async () => {
    const { fs } = fakeFs();
    let runs = 0;
    const engine: DownloadEngine = new DownloadEngine({
      resolve: found,
      fs,
      run: runner(async (h, _s, args) => {
        runs += 1;
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/T.mp4`);
        // The cap changes in the moment between the last line and the exit.
        engine.setRate(engine.list()[0]?.id ?? "", 1000);
        engine.applyRate(engine.list()[0]?.id ?? "");
        return 0;
      }),
    });
    const job = await engine.whenSettled(engine.submit(request()).id);
    expect(job?.status).toBe("completed");
    expect(runs).toBe(1);
  });
});
```

In the "does not restart" test, the first job reports `processing` before it is held; the fake runner keeps it there until `release()`.

The spawn of yt-dlp happens after `#update(..., downloading)` and a few awaits, so `applyRate` may be called before the first run has its args: that is why the pause test retries `applyRate` inside `vi.waitFor` until it returns true.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/engine`
Expected: FAIL, `engine.setRate is not a function`, and no `--limit-rate` in the args.

- [ ] **Step 3: Implement `--limit-rate`**

`apps/desktop/src/engine/args.ts`: add to `BuildArgsInput`:

```ts
  /** Speed cap in bytes per second. Unset: no cap. */
  limitRate?: number;
```

Destructure `limitRate` in `buildYtDlpArgs` and add it right after `"--continue",`:

```ts
    // yt-dlp reads a bare number as bytes per second; it rejects 0.
    ...(limitRate !== undefined ? ["--limit-rate", String(Math.max(1, Math.floor(limitRate)))] : []),
```

- [ ] **Step 4: Implement the engine changes**

`apps/desktop/src/engine/engine.ts`.

`Entry`: widen `stopReason` and add three fields:

```ts
/**
 * Why the controller was aborted: a pause keeps the partial files, a cancel removes them, a
 * restart runs yt-dlp again at once with the new speed cap.
 */
stopReason: "pause" | "cancel" | "restart" | undefined;
/** The cap `setRate` asked for, in bytes per second. */
rate: number | undefined;
/** The cap the running yt-dlp was started with. */
appliedRate: number | undefined;
/** True once this try's yt-dlp has its arguments, so `appliedRate` means something. */
spawned: boolean;
```

Initialise them in `submit` and `restore` (`rate: undefined, appliedRate: undefined, spawned: false`).

New public methods, after `restore`:

```ts
  /** The speed cap for this job, in bytes per second (undefined: none). Used from its next start. */
  setRate(id: string, bytesPerSec: number | undefined): void {
    const entry = this.#entries.get(id);
    if (entry) entry.rate = bytesPerSec;
  }

  /**
   * Restart a downloading job whose yt-dlp runs with another cap than `setRate` last asked for.
   * Clients see nothing: the status stays downloading, the job keeps its slot, and yt-dlp
   * continues the partial files. False when there was nothing to restart.
   */
  applyRate(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry || entry.job.status !== "downloading" || entry.stopReason || !entry.spawned) {
      return false;
    }
    if (entry.rate === entry.appliedRate) return false;
    entry.stopReason = "restart";
    entry.controller.abort();
    return true;
  }
```

`pause`: a restart in flight must not block a pause. Replace its guard and the abort branch:

```ts
// A cancel or pause already in flight is final; a restart is not.
if (
  !entry ||
  !ACTIVE.has(entry.job.status) ||
  (entry.stopReason && entry.stopReason !== "restart")
) {
  return false;
}
```

(The rest of `pause` is unchanged: it sets `stopReason = "pause"` and calls `abort()`, which does nothing on an already aborted controller.)

`#execute`: record the cap and pass it. Just before `const { exitCode } = await this.#run(`:

```ts
entry.appliedRate = entry.rate;
entry.spawned = true;
```

and in the `buildYtDlpArgs({ ... })` input add `limitRate: entry.appliedRate,`. Because the input object is built after the awaits above it, a `setRate` made from `onUpdate` when the job turned `downloading` is already in `entry.rate`.

Replace the outcome logic so a restart is told apart from a stop. Declare `let restart = false;` next to `let outcome`. Then:

```ts
      const restarting = controller.signal.aborted && entry.stopReason === "restart";
      if (restarting && exitCode !== 0) {
        restart = true;
        outcome = {};
      } else if (controller.signal.aborted && !restarting) {
        outcome = { status: entry.stopReason === "pause" ? "paused" : "cancelled" };
      } else if (exitCode === 0 && (filePath || job.request.subtitle)) {
```

(the `completed` and `failed` branches stay as they are). In the `catch`:

```ts
    } catch (error) {
      if (controller.signal.aborted && entry.stopReason === "restart") {
        restart = true;
        outcome = {};
      } else {
        outcome = controller.signal.aborted
          ? { status: entry.stopReason === "pause" ? "paused" : "cancelled" }
          : {
              status: "failed",
              error: redactSecrets(error instanceof Error ? error.message : String(error), secrets),
              errorKind: error instanceof CliError ? error.exitCode : ExitCode.Failure,
            };
      }
    }

    // Same slot, same id, same work folder: run yt-dlp again with the new cap.
    if (restart) {
      entry.controller = new AbortController();
      entry.stopReason = undefined;
      entry.spawned = false;
      return this.#execute(entry);
    }
```

The restart block sits before the work folder clean-up, so the folder survives. `#execute` reads `entry.controller` through `const { job, controller } = entry;` at its top, so the new call uses the new controller. Its first line reports `downloading` again with the same status; `#record` in the service only stamps `lastTryAt` when the status changes, so the row is not touched.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop/src/engine`
Expected: PASS, including every earlier pause, resume and cancel test.

- [ ] **Step 6: Commit message for the user**

```markdown
✨ desktop: cap a download's speed and restart yt-dlp when the cap changes

## Description

yt-dlp cannot change its speed limit while it runs, so a new limit
needs a restart that must not look like a pause to anyone watching.

The engine passes --limit-rate from setRate, and applyRate restarts a
downloading job whose cap changed: same id, same slot, same work
folder, and the status never leaves downloading. A pause or cancel
during a restart wins, a restart that lands after yt-dlp exited 0
still completes the job, and jobs that are queued or merging are left
alone.

## Test

pnpm exec vitest run apps/desktop/src/engine
```

---

### Task 5: The bandwidth controller

**Files:**

- Create: `apps/desktop/src/core/bandwidth.ts`
- Create: `apps/desktop/src/core/bandwidth.test.ts`

**Interfaces:**

- Consumes: `LimitPreset`, `Limits` (Task 1); the engine methods `list`, `setRate`, `applyRate` (Task 4).
- Produces:
  - `interface BandwidthSettings { limitPreset: LimitPreset; limits: Limits }`
  - `interface RateJob { id: string; status: DownloadStatus }`
  - `planRates(jobs: readonly (RateJob & { limitOverride?: LimitPreset })[], settings: BandwidthSettings): Map<string, number | undefined>`
  - `interface RateEngine { list(): RateJob[]; setRate(id: string, bytesPerSec: number | undefined): void; applyRate(id: string): boolean }`
  - `class Bandwidth` with `constructor(options: { engine: RateEngine; overrideOf: (id: string) => LimitPreset | undefined; settings: BandwidthSettings; debounceMs?: number })`, `update(): void`, `setSettings(settings: BandwidthSettings): void`, `dispose(): void`
  - `const RESTART_DEBOUNCE_MS = 3000`

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/core/bandwidth.test.ts`:

```ts
import { DEFAULT_LIMITS, type LimitPreset } from "@mediaforge/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Bandwidth,
  type BandwidthSettings,
  planRates,
  type RateJob,
} from "./bandwidth.ts";

const settings = (preset: LimitPreset, limits = {}): BandwidthSettings => ({
  limitPreset: preset,
  limits: { ...DEFAULT_LIMITS, ...limits },
});

describe("planRates", () => {
  it("gives nothing a cap while the preset is unlimited", () => {
    const jobs = [{ id: "a", status: "downloading" as const }];
    expect(planRates(jobs, settings("high"))).toEqual(
      new Map([["a", undefined]]),
    );
  });

  it("splits the preset evenly, rounding down, over downloading jobs only", () => {
    const jobs: RateJob[] = [
      { id: "a", status: "downloading" },
      { id: "b", status: "downloading" },
      { id: "c", status: "downloading" },
      { id: "q", status: "queued" },
      { id: "p", status: "processing" },
      { id: "z", status: "paused" },
    ];
    expect(planRates(jobs, settings("med"))).toEqual(
      new Map([
        ["a", 1_666_666],
        ["b", 1_666_666],
        ["c", 1_666_666],
      ]),
    );
  });

  it("gives an overridden job its own cap, outside the split", () => {
    const jobs = [
      { id: "a", status: "downloading" as const },
      {
        id: "b",
        status: "downloading" as const,
        limitOverride: "low" as const,
      },
      {
        id: "c",
        status: "downloading" as const,
        limitOverride: "high" as const,
      },
    ];
    expect(planRates(jobs, settings("med"))).toEqual(
      new Map([
        ["a", 5_000_000],
        ["b", 1_000_000],
        ["c", undefined],
      ]),
    );
  });

  it("never splits below 1 byte per second", () => {
    const jobs = [
      { id: "a", status: "downloading" as const },
      { id: "b", status: "downloading" as const },
    ];
    expect(planRates(jobs, settings("custom", { custom: 1 })).get("a")).toBe(1);
  });
});

describe("Bandwidth", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeEngine(jobs: RateJob[]) {
    const rates = new Map<string, number | undefined>();
    const applied = new Map<string, number | undefined>();
    const restarts: string[] = [];
    return {
      jobs,
      rates,
      restarts,
      /** The rate each running job's yt-dlp was started with. */
      applied,
      engine: {
        list: () => jobs.map((j) => ({ ...j })),
        setRate: (id: string, rate: number | undefined) =>
          void rates.set(id, rate),
        applyRate: (id: string) => {
          const job = jobs.find((j) => j.id === id);
          if (
            job?.status !== "downloading" ||
            rates.get(id) === applied.get(id)
          )
            return false;
          restarts.push(id);
          applied.set(id, rates.get(id));
          return true;
        },
      },
    };
  }

  it("sets a starting job's cap at once and restarts the others after 3 s", () => {
    const f = fakeEngine([{ id: "a", status: "downloading" }]);
    const bw = new Bandwidth({
      engine: f.engine,
      overrideOf: () => undefined,
      settings: settings("med"),
    });
    bw.update();
    f.applied.set("a", f.rates.get("a"));
    expect(f.rates.get("a")).toBe(5_000_000);

    f.jobs.push({ id: "b", status: "downloading" });
    bw.update();
    expect(f.rates.get("b")).toBe(2_500_000);
    f.applied.set("b", 2_500_000); // b starts with its share
    expect(f.restarts).toEqual([]);
    vi.advanceTimersByTime(2999);
    expect(f.restarts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(f.restarts).toEqual(["a"]);
    bw.dispose();
  });

  it("restarts each job once for a burst of changes", () => {
    const f = fakeEngine([
      { id: "a", status: "downloading" },
      { id: "b", status: "downloading" },
    ]);
    const bw = new Bandwidth({
      engine: f.engine,
      overrideOf: () => undefined,
      settings: settings("high"),
    });
    bw.setSettings(settings("med"));
    vi.advanceTimersByTime(1000);
    bw.setSettings(settings("low"));
    vi.advanceTimersByTime(1000);
    f.jobs.push({ id: "c", status: "queued" });
    bw.update();
    vi.advanceTimersByTime(3000);
    expect(f.restarts.sort()).toEqual(["a", "b"]);
    expect(f.applied.get("a")).toBe(500_000);
    bw.dispose();
  });

  it("does not restart a job whose cap ends up where it started", () => {
    const f = fakeEngine([{ id: "a", status: "downloading" }]);
    f.applied.set("a", undefined);
    const bw = new Bandwidth({
      engine: f.engine,
      overrideOf: () => undefined,
      settings: settings("high"),
    });
    bw.setSettings(settings("med"));
    bw.setSettings(settings("high"));
    vi.advanceTimersByTime(3000);
    expect(f.restarts).toEqual([]);
    bw.dispose();
  });

  it("leaves a job alone that went on to processing while the restart waited", () => {
    const f = fakeEngine([{ id: "a", status: "downloading" }]);
    const bw = new Bandwidth({
      engine: f.engine,
      overrideOf: () => undefined,
      settings: settings("high"),
    });
    bw.setSettings(settings("med"));
    (f.jobs[0] as RateJob).status = "processing";
    vi.advanceTimersByTime(3000);
    expect(f.restarts).toEqual([]);
    bw.dispose();
  });

  it("reads overrides through overrideOf", () => {
    const f = fakeEngine([{ id: "a", status: "downloading" }]);
    const bw = new Bandwidth({
      engine: f.engine,
      overrideOf: () => "low",
      settings: settings("high"),
    });
    bw.update();
    expect(f.rates.get("a")).toBe(1_000_000);
    bw.dispose();
  });

  it("schedules nothing when no job is downloading, and dispose clears a pending restart", () => {
    const f = fakeEngine([{ id: "a", status: "paused" }]);
    const bw = new Bandwidth({
      engine: f.engine,
      overrideOf: () => undefined,
      settings: settings("med"),
    });
    bw.update();
    expect(vi.getTimerCount()).toBe(0);
    f.jobs[0] = { id: "a", status: "downloading" };
    bw.update();
    expect(vi.getTimerCount()).toBe(1);
    bw.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/core/bandwidth.test.ts`
Expected: FAIL, `Failed to resolve import "./bandwidth.ts"`.

- [ ] **Step 3: Implement**

`apps/desktop/src/core/bandwidth.ts`:

```ts
import type {
  DownloadStatus,
  LimitPreset,
  Limits,
} from "@mediaforge/shared-types";

/** Wait this long after the last change before restarting running jobs with their new cap. */
export const RESTART_DEBOUNCE_MS = 3000;

export interface BandwidthSettings {
  limitPreset: LimitPreset;
  limits: Limits;
}

export interface RateJob {
  id: string;
  status: DownloadStatus;
}

/**
 * Each downloading job's cap in bytes per second (undefined: none). A job with an override gets
 * that preset's value; the others split the global preset evenly. Jobs that are queued, merging
 * (processing) or stopped are left out: they run no download to limit.
 */
export function planRates(
  jobs: readonly (RateJob & { limitOverride?: LimitPreset })[],
  settings: BandwidthSettings,
): Map<string, number | undefined> {
  const downloading = jobs.filter((job) => job.status === "downloading");
  const sharing = downloading.filter((job) => !job.limitOverride).length;
  const global = settings.limits[settings.limitPreset];
  const rates = new Map<string, number | undefined>();
  for (const job of downloading) {
    if (job.limitOverride) {
      rates.set(job.id, settings.limits[job.limitOverride] ?? undefined);
    } else {
      rates.set(
        job.id,
        global === null ? undefined : Math.max(1, Math.floor(global / sharing)),
      );
    }
  }
  return rates;
}

export interface RateEngine {
  list(): RateJob[];
  setRate(id: string, bytesPerSec: number | undefined): void;
  /** Restart the job if its yt-dlp runs with another cap. False when nothing was restarted. */
  applyRate(id: string): boolean;
}

export interface BandwidthOptions {
  engine: RateEngine;
  /** A job's own preset, from its history row. */
  overrideOf: (id: string) => LimitPreset | undefined;
  settings: BandwidthSettings;
  debounceMs?: number;
}

/**
 * Keeps every downloading job's speed cap in line with the presets. A job that is about to start
 * gets its cap at once (the engine reads it when it starts yt-dlp). Jobs already running restart
 * once, `debounceMs` after the last change, and only if their cap really changed.
 */
export class Bandwidth {
  readonly #engine: RateEngine;
  readonly #overrideOf: (id: string) => LimitPreset | undefined;
  readonly #debounceMs: number;
  #settings: BandwidthSettings;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BandwidthOptions) {
    this.#engine = options.engine;
    this.#overrideOf = options.overrideOf;
    this.#settings = options.settings;
    this.#debounceMs = options.debounceMs ?? RESTART_DEBOUNCE_MS;
  }

  /** New preset or values, from the settings file or a client. */
  setSettings(settings: BandwidthSettings): void {
    this.#settings = settings;
    this.update();
  }

  /** Call after any job starts, stops or changes its override. */
  update(): void {
    const rates = this.#plan();
    for (const [id, rate] of rates) this.#engine.setRate(id, rate);
    if (rates.size === 0) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      // Planned again: jobs may have started, stopped or reached processing in the meantime.
      for (const [id, rate] of this.#plan()) {
        this.#engine.setRate(id, rate);
        this.#engine.applyRate(id);
      }
    }, this.#debounceMs);
    // A pending restart must not keep an otherwise idle core alive.
    this.#timer.unref?.();
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #plan(): Map<string, number | undefined> {
    const jobs = this.#engine.list().map((job) => {
      const limitOverride = this.#overrideOf(job.id);
      return limitOverride ? { ...job, limitOverride } : job;
    });
    return planRates(jobs, this.#settings);
  }
}
```

`setTimeout` returns a `NodeJS.Timeout` under `@types/node` (which `apps/desktop` uses), and vitest's fake timers return an object with `unref` too, so `.unref?.()` type-checks and runs in both.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop/src/core/bandwidth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit message for the user**

```markdown
✨ desktop: split the bandwidth preset across running downloads

## Description

The global limit is shared by every running download, and jobs with
an override sit outside it, so each job's cap depends on all the
others and changes whenever one starts or stops.

Adds planRates, which splits the active preset evenly over downloading
jobs (rounded down, at least 1 B/s) and gives overridden jobs their own
preset, and a controller that applies the result: a starting job gets
its cap at once, running ones restart once, 3 s after the last change,
and only when their cap changed. Queued and merging jobs are left out.

## Test

pnpm exec vitest run apps/desktop/src/core/bandwidth.test.ts
```

---

### Task 6: Bandwidth in the core service

**Files:**

- Modify: `apps/desktop/src/core/service.ts`
- Modify: `apps/desktop/src/core/run-core.ts`
- Modify: `apps/desktop/src/core/in-process.ts`
- Test: `apps/desktop/src/core/service.test.ts`, `apps/desktop/src/core/run-core.test.ts`

**Interfaces:**

- Consumes: `Bandwidth`, `BandwidthSettings` (Task 5); engine `setRate`, `applyRate` (Task 4); `download.setLimit` and `limitOverride` (Task 2).
- Produces:
  - `CoreServiceDeps.bandwidth?: BandwidthSettings` (the settings at start; default High with the built-in values)
  - `download.setLimit` handled: `jobs.result`, then a `jobs.snapshot` to subscribers.
  - `HistoryJob.limitOverride` kept across engine updates.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/core/service.test.ts`, give `fakeEngine` the two new methods so the service can call them:

```ts
    setRate: vi.fn(),
    applyRate: vi.fn(() => false),
```

and pass `bandwidth` through `setup` (add `bandwidth?: CoreServiceDeps["bandwidth"]` to `SetupOptions`, and `...(options.bandwidth && { bandwidth: options.bandwidth })` to the `CoreService` deps).

Then add:

```ts
describe("bandwidth", () => {
  const start = async (t: Awaited<ReturnType<typeof setup>>, id = "s") => {
    await t.send("download.start", { candidate, profileId: "best" }, id);
  };

  it("caps a starting job with the global preset", async () => {
    const t = await setup({
      autoStart: true,
      bandwidth: {
        limitPreset: "med",
        limits: { high: null, med: 5_000_000, low: 1_000_000, custom: null },
      },
    });
    await start(t);
    expect(t.fake.engine.setRate).toHaveBeenCalledWith("job-1", 5_000_000);
  });

  it("applies a new preset from settings.set at once", async () => {
    const t = await setup({ autoStart: true });
    await start(t);
    t.fake.engine.setRate.mockClear();
    await t.send("settings.set", { limitPreset: "low" });
    expect(t.fake.engine.setRate).toHaveBeenCalledWith("job-1", 1_000_000);
  });

  it("applies preset values re-read on applySettings", async () => {
    const t = await setup({
      autoStart: true,
      settings: { limitPreset: "custom" },
    });
    await start(t);
    await t.settings.save({
      ...(await t.settings.load()),
      limits: { high: null, med: 1, low: 1, custom: 300_000 },
    });
    t.fake.engine.setRate.mockClear();
    await t.service.applySettings();
    expect(t.fake.engine.setRate).toHaveBeenCalledWith("job-1", 300_000);
  });

  it("sets and clears a job override, then sends subscribers a snapshot", async () => {
    const t = await setup({ autoStart: true });
    await start(t);
    await t.send("jobs.subscribe", {}, "sub");
    t.sent.length = 0;
    await t.send(
      "download.setLimit",
      { jobIds: ["job-1"], preset: "low" },
      "lim",
    );
    expect(t.sent[0]).toMatchObject({
      id: "lim",
      type: "jobs.result",
      payload: { failed: [] },
    });
    const snapshot = t.sent.find((m) => m.type === "jobs.snapshot");
    expect(snapshot).toMatchObject({
      payload: { jobs: [{ id: "job-1", limitOverride: "low" }] },
    });
    expect(t.history.get("job-1")?.limitOverride).toBe("low");
    expect(t.fake.engine.setRate).toHaveBeenLastCalledWith("job-1", 1_000_000);

    await t.send(
      "download.setLimit",
      { jobIds: ["job-1"], preset: null },
      "clr",
    );
    expect(t.history.get("job-1")?.limitOverride).toBeUndefined();
  });

  it("reports unknown and finished jobs, and still sets the others", async () => {
    const t = await setup({ autoStart: true });
    await start(t, "s1");
    await start(t, "s2");
    t.update("job-2", { status: "completed", outputPath: "/out/a.mp4" });
    t.sent.length = 0;
    await t.send("download.setLimit", {
      jobIds: ["job-1", "job-2", "nope", "job-1"],
      preset: "med",
    });
    expect(t.sent[0]).toMatchObject({
      type: "jobs.result",
      payload: {
        failed: [
          { jobId: "job-2", message: "Finished downloads have no limit." },
          { jobId: "nope", message: "No such download." },
        ],
      },
    });
    expect(t.history.get("job-1")?.limitOverride).toBe("med");
  });

  it("keeps the override when the engine reports the job again", async () => {
    const t = await setup({ autoStart: true });
    await start(t);
    await t.send("download.setLimit", { jobIds: ["job-1"], preset: "low" });
    t.update("job-1", { progress: { bytesDownloaded: 10 } });
    t.update("job-1", { status: "paused" });
    expect(t.history.get("job-1")?.limitOverride).toBe("low");
  });
});
```

In `apps/desktop/src/core/run-core.test.ts`, next to `"builds the engine with the saved number of downloads at once"` (it uses the file's `launch` helper; add `import type { EngineJob } from "../engine/index.ts";` if the file lacks it):

```ts
it("starts the bandwidth controller with the saved preset", async () => {
  const setRate = vi.fn();
  const job = {
    id: "j",
    status: "downloading",
    request: { candidate: {}, profileId: "best" },
    progress: { bytesDownloaded: 0 },
    createdAt: 1,
    updatedAt: 1,
  } as unknown as EngineJob;
  let report: (job: EngineJob) => void = () => {};
  const createEngine = vi.fn((onUpdate: (job: EngineJob) => void) => {
    report = onUpdate;
    return {
      list: () => [job],
      submit: () => ({}),
      cancel: () => false,
      get: () => undefined,
      restore: () => {},
      setRate,
      applyRate: () => false,
    } as never;
  });
  await launch({
    settings: memorySettingsStore({ limitPreset: "low" }),
    createEngine,
  });
  report(job);
  expect(setRate).toHaveBeenCalledWith("j", 1_000_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/core`
Expected: FAIL: `setRate` never called, `download.setLimit` answers `unsupported`.

- [ ] **Step 3: Implement the service**

`apps/desktop/src/core/service.ts`.

Imports:

```ts
import {
  DEFAULT_LIMITS,
  type DownloadJob,
  type JobOrigin,
} from "@mediaforge/shared-types";
import { Bandwidth, type BandwidthSettings } from "./bandwidth.ts";
```

`CoreServiceDeps`:

```ts
  /** The bandwidth settings at start. `applySettings` and `settings.set` keep them current. */
  bandwidth?: BandwidthSettings;
```

Field and constructor (create it right after the engine; the engine only reports jobs once requests arrive, after the constructor):

```ts
  readonly #bandwidth: Bandwidth;
```

```ts
this.#engine = deps.createEngine((job) => this.#onJob(job));
this.#bandwidth = new Bandwidth({
  engine: this.#engine,
  overrideOf: (id) => this.#deps.history.get(id)?.limitOverride,
  settings: deps.bandwidth ?? {
    limitPreset: "high",
    limits: { ...DEFAULT_LIMITS },
  },
});
```

`applySettings`:

```ts
  async applySettings(): Promise<void> {
    const settings = await this.#deps.settings.load();
    this.#engine.setMaxConcurrent(settings.concurrency);
    this.#bandwidth.setSettings({ limitPreset: settings.limitPreset, limits: settings.limits });
  }
```

`shutdown`: call `this.#bandwidth.dispose();` before closing the history.

`#setSettings`: after `await this.#deps.settings.save(next);` add

```ts
this.#bandwidth.setSettings({
  limitPreset: next.limitPreset,
  limits: next.limits,
});
```

`#dispatch`: replace the placeholder `download.setLimit` case from Task 2:

```ts
      case "download.setLimit": {
        const preset = message.payload.preset;
        await this.#batch(state, message.id, message.payload.jobIds, (jobId) => {
          const row = this.#deps.history.get(jobId);
          if (!row) return UNKNOWN;
          if (row.status === "completed" || row.status === "cancelled") {
            return "Finished downloads have no limit.";
          }
          const { limitOverride: _old, ...rest } = row;
          this.#deps.history.upsert(preset ? { ...rest, limitOverride: preset } : rest, {
            save: true,
          });
          return undefined;
        });
        this.#bandwidth.update();
        return this.#pushSnapshot();
      }
```

Rename `#afterRemoval` into two parts so the snapshot push can be reused:

```ts
  /** Subscribers get the whole list again: rows went away or changed outside the engine. */
  #pushSnapshot(): void {
    for (const state of this.#clients) {
      if (!state.active || !state.subscribedAll) continue;
      const id = this.#deps.newId();
      this.#reply(state, id, "jobs.snapshot", { jobs: this.#snapshot(id) });
    }
  }

  /** Rows went away: subscribers get the new list, and the notice may no longer apply. */
  #afterRemoval(): void {
    this.#pushSnapshot();
    this.#settleNotice();
  }
```

`#record`: keep the override across engine updates. Add to the `row` object, after the `plan` line:

```ts
      ...(before?.limitOverride && { limitOverride: before.limitOverride }),
```

`#onJob`: a status change can change every running job's share. Read the old status before recording:

```ts
  #onJob(job: EngineJob): void {
    const before = this.#deps.history.get(job.id)?.status;
    this.#record(job);
    if (before !== job.status) this.#bandwidth.update();
    this.#settleNotice();
```

(the rest of `#onJob` is unchanged).

Because `#onJob` runs synchronously inside the engine's `#update`, a job that turns `downloading` gets its cap from `update()` before the engine builds the yt-dlp arguments.

- [ ] **Step 4: Implement the start-up wiring**

`apps/desktop/src/core/run-core.ts`: the core already loads the settings once for `maxConcurrent`. Keep the whole object:

```ts
let maxConcurrent = DEFAULT_SETTINGS.concurrency;
let bandwidth = {
  limitPreset: DEFAULT_SETTINGS.limitPreset,
  limits: DEFAULT_SETTINGS.limits,
};
try {
  const initial = await deps.settings.load();
  maxConcurrent = initial.concurrency;
  bandwidth = { limitPreset: initial.limitPreset, limits: initial.limits };
} catch {
  // Keep the defaults.
}
```

and pass `bandwidth,` in the `new CoreService({ ... })` deps.

`apps/desktop/src/core/in-process.ts`: it builds a `CoreService` for tests and the menu tests. Pass nothing: the default (High, unlimited) applies, and `applySettings` reads the store when a test calls it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit message for the user**

```markdown
✨ desktop: limit download speed from the bandwidth preset and job overrides

## Description

The core now applies the bandwidth settings: every downloading job is
capped by its share of the active preset, or by its own override, and
the caps follow preset changes, job starts and job ends.

download.setLimit sets or clears a job's override (finished jobs are
reported, the others still set), the override is kept in history.json,
and subscribers get a fresh snapshot. Preset changes apply at once
from settings.set and from the settings file on reload and poll.

## Test

pnpm exec vitest run apps/desktop
```

---

### Task 7: Speed unit and Bandwidth limit in Settings

**Files:**

- Modify: `apps/desktop/src/interactive/components/Menu.tsx`
- Test: `apps/desktop/src/interactive/components/Menu.test.tsx`
- Create: `apps/desktop/src/interactive/screens/BandwidthScreen.tsx`
- Modify: `apps/desktop/src/interactive/screens/SettingsScreen.tsx`
- Test: `apps/desktop/src/interactive/App.test.tsx`

**Interfaces:**

- Consumes: `Settings.speedUnit/limitPreset/limits` (Task 2); `formatLimit`, `parseRate`, `LIMIT_PRESETS` (Task 1); `onSaved` (Task 3); `deps.notifyCore()` (exists: sends `settings.reload`).
- Produces:
  - `MenuProps.onHighlight?: (value: T) => void`
  - `BandwidthScreen({ settings, note, onSave, onBack }: { settings: Settings; note?: { tone: "ok" | "error"; text: string }; onSave: (next: Settings) => void; onBack: () => void })`
  - `PRESET_NAMES: Record<LimitPreset, string>` exported from `BandwidthScreen.tsx` (`High`, `Med`, `Low`, `Custom`)

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/interactive/components/Menu.test.tsx` (the file defines `tick` and imports `render`):

```tsx
it("reports the highlighted value as it moves", async () => {
  const seen: string[] = [];
  const app = render(
    <Menu<string>
      items={[
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ]}
      onSelect={() => {}}
      onHighlight={(value) => seen.push(value)}
    />,
  );
  await tick();
  app.stdin.write("\u001B[B");
  await tick();
  expect(seen).toEqual(["a", "b"]);
  app.unmount();
});
```

`apps/desktop/src/interactive/App.test.tsx`: raise the loop limit in `moveTo` from 12 to 16 (Settings gains two rows). Add to `describe("settings")`:

```tsx
it("toggles the speed unit", async () => {
  const t = await openSettings();
  await moveTo(t.app, "Speed unit");
  expect(t.app.lastFrame()).toContain("MB/s");
  await press(t.app, KEY.enter);
  await waitFor(t.app, "Saved");
  expect((await t.store.load()).speedUnit).toBe("bits");
  expect(t.app.lastFrame()).toContain("Mbps");
  t.app.unmount();
});

it("picks the bandwidth preset and tells the core", async () => {
  const t = await openSettings();
  await moveTo(t.app, "Bandwidth limit");
  expect(t.app.lastFrame()).toContain("High (no limit)");
  await press(t.app, KEY.enter);
  await waitFor(t.app, "e Edit value");
  await moveTo(t.app, "Med");
  await press(t.app, KEY.enter);
  await waitFor(t.app, "Saved");
  expect((await t.store.load()).limitPreset).toBe("med");
  expect(t.app.lastFrame()).toContain("(in use)");
  await vi.waitFor(() => expect(t.notified).toHaveLength(1));
  await press(t.app, KEY.esc);
  await waitFor(t.app, "Med (5.0 MB/s)");
  t.app.unmount();
});

it("edits a preset value in the speed unit, with empty for no limit", async () => {
  const t = await openSettings({ settings: { speedUnit: "bits" } });
  await moveTo(t.app, "Bandwidth limit");
  await press(t.app, KEY.enter);
  await waitFor(t.app, "e Edit value");
  await moveTo(t.app, "Low");
  await press(t.app, "e");
  await waitFor(t.app, "Empty or 0 for no limit");
  await press(t.app, KEY.ctrlU, "2", "0", KEY.enter);
  await waitFor(t.app, "Saved");
  expect((await t.store.load()).limits.low).toBe(2_500_000);
  expect((await t.store.load()).limitPreset).toBe("high");
  expect(t.app.lastFrame()).toContain("20.0 Mbps");

  await press(t.app, "e");
  await waitFor(t.app, "Empty or 0 for no limit");
  await press(t.app, KEY.ctrlU, KEY.enter);
  await waitFor(t.app, "Saved");
  expect((await t.store.load()).limits.low).toBeNull();
  t.app.unmount();
});

it("refuses a value it cannot read and keeps the old one", async () => {
  const t = await openSettings();
  await moveTo(t.app, "Bandwidth limit");
  await press(t.app, KEY.enter);
  await waitFor(t.app, "e Edit value");
  await moveTo(t.app, "Med");
  await press(t.app, "e");
  await waitFor(t.app, "Empty or 0 for no limit");
  await press(t.app, KEY.ctrlU, "f", "a", "s", "t", KEY.enter);
  await waitFor(t.app, "Type a speed such as 5, 5 MB/s or 40 Mbps.");
  expect((await t.store.load()).limits.med).toBe(5_000_000);
  t.app.unmount();
});
```

`KEY.ctrlU` clears a `TextField` (`TextField.tsx:121`).

`moveTo` looks for a line starting with `"  ► "` that contains the label. The Bandwidth screen's rows are `High`, `Med`, `Low` and `Custom`, and no other text on it contains those words, so the label match is safe.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/interactive`
Expected: FAIL: no `onHighlight`, no "Speed unit" row.

- [ ] **Step 3: Implement `onHighlight`**

`Menu.tsx`: add to `MenuProps`:

```ts
  /** Called with the highlighted value, first on mount and then on every move. */
  onHighlight?: (value: T) => void;
```

Destructure it in `Menu`, and after the `useState` for `index`:

```ts
const highlighted = items[index]?.value;
useEffect(() => {
  if (highlighted !== undefined) onHighlight?.(highlighted);
}, [highlighted, onHighlight]);
```

Import `useEffect` from `react`. Callers must pass a stable `onHighlight` (a state setter is) or the effect runs on each render; that is harmless but noisy.

- [ ] **Step 4: Implement the Bandwidth screen**

`apps/desktop/src/interactive/screens/BandwidthScreen.tsx`:

```tsx
import {
  formatLimit,
  LIMIT_PRESETS,
  type LimitPreset,
  parseRate,
} from "@mediaforge/shared-types";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Settings } from "../../settings.ts";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { TextField } from "../components/TextField.tsx";
import { COLORS, ICONS } from "../theme.ts";

export const PRESET_NAMES: Record<LimitPreset, string> = {
  high: "High",
  med: "Med",
  low: "Low",
  custom: "Custom",
};

interface BandwidthScreenProps {
  settings: Settings;
  /** The result of the last save, shown under the list. */
  note?: { tone: "ok" | "error"; text: string };
  /** Save the whole settings object; the caller sets `note` and tells the core. */
  onSave: (next: Settings) => void;
  onBack: () => void;
}

/** The four presets with their values: Enter makes one the global limit, `e` edits its value. */
export function BandwidthScreen({
  settings,
  note,
  onSave,
  onBack,
}: BandwidthScreenProps) {
  const [highlighted, setHighlighted] = useState<LimitPreset>(
    settings.limitPreset,
  );
  const [editing, setEditing] = useState<LimitPreset>();
  const unit = settings.speedUnit;
  const unitName = unit === "bits" ? "Mbps" : "MB/s";

  useInput(
    (input) => {
      if (input === "e") setEditing(highlighted);
    },
    { isActive: editing === undefined },
  );

  if (editing) {
    const current = settings.limits[editing];
    return (
      <Frame
        crumbs={["Home", "Settings", "Bandwidth limit", PRESET_NAMES[editing]]}
        icon={ICONS.download}
        title={`Limit for ${PRESET_NAMES[editing]}`}
        hints={[
          ["Enter", "Save"],
          ["Esc", "Cancel"],
        ]}
      >
        <Box marginBottom={1}>
          <Text color={COLORS.muted}>
            {`In ${unitName} unless you type a unit (MB/s, Mbps, kB/s…). Empty or 0 for no limit.`}
          </Text>
        </Box>
        <TextField
          initial={current === null ? "" : formatLimit(current, unit)}
          validate={(value) => {
            const parsed = parseRate(value, unit);
            return parsed.ok ? undefined : parsed.error;
          }}
          onSubmit={(value) => {
            const parsed = parseRate(value, unit);
            if (!parsed.ok) return;
            setEditing(undefined);
            onSave({
              ...settings,
              limits: { ...settings.limits, [editing]: parsed.bytesPerSec },
            });
          }}
          onCancel={() => setEditing(undefined)}
        />
      </Frame>
    );
  }

  return (
    <Frame
      crumbs={["Home", "Settings", "Bandwidth limit"]}
      icon={ICONS.download}
      title="Bandwidth limit"
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Use"],
        ["e", "Edit value"],
        ["Esc", "Back"],
      ]}
    >
      <Box marginBottom={1}>
        <Text color={COLORS.muted}>
          Shared evenly by the downloads that are running. Downloads with their
          own limit are not counted.
        </Text>
      </Box>
      <Menu<LimitPreset>
        initial={settings.limitPreset}
        onBack={onBack}
        onHighlight={setHighlighted}
        onSelect={(preset) => onSave({ ...settings, limitPreset: preset })}
        items={LIMIT_PRESETS.map((preset) => ({
          value: preset,
          icon: preset === settings.limitPreset ? ICONS.on : ICONS.off,
          label: PRESET_NAMES[preset].padEnd(8),
          hint: `${formatLimit(settings.limits[preset], unit)}${preset === settings.limitPreset ? "  (in use)" : ""}`,
        }))}
      />
      {note ? (
        <Box marginTop={1}>
          <Text color={note.tone === "ok" ? COLORS.ok : COLORS.error}>
            {note.tone === "ok" ? ICONS.ok : ICONS.error} {note.text}
          </Text>
        </Box>
      ) : null}
    </Frame>
  );
}
```

`TextField` shows the `validate` message itself and blocks Enter while the value is invalid, so the "refuses a value" test sees the error under the field.

- [ ] **Step 5: Wire it into Settings**

`SettingsScreen.tsx`:

Imports:

```ts
import { formatLimit } from "@mediaforge/shared-types";
import { BandwidthScreen, PRESET_NAMES } from "./BandwidthScreen.tsx";
```

`Choice` gains `"speedUnit" | "bandwidth"`; `Mode` gains `"bandwidth"`.

In `save`, tell the core about any change it applies live:

```ts
const live =
  next.concurrency !== settings.concurrency ||
  next.limitPreset !== settings.limitPreset ||
  JSON.stringify(next.limits) !== JSON.stringify(settings.limits);
if (live) void deps.notifyCore();
```

(replacing the single `concurrency` check).

`save` sets the mode back to `"menu"` at its end. The Bandwidth screen should stay open after a save, so give `save` a third parameter:

```ts
  const save = async (next: Settings, syncAutostart = false, stay = false) => {
```

and end it with `if (!stay) setMode("menu");`.

The bandwidth mode, before the `quality` mode block:

```tsx
if (mode === "bandwidth") {
  return (
    <BandwidthScreen
      settings={settings}
      note={note}
      onSave={(next) => void save(next, false, true)}
      onBack={() => {
        setNote(undefined);
        setMode("menu");
      }}
    />
  );
}
```

The note goes inside the screen's `Frame`, as on the main Settings menu: `Frame` fills the terminal height, so anything rendered after it would fall off screen.

In the main `onSelect`, add:

```ts
          } else if (choice === "speedUnit") {
            void save({ ...settings, speedUnit: settings.speedUnit === "bits" ? "bytes" : "bits" });
```

(`"bandwidth"` falls through to `setMode(choice)`.)

New items, after `"concurrency"`:

```tsx
          {
            value: "speedUnit",
            icon: ICONS.download,
            label: "Speed unit",
            hint: settings.speedUnit === "bits" ? "Mbps (bits per second)" : "MB/s (bytes per second)",
          },
          {
            value: "bandwidth",
            icon: ICONS.download,
            label: "Bandwidth limit",
            hint: `${PRESET_NAMES[settings.limitPreset]} (${formatLimit(settings.limits[settings.limitPreset], settings.speedUnit)})`,
          },
```

`setNote(undefined)` runs when the main menu picks a row; the Bandwidth screen keeps the last note until the next save, which is what the tests expect.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop/src/interactive && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit message for the user**

```markdown
✨ desktop: set the speed unit and the bandwidth limit in Settings

## Description

The bandwidth presets and the speed unit had no place in the menu.

Settings gains "Speed unit" (Enter toggles MB/s and Mbps) and
"Bandwidth limit", which lists High, Med, Low and Custom with their
values: Enter makes one the global limit, e edits its value in the
current unit (empty or 0 for no limit). A preset or value change is
sent to a running core at once.

## Test

pnpm exec vitest run apps/desktop/src/interactive
```

---

### Task 8: Manual checklist

**Files:**

- Modify: `docs/desktop-cli-checklist.md`

- [ ] **Step 1: Add the phase 3a checks**

Append, using the file's heading level and checkbox style:

```markdown
## Speed unit and bandwidth (downloads manager phase 3a)

- [ ] Sizes in the menu, the download screen, About and `mediaforge formats` read kB/MB/GB (×1000); a 5 MiB file reads 5.2 MB.
- [ ] Set Speed unit to Mbps: the menu download screen and the `mediaforge download` progress line show Mbps.
- [ ] Set the Bandwidth limit to Low (1.0 MB/s) during one large real download: within about 3 s the speed drops to about 1 MB/s, the screen never shows Paused, and the byte count keeps growing from where it was.
- [ ] Start a second download with Low still active: both settle near 0.5 MB/s.
- [ ] Set the limit back to High: both speed up within about 3 s.
- [ ] Edit Custom to `40 Mbps` with the unit on MB/s: it saves as 5.0 MB/s. Edit it to empty: it shows "no limit".
- [ ] Change the preset while a download is merging (Processing): the merge is not interrupted.
- [ ] Put `"limits": { "med": -5 }` in config.json by hand: Settings shows Med at 5.0 MB/s and the other values are kept.
```

- [ ] **Step 2: Commit message for the user**

```markdown
📝 docs: add manual checks for the speed unit and bandwidth limits

## Test

Read through docs/desktop-cli-checklist.md
```

---

## Before finishing

- [ ] Run `pnpm lint`, `pnpm typecheck` and `pnpm test` from the repo root. All three must pass.
