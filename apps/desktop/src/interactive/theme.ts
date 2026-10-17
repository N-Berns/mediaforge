/**
 * Taken from the logo (assets/brand/icon.svg): its cyan top and its amber-to-red bottom. Success
 * keeps a green, which the logo has none of. Terminals without 24-bit color get the nearest one.
 */
export const COLORS = {
  accent: "#22d3ee",
  /** The key in a key hint: "Esc" in "Esc Back". */
  key: "#ff9a4d",
  ok: "#4ade80",
  error: "#f2542d",
  warn: "#ffc26b",
  /** Paused downloads, kept apart from cancelled ones (which use warn). */
  paused: "#7df0ff",
  muted: "gray",
} as const;

/** One color per letter of the wordmark: MEDIA in the logo's cyans, FORGE in its fire. */
export const LOGO_COLORS = [
  "#7df0ff",
  "#62e7f8",
  "#4bdef3",
  "#36d8f0",
  "#22d3ee",
  "#ffc26b",
  "#ffae5c",
  "#ff9a4d",
  "#ff7a2f",
  "#f2542d",
] as const;

/**
 * Icons are limited to characters in the WGL4 set, which the default Windows
 * console fonts (Consolas, Lucida Console) can draw. No emoji: they show as boxes.
 */
export const ICONS = {
  app: "■",
  download: "▼",
  settings: "≡",
  setup: "√",
  quit: "×",
  back: "◄",
  pointer: "►",
  /** The selection cursor in every list, the same as the downloads table's. */
  cursor: ">",
  link: "►",
  type: "»",
  paste: "▪",
  video: "►",
  audio: "♪",
  /** The three download types share one width so their labels line up: picture, picture + sound, sound. */
  kindVideo: "► ",
  kindVideoAudio: "►♪",
  kindAudio: "♪ ",
  folder: "▬",
  format: "◊",
  retry: "●",
  ok: "√",
  error: "×",
  warn: "▲",
  /** Two half blocks, the nearest WGL4 has to a pause sign (U+23F8 and U+2016 are not in it). */
  paused: "▌▌",
  info: "○",
  on: "●",
  off: "○",
  chevron: "›",
  ellipsis: "…",
} as const;

/** The "MEDIAFORGE" wordmark in half-block letters. Uses only characters the default console fonts have. */
export const LOGO = [
  "█▀▄▀█ █▀▀ █▀▄ █ ▄▀█ █▀▀ █▀█ █▀█ █▀▀ █▀▀",
  "█░▀░█ ██▄ █▄▀ █ █▀█ █▀░ █▄█ █▀▄ █▄█ ██▄",
] as const;

export const SPINNER_FRAMES = ["|", "/", "-", "\\"] as const;

export const BAR = { full: "█", empty: "░" } as const;

/** Thinner bar for the individual steps, so the overall bar stands out above them. */
export const STEP_BAR = { full: "▬", empty: "─" } as const;

/** Each step has its own colour while it runs; finished steps turn green, waiting ones grey. */
export const STEP_COLORS = {
  download: "#22d3ee",
  video: "#22d3ee",
  audio: "#7df0ff",
  merge: "#ff9a4d",
  convert: "#ff9a4d",
} as const;
