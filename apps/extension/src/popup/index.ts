import type { ProbedMedia } from "@mediaforge/shared-protocol";
import type { DownloadResult, PopupState } from "../background/controller.ts";
import {
  browserFromUserAgent,
  DEVELOPER,
  NOTICES,
  osFromUserAgent,
  REPO_URL,
  REPORT_TYPES,
  REVIEW_URL,
  type ReportType,
  sendReport,
} from "./about.ts";
import { buildDiagnostics, type DiagnosticsDecision } from "./diagnostics.ts";
import {
  buildPopupModel,
  type ItemModel,
  type PageSource,
  type PopupModel,
  pendingPicker,
  unreachableModel,
} from "./model.ts";

const root = globalThis as unknown as { browser?: typeof browser; chrome: typeof browser };
const api: typeof browser = root.browser ?? root.chrome;

const app = document.getElementById("app") as HTMLElement;
const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url);
const ALL_SITES = { origins: ["<all_urls>"] };

let tabId = -1;
let tabUrl = "";
let picker: { media: ProbedMedia; source: PageSource } | undefined;
let notice: string | undefined;
/** The subtitle format last chosen in the picker. */
let subtitleFormat: "srt" | "vtt" = "srt";
/** Undefined until checked; only `false` shows the access banner. */
let hostAccess: boolean | undefined;
/** The latest state from the background, for the About section. */
let lastState: PopupState | undefined;
/** What is ticked in the picker: `f:<format id>` and `s:<manual|auto>:<language>`. */
let selection = new Set<string>();
/** The page the ticks belong to, so a picker opened afresh starts from its default. */
let selectionFor = "";

/** Whether the browser granted access to all sites; Firefox lets the user withhold it. */
async function checkHostAccess(): Promise<boolean | undefined> {
  try {
    return await api.permissions.contains(ALL_SITES);
  } catch {
    return undefined;
  }
}

const send = <T>(command: unknown): Promise<T> => api.runtime.sendMessage(command) as Promise<T>;

// Every string shown here is untrusted (pages, core): text nodes only, never HTML.
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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Runs a click handler with the button disabled; failures become an error notice. */
function guarded(button: HTMLButtonElement, action: () => Promise<void>): void {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    button.disabled = true;
    action()
      .catch(async (error: unknown) => {
        notice = messageOf(error);
        await refresh();
      })
      .catch(() => {})
      .finally(() => {
        button.disabled = false;
      });
  });
}

function button(text: string, label: string): HTMLButtonElement {
  return el("button", { text, attrs: { "aria-label": label } });
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_PATHS = {
  copy: ["M9 9h10v10H9z", "M5 15V5h10"],
  refresh: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"],
  video: ["M3 6h12v12H3z", "M15 10l6-3v10l-6-3"],
  subtitles: ["M3 5h18v14H3z", "M7 11h4", "M13 11h4", "M7 15h6"],
  audio: [
    "M9 18V5l11-2v13",
    "M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
    "M20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  ],
  trash: ["M4 7h16", "M10 11v6M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
  system: ["M3 4h18v12H3z", "M8 20h8", "M12 16v4"],
  sun: [
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
    "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4",
    "M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  ],
  moon: ["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"],
  download: ["M12 3v12", "M7 10l5 5 5-5", "M5 21h14"],
  file: ["M6 3h9l5 5v13H6z", "M14 3v6h6", "M9 13h6", "M9 17h6"],
  folder: ["M3 6h6l2 2h10v11H3z"],
  globe: [
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
    "M3 12h18",
    "M12 3c3 3.5 3 14.5 0 18",
    "M12 3c-3 3.5-3 14.5 0 18",
  ],
} as const;

/** A 16px stroke icon that follows the text colour. Built from constants, never from page data. */
function icon(name: keyof typeof ICON_PATHS): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** A button with an icon and a text label; `setLabel` swaps the text and keeps the icon. */
function iconButton(name: keyof typeof ICON_PATHS, text: string, label: string): HTMLButtonElement {
  const btn = el("button", { attrs: { "aria-label": label } });
  btn.append(icon(name), el("span", { text }));
  return btn;
}

const setLabel = (btn: HTMLButtonElement, text: string): void => {
  const span = btn.querySelector("span");
  if (span) span.textContent = text;
};

interface Pick<T extends string> {
  value: T;
  label: string;
  /** Left out for a tab that is text only. */
  glyph?: keyof typeof ICON_PATHS;
}

/** A row of mutually exclusive tabs with icons, in place of a dropdown. */
function segmented<T extends string>(
  name: string,
  picks: ReadonlyArray<Pick<T>>,
  current: T,
  onPick: (value: T) => void,
): HTMLElement {
  const group = el("div", {
    className: "segmented",
    attrs: { role: "radiogroup", "aria-label": name },
  });
  const tabs: Array<{ value: T; node: HTMLButtonElement }> = [];
  for (const { value, label, glyph } of picks) {
    const aria = `${label} ${name.toLowerCase()}`;
    const node = glyph ? iconButton(glyph, label, aria) : button(label, aria);
    node.setAttribute("role", "radio");
    node.setAttribute("aria-checked", String(value === current));
    node.addEventListener("click", () => {
      for (const tab of tabs) tab.node.setAttribute("aria-checked", String(tab.value === value));
      onPick(value);
    });
    tabs.push({ value, node });
    group.append(node);
  }
  return group;
}

function row(title: string, sub: string, button: HTMLButtonElement): HTMLElement {
  return el(
    "div",
    { className: "row" },
    el("div", {}, el("div", { text: title }), el("div", { className: "sub", text: sub })),
    button,
  );
}

/** Sections the user collapsed; every render rebuilds the DOM, so the choice is kept here. */
const collapsed = new Set<string>();

/** A section that folds away under its header, like Diagnostics. */
function collapsible(
  id: string,
  title: string,
  body: Node[],
  actions: HTMLButtonElement[] = [],
  glyph?: keyof typeof ICON_PATHS,
  count?: HTMLElement,
): HTMLElement {
  const head = el(
    "summary",
    { className: "section-head" },
    el("h2", {}, ...(glyph ? [icon(glyph)] : []), el("span", { text: title })),
    ...(count ? [count] : []),
    ...(actions.length > 0 ? [el("span", { className: "section-actions" }, ...actions)] : []),
    el("span", { className: "chevron", attrs: { "aria-hidden": "true" } }),
  );
  // A click on an action must not fold the section.
  for (const action of actions) {
    action.addEventListener("click", (event) => event.preventDefault());
  }
  const details = el(
    "details",
    { className: "collapsible" },
    head,
    el("div", { className: "collapsible-body" }, ...body),
  );
  details.open = !collapsed.has(id);
  details.addEventListener("toggle", () => {
    if (details.open) collapsed.delete(id);
    else collapsed.add(id);
  });
  return details;
}

const SUBTITLE_FORMATS: ReadonlyArray<Pick<"srt" | "vtt">> = [
  { value: "srt", label: "SRT", glyph: "file" },
  { value: "vtt", label: "VTT", glyph: "globe" },
];

/**
 * The picker: every format, audio track and subtitle as a tickable row, and one bar to download
 * what is ticked. The best video starts ticked, so a single press still downloads the best.
 */
function pickerView(model: NonNullable<PopupModel["picker"]>, source: PageSource): HTMLElement {
  if (selectionFor !== source.url) {
    selectionFor = source.url;
    const best = model.formats.find((f) => f.kind === "video") ?? model.formats[0];
    selection = new Set(best ? [`f:${best.id}`] : []);
  }
  const go = iconButton("download", "", "Download selected");
  go.className = "primary";
  // Per type: the ids it holds and the label on its header that says how many are ticked.
  const groupCounts: Array<{ ids: string[]; node: HTMLElement }> = [];
  const sync = (): void => {
    setLabel(go, `Download selected (${selection.size})`);
    go.disabled = selection.size === 0;
    for (const { ids, node } of groupCounts) {
      const n = ids.filter((id) => selection.has(id)).length;
      node.textContent = n > 0 ? `${n} selected` : "";
    }
  };
  const counter = (ids: string[]): HTMLElement => {
    const node = el("span", { className: "count", attrs: { role: "status" } });
    groupCounts.push({ ids, node });
    return node;
  };
  const choice = (id: string, title: string, detail: string): HTMLElement => {
    const box = el("input", { attrs: { type: "checkbox", "aria-label": title } });
    box.checked = selection.has(id);
    box.addEventListener("change", () => {
      if (box.checked) selection.add(id);
      else selection.delete(id);
      sync();
    });
    const text = el("div", {}, el("div", { text: title }));
    if (detail) text.append(el("div", { className: "sub", text: detail }));
    return el("label", { className: "choice" }, box, text);
  };

  const list: Node[] = [el("h2", { text: model.title, className: "picker-title" })];
  const groups = [
    { kind: "video", title: "Video" },
    { kind: "audio", title: "Audio only" },
  ] as const;
  for (const group of groups) {
    const formats = model.formats.filter((f) => f.kind === group.kind);
    if (formats.length === 0) continue;
    const rows = formats.map((f) => choice(`f:${f.id}`, f.label, f.detail));
    const ids = formats.map((f) => `f:${f.id}`);
    list.push(collapsible(`pick-${group.kind}`, group.title, rows, [], group.kind, counter(ids)));
  }
  const subtitleRows: Node[] = [];
  if (!model.subtitlesSupported || model.subtitles.length === 0) {
    subtitleRows.push(
      el("div", {
        className: "sub",
        text: model.subtitlesSupported
          ? "No subtitles found for this video."
          : "Update MediaForge to download subtitles.",
      }),
    );
  } else {
    subtitleRows.push(
      el(
        "div",
        { className: "field" },
        el("span", { text: "Format" }),
        segmented("Subtitle format", SUBTITLE_FORMATS, subtitleFormat, (value) => {
          subtitleFormat = value;
        }),
      ),
    );
    for (const t of model.subtitles) subtitleRows.push(choice(`s:${t.key}`, t.label, t.detail));
  }
  const subtitleIds = model.subtitles.map((t) => `s:${t.key}`);
  list.push(
    collapsible(
      "pick-subtitles",
      "Subtitles",
      subtitleRows,
      undefined,
      "subtitles",
      counter(subtitleIds),
    ),
  );

  guarded(go, () => downloadSelected(source, model));
  const cancel = button("Cancel", "Cancel");
  cancel.addEventListener("click", () => {
    picker = undefined;
    selectionFor = "";
    void refresh();
  });
  sync();
  return el(
    "div",
    { className: "picker" },
    el("div", { className: "picker-list" }, ...list),
    el("div", { className: "pickbar" }, go, cancel),
  );
}

const status = (job: PopupModel["jobs"][number]): string => job.percentText || job.status;

/** Full text of the failure being read; lives outside the render so a refresh keeps it open. */
let errorDetail: { title: string; message: string } | undefined;

/** The word "Error" in the percentage column; a click opens the whole message. */
function errorLink(title: string, message: string): HTMLButtonElement {
  const link = el("button", {
    text: "Error",
    className: "error-link",
    attrs: { "aria-label": `Show the error for ${title}`, "aria-haspopup": "dialog" },
  });
  link.addEventListener("click", () => {
    errorDetail = { title, message };
    showErrorDialog();
  });
  return link;
}

function closeErrorDialog(): void {
  errorDetail = undefined;
  document.getElementById("error-dialog")?.remove();
}

function showErrorDialog(): void {
  document.getElementById("error-dialog")?.remove();
  if (!errorDetail) return;
  const { title, message } = errorDetail;
  const copy = iconButton("copy", "Copy", "Copy the error");
  copy.addEventListener("click", () => {
    void Promise.resolve(navigator.clipboard.writeText(message))
      .then(() => setLabel(copy, "Copied"))
      .catch(() => {});
  });
  const close = button("Close", "Close the error");
  close.addEventListener("click", closeErrorDialog);
  const dialog = el(
    "div",
    { className: "modal", attrs: { id: "error-dialog", role: "dialog", "aria-modal": "true" } },
    el(
      "div",
      { className: "modal-card" },
      el("h2", { text: "Download failed" }),
      el("div", { className: "sub", text: title }),
      el("pre", { className: "diagnostics-text", text: message }),
      el("div", { className: "diagnostics-actions" }, copy, close),
    ),
  );
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeErrorDialog();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeErrorDialog();
  });
  document.body.append(dialog);
  close.focus();
}

/** What the popup last drew, so a state push that changes nothing leaves the DOM alone. */
let lastRenderKey = "";

function render(model: PopupModel): void {
  const key = JSON.stringify([model, picker?.source ?? null]);
  if (key === lastRenderKey) return;
  const nodes: Node[] = [];
  if (model.access) {
    const allow = button(model.access.button, model.access.button);
    // The request must run inside the click, so it is the first thing the handler does.
    allow.addEventListener("click", () => {
      allow.disabled = true;
      Promise.resolve(api.permissions.request(ALL_SITES))
        .then(async () => {
          hostAccess = await checkHostAccess();
        })
        .catch((error: unknown) => {
          notice = messageOf(error);
        })
        .finally(() => {
          allow.disabled = false;
          void refresh();
        });
    });
    nodes.push(
      el(
        "div",
        { className: "banner", attrs: { "data-tone": "warn", role: "status" } },
        el("span", { text: model.access.text }),
        document.createTextNode(" "),
        allow,
      ),
    );
  }
  if (model.banner) {
    const banner = el("div", {
      className: "banner",
      text: model.banner.text,
      attrs: {
        "data-tone": model.banner.tone,
        role: model.banner.tone === "error" ? "alert" : "status",
      },
    });
    if (model.banner.link) {
      banner.append(
        " ",
        el("a", {
          text: model.banner.link.label,
          attrs: { href: model.banner.link.href, target: "_blank", rel: "noreferrer noopener" },
        }),
      );
    }
    nodes.push(banner);
  }

  const picking = Boolean(model.picker && picker);
  app.classList.toggle("picking", picking);
  if (!picking) selectionFor = "";
  if (model.picker && picker) {
    nodes.push(pickerView(model.picker, picker.source));
  } else {
    const body: Node[] = [];
    if (model.placeholder) {
      body.push(el("div", { className: "row" }, el("div", { text: model.placeholder })));
    }
    for (const item of model.items) {
      const start = iconButton("download", "Download", `Download ${item.title}`);
      start.className = "primary";
      const source = item.action;
      guarded(start, () => download(source));
      body.push(row(item.title, item.detail, start));
    }
    if (body.length > 0) nodes.push(collapsible("page", "On this page", body));
  }

  if (model.jobs.length > 0 || model.openFolder) {
    const actions: HTMLButtonElement[] = [];
    if (model.openFolder) {
      const view = iconButton("folder", "View folder", "Open the download folder");
      guarded(view, () => openFolder());
      actions.push(view);
    }
    if (model.jobs.length > 0) {
      const clear = iconButton("trash", "Clear", "Clear finished downloads");
      clear.disabled = !model.jobs.some((j) => !j.active);
      guarded(clear, async () => {
        await send({ kind: "clearFinished" });
        await refresh();
      });
      actions.push(clear);
    }
    const body: Node[] = [];
    if (model.jobs.length === 0) {
      body.push(
        el("div", { className: "row" }, el("div", { className: "sub", text: "No downloads yet." })),
      );
    }
    for (const job of model.jobs) {
      const failed = job.error !== undefined;
      const item = el(
        "div",
        {},
        el(
          "div",
          { className: "row" },
          el(
            "div",
            {},
            el("div", { text: job.title }),
            ...(job.label ? [el("span", { className: "tag", text: job.label })] : []),
          ),
          failed ? errorLink(job.title, job.error ?? "") : jobEnd(job),
        ),
      );
      if (job.active) {
        const pct = Number.parseInt(job.percentText, 10);
        const attrs: Record<string, string> = {
          max: "100",
          "aria-label": `${job.title} progress`,
        };
        if (Number.isFinite(pct)) attrs.value = String(pct);
        const cancel = button("Cancel", `Cancel ${job.title}`);
        guarded(cancel, async () => {
          await send({ kind: "cancel", jobId: job.id });
        });
        item.append(el("progress", { attrs }), cancel);
      }
      body.push(item);
    }
    nodes.push(collapsible("downloads", "Downloads", body, actions));
  }

  // The theme is the popup's own, so it stays available when MediaForge is not connected.
  const settings: Node[] = [themeField(), fontSizeField()];
  if (model.toggles) {
    settings.push(
      toggle("Show a Download button on videos", model.toggles.overlay, (v) =>
        setting("extensionUi", v ? "overlay" : "popup"),
      ),
      toggle("Keep MediaForge running", model.toggles.keepRunning, (v) =>
        setting("keepRunning", v),
      ),
    );
  }
  nodes.push(collapsible("settings", "Settings", settings));
  nodes.push(diagnosticsSection());
  nodes.push(aboutSection());
  // The popup has a fixed size and scrolls inside, so a rebuild must not jump back to the top.
  const scrolled = app.scrollTop;
  const listScrolled = app.querySelector(".picker-list")?.scrollTop ?? 0;
  app.replaceChildren(...nodes);
  app.scrollTop = scrolled;
  const list = app.querySelector(".picker-list");
  if (list) list.scrollTop = listScrolled;
  lastRenderKey = key;
}

type Theme = "system" | "light" | "dark";
const THEMES: ReadonlyArray<{ value: Theme; label: string; glyph: keyof typeof ICON_PATHS }> = [
  { value: "system", label: "System", glyph: "system" },
  { value: "light", label: "Light", glyph: "sun" },
  { value: "dark", label: "Dark", glyph: "moon" },
];
let theme: Theme = "system";

/** The three presets, in pixels. Anything else is a custom size. */
const FONT_PRESETS: ReadonlyArray<Pick<string> & { px: number }> = [
  { value: "small", label: "S", px: 12 },
  { value: "medium", label: "M", px: 13 },
  { value: "large", label: "L", px: 15 },
];
const FONT_MIN = 10;
const FONT_MAX = 20;
let fontPx = 12;

function applyFontSize(): void {
  document.documentElement.style.setProperty("--fs", `${fontPx}px`);
}

/** "System" leaves the choice to the browser; the others pin the popup's colour scheme. */
function applyTheme(): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

async function loadTheme(): Promise<void> {
  try {
    const saved = (await api.storage.local.get("theme")).theme;
    if (saved === "light" || saved === "dark" || saved === "system") theme = saved;
    const size = (await api.storage.local.get("fontSize")).fontSize;
    if (typeof size === "number" && size >= FONT_MIN && size <= FONT_MAX) fontPx = Math.round(size);
  } catch {
    // Storage can be unavailable (private windows); the popup follows the system.
  }
  applyTheme();
  applyFontSize();
}

/** Text size: S, M or L, or any size in between with the slider. Applies at once, remembered. */
function fontSizeField(): HTMLElement {
  const save = (): void => {
    void Promise.resolve(api.storage.local.set({ fontSize: fontPx })).catch(() => {});
  };
  const slider = el("input", {
    attrs: {
      type: "range",
      min: String(FONT_MIN),
      max: String(FONT_MAX),
      step: "1",
      "aria-label": "Custom font size",
    },
  });
  slider.value = String(fontPx);
  const readout = el("span", { className: "sub", text: `${fontPx} px` });
  const current = FONT_PRESETS.find((p) => p.px === fontPx)?.value ?? "";
  const tabs = segmented("Font size", FONT_PRESETS, current, (value) => {
    fontPx = FONT_PRESETS.find((p) => p.value === value)?.px ?? fontPx;
    slider.value = String(fontPx);
    readout.textContent = `${fontPx} px`;
    applyFontSize();
    save();
  });
  slider.addEventListener("input", () => {
    fontPx = Number(slider.value);
    readout.textContent = `${fontPx} px`;
    applyFontSize();
    // A size that matches a preset lights it up; any other leaves the presets unticked.
    const buttons = Array.from(tabs.querySelectorAll("button"));
    FONT_PRESETS.forEach((p, i) => {
      buttons[i]?.setAttribute("aria-checked", String(p.px === fontPx));
    });
  });
  slider.addEventListener("change", save);
  return el(
    "div",
    { className: "font-size" },
    el("div", { className: "field" }, el("span", { text: "Font size" }), tabs),
    el("div", { className: "field" }, slider, readout),
  );
}

/** A three-way switch: System, Light, Dark. Applies at once and is remembered. */
function themeField(): HTMLElement {
  const group = segmented("Theme", THEMES, theme, (value) => {
    theme = value;
    applyTheme();
    void Promise.resolve(api.storage.local.set({ theme: value })).catch(() => {});
  });
  return el("div", { className: "field" }, el("span", { text: "Theme" }), group);
}

// The section is one persistent element, re-attached after each render, so refreshes
// neither close it nor lose its text.
let diagnosticsNode: HTMLDetailsElement | undefined;
let diagnosticsText = "";
let diagnosticsNote = "";
let diagnosticsLoaded = false;
let diagnosticsBusy = false;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
let outputEl: HTMLPreElement;
let noteEl: HTMLElement;
let copyBtn: HTMLButtonElement;

function diagnosticsSection(): HTMLDetailsElement {
  if (diagnosticsNode) return diagnosticsNode;
  outputEl = el("pre", { className: "diagnostics-text" });
  noteEl = el("div", { className: "sub", attrs: { role: "status" } });
  copyBtn = iconButton("copy", "Copy", "Copy diagnostics");
  const refreshBtn = iconButton("refresh", "Refresh", "Refresh diagnostics");
  copyBtn.addEventListener("click", () => {
    void copyDiagnostics();
  });
  refreshBtn.addEventListener("click", () => {
    void collectDiagnostics();
  });
  const details = el(
    "details",
    { className: "diagnostics" },
    el(
      "summary",
      { className: "section-head" },
      el("h2", { text: "Diagnostics" }),
      el("span", { className: "chevron", attrs: { "aria-hidden": "true" } }),
    ),
    el("div", { className: "diagnostics-actions" }, copyBtn, refreshBtn),
    noteEl,
    outputEl,
  );
  details.addEventListener("toggle", () => {
    if (details.open && !diagnosticsLoaded) void collectDiagnostics();
  });
  diagnosticsNode = details;
  return details;
}

function paintDiagnostics(): void {
  outputEl.textContent = diagnosticsText;
  noteEl.textContent = diagnosticsNote;
}

async function collectDiagnostics(): Promise<void> {
  if (diagnosticsBusy) return;
  diagnosticsBusy = true;
  diagnosticsLoaded = true;
  try {
    let decisions: DiagnosticsDecision[] | undefined;
    let decisionsError: string | undefined;
    try {
      const reply = await send<unknown>({ kind: "debug", tabId });
      if (!Array.isArray(reply)) throw new Error("unexpected reply");
      decisions = reply as DiagnosticsDecision[];
    } catch (error) {
      decisionsError = messageOf(error);
    }
    let state: PopupState | undefined;
    try {
      const reply = await send<PopupState | undefined>({
        kind: "getState",
        tabId,
        ...(isWebUrl(tabUrl) && { pageUrl: tabUrl }),
      });
      if (reply && typeof reply === "object" && "connection" in reply) state = reply;
    } catch {
      // Rendered as "state unavailable".
    }
    let version = "unknown";
    try {
      version = api.runtime.getManifest().version;
    } catch {
      // Keep "unknown".
    }
    diagnosticsText = buildDiagnostics({
      version,
      userAgent: globalThis.navigator?.userAgent ?? "unknown",
      tab: { id: tabId, url: tabUrl },
      state,
      hostAccess,
      decisions,
      decisionsError,
    });
    diagnosticsNote = "";
  } finally {
    diagnosticsBusy = false;
    paintDiagnostics();
  }
}

async function copyDiagnostics(): Promise<void> {
  try {
    await navigator.clipboard.writeText(diagnosticsText);
    diagnosticsNote = "";
    setLabel(copyBtn, "Copied");
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      setLabel(copyBtn, "Copy");
    }, 2000);
  } catch {
    diagnosticsNote = "Select the text and copy it manually";
  }
  paintDiagnostics();
}

// One persistent element like Diagnostics, so a refresh never loses what the user is typing.
let aboutNode: HTMLDetailsElement | undefined;
let aboutInfo: HTMLElement;

const extensionVersion = (): string => {
  try {
    return api.runtime.getManifest().version;
  } catch {
    return "unknown";
  }
};

function link(text: string, href: string): HTMLAnchorElement {
  return el("a", {
    text,
    attrs: { href, target: "_blank", rel: "noreferrer noopener" },
  });
}

/** Label and value rows; the app's own version and tools appear once it is connected. */
function paintAbout(): void {
  if (!aboutInfo) return;
  const host = lastState?.host;
  const rows: Array<[string, string]> = [
    ["Extension", extensionVersion()],
    ["MediaForge app", host?.hostVersion ?? "not connected"],
  ];
  if (host) {
    rows.push(
      ["yt-dlp", host.ytDlp.available ? (host.ytDlp.version ?? "ok") : "missing"],
      ["ffmpeg", host.ffmpeg.available ? (host.ffmpeg.version ?? "ok") : "missing"],
    );
  }
  rows.push(["Developer", DEVELOPER]);
  const labelled = (name: string, value: Node): HTMLElement =>
    el("div", { className: "field" }, el("span", { text: name }), value);
  const nodes: Node[] = rows.map(([name, value]) =>
    labelled(name, el("span", { className: "sub", text: value })),
  );
  nodes.push(labelled("Source code", link("GitHub", REPO_URL)));
  if (REVIEW_URL) nodes.push(labelled("Review", link("Rate MediaForge", REVIEW_URL)));
  nodes.push(
    el("h2", { text: "Built with", className: "about-heading" }),
    ...NOTICES.map((n) =>
      el(
        "div",
        { className: "field credit" },
        link(n.name, n.url),
        el("span", { className: "sub", text: n.license }),
      ),
    ),
  );
  aboutInfo.replaceChildren(...nodes);
}

function aboutSection(): HTMLDetailsElement {
  if (aboutNode) return aboutNode;
  aboutInfo = el("div", { className: "about-info" });
  const text = el("textarea", {
    attrs: {
      rows: "4",
      maxlength: "2000",
      "aria-label": "What went wrong?",
      placeholder: "What went wrong?",
    },
  });
  let reportType: ReportType = "Extension";
  const typeField = el(
    "div",
    { className: "field" },
    el("span", { text: "Problem is with" }),
    segmented(
      "Problem is with",
      REPORT_TYPES.map((value) => ({ value, label: value })),
      reportType,
      (value) => {
        reportType = value;
      },
    ),
  );
  const status = el("div", { className: "report-status", attrs: { role: "status" } });
  const showStatus = (tone: "pending" | "ok" | "error", message: string): void => {
    status.dataset.tone = tone;
    status.textContent = message;
  };
  const send = iconButton("download", "Send report", "Send the report");
  send.addEventListener("click", () => {
    if (send.disabled) return;
    send.disabled = true;
    showStatus("pending", "Sending…");
    void (async () => {
      if (!diagnosticsLoaded) await collectDiagnostics();
      const ua = globalThis.navigator?.userAgent ?? "";
      const result = await sendReport({
        description: text.value,
        type: reportType,
        extensionVersion: extensionVersion(),
        appVersion: lastState?.host?.hostVersion ?? "not connected",
        os: osFromUserAgent(ua),
        browser: browserFromUserAgent(ua),
        details: diagnosticsText,
      });
      if (result.ok) {
        text.value = "";
        showStatus("ok", "Thank you. The report was sent.");
      } else {
        showStatus("error", result.message);
      }
    })()
      .catch(() => {
        showStatus("error", "Could not send the report.");
      })
      .finally(() => {
        send.disabled = false;
      });
  });
  const form = el(
    "div",
    { className: "report" },
    el("h2", { text: "Report a problem" }),
    typeField,
    text,
    el("div", {
      className: "sub",
      text: "Technical details (versions, tool status, page address without its query) are sent with the report.",
    }),
    send,
    status,
  );
  const details = el(
    "details",
    { className: "diagnostics" },
    el(
      "summary",
      { className: "section-head" },
      el("h2", { text: "About" }),
      el("span", { className: "chevron", attrs: { "aria-hidden": "true" } }),
    ),
    aboutInfo,
    form,
  );
  aboutNode = details;
  paintAbout();
  return details;
}

function toggle(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => Promise<void>,
): HTMLElement {
  const input = el("input", { attrs: { type: "checkbox" } });
  input.checked = checked;
  input.addEventListener("change", () => {
    input.disabled = true;
    onChange(input.checked)
      .catch(async (error: unknown) => {
        notice = messageOf(error);
        await refresh();
      })
      .catch(() => {})
      .finally(() => {
        input.disabled = false;
      });
  });
  return el("label", { className: "toggle" }, input, el("span", { text: label }));
}

async function setting(key: string, value: string | boolean): Promise<void> {
  const reply = await send<{ ok?: boolean; message?: string } | undefined>({
    kind: "setSetting",
    key,
    value,
  });
  notice =
    reply && reply.ok === false ? (reply.message ?? "Could not change the setting.") : undefined;
  await refresh();
}

/**
 * Download for a page starts at the picker whenever there is something to choose: another format
 * or a subtitle track. The background answers `needs-picker` for those; a page with one format
 * and no subtitles downloads straight away.
 */
async function download(source: ItemModel["action"]): Promise<void> {
  const result = await send<DownloadResult>({ kind: "download", tabId, source });
  notice = undefined;
  picker = undefined;
  if (result.status === "needs-picker") {
    if (source.type === "page") picker = { media: result.media, source };
    else notice = "Could not list quality options for this item.";
  } else if (result.status === "error") {
    notice = result.message;
  }
  await refresh();
}

/** Shows a finished job's file in the file manager, or the download folder without a job. */
async function openFolder(jobId?: string): Promise<void> {
  const result = await send<{ ok: boolean; message?: string }>({
    kind: "openFolder",
    ...(jobId !== undefined && { jobId }),
  });
  if (result.ok) return;
  notice = result.message ?? "Could not open the folder.";
  await refresh();
}

/** A job's status, and for a finished file, a button that shows it in its folder. */
function jobEnd(job: PopupModel["jobs"][number]): HTMLElement {
  const text = el("div", { text: status(job) });
  if (!job.openable) return text;
  const show = iconButton("folder", "", `Show ${job.title} in its folder`);
  show.className = "icon-only";
  guarded(show, () => openFolder(job.id));
  return el("div", { className: "job-end" }, text, show);
}

/** Starts one download per ticked row, in the order they are listed. */
async function downloadSelected(
  source: PageSource,
  media: NonNullable<PopupModel["picker"]>,
): Promise<void> {
  const jobs: Array<{
    variantId?: string;
    subtitle?: { lang: string; auto: boolean; format: "srt" | "vtt" };
  }> = [];
  for (const f of media.formats) {
    if (selection.has(`f:${f.id}`)) jobs.push({ variantId: f.id });
  }
  for (const t of media.subtitles) {
    if (selection.has(`s:${t.key}`)) {
      jobs.push({ subtitle: { lang: t.lang, auto: t.auto, format: subtitleFormat } });
    }
  }
  let failure: string | undefined;
  for (const job of jobs) {
    const result = await send<DownloadResult>({ kind: "download", tabId, source, ...job });
    if (result.status === "error") failure ??= result.message;
    else if (result.status !== "started") failure ??= "Could not start every download.";
  }
  notice = failure;
  picker = undefined;
  selectionFor = "";
  await refresh();
}

/** Counts reads, so an older answer arriving late never draws over a newer one. */
let refreshSeq = 0;

/** Re-reads state and renders; renders the unreachable banner and returns false on failure. */
async function refresh(): Promise<boolean> {
  const seq = ++refreshSeq;
  try {
    const state = await send<PopupState | undefined>({
      kind: "getState",
      tabId,
      ...(isWebUrl(tabUrl) && { pageUrl: tabUrl }),
    });
    if (seq !== refreshSeq) return true;
    if (!state || typeof state !== "object" || !("connection" in state))
      throw new Error("bad state");
    if (state.picker && !picker) {
      // An overlay click that needed a choice: show the same picker a popup click would, and tell
      // the background it was taken so Cancel does not bring it back.
      picker = pendingPicker(state);
      void send({ kind: "clearPicker", tabId }).catch(() => {});
    }
    lastState = state;
    paintAbout();
    const model = buildPopupModel(state, picker?.media, {
      ...(hostAccess !== undefined && { hostAccess }),
    });
    if (notice) model.banner = { tone: "error", text: notice };
    render(model);
    return true;
  } catch {
    render(unreachableModel());
    return false;
  }
}

async function init(): Promise<void> {
  // The saved theme is applied before the first draw, but a slow storage must not hold the popup.
  await Promise.race([loadTheme(), new Promise((resolve) => setTimeout(resolve, 150))]);
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? -1;
  tabUrl = tab?.url ?? "";
  api.runtime.onMessage.addListener((message: unknown) => {
    if ((message as { kind?: string } | undefined)?.kind === "stateChanged") void refresh();
  });
  hostAccess = await checkHostAccess();
  if (tabId < 0) {
    render(
      buildPopupModel(undefined, undefined, { ...(hostAccess !== undefined && { hostAccess }) }),
    );
    return;
  }
  if (!(await refresh())) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!(await refresh())) return;
  }
  if (isWebUrl(tabUrl)) {
    // Read the state again while the probe runs, so the list says "Checking this page…" instead
    // of sitting empty for the seconds a probe takes.
    const probing = send({ kind: "probe", tabId, url: tabUrl }).catch(() => {
      // The next refresh reports whether the background is reachable.
    });
    await refresh();
    await probing;
    await refresh();
  }
}

init().catch(() => {
  render(unreachableModel());
});
