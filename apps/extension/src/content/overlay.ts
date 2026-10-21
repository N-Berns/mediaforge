import {
  applyDrag,
  BRAND,
  findMediaIndex,
  isDrag,
  isTargetGone,
  isWorthOverlay,
  labelFor,
  MARK_RUNS,
  MARK_VIEWBOX,
  placeButton,
} from "./overlay-logic.ts";

const root = globalThis as unknown as { browser?: typeof browser; chrome: typeof browser };
const api = root.browser ?? root.chrome;

// The host element carries no page-visible text; the button lives in a closed shadow root so page
// styles and scripts cannot reach it. The only data sent to the background is the command kind;
// the background takes the tab and frame URL from the message sender, never from the page.
let host: HTMLElement | undefined;
let button: HTMLElement | undefined;
let label: HTMLSpanElement | undefined;
let target: HTMLMediaElement | undefined;
let enabled = false;
let listening = false;
let messageListening = false;
let busy = false;
let disposed = false;
let resetTimer: ReturnType<typeof setTimeout> | undefined;
// While the button is up, a timer re-checks its video: pages can remove, hide or move it, or
// swap the whole view, without any event the overlay listens to.
let trackTimer: ReturnType<typeof setInterval> | undefined;
let shownUrl = "";
const TRACK_MS = 300;

async function send<T>(message: { kind: string }, fallback: T): Promise<T> {
  try {
    const reply = (await api.runtime.sendMessage(message)) as T | undefined;
    return reply ?? fallback;
  } catch {
    return fallback;
  }
}

const HOST_STYLE: ReadonlyArray<readonly [string, string]> = [
  ["all", "initial"],
  ["position", "absolute"],
  ["z-index", "2147483647"],
  ["display", "block"],
  ["visibility", "visible"],
  ["opacity", "1"],
  ["pointer-events", "auto"],
  ["margin", "0"],
  ["padding", "0"],
  ["transform", "none"],
];

// Page CSS must not be able to hide or restyle the host, so every property is !important inline.
function applyHostStyle(el: HTMLElement, top: number, left: number): void {
  for (const [name, value] of HOST_STYLE) el.style.setProperty(name, value, "important");
  el.style.setProperty("top", `${top}px`, "important");
  el.style.setProperty("left", `${left}px`, "important");
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The MediaForge icon, drawn from its pixel runs. Attributes only: page CSP cannot block them. */
function markIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", MARK_VIEWBOX);
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "13");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "flex:none;display:block;";
  for (const [x, y, width, fill] of MARK_RUNS) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(width));
    rect.setAttribute("height", "24");
    rect.setAttribute("fill", fill);
    svg.append(rect);
  }
  return svg;
}

const PILL_BG = BRAND.ink;
const PILL_BG_HOVER = "#262b38";
const PILL_BG_PRESSED = "#0a0b0e";
const PILL_STYLE =
  "box-sizing:border-box;display:inline-flex;align-items:stretch;height:24px;margin:0;padding:0;" +
  `font:600 11px/14px system-ui,sans-serif;border:1px solid ${BRAND.ember};border-radius:6px;` +
  `color:${BRAND.glow};box-shadow:0 1px 6px rgba(0,0,0,.55);user-select:none;touch-action:none;` +
  "outline-offset:1px;";
const INNER_STYLE =
  "all:unset;box-sizing:border-box;display:inline-flex;align-items:center;cursor:inherit;";
const MAIN_STYLE = `${INNER_STYLE}gap:5px;padding:0 6px;font:inherit;color:inherit;`;
const CLOSE_STYLE = `${INNER_STYLE}justify-content:center;width:22px;min-width:22px;font:inherit;color:inherit;opacity:.75;border-left:1px solid rgba(255,194,107,.25);cursor:pointer;`;

// Per video element, until the page reloads: where the user dragged the pill (as an offset from its
// default corner) and whether they closed it. Nothing is stored.
const offsets = new WeakMap<HTMLMediaElement, { dx: number; dy: number }>();
const dismissed = new WeakSet<HTMLMediaElement>();

type Drag = {
  pointerId: number;
  startX: number;
  startY: number;
  origin: { top: number; left: number };
  moved: boolean;
};
let drag: Drag | undefined;
let placed = { top: 0, left: 0 };
let hovered = false;
let pressed = false;
let focused = false;
let dragging = false;

/** One place decides the look from the pointer state, so hover, press and busy never fight. */
function applyLook(): void {
  if (!button) return;
  const down = pressed || dragging;
  button.style.background = down ? PILL_BG_PRESSED : hovered ? PILL_BG_HOVER : PILL_BG;
  button.style.borderColor = hovered || dragging ? BRAND.flame : BRAND.ember;
  button.style.cursor = dragging ? "grabbing" : "grab";
  button.style.opacity = busy ? "0.7" : "1";
  button.style.transform = down ? "translateY(1px)" : "none";
  button.style.outline = focused ? `2px solid ${BRAND.flame}` : "none";
}

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

function pageBounds(): { width: number; height: number } {
  const el = document.documentElement;
  return {
    width: Math.max(el.scrollWidth, el.clientWidth),
    height: Math.max(el.scrollHeight, el.clientHeight),
  };
}

function buttonSize(): { width: number; height: number } {
  return { width: button?.offsetWidth || 90, height: button?.offsetHeight || 24 };
}

function onDragMove(event: PointerEvent): void {
  if (!drag || !button || !target) return;
  // The button was released somewhere we never heard about: this is a hover, not a drag.
  if ((event.buttons & 1) === 0) {
    endPress();
    return;
  }
  if (event.pointerId !== drag.pointerId) return;
  const delta = { dx: event.clientX - drag.startX, dy: event.clientY - drag.startY };
  if (!drag.moved) {
    if (!isDrag(delta)) return;
    drag.moved = true;
    dragging = true;
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // The drag still works through the pill's own events; capture only keeps it from slipping.
    }
    applyLook();
  }
  const size = buttonSize();
  const pos = applyDrag(drag.origin, delta, pageBounds(), size);
  const home = placeButton(
    target.getBoundingClientRect(),
    { x: window.scrollX, y: window.scrollY },
    size,
  );
  offsets.set(target, { dx: pos.left - home.left, dy: pos.top - home.top });
  placed = pos;
  if (host) applyHostStyle(host, pos.top, pos.left);
}

/** A release outside the pill never reaches it, so a pressed pill also listens on the window. */
function watchRelease(on: boolean): void {
  const method = on ? "addEventListener" : "removeEventListener";
  window[method]("pointerup", endPress);
  window[method]("pointercancel", endPress);
}

function endPress(): void {
  watchRelease(false);
  pressed = false;
  dragging = false;
  drag = undefined;
  applyLook();
}

/** Hides the button for this video until the page reloads. */
function dismiss(): void {
  if (target) dismissed.add(target);
  hide();
}

function innerButton(style: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.style.cssText = style;
  return el;
}

function ensureButton(): HTMLElement {
  if (button && host) return button;
  host = document.createElement("div");
  applyHostStyle(host, 0, 0);
  const shadow = host.attachShadow({ mode: "closed" });
  const pill = document.createElement("div");
  button = pill;
  pill.setAttribute("role", "group");
  pill.setAttribute("aria-label", "MediaForge download");
  pill.style.cssText = PILL_STYLE;
  const main = innerButton(MAIN_STYLE);
  label = document.createElement("span");
  label.textContent = "Download";
  main.append(markIcon(), label);
  const close = innerButton(CLOSE_STYLE);
  close.setAttribute("aria-label", "Hide the download button on this video");
  close.title = "Hide";
  const cross = document.createElement("span");
  cross.textContent = "×";
  cross.style.cssText = "font:600 13px/1 system-ui,sans-serif;";
  close.append(cross);
  pill.append(main, close);
  applyLook();

  pill.addEventListener("pointerenter", () => {
    hovered = true;
    applyLook();
  });
  pill.addEventListener("pointerleave", () => {
    hovered = false;
    applyLook();
  });
  pill.addEventListener("focusin", (event) => {
    focused = event.target instanceof Element && isFocusVisible(event.target);
    applyLook();
  });
  pill.addEventListener("focusout", () => {
    focused = false;
    applyLook();
  });

  // Drag from the pill. The close button stops its own pointerdown, so it never starts one.
  let swallowClick = false;
  pill.addEventListener("pointerdown", (event) => {
    swallowClick = false;
    if (!event.isPrimary || event.button !== 0) return;
    pressed = true;
    watchRelease(true);
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...placed },
      moved: false,
    };
    applyLook();
  });
  pill.addEventListener("pointermove", onDragMove);
  pill.addEventListener("pointerup", () => {
    // A drag ends in a click on the pill; the download must not fire for it.
    swallowClick = drag?.moved === true;
    endPress();
    // The click follows at once; after that, a keyboard activation must not be swallowed.
    if (swallowClick) setTimeout(() => (swallowClick = false), 0);
  });
  pill.addEventListener("pointercancel", endPress);
  pill.addEventListener("lostpointercapture", endPress);

  // Keep the page's players from reacting to our clicks.
  for (const el of [pill, close]) {
    for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "click", "dblclick"]) {
      el.addEventListener(type, (event) => event.stopPropagation());
    }
  }
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (!event.isTrusted) return;
    dismiss();
  });
  main.addEventListener("click", async (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (!event.isTrusted || busy) return;
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    busy = true;
    applyLook();
    setLabel("Opening…");
    const result = await send<{ status?: string; reason?: string; popup?: boolean }>(
      { kind: "overlayDownload" },
      { status: "error" },
    );
    setLabel(labelFor(result.status, result.reason, result.popup === true));
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      busy = false;
      setLabel("Download");
      applyLook();
    }, 2000);
  });
  shadow.append(pill);
  document.documentElement.append(host);
  return pill;
}

function setLabel(text: string): void {
  if (label) label.textContent = text;
}

function hide(): void {
  clearInterval(trackTimer);
  trackTimer = undefined;
  host?.remove();
  host = undefined;
  button = undefined;
  label = undefined;
  target = undefined;
  hovered = false;
  focused = false;
  endPress();
}

function show(media: HTMLMediaElement): void {
  if (dismissed.has(media)) {
    if (target === media) hide();
    return;
  }
  const rect = media.getBoundingClientRect();
  const hidden = getComputedStyle(media).visibility === "hidden" || media.offsetParent === null;
  if (!isWorthOverlay(rect, hidden)) {
    if (target === media) hide();
    return;
  }
  const b = ensureButton();
  if (target !== media) shownUrl = location.href;
  target = media;
  if (drag?.moved === true) return; // the pointer is placing it
  const size = { width: b.offsetWidth || 90, height: b.offsetHeight || 24 };
  const home = placeButton(
    rect,
    { x: window.scrollX, y: window.scrollY },
    size,
    offsets.get(media),
  );
  // A resize can leave a dragged pill outside the page; pull it back in.
  const pos = applyDrag(home, { dx: 0, dy: 0 }, pageBounds(), size);
  placed = pos;
  if (host) applyHostStyle(host, pos.top, pos.left);
  trackTimer ??= setInterval(track, TRACK_MS);
}

/** Drops the button once its video is gone, otherwise keeps it on the video's corner. */
function track(): void {
  if (
    !target ||
    isTargetGone({ connected: target.isConnected, shownUrl, currentUrl: location.href })
  ) {
    hide();
    return;
  }
  show(target);
}

function mediaAt(event: Event): HTMLMediaElement | undefined {
  const sources: Element[][] = [];
  const node = event.target;
  if (node instanceof Element) {
    const closest = node.closest("video, audio");
    if (closest instanceof HTMLMediaElement) return closest;
  }
  sources.push(event.composedPath().filter((n): n is Element => n instanceof Element));
  if (event instanceof MouseEvent) {
    sources.push(document.elementsFromPoint(event.clientX, event.clientY));
  }
  for (const list of sources) {
    const index = findMediaIndex(list);
    const found = index === undefined ? undefined : list[index];
    if (found instanceof HTMLMediaElement) return found;
  }
  return undefined;
}

function onPointer(event: Event): void {
  if (!enabled || disposed) return;
  const media = mediaAt(event);
  if (media) show(media);
}

function onScroll(): void {
  if (target) show(target);
}

function listen(): void {
  if (listening) return;
  listening = true;
  document.addEventListener("mouseover", onPointer, { passive: true, capture: true });
  window.addEventListener("scroll", onScroll, { passive: true });
}

function unlisten(): void {
  if (!listening) return;
  listening = false;
  document.removeEventListener("mouseover", onPointer, { capture: true });
  window.removeEventListener("scroll", onScroll);
}

async function refresh(): Promise<void> {
  if (disposed) return;
  const config = await send<{ enabled?: boolean }>({ kind: "overlayConfig" }, { enabled: false });
  if (disposed) return;
  enabled = config.enabled === true;
  if (enabled) {
    listen();
  } else {
    unlisten();
    hide();
  }
}

function onMessage(message: unknown): void {
  if ((message as { kind?: string } | undefined)?.kind === "overlayChanged") void refresh();
}

function onVisibility(): void {
  void refresh();
}

function suspend(): void {
  enabled = false;
  unlisten();
  hide();
}

function onPageHide(event: PageTransitionEvent): void {
  suspend();
  if (event.persisted) return; // bfcache: come back on pageshow
  disposed = true;
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("pagehide", onPageHide);
  window.removeEventListener("pageshow", onPageShow);
}

function onPageShow(event: PageTransitionEvent): void {
  if (!event.persisted) return;
  disposed = false;
  void refresh();
}

// Registered once; every later change of tab visibility only refreshes.
if (!messageListening) {
  messageListening = true;
  api.runtime.onMessage.addListener(onMessage);
}
document.addEventListener("visibilitychange", onVisibility);
window.addEventListener("pagehide", onPageHide);
window.addEventListener("pageshow", onPageShow);
void refresh();
