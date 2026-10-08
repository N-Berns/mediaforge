export const COLORS = {
  accent: "cyan",
  ok: "green",
  error: "red",
  warn: "yellow",
  muted: "gray",
} as const;

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
  download: "blueBright",
  video: "blueBright",
  audio: "magentaBright",
  merge: "yellow",
  convert: "yellow",
} as const;
