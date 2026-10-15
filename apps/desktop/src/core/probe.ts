import type { ProbedFormat, ProbedMedia, ProbedSubtitle } from "@mediaforge/shared-protocol";
import type { MediaInfo, RawFormat, RawSubtitle } from "../formats.ts";
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

/** Most tracks offered, to keep `media.info` small. */
export const MAX_SUBTITLES = 60;

/** Live-chat "subtitles" are not captions. */
const NOT_CAPTIONS = new Set(["live_chat"]);

/**
 * YouTube lists every language as an auto-translation of the spoken one; those entries carry a
 * `tlang=` parameter. Only tracks with an untranslated file are real captions.
 */
const isTranslation = (files: RawSubtitle[]): boolean =>
  files.length > 0 && files.every((file) => /[?&]tlang=/.test(file.url ?? ""));

function subtitlesOf(info: MediaInfo): ProbedSubtitle[] {
  const out: ProbedSubtitle[] = [];
  const manual = new Set<string>();
  const add = (table: Record<string, RawSubtitle[]> | undefined, auto: boolean) => {
    for (const [lang, files] of Object.entries(table ?? {})) {
      if (NOT_CAPTIONS.has(lang) || !Array.isArray(files)) continue;
      // An auto track is dropped when it is a translation, or a human track already covers it.
      if (auto && (isTranslation(files) || manual.has(lang))) continue;
      if (!auto) manual.add(lang);
      const name = files.find((f) => f.name)?.name;
      out.push({ lang, auto, ...(name && { name }) });
    }
  };
  add(info.subtitles, false);
  add(info.automatic_captions, true);
  // YouTube lists the spoken language twice, as `en` and `en-orig`: the same track.
  const langs = new Set(out.map((t) => t.lang));
  const unique = out.filter(
    (t) => !(t.auto && t.lang.endsWith("-orig") && langs.has(t.lang.slice(0, -5))),
  );
  return unique.slice(0, MAX_SUBTITLES);
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
  const subtitles = subtitlesOf(info);
  return {
    url,
    ...(info.title && { title: info.title }),
    ...(info.duration !== undefined && { durationSec: info.duration }),
    formats,
    // Always present from a host that can save subtitles, so an absent list means an older host.
    subtitles,
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
