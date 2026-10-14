import type { ProbedFormat, ProbedMedia } from "@mediaforge/shared-protocol";
import type { MediaInfo, RawFormat } from "../formats.ts";
import {
  isAudio,
  isVideo,
  resolutionName,
  sizeOf,
  usableFormats,
} from "../interactive/format-choices.ts";

/** `media.info` stays well under the 1 MiB host message cap with this many formats. */
export const MAX_FORMATS = 50;

/** The page is not a site yt-dlp has its own extractor for. */
export class UnsupportedSiteError extends Error {
  override name = "UnsupportedSiteError";
}

export interface KnownFormat {
  id: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

function labelOf(f: RawFormat): string {
  if (isVideo(f)) return resolutionName(f);
  return f.abr ? `Audio ${Math.round(f.abr)} kbps` : "Audio";
}

function toFormat(f: RawFormat, duration: number | undefined): ProbedFormat {
  const size = sizeOf(f, duration);
  return {
    id: f.format_id as string,
    label: labelOf(f),
    ...(f.width && { width: f.width }),
    ...(f.height && { height: f.height }),
    ...(f.ext && { container: f.ext }),
    hasVideo: isVideo(f),
    hasAudio: isAudio(f),
    ...(size && { approxBytes: Math.round(size.bytes) }),
  };
}

/** Turn yt-dlp's JSON into the `media.info` payload. Best format first. */
export function toProbedMedia(url: string, info: MediaInfo): ProbedMedia {
  if (info.extractor_key === "Generic") {
    throw new UnsupportedSiteError("MediaForge has no extractor for this page.");
  }
  // yt-dlp lists formats worst to best.
  const seen = new Set<string>();
  const formats: ProbedFormat[] = [];
  for (const raw of usableFormats(info).reverse()) {
    const format = toFormat(raw, info.duration);
    const key = [format.label, format.container, format.hasVideo, format.hasAudio].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    formats.push(format);
    if (formats.length === MAX_FORMATS) break;
  }
  return {
    url,
    ...(info.title && { title: info.title }),
    ...(info.duration !== undefined && { durationSec: info.duration }),
    formats,
  };
}

/** The yt-dlp `-f` value for one probed format: silent video gets the best audio added. */
export const selectorFor = (f: KnownFormat): string =>
  f.hasVideo && !f.hasAudio ? `${f.id}+ba/${f.id}` : f.id;

/** Run at most `max` tasks at once; the rest wait their turn. */
export function createProbeLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
