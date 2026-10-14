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

export function createDetector(deps: DetectorDeps) {
  return {
    async handle(details: ResponseDetails): Promise<void> {
      if (details.tabId < 0) return;
      if (details.statusCode !== 200 && details.statusCode !== 206) return;
      if (details.type === "ping" || details.type === "beacon") return;

      const contentType = header(details, "content-type");
      // Manifests are often served as text/plain, text/html or xml, so a manifest URL wins.
      const urlClass = classifyByUrl(details.url);
      const manifestUrl = urlClass?.streamType === "hls" || urlClass?.streamType === "dash";
      if (!manifestUrl && contentType && NON_MEDIA_TYPE.test(contentType.trim().toLowerCase())) {
        return;
      }
      const classification = classifyRequest(details.url, contentType);
      if (!classification) return;

      const length = Number(header(details, "content-length"));
      if (
        classification.streamType === "progressive" &&
        Number.isFinite(length) &&
        length > 0 &&
        length < MIN_PROGRESSIVE_BYTES
      ) {
        return;
      }

      // The tab may have closed between the response and now.
      const tab = await deps.getTab(details.tabId).catch(() => undefined);
      if (!tab?.url || !/^https?:\/\//i.test(tab.url)) return;
      const mime = contentType?.split(";")[0]?.trim();
      await deps.store.add(
        details.tabId,
        createCandidate({
          url: details.url,
          pageUrl: tab.url,
          ...(tab.title && { pageTitle: tab.title }),
          source: "network",
          classification,
          ...(mime && { mime }),
          ...(deps.now && { detectedAt: deps.now() }),
        }),
      );
    },
  };
}
