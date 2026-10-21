const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;
const INSET = 8;

/** Colours taken from the MediaForge icon: its dark tile and its cooling-metal gradient. */
export const BRAND = {
  ink: "#14161c",
  glow: "#ffe29a",
  ember: "#ff7a2f",
  flame: "#ffc26b",
} as const;

/** The icon's drawing area: x, y, width and height in its own 512-unit grid. */
export const MARK_VIEWBOX = "76 88 360 336";

/** The icon's pixels as runs of 24-unit cells: x, y, width, colour. */
export const MARK_RUNS: ReadonlyArray<readonly [number, number, number, string]> = [
  [220, 88, 72, "#7df0ff"],
  [220, 112, 72, "#7df0ff"],
  [220, 136, 72, "#7df0ff"],
  [172, 160, 168, "#22d3ee"],
  [196, 184, 120, "#22d3ee"],
  [220, 208, 72, "#22d3ee"],
  [76, 256, 360, "#ffe29a"],
  [124, 280, 312, "#ffc26b"],
  [172, 304, 240, "#ff9a4d"],
  [220, 328, 120, "#ff7a2f"],
  [220, 352, 120, "#f2542d"],
  [196, 376, 168, "#d93a1c"],
  [172, 400, 216, "#b92d18"],
];

/**
 * The button text after a click, from the background's answer. `popup` says whether the toolbar
 * popup opened for it, which is where a quality is picked.
 */
export function labelFor(status: string | undefined, reason?: string, popup = false): string {
  switch (status) {
    case "started":
      return "Started";
    case "needs-picker":
      return popup ? "Choose in the popup" : "Pick quality in the toolbar popup";
    case "nothing":
      switch (reason) {
        case "unsupported":
          return "Not supported here";
        case "error":
          return "Could not check this page";
        case "unavailable":
          return "MediaForge is not running";
        default:
          return "Nothing found";
      }
    default:
      return "Failed";
  }
}

export function isWorthOverlay(rect: { width: number; height: number }, hidden: boolean): boolean {
  return !hidden && rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT;
}

/**
 * Whether the video the button belongs to is gone: taken out of the page, or the page moved to
 * another address without a reload (single-page sites swap their content in place).
 */
export function isTargetGone(state: {
  connected: boolean;
  shownUrl: string;
  currentUrl: string;
}): boolean {
  return !state.connected || state.shownUrl !== state.currentUrl;
}

/**
 * Top-right corner of the element, inset a little, in document coordinates, moved by the
 * user's drag offset when there is one.
 */
export function placeButton(
  rect: { top: number; left: number; width: number; height: number },
  scroll: { x: number; y: number },
  button: { width: number; height: number },
  offset?: { dx: number; dy: number },
): { top: number; left: number } {
  return {
    top: rect.top + scroll.y + INSET + (offset?.dy ?? 0),
    left: rect.left + scroll.x + rect.width - button.width - INSET + (offset?.dx ?? 0),
  };
}

/** Moves the button by the drag delta, keeping it inside the document bounds. */
export function applyDrag(
  origin: { top: number; left: number },
  delta: { dx: number; dy: number },
  bounds: { width: number; height: number },
  button: { width: number; height: number },
): { top: number; left: number } {
  const clamp = (value: number, max: number): number =>
    Math.min(Math.max(0, value), Math.max(0, max));
  return {
    top: clamp(origin.top + delta.dy, bounds.height - button.height),
    left: clamp(origin.left + delta.dx, bounds.width - button.width),
  };
}

const DRAG_THRESHOLD = 4;

/** Whether a pointer moved far enough to be a drag rather than a click. */
export function isDrag(delta: { dx: number; dy: number }): boolean {
  return Math.hypot(delta.dx, delta.dy) >= DRAG_THRESHOLD;
}

/** Index of the first video or audio in an ordered list of elements, if any. */
export function findMediaIndex(elements: ReadonlyArray<{ tagName?: string }>): number | undefined {
  const index = elements.findIndex((el) => {
    const tag = el.tagName?.toUpperCase();
    return tag === "VIDEO" || tag === "AUDIO";
  });
  return index === -1 ? undefined : index;
}
