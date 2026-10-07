import type { MediaKind, StreamType } from "@mediaforge/shared-types";

export interface Classification {
  kind: MediaKind;
  streamType: StreamType;
  container?: string;
}

const MIME_TABLE: Record<string, Classification> = {
  "video/mp4": { kind: "video", streamType: "progressive", container: "mp4" },
  "video/webm": { kind: "video", streamType: "progressive", container: "webm" },
  "video/quicktime": { kind: "video", streamType: "progressive", container: "mov" },
  "video/x-matroska": { kind: "video", streamType: "progressive", container: "mkv" },
  "video/x-flv": { kind: "video", streamType: "progressive", container: "flv" },
  "audio/mp4": { kind: "audio", streamType: "progressive", container: "m4a" },
  "audio/x-m4a": { kind: "audio", streamType: "progressive", container: "m4a" },
  "audio/mpeg": { kind: "audio", streamType: "progressive", container: "mp3" },
  "audio/webm": { kind: "audio", streamType: "progressive", container: "weba" },
  "audio/ogg": { kind: "audio", streamType: "progressive", container: "ogg" },
  "audio/aac": { kind: "audio", streamType: "progressive", container: "aac" },
  "audio/flac": { kind: "audio", streamType: "progressive", container: "flac" },
  "audio/wav": { kind: "audio", streamType: "progressive", container: "wav" },
  "application/vnd.apple.mpegurl": { kind: "video", streamType: "hls" },
  "application/x-mpegurl": { kind: "video", streamType: "hls" },
  "audio/mpegurl": { kind: "video", streamType: "hls" },
  "application/dash+xml": { kind: "video", streamType: "dash" },
};

const EXTENSION_TABLE: Record<string, Classification> = {
  mp4: MIME_TABLE["video/mp4"] as Classification,
  m4v: MIME_TABLE["video/mp4"] as Classification,
  webm: MIME_TABLE["video/webm"] as Classification,
  mov: MIME_TABLE["video/quicktime"] as Classification,
  mkv: MIME_TABLE["video/x-matroska"] as Classification,
  flv: MIME_TABLE["video/x-flv"] as Classification,
  m4a: MIME_TABLE["audio/mp4"] as Classification,
  mp3: MIME_TABLE["audio/mpeg"] as Classification,
  ogg: MIME_TABLE["audio/ogg"] as Classification,
  opus: { kind: "audio", streamType: "progressive", container: "opus" },
  aac: MIME_TABLE["audio/aac"] as Classification,
  flac: MIME_TABLE["audio/flac"] as Classification,
  wav: MIME_TABLE["audio/wav"] as Classification,
  m3u8: { kind: "video", streamType: "hls" },
  mpd: { kind: "video", streamType: "dash" },
};

/** Extensions of HLS/DASH segments: useful only via their manifest, never as candidates. */
const SEGMENT_EXTENSIONS = new Set(["ts", "m4s", "m4f", "cmfv", "cmfa"]);

/** Query params that mark a request as a byte-range/segment fetch of a larger file. */
const RANGE_PARAMS = ["range", "bytestart", "byteend", "rn", "rbuf"];

function extensionOf(pathname: string): string | undefined {
  const file = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(dot + 1).toLowerCase() : undefined;
}

/** Classify a response by its Content-Type header. */
export function classifyByMime(contentType: string | undefined): Classification | undefined {
  if (!contentType) return undefined;
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_TABLE[mime];
}

/** True when the URL looks like a segment or partial range of a larger stream. */
export function isSegmentUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const ext = extensionOf(url.pathname);
  if (ext && SEGMENT_EXTENSIONS.has(ext)) return true;
  if (/\/(init|seg|segment|chunk|frag(ment)?)[-_]?\d*\.(mp4|m4a|m4v)$/i.test(url.pathname)) {
    return true;
  }
  return RANGE_PARAMS.some((param) => url.searchParams.has(param));
}

/** Classify a URL by its file extension, ignoring segments. */
export function classifyByUrl(rawUrl: string): Classification | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (isSegmentUrl(rawUrl)) return undefined;
  const ext = extensionOf(url.pathname);
  return ext ? EXTENSION_TABLE[ext] : undefined;
}

/** Classify a network request, preferring the Content-Type header over the URL. */
export function classifyRequest(url: string, contentType?: string): Classification | undefined {
  if (isSegmentUrl(url)) return undefined;
  return classifyByMime(contentType) ?? classifyByUrl(url);
}
