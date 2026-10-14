import { DEFAULT_PROFILE_ID } from "@mediaforge/media-profiles";
import type { ExtensionSettings, ProbedMedia } from "@mediaforge/shared-protocol";
import type { MediaCandidate } from "@mediaforge/shared-types";
import type { JobMirrorApi, MirrorJob } from "./job-mirror.ts";
import { type ConnectionState, type NativeClient, NativeRequestError } from "./native-client.ts";
import type { TabStore } from "./tab-store.ts";

export type ProbeView =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; media: ProbedMedia }
  | { state: "unsupported" }
  | { state: "error"; message: string };

export interface PopupState {
  connection: ConnectionState;
  settings?: ExtensionSettings;
  candidates: MediaCandidate[];
  jobs: MirrorJob[];
  probe: ProbeView;
  /** Media the overlay could not download without a quality choice; the popup opens its picker. */
  picker?: ProbedMedia;
}

export type DownloadResult =
  | { status: "started"; jobId: string }
  | { status: "needs-picker"; media: ProbedMedia }
  | { status: "nothing" }
  | { status: "error"; message: string };

export type Command =
  | { kind: "getState"; tabId: number; pageUrl?: string }
  | { kind: "probe"; tabId: number; url: string }
  | {
      kind: "download";
      tabId: number;
      source: { type: "candidate"; id: string } | { type: "page"; url: string; title?: string };
      variantId?: string;
    }
  | { kind: "cancel"; jobId: string }
  | {
      kind: "setSetting";
      key: "extensionUi" | "keepRunning" | "askQuality";
      value: string | boolean;
    }
  | { kind: "overlayConfig" }
  | { kind: "overlayDownload" };

export interface Sender {
  /** The URL of the frame that sent the message, set by the browser. */
  url?: string;
  tab?: { id?: number; url?: string; title?: string };
}

export interface ControllerDeps {
  client: NativeClient;
  store: TabStore;
  mirror: JobMirrorApi;
  /** The Cookie header value for a URL. Called at click time only. */
  getCookies(url: string, tabId: number): Promise<string>;
  userAgent: string;
  now(): number;
}

const PROBE_TIMEOUT_MS = 45_000;
const MAX_PROBES = 50;
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

const isWebUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

const OVERLAY_KINDS = new Set(["overlayConfig", "overlayDownload"]);
const POPUP_KINDS = new Set(["getState", "probe", "download", "cancel", "setSetting"]);

export function createController(deps: ControllerDeps) {
  const probes = new Map<string, ProbeView>();
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
  const keepSettings = (value: ExtensionSettings): void => {
    settings = value;
    settingsAt = deps.now();
  };

  // Keep the settings cache current without the caller having to wire it.
  deps.client.onPush((message) => {
    if (message.type === "settings.value") keepSettings(message.payload);
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
    options: { variantId?: string; tabId?: number },
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
    deps.mirror.apply(reply);
    if (reply.type === "download.failed") return { status: "error", message: reply.payload.error };
    return { status: "started", jobId };
  };

  const start = (
    candidate: MediaCandidate,
    options: { variantId?: string; tabId?: number },
  ): Promise<DownloadResult> =>
    send(candidate, options).catch((error: unknown) => ({
      status: "error",
      message: errorMessage(error),
    }));

  const downloadPage = async (
    url: string,
    title: string | undefined,
    variantId: string | undefined,
  ): Promise<DownloadResult> => {
    const view = await probe(url);
    if (view.state !== "ready") return { status: "nothing" };
    const s = await loadSettings();
    if (s?.askQuality && !variantId && view.media.formats.length > 1) {
      return { status: "needs-picker", media: view.media };
    }
    const candidate = pageCandidate(url, title ?? view.media.title);
    if (!variantId) return start(candidate, {});
    try {
      return await send(candidate, { variantId });
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
    return start(pageCandidate(url, title ?? fresh.media.title), { variantId });
  };

  const dispatch = async (command: Command, sender: Sender): Promise<unknown> => {
    switch (command.kind) {
      case "getState": {
        if (command.pageUrl) noteTabUrl(command.tabId, command.pageUrl);
        const s = await loadSettings();
        const picker = pendingPickers.get(command.tabId);
        const state: PopupState = {
          connection: deps.client.state(),
          ...(s && { settings: s }),
          candidates: await deps.store.list(command.tabId),
          jobs: deps.mirror.list(),
          probe: command.pageUrl
            ? (probes.get(command.pageUrl) ?? { state: "idle" })
            : { state: "idle" },
          ...(picker && { picker }),
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
          result = await downloadPage(command.source.url, command.source.title, command.variantId);
        }
        if (result.status === "started") pendingPickers.delete(command.tabId);
        return result;
      }
      case "cancel": {
        try {
          await deps.client.request("download.cancel", { jobId: command.jobId });
        } catch {
          // The job may have just finished; the next progress frame shows the truth.
        }
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
      case "overlayConfig": {
        const s = await loadSettings();
        return { enabled: s?.extensionUi === "overlay" };
      }
      case "overlayDownload": {
        const tab = sender.tab;
        // The frame's own URL (set by the browser) is the page to download; embeds are separate pages.
        const pageUrl = sender.url && isWebUrl(sender.url) ? sender.url : tab?.url;
        if (!tab?.id || !pageUrl || !isWebUrl(pageUrl))
          return { status: "nothing" } satisfies DownloadResult;
        noteTabUrl(tab.id, pageUrl);
        const view = await probe(pageUrl);
        let result: DownloadResult;
        if (view.state === "ready") {
          result = await downloadPage(
            pageUrl,
            pageUrl === tab.url ? tab.title : undefined,
            undefined,
          );
        } else {
          const chosen = fallbackCandidate(await deps.store.list(tab.id));
          if (!chosen) return { status: "nothing" } satisfies DownloadResult;
          result = await start(chosen, { tabId: tab.id });
        }
        // The overlay cannot show a picker: the toolbar popup opens it for this tab.
        if (result.status === "needs-picker") pendingPickers.set(tab.id, result.media);
        else if (result.status === "started") pendingPickers.delete(tab.id);
        return result;
      }
    }
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
      if (urls) for (const url of urls) probes.delete(url);
    },
  };
}

export type Controller = ReturnType<typeof createController>;
