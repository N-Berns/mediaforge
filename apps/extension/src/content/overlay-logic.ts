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

/** A box in document coordinates. */
export type Box = { top: number; left: number; width: number; height: number };

/**
 * The area a button may sit in on a video: the element's box in document coordinates, inset on
 * every side by the same margin as the default corner.
 */
export function frameBounds(
  rect: { top: number; left: number; width: number; height: number },
  scroll: { x: number; y: number },
): Box {
  return {
    top: rect.top + scroll.y + INSET,
    left: rect.left + scroll.x + INSET,
    width: rect.width - 2 * INSET,
    height: rect.height - 2 * INSET,
  };
}

/**
 * Moves the button by the drag delta, keeping it inside `bounds`. A box too small for the button
 * pins it to its top-left corner.
 */
export function applyDrag(
  origin: { top: number; left: number },
  delta: { dx: number; dy: number },
  bounds: Box,
  button: { width: number; height: number },
): { top: number; left: number } {
  const clamp = (value: number, min: number, room: number): number =>
    Math.min(Math.max(min, value), min + Math.max(0, room));
  return {
    top: clamp(origin.top + delta.dy, bounds.top, bounds.height - button.height),
    left: clamp(origin.left + delta.dx, bounds.left, bounds.width - button.width),
  };
}

/**
 * Where the button sits in `bounds`, as a share of the room it can move in: x 0 is the left limit
 * and 1 the right, y 0 the top and 1 the bottom. A side with no room counts as 0.
 */
export function spotIn(
  pos: { top: number; left: number },
  bounds: Box,
  button: { width: number; height: number },
): { x: number; y: number } {
  const share = (value: number, min: number, room: number): number =>
    room > 0 ? Math.min(1, Math.max(0, (value - min) / room)) : 0;
  return {
    x: share(pos.left, bounds.left, bounds.width - button.width),
    y: share(pos.top, bounds.top, bounds.height - button.height),
  };
}

/** The position of a spot from `spotIn` in `bounds`, so it scales when the frame changes size. */
export function placeAtSpot(
  spot: { x: number; y: number },
  bounds: Box,
  button: { width: number; height: number },
): { top: number; left: number } {
  return {
    top: bounds.top + spot.y * Math.max(0, bounds.height - button.height),
    left: bounds.left + spot.x * Math.max(0, bounds.width - button.width),
  };
}

/** How long a still pointer over the video keeps the button up. */
export const IDLE_HIDE_MS = 3000;
/** How long the button stays after the pointer left its video. */
export const LEAVE_HIDE_MS = 500;

export type HideTimer = "idle" | "leave";

/**
 * What a pointer move or a change of the button's state does to it. `held` is a button that must
 * stay up: pointer on it, a drag, or a click's result on show. `moved` tells a real move from a
 * re-check, which never brings back a button hidden for being idle. `timer` says to clear the hide
 * timer, keep the one pending, or start the idle or the leave timer anew.
 */
export function hidePlan(state: {
  held: boolean;
  inside: boolean;
  moved: boolean;
  shown: boolean;
  pending: HideTimer | undefined;
}): { reveal: boolean; timer: "clear" | "keep" | HideTimer } {
  const { held, inside, moved, shown, pending } = state;
  if (held) return { reveal: true, timer: "clear" };
  if (inside && moved) return { reveal: true, timer: "idle" };
  if (inside) return { reveal: false, timer: shown && pending !== "idle" ? "idle" : "keep" };
  return { reveal: false, timer: shown && pending !== "leave" ? "leave" : "keep" };
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
