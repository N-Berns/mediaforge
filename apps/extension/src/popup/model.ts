import type { ProbedMedia } from "@mediaforge/shared-protocol";
import {
  DEFAULT_LIMITS,
  formatBytes,
  formatLimit,
  formatRate,
  LIMIT_PRESETS,
  type LimitPreset,
  type SpeedUnit,
} from "@mediaforge/shared-types";
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
  /** The small label beside the title: a format or subtitle language. */
  label?: string;
  status: string;
  percentText: string;
  active: boolean;
  /** Finished with a file the core can show in the file manager. */
  openable: boolean;
  /** The speed of a downloading job, in the unit the user chose. */
  speedText?: string;
  canPause: boolean;
  canResume: boolean;
  canRetry: boolean;
  canCancel: boolean;
  error?: string;
}

/** What the popup says after asking to open MediaForge. */
export interface OpenBanner {
  text: string;
  /** Text the popup offers to copy. */
  copy?: string;
  clearAfterMs?: number;
}

export const MANAGER_COMMAND = "mediaforge --manager";

/** The note for an open request that needs no further action when it launched the app. */
export function openResultBanner(
  mode: "attention" | "launched" | "no-terminal",
): OpenBanner | undefined {
  switch (mode) {
    case "attention":
      return { text: "MediaForge is already open.", clearAfterMs: 5000 };
    case "no-terminal":
      return {
        text: `Could not open a terminal. Run ${MANAGER_COMMAND}.`,
        copy: MANAGER_COMMAND,
      };
    case "launched":
      return undefined;
  }
}

/**
 * A picture format, a sound-only one, or a silent stream saved without sound. Under "video" a
 * silent stream gets the best audio added, so what the user gets there always has sound.
 */
export type FormatKind = "video" | "video-only" | "audio";

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
    formats: Array<{ id: string; label: string; detail: string; kind: FormatKind }>;
    /** False when the host predates subtitle support, so an empty list means nothing either way. */
    subtitlesSupported: boolean;
    subtitles: Array<{ key: string; lang: string; auto: boolean; label: string; detail: string }>;
  };
  jobs: JobRow[];
  /** Set while connected: the core can open the download folder. */
  openFolder?: true;
  toggles?: { overlay: boolean; keepRunning: boolean };
  /** The Open MediaForge button; always set, disabled with a tooltip when not connected. */
  openApp: { enabled: boolean; tooltip?: string };
  /** Why downloads were paused when MediaForge last started; set while connected. */
  notice?: { text: string };
  /** The bandwidth presets, set once settings arrive. */
  presets?: {
    current: LimitPreset;
    options: Array<{ value: LimitPreset; label: string; detail: string; unlimited: boolean }>;
    /** The unit the Custom field reads and shows. */
    unit: SpeedUnit;
    /** The Custom value as the field shows it; empty for no limit. */
    customText: string;
  };
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

const MAX_JOBS = 5;
const MAX_PROBE_ERROR = 120;

export const UNREACHABLE_TEXT = "Cannot reach the MediaForge extension. Reopen this popup.";

/** Shown when the popup cannot talk to the background page. */
export function unreachableModel(): PopupModel {
  return {
    items: [],
    jobs: [],
    banner: { tone: "error", text: UNREACHABLE_TEXT },
    openApp: NOT_CONNECTED,
  };
}

const ACTIVE = new Set(["queued", "downloading", "processing"]);
const NOT_CONNECTED = { enabled: false, tooltip: "MediaForge is not connected." };
const PRESET_LABELS: Record<LimitPreset, string> = {
  high: "High",
  med: "Med",
  low: "Low",
  custom: "Custom",
};

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
  const connected = state?.connection.kind === "ready" || state?.connection.kind === "setting-up";
  const model: PopupModel = {
    items: [],
    jobs: [],
    openApp: connected ? { enabled: true } : NOT_CONNECTED,
  };
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
      model.banner =
        state.connection.outdated === "app"
          ? {
              tone: "warn",
              text: "Update MediaForge: the app on your computer is older than this extension.",
              link: { label: "Get MediaForge", href: INSTALL_URL },
            }
          : {
              tone: "warn",
              text: "Update this extension: it is older than the MediaForge app on your computer.",
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

  // Only "ready" and "setting-up" get this far: the core is connected and can open folders.
  model.openFolder = true;

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
      formats: picker.formats.flatMap((f) => {
        const row = {
          id: f.id,
          label: f.label,
          kind: f.hasVideo ? ("video" as const) : ("audio" as const),
          detail: [
            f.container,
            f.approxBytes ? formatBytes(f.approxBytes) : "",
            f.hasVideo ? "" : "audio only",
          ]
            .filter(Boolean)
            .join(" · "),
        };
        // A silent stream is also offered on its own, without the audio the Video row adds.
        return f.hasVideo && !f.hasAudio ? [row, { ...row, kind: "video-only" as const }] : [row];
      }),
      subtitlesSupported: picker.subtitles !== undefined,
      subtitles: (picker.subtitles ?? []).map((t) => ({
        key: `${t.auto ? "auto" : "manual"}:${t.lang}`,
        lang: t.lang,
        auto: t.auto,
        label: t.name ?? t.lang,
        detail: [t.name ? t.lang : "", t.auto ? "Auto-generated" : ""].filter(Boolean).join(" · "),
      })),
    };
  }

  const unit = state.settings?.speedUnit ?? "bytes";
  model.jobs = state.jobs.slice(0, MAX_JOBS).map((j) => {
    const percent = j.percent !== undefined ? `${Math.round(j.percent)}%` : "";
    const paused = j.status === "paused";
    return {
      id: j.id,
      title: j.title ?? j.id,
      ...(j.label && { label: j.label }),
      status: j.status,
      percentText: paused
        ? `Paused${percent && ` ${percent}`}`
        : j.status === "cancelled"
          ? "Cancelled"
          : percent,
      active: ACTIVE.has(j.status),
      openable: j.status === "completed" && Boolean(j.outputPath),
      ...(j.status === "downloading" &&
        j.speed !== undefined && { speedText: formatRate(j.speed, unit) }),
      canPause: ACTIVE.has(j.status),
      canResume: paused,
      canRetry: j.status === "failed",
      canCancel: ACTIVE.has(j.status) || paused,
      // A cancel is the user's own choice, not a failure: it shows as a status, with no error.
      ...(j.status === "failed" && j.error && { error: j.error }),
    };
  });

  if (state.notice) {
    const { reason, pausedCount } = state.notice;
    const what =
      reason === "unexpected" ? "MediaForge closed unexpectedly." : "MediaForge was restarted.";
    const count = pausedCount === 1 ? "1 download was" : `${pausedCount} downloads were`;
    model.notice = { text: `${what} ${count} paused.` };
  }

  if (state.settings) {
    const limits = state.settings.limits ?? DEFAULT_LIMITS;
    model.presets = {
      current: state.settings.limitPreset ?? "high",
      options: LIMIT_PRESETS.map((value) => ({
        value,
        label: PRESET_LABELS[value],
        detail: formatLimit(limits[value], unit),
        unlimited: limits[value] === null,
      })),
      unit,
      customText: limits.custom === null ? "" : formatRate(limits.custom, unit),
    };
    model.toggles = {
      overlay: state.settings.extensionUi === "overlay",
      keepRunning: state.settings.keepRunning,
    };
  }
  return model;
}
