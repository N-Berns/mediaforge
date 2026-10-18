import {
  BRAND,
  findMediaIndex,
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
let button: HTMLButtonElement | undefined;
let label: HTMLSpanElement | undefined;
let target: HTMLMediaElement | undefined;
let enabled = false;
let listening = false;
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
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "17");
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

const BUTTON_STYLE = `display:inline-flex;align-items:center;gap:7px;font:600 12px system-ui,sans-serif;padding:5px 11px 5px 8px;border:1px solid ${BRAND.ember};border-radius:8px;background:${BRAND.ink};color:${BRAND.glow};cursor:pointer;box-shadow:0 1px 6px rgba(0,0,0,.55);`;

function ensureButton(): HTMLButtonElement {
  if (button && host) return button;
  host = document.createElement("div");
  applyHostStyle(host, 0, 0);
  const root = host.attachShadow({ mode: "closed" });
  const created = document.createElement("button");
  button = created;
  label = document.createElement("span");
  label.textContent = "Download";
  created.append(markIcon(), label);
  created.style.cssText = BUTTON_STYLE;
  created.addEventListener("mouseenter", () => {
    created.style.borderColor = BRAND.flame;
  });
  created.addEventListener("mouseleave", () => {
    created.style.borderColor = BRAND.ember;
  });
  // Keep the page's players from reacting to our clicks.
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"]) {
    created.addEventListener(type, (event) => event.stopPropagation());
  }
  created.addEventListener("click", async (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (!event.isTrusted || busy) return;
    busy = true;
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
    }, 2000);
  });
  root.append(created);
  document.documentElement.append(host);
  return created;
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
}

function show(media: HTMLMediaElement): void {
  const rect = media.getBoundingClientRect();
  const hidden = getComputedStyle(media).visibility === "hidden" || media.offsetParent === null;
  if (!isWorthOverlay(rect, hidden)) {
    if (target === media) hide();
    return;
  }
  const b = ensureButton();
  if (target !== media) shownUrl = location.href;
  target = media;
  const pos = placeButton(
    rect,
    { x: window.scrollX, y: window.scrollY },
    { width: b.offsetWidth || 90, height: b.offsetHeight || 28 },
  );
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

function onVisibility(): void {
  if (document.visibilityState === "visible")
    api.runtime.onMessage.addListener((message: unknown) => {
      if ((message as { kind?: string } | undefined)?.kind === "overlayChanged") void refresh();
    });
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

document.addEventListener("visibilitychange", onVisibility);
window.addEventListener("pagehide", onPageHide);
window.addEventListener("pageshow", onPageShow);
void refresh();
