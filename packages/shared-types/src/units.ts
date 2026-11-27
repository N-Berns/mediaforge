/** How speeds are shown: bytes per second (MB/s) or bits per second (Mbps). */
export type SpeedUnit = "bytes" | "bits";

/** The global bandwidth presets; a job's override names one of them too. */
export type LimitPreset = "high" | "med" | "low" | "custom";

/** Each preset's cap in bytes per second. `null` means unlimited. */
export type Limits = Record<LimitPreset, number | null>;

export const LIMIT_PRESETS: readonly LimitPreset[] = ["high", "med", "low", "custom"];

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
export function formatLimit(bytesPerSec: number | null, unit: SpeedUnit): string {
  return bytesPerSec === null ? "no limit" : formatRate(bytesPerSec, unit);
}

export type ParsedRate = { ok: true; bytesPerSec: number | null } | { ok: false; error: string };

/** Number, optional prefix, optional unit. `B` and `b` differ by case on purpose. */
const RATE = /^(\d+(?:[.,]\d+)?)\s*([kKmMgGtTpP])?\s*(B\/s|B|bps|b\/s|bit\/s|b)?$/;

const PREFIX_POWER: Record<string, number> = { k: 1, m: 2, g: 3, t: 4, p: 5 };

/**
 * Read a limit typed by the user. Empty or 0 means unlimited (`null`). Without a unit the current
 * one is used; without a prefix and a unit, M (`5` is 5 MB/s or 5 Mbps).
 */
export function parseRate(text: string, unit: SpeedUnit): ParsedRate {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, bytesPerSec: null };
  const match = RATE.exec(trimmed);
  if (!match) return { ok: false, error: "Type a speed such as 5, 5 MB/s or 40 Mbps." };
  const [, digits = "", prefix, suffix] = match;
  const value = Number(digits.replace(",", "."));
  if (value === 0) return { ok: true, bytesPerSec: null };
  const bits = suffix === undefined ? unit === "bits" : !suffix.startsWith("B");
  const power = prefix ? (PREFIX_POWER[prefix.toLowerCase()] ?? 0) : suffix ? 0 : 2;
  const bytesPerSec = Math.round((value * 1000 ** power) / (bits ? 8 : 1));
  if (bytesPerSec < 1) return { ok: false, error: "The smallest limit is 1 B/s." };
  if (bytesPerSec > MAX_RATE) return { ok: false, error: "The largest limit is 1 PB/s." };
  return { ok: true, bytesPerSec };
}
