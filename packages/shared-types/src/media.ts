export type MediaKind = "video" | "audio";

/** How the media is delivered: a single file, or a segmented manifest. */
export type StreamType = "progressive" | "hls" | "dash";

/** Where the extension found the candidate. */
export type DetectionSource = "dom" | "network" | "manifest";

/** One selectable quality/format of a candidate. */
export interface MediaVariant {
  id: string;
  /** Human-readable label, e.g. "1080p", "128 kbps". */
  label: string;
  width?: number;
  height?: number;
  /** Bits per second. */
  bitrate?: number;
  codecs?: string;
  /** File extension / container, e.g. "mp4", "webm", "m4a". */
  container?: string;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Direct URL for this variant, when it differs from the candidate URL. */
  url?: string;
}

/** A piece of media detected on a page that the user could download. */
export interface MediaCandidate {
  id: string;
  pageUrl: string;
  pageTitle?: string;
  url: string;
  kind: MediaKind;
  streamType: StreamType;
  source: DetectionSource;
  mime?: string;
  durationSec?: number;
  thumbnail?: string;
  variants: MediaVariant[];
  /** Epoch milliseconds. */
  detectedAt: number;
}
