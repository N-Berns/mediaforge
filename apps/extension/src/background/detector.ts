import { classifyByUrl, classifyRequest, createCandidate } from "@mediaforge/extension-core";
import type { TabStore } from "./tab-store.ts";

export interface ResponseDetails {
  url: string;
  tabId: number;
  statusCode: number;
  type?: string;
  responseHeaders?: Array<{ name: string; value?: string }>;
}

export interface DetectorDeps {
  store: TabStore;
  getTab(tabId: number): Promise<{ url?: string; title?: string } | undefined>;
  now?: () => number;
}

/** An explicit content type like this means the response is not media, whatever the URL says. */
const NON_MEDIA_TYPE = /^(text\/|image\/|application\/(json|javascript|xml)(;|$))/;

/** Progressive responses smaller than this are tracking pixels and placeholders, not media. */
const MIN_PROGRESSIVE_BYTES = 100_000;

const header = (details: ResponseDetails, name: string): string | undefined =>
  details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;

/** The size of the whole file: the Content-Range total of a partial response, else Content-Length. */
function totalLength(details: ResponseDetails): number | undefined {
  const total = /\/(\d+)\s*$/.exec(header(details, "content-range") ?? "")?.[1];
  const value = total !== undefined ? Number(total) : Number(header(details, "content-length"));
  return Number.isFinite(value) ? value : undefined;
}

/** One detector verdict, kept in memory for diagnosis; the URL carries no query or fragment. */
export interface Decision {
  url: string;
  accepted: boolean;
  reason: string;
}

const MAX_DECISIONS_PER_TAB = 20;

const safeUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(invalid url)";
  }
};

export function createDetector(deps: DetectorDeps) {
  const log = new Map<number, Decision[]>();
  const record = (tabId: number, url: string, accepted: boolean, reason: string): void => {
    const list = log.get(tabId) ?? [];
    list.push({ url: safeUrl(url), accepted, reason });
    if (list.length > MAX_DECISIONS_PER_TAB) list.shift();
    log.set(tabId, list);
  };

  return {
    decisions: (tabId: number): Decision[] => [...(log.get(tabId) ?? [])],
    forgetDecisions: (tabId: number): void => void log.delete(tabId),
    /** Resolves with whether the response changed the tab's list of candidates. */
    async handle(details: ResponseDetails): Promise<boolean> {
      if (details.tabId < 0) return false;
      const reject = (reason: string): boolean => {
        record(details.tabId, details.url, false, reason);
        return false;
      };
      if (details.statusCode !== 200 && details.statusCode !== 206) {
        return reject(`status ${details.statusCode}`);
      }
      if (details.type === "ping" || details.type === "beacon") return reject("ping or beacon");

      const contentType = header(details, "content-type");
      // Manifests are often served as text/plain, text/html or xml, so a manifest URL wins.
      const urlClass = classifyByUrl(details.url);
      const manifestUrl = urlClass?.streamType === "hls" || urlClass?.streamType === "dash";
      if (!manifestUrl && contentType && NON_MEDIA_TYPE.test(contentType.trim().toLowerCase())) {
        return reject(`non-media content type ${contentType}`);
      }
      const classification = classifyRequest(details.url, contentType);
      if (!classification) return reject("not media");

      const length = totalLength(details);
      if (
        classification.streamType === "progressive" &&
        length !== undefined &&
        length > 0 &&
        length < MIN_PROGRESSIVE_BYTES
      ) {
        return reject("too small for a media file");
      }
      if (!/^https?:\/\//i.test(details.url)) return reject("not http(s)");

      // The tab may have closed between the response and now.
      const tab = await deps.getTab(details.tabId).catch(() => undefined);
      // A top-level load reports the previous page's URL for the tab, so the response is its own page.
      const tabUrl = tab?.url !== undefined && /^https?:\/\//i.test(tab.url) ? tab.url : undefined;
      const pageUrl = tabUrl !== undefined && details.type !== "main_frame" ? tabUrl : details.url;
      const pageTitle = pageUrl === tabUrl ? tab?.title : undefined;
      const mime = contentType?.split(";")[0]?.trim();
      record(
        details.tabId,
        details.url,
        true,
        `${classification.streamType}${details.type === "main_frame" ? " (document)" : ""}`,
      );
      return deps.store.add(
        details.tabId,
        createCandidate({
          url: details.url,
          pageUrl,
          ...(pageTitle && { pageTitle }),
          source: "network",
          classification,
          ...(mime && { mime }),
          ...(deps.now && { detectedAt: deps.now() }),
        }),
      );
    },
  };
}
