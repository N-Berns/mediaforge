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
  banner?: {
    tone: "info" | "warn" | "error";
    text: string;
    link?: { label: string; href: string };
  };
  /** Shown when the browser has not granted access to all sites (Firefox makes it optional). */
  access?: { text: string; button: string };
  items: ItemModel[];
  /** A row with no action, shown while the page is being checked. */
  placeholder?: string;
  picker?: {
    title: string;
    formats: Array<{ id: string; label: string; detail: string }>;
  };
  jobs: JobRow[];
  toggles?: { overlay: boolean; keepRunning: boolean };
}

const INSTALL_URL = "https://github.com/N-Berns/mediaforge/releases/latest";

function duration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
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

const MAX_JOBS = 20;
const MAX_PROBE_ERROR = 120;

export const UNREACHABLE_TEXT = "Cannot reach the MediaForge extension. Reopen this popup.";

/** Shown when the popup cannot talk to the background page. */
export function unreachableModel(): PopupModel {
  return { items: [], jobs: [], banner: { tone: "error", text: UNREACHABLE_TEXT } };
}

const ACTIVE = new Set(["queued", "downloading", "processing"]);

export type PageSource = Extract<ItemModel["action"], { type: "page" }>;

/** The picker to open for media an overlay click left waiting on a quality choice. */
export function pendingPicker(
  state: PopupState | undefined,
): { media: ProbedMedia; source: PageSource } | undefined {
  const media = state?.picker;
  if (!media) return undefined;
  return {
    media,
    source: { type: "page", url: media.url, ...(media.title && { title: media.title }) },
  };
}

export const HOST_ACCESS_TEXT = "MediaForge needs access to all sites to find media.";

export function buildPopupModel(
  state: PopupState | undefined,
  picker?: ProbedMedia,
  options: { hostAccess?: boolean } = {},
): PopupModel {
  const model: PopupModel = { items: [], jobs: [] };
  if (options.hostAccess === false) {
    model.access = { text: HOST_ACCESS_TEXT, button: "Allow access" };
  }
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

  if (state.probe.state === "error" && !model.banner) {
    const message = state.probe.message;
    const short =
      message.length > MAX_PROBE_ERROR ? `${message.slice(0, MAX_PROBE_ERROR - 1)}…` : message;
    model.banner = { tone: "info", text: `Could not check this page: ${short}` };
  }
  if (state.probe.state === "loading") model.placeholder = "Checking this page…";
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
        detail: [
          f.container,
          f.approxBytes ? megabytes(f.approxBytes) : "",
          f.hasVideo ? "" : "audio only",
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    };
  }

  model.jobs = state.jobs.slice(0, MAX_JOBS).map((j) => ({
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
