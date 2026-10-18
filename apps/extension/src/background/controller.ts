import { DEFAULT_PROFILE_ID } from "@mediaforge/media-profiles";
import type { ExtensionSettings, ProbedMedia } from "@mediaforge/shared-protocol";
import {
  DEFAULT_LIMITS,
  type MediaCandidate,
  type Notice,
  type SubtitleRequest,
} from "@mediaforge/shared-types";
import type { JobMirrorApi, MirrorJob } from "./job-mirror.ts";
import {
  type ConnectionState,
  type HostInfo,
  type NativeClient,
  NativeRequestError,
} from "./native-client.ts";
import type { TabStore } from "./tab-store.ts";

export type ProbeView =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; media: ProbedMedia }
  | { state: "unsupported" }
  | { state: "error"; message: string };

export interface PopupState {
  connection: ConnectionState;
  /** The core's version and tools, for diagnosis. */
  host?: HostInfo;
  settings?: ExtensionSettings;
  candidates: MediaCandidate[];
  jobs: MirrorJob[];
  probe: ProbeView;
  /** Media the overlay could not download without a quality choice; the popup opens its picker. */
  picker?: ProbedMedia;
  /** Downloads the core paused when the last session ended, until the user dismisses it. */
  notice?: Notice;
}

export type NothingReason = "unsupported" | "error" | "no-media" | "unavailable";

export type DownloadResult =
  | { status: "started"; jobId: string }
  | { status: "needs-picker"; media: ProbedMedia }
  | { status: "nothing"; reason?: NothingReason; message?: string }
  | { status: "error"; message: string };

export type Command =
  | { kind: "getState"; tabId: number; pageUrl?: string }
  | { kind: "probe"; tabId: number; url: string }
  | {
      kind: "download";
      tabId: number;
      source: { type: "candidate"; id: string } | { type: "page"; url: string; title?: string };
      variantId?: string;
      /** With a silent `variantId`: no audio is added. */
      videoOnly?: boolean;
      /** Save this subtitle track instead of the media. */
      subtitle?: SubtitleRequest;
    }
  | { kind: "cancel"; jobId: string }
  | { kind: "pause"; jobId: string }
  /** Resumes a paused job, or retries a failed one. */
  | { kind: "resume"; jobId: string }
  /** Brings the desktop app forward, launching it when it is not running. */
  | { kind: "openApp" }
  | { kind: "dismissNotice" }
  /** Show a finished job's file in the file manager, or the download folder without a job. */
  | { kind: "openFolder"; jobId?: string }
  /** The popup took the pending picker for this tab; it must not come back after Cancel. */
  | { kind: "clearPicker"; tabId: number }
  | { kind: "clearFinished" }
  /** Hides one item from "On this page" for this tab. */
  | {
      kind: "removeItem";
      tabId: number;
      source: { type: "candidate"; id: string } | { type: "page"; url: string };
    }
  /** Hides every item from "On this page" for this tab. */
  | { kind: "clearItems"; tabId: number; pageUrl?: string }
  | {
      kind: "setSetting";
      key: "extensionUi" | "keepRunning" | "askQuality" | "limitPreset";
      value: string | boolean;
    }
  /** The Custom preset's cap in bytes per second; null is no limit. */
  | { kind: "setCustomLimit"; bytesPerSec: number | null }
  | { kind: "debug"; tabId: number }
  | { kind: "overlayConfig" }
  | { kind: "overlayDownload" };

export interface Sender {
  /** The URL of the frame that sent the message, set by the browser. */
  url?: string;
  tab?: { id?: number; windowId?: number; url?: string; title?: string };
}

export interface ControllerDeps {
  client: NativeClient;
  store: TabStore;
  mirror: JobMirrorApi;
  /** The Cookie header value for a URL. Called at click time only. */
  getCookies(url: string, tabId: number): Promise<string>;
  userAgent: string;
  now(): number;
  /** The detector's recent decisions for a tab, for the popup-only `debug` command. */
  getDecisions?(tabId: number): unknown[];
  /**
   * Opens the toolbar popup. Called before anything is awaited, so the overlay click that caused
   * it still counts as a user action. Resolves with whether the browser opened it.
   */
  openPopup?(windowId: number | undefined): Promise<boolean>;
}

const PROBE_TIMEOUT_MS = 45_000;
const MAX_PROBES = 50;
const MAX_REASON_MESSAGE = 120;
/** The core does not push every settings change, so a cached copy is trusted this long. */
const SETTINGS_FRESH_MS = 5_000;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isManifest = (c: MediaCandidate): boolean =>
  c.streamType === "hls" || c.streamType === "dash";

/**
 * The candidate the overlay falls back to: the first manifest the page loaded (later ones are
 * usually variant or audio playlists, or ads), else the newest plain file.
 */
function fallbackCandidate(candidates: MediaCandidate[]): MediaCandidate | undefined {
  const manifests = candidates.filter(isManifest).sort((a, b) => a.detectedAt - b.detectedAt);
  if (manifests[0]) return manifests[0];
  return candidates.filter((c) => !isManifest(c)).sort((a, b) => b.detectedAt - a.detectedAt)[0];
}

/** Whether the page offers anything to choose: another format, or a subtitle track. */
const hasChoices = (media: ProbedMedia): boolean =>
  media.formats.length > 1 || (media.subtitles?.length ?? 0) > 0;

/** The small label a job shows beside its title: the picked format, e.g. "1080p mp4". */
function formatLabel(media: ProbedMedia, formatId: string): string | undefined {
  const format = media.formats.find((f) => f.id === formatId);
  return format ? [format.label, format.container].filter(Boolean).join(" ") : undefined;
}

/** Marks a picture-only pick, so its job row is told apart from the same format with sound. */
const videoLabel = (
  label: string | undefined,
  videoOnly: boolean | undefined,
): string | undefined => (videoOnly && label ? `${label} video only` : label);

const isWebUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

const OVERLAY_KINDS = new Set(["overlayConfig", "overlayDownload"]);
const POPUP_KINDS = new Set([
  "getState",
  "probe",
  "download",
  "cancel",
  "pause",
  "resume",
  "openApp",
  "dismissNotice",
  "openFolder",
  "clearPicker",
  "clearFinished",
  "removeItem",
  "clearItems",
  "setSetting",
  "setCustomLimit",
  "debug",
]);

export function createController(deps: ControllerDeps) {
  const probes = new Map<string, ProbeView>();
  /** Page videos the user removed from the list; the page is not listed again until it reloads. */
  const hiddenPages = new Set<string>();
  const inflight = new Map<string, Promise<ProbeView>>();
  const remember = (url: string, view: ProbeView): void => {
    probes.delete(url);
    probes.set(url, view);
    while (probes.size > MAX_PROBES) {
      const oldest = probes.keys().next().value;
      if (oldest === undefined) break;
      probes.delete(oldest);
    }
  };
  /** The page URL each tab last asked about, so navigation can drop the stale probe. */
  const tabUrls = new Map<number, Set<string>>();
  const noteTabUrl = (tabId: number, url: string): void => {
    const urls = tabUrls.get(tabId) ?? new Set<string>();
    urls.add(url);
    tabUrls.set(tabId, urls);
  };
  /** Media waiting for a quality choice after an overlay click, one per tab. */
  const pendingPickers = new Map<number, ProbedMedia>();
  let settings: ExtensionSettings | undefined;
  let settingsAt = 0;
  let settingsLoad: Promise<ExtensionSettings | undefined> | undefined;
  let notice: Notice | undefined;
  const keepSettings = (value: ExtensionSettings): void => {
    settings = value;
    settingsAt = deps.now();
  };

  // Keep the settings cache current without the caller having to wire it.
  deps.client.onPush((message) => {
    if (message.type === "settings.value") keepSettings(message.payload);
    // A hello.ack without a notice clears a stale one, as does a notice push without one.
    if (message.type === "hello.ack" || message.type === "notice") notice = message.payload.notice;
  });
  let lastConnection: ConnectionState["kind"] | undefined;
  deps.client.onState((state) => {
    const previous = lastConnection;
    lastConnection = state.kind;
    if (state.kind !== "ready" || previous === "ready") return;
    // A fresh connection may be a restarted core, which has forgotten every probe's formats: re-read
    // settings and probe again.
    settings = undefined;
    probes.clear();
  });

  const loadSettings = (): Promise<ExtensionSettings | undefined> => {
    if (settings && deps.now() - settingsAt < SETTINGS_FRESH_MS) return Promise.resolve(settings);
    if (settingsLoad) return settingsLoad;
    const load = (async () => {
      try {
        const reply = await deps.client.request("settings.get", {});
        if (reply.type === "settings.value") keepSettings(reply.payload);
      } catch {
        // The popup shows the connection banner; a stale copy beats none.
      }
      return settings;
    })().finally(() => {
      if (settingsLoad === load) settingsLoad = undefined;
    });
    settingsLoad = load;
    return load;
  };

  const probe = (url: string): Promise<ProbeView> => {
    if (!isWebUrl(url)) return Promise.resolve({ state: "idle" });
    const cached = probes.get(url);
    if (cached && cached.state !== "loading") return Promise.resolve(cached);
    const existing = inflight.get(url);
    if (existing) return existing;
    const run = runProbe(url).finally(() => inflight.delete(url));
    inflight.set(url, run);
    return run;
  };

  const runProbe = async (url: string): Promise<ProbeView> => {
    remember(url, { state: "loading" });
    let view: ProbeView;
    try {
      const reply = await deps.client.request(
        "media.probe",
        { url },
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      view =
        reply.type === "media.info"
          ? { state: "ready", media: reply.payload }
          : { state: "error", message: "Unexpected reply." };
    } catch (error) {
      view =
        error instanceof NativeRequestError && error.code === "unsupported-site"
          ? { state: "unsupported" }
          : {
              state: "error",
              message: error instanceof Error ? error.message : String(error),
            };
    }
    // Transient failures are not cached, so the next open tries again.
    if (view.state === "ready" || view.state === "unsupported") remember(url, view);
    else probes.delete(url);
    return view;
  };

  const pageCandidate = (url: string, title: string | undefined): MediaCandidate => ({
    id: url,
    pageUrl: url,
    ...(title && { pageTitle: title }),
    url,
    kind: "video",
    streamType: "progressive",
    source: "dom",
    variants: [],
    detectedAt: deps.now(),
  });

  /** Sends `download.start`; rejects with the core's error. */
  const send = async (
    candidate: MediaCandidate,
    options: {
      variantId?: string;
      videoOnly?: boolean;
      tabId?: number;
      subtitle?: SubtitleRequest;
      label?: string;
    },
  ): Promise<DownloadResult> => {
    const s = await loadSettings();
    const profileId = s?.quality ?? DEFAULT_PROFILE_ID;
    let context: Record<string, string> | undefined;
    if (options.tabId !== undefined) {
      // Cookies are read at click time from the tab's own store; none on any failure.
      const cookies = await deps.getCookies(candidate.url, options.tabId).catch(() => "");
      let referer = candidate.pageUrl;
      try {
        referer = `${new URL(candidate.pageUrl).origin}/`;
      } catch {
        // Keep the raw value.
      }
      context = {
        referer,
        userAgent: deps.userAgent,
        ...(cookies && { cookies }),
      };
    }
    const reply = await deps.client.request("download.start", {
      candidate,
      profileId,
      ...(options.variantId && { variantId: options.variantId }),
      ...(options.videoOnly && { videoOnly: true }),
      ...(options.subtitle && { subtitle: options.subtitle }),
      ...(context && { context }),
    });
    if (
      reply.type !== "download.progress" &&
      reply.type !== "download.completed" &&
      reply.type !== "download.failed"
    ) {
      return { status: "error", message: "Unexpected reply." };
    }
    // A job can finish or fail before its first progress frame; it was still started.
    const jobId = reply.payload.jobId;
    deps.mirror.noteTitle(jobId, candidate.pageTitle ?? candidate.url);
    if (options.label) deps.mirror.noteLabel(jobId, options.label);
    deps.mirror.apply(reply);
    if (reply.type === "download.failed") return { status: "error", message: reply.payload.error };
    return { status: "started", jobId };
  };

  const start = (
    candidate: MediaCandidate,
    options: Parameters<typeof send>[1],
  ): Promise<DownloadResult> =>
    send(candidate, options).catch((error: unknown) => ({
      status: "error",
      message: errorMessage(error),
    }));

  const downloadPage = async (
    url: string,
    title: string | undefined,
    variantId: string | undefined,
    subtitle?: SubtitleRequest,
    videoOnly?: boolean,
  ): Promise<DownloadResult> => {
    const view = await probe(url);
    if (view.state !== "ready") return { status: "nothing" };
    if (subtitle) {
      const label = `${subtitle.lang} subtitles`;
      return start(pageCandidate(url, title ?? view.media.title), { subtitle, label });
    }
    // The picker is the default: choosing is how formats, audio and subtitles are reached.
    if (!variantId && hasChoices(view.media)) {
      return { status: "needs-picker", media: view.media };
    }
    const base = title ?? view.media.title;
    if (!variantId) return start(pageCandidate(url, base), {});
    try {
      const label = videoLabel(formatLabel(view.media, variantId), videoOnly);
      return await send(pageCandidate(url, base), {
        variantId,
        ...(videoOnly && { videoOnly }),
        ...(label && { label }),
      });
    } catch (error) {
      if (!(error instanceof NativeRequestError && error.code === "unknown-variant")) {
        return { status: "error", message: errorMessage(error) };
      }
    }
    // The core no longer knows this page's formats (it restarted, or forgot older pages): probe
    // again, and retry only if the same choice is still offered.
    probes.delete(url);
    const fresh = await probe(url);
    if (fresh.state !== "ready") {
      return {
        status: "error",
        message: fresh.state === "error" ? fresh.message : "This page can no longer be checked.",
      };
    }
    if (!fresh.media.formats.some((f) => f.id === variantId)) {
      return { status: "needs-picker", media: fresh.media };
    }
    const freshLabel = videoLabel(formatLabel(fresh.media, variantId), videoOnly);
    return start(pageCandidate(url, title ?? fresh.media.title), {
      variantId,
      ...(videoOnly && { videoOnly }),
      ...(freshLabel && { label: freshLabel }),
    });
  };

  const dispatch = async (command: Command, sender: Sender): Promise<unknown> => {
    switch (command.kind) {
      case "getState": {
        if (command.pageUrl) noteTabUrl(command.tabId, command.pageUrl);
        const s = await loadSettings();
        const picker = pendingPickers.get(command.tabId);
        const host = deps.client.host?.();
        const state: PopupState = {
          connection: deps.client.state(),
          ...(host && { host }),
          ...(s && { settings: s }),
          candidates: await deps.store.list(command.tabId),
          jobs: deps.mirror.list(),
          probe:
            command.pageUrl && !hiddenPages.has(command.pageUrl)
              ? (probes.get(command.pageUrl) ?? { state: "idle" })
              : { state: "idle" },
          ...(picker && { picker }),
          ...(notice && { notice }),
        };
        return state;
      }
      case "probe":
        noteTabUrl(command.tabId, command.url);
        return probe(command.url);
      case "download": {
        let result: DownloadResult;
        if (command.source.type === "candidate") {
          const found = await deps.store.find(command.tabId, command.source.id);
          if (!found) return { status: "nothing" } satisfies DownloadResult;
          result = await start(found, { tabId: command.tabId });
        } else {
          if (!isWebUrl(command.source.url)) return { status: "nothing" } satisfies DownloadResult;
          result = await downloadPage(
            command.source.url,
            command.source.title,
            command.variantId,
            command.subtitle,
            command.videoOnly,
          );
        }
        if (result.status === "started") pendingPickers.delete(command.tabId);
        return result;
      }
      case "removeItem": {
        if (command.source.type === "candidate") {
          await deps.store.remove(command.tabId, command.source.id);
        } else hiddenPages.add(command.source.url);
        return { ok: true };
      }
      case "clearItems": {
        await deps.store.clear(command.tabId);
        if (command.pageUrl) hiddenPages.add(command.pageUrl);
        return { ok: true };
      }
      case "cancel": {
        try {
          await deps.client.request("download.cancel", { jobId: command.jobId });
        } catch {
          // The job may have just finished; the next progress frame shows the truth.
        }
        return { ok: true };
      }
      case "pause":
      case "resume": {
        try {
          const type = command.kind === "pause" ? "download.pause" : "download.resume";
          const reply = await deps.client.request(type, { jobIds: [command.jobId] });
          const failed = reply.type === "jobs.result" ? reply.payload.failed[0] : undefined;
          return failed ? { ok: false, message: failed.message } : { ok: true };
        } catch (error) {
          return { ok: false, message: errorMessage(error) };
        }
      }
      case "openApp": {
        try {
          const reply = await deps.client.request("app.open", {});
          if (reply.type !== "app.opened") return { ok: false, message: "Unexpected reply." };
          return { ok: true, mode: reply.payload.mode };
        } catch (error) {
          // A core older than this request rejects its type as an invalid message.
          if (error instanceof NativeRequestError && error.code === "invalid-message") {
            return { ok: false, message: "Update MediaForge to open it from the browser." };
          }
          return { ok: false, message: errorMessage(error) };
        }
      }
      case "dismissNotice": {
        try {
          await deps.client.request("notice.dismiss", {});
          notice = undefined;
          return { ok: true };
        } catch (error) {
          return { ok: false, message: errorMessage(error) };
        }
      }
      case "openFolder": {
        try {
          await deps.client.request(
            "folder.open",
            command.jobId === undefined ? {} : { jobId: command.jobId },
          );
          return { ok: true };
        } catch (error) {
          // A core older than this request rejects its type as an invalid message.
          if (error instanceof NativeRequestError && error.code === "invalid-message") {
            return { ok: false, message: "Update MediaForge to open folders from the browser." };
          }
          return { ok: false, message: errorMessage(error) };
        }
      }
      case "clearPicker": {
        pendingPickers.delete(command.tabId);
        return { ok: true };
      }
      case "clearFinished": {
        deps.mirror.clearFinished();
        return { ok: true };
      }
      case "setSetting": {
        try {
          const reply = await deps.client.request("settings.set", { [command.key]: command.value });
          if (reply.type === "settings.value") settings = reply.payload;
          return { ok: true, settings };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      }
      case "setCustomLimit": {
        try {
          // Read the values fresh: the core refuses a change to High, Med or Low from here, so a
          // stale copy of them would get the whole change refused.
          const fresh = await deps.client.request("settings.get", {});
          if (fresh.type !== "settings.value") return { ok: false, message: "Unexpected reply." };
          const limits = {
            ...(fresh.payload.limits ?? DEFAULT_LIMITS),
            custom: command.bytesPerSec,
          };
          const reply = await deps.client.request("settings.set", { limits });
          if (reply.type === "settings.value") keepSettings(reply.payload);
          return { ok: true, settings };
        } catch (error) {
          return { ok: false, message: errorMessage(error) };
        }
      }
      case "debug":
        return deps.getDecisions?.(command.tabId) ?? [];
      case "overlayConfig": {
        const s = await loadSettings();
        return { enabled: s?.extensionUi === "overlay" };
      }
      case "overlayDownload": {
        // First, before any await: the click is still a user action, which opening needs.
        const opening = deps.openPopup?.(sender.tab?.windowId).catch(() => false);
        const result = await overlayDownload(sender);
        return opening ? { ...result, popup: await opening } : result;
      }
    }
  };

  const overlayDownload = async (sender: Sender): Promise<DownloadResult> => {
    const tab = sender.tab;
    // The frame's own URL (set by the browser) is the page to download; embeds are separate pages.
    const pageUrl = sender.url && isWebUrl(sender.url) ? sender.url : tab?.url;
    if (!tab?.id || !pageUrl || !isWebUrl(pageUrl)) {
      return { status: "nothing", reason: "no-media" } satisfies DownloadResult;
    }
    if (deps.client.state().kind !== "ready") {
      return { status: "nothing", reason: "unavailable" } satisfies DownloadResult;
    }
    noteTabUrl(tab.id, pageUrl);
    const view = await probe(pageUrl);
    let result: DownloadResult;
    if (view.state === "ready") {
      result = await downloadPage(pageUrl, pageUrl === tab.url ? tab.title : undefined, undefined);
    } else {
      const chosen = fallbackCandidate(await deps.store.list(tab.id));
      if (!chosen) {
        if (view.state === "error") {
          return {
            status: "nothing",
            reason: "error",
            message: view.message.slice(0, MAX_REASON_MESSAGE),
          } satisfies DownloadResult;
        }
        const reason = view.state === "unsupported" ? "unsupported" : "no-media";
        return { status: "nothing", reason } satisfies DownloadResult;
      }
      result = await start(chosen, { tabId: tab.id });
    }
    // The overlay cannot show a picker: the toolbar popup opens it for this tab.
    if (result.status === "needs-picker") pendingPickers.set(tab.id, result.media);
    else if (result.status === "started") pendingPickers.delete(tab.id);
    return result;
  };

  return {
    async handle(command: Command, sender: Sender): Promise<unknown> {
      const kind = (command as { kind?: unknown } | undefined)?.kind;
      const fromTab = sender.tab !== undefined;
      const failure = (message: string) =>
        kind === "download"
          ? ({ status: "error", message } satisfies DownloadResult)
          : { ok: false, message };
      if (typeof kind !== "string" || !(OVERLAY_KINDS.has(kind) || POPUP_KINDS.has(kind))) {
        return { ok: false, message: "unknown command" };
      }
      // Content scripts speak for their own tab only; popup commands come from the extension page.
      if (fromTab ? !OVERLAY_KINDS.has(kind) : OVERLAY_KINDS.has(kind)) {
        return failure("not allowed");
      }
      try {
        return await dispatch(command, sender);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return command.kind === "download"
          ? ({ status: "error", message } satisfies DownloadResult)
          : { ok: false, message };
      }
    },
    /** Drops the tab's cached probe view; called when the tab navigates or closes. */
    forgetTab(tabId: number): void {
      pendingPickers.delete(tabId);
      const urls = tabUrls.get(tabId);
      tabUrls.delete(tabId);
      if (urls) {
        for (const url of urls) {
          probes.delete(url);
          hiddenPages.delete(url);
        }
      }
    },
  };
}

export type Controller = ReturnType<typeof createController>;
