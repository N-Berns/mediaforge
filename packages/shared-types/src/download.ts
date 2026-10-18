import type { MediaCandidate } from "./media.ts";
import type { Step } from "./steps.ts";
import type { LimitPreset } from "./units.ts";

/** A subtitle track to save on its own, instead of the media itself. */
export interface SubtitleRequest {
  /** Language code as listed by the probe, e.g. "en" or "pt-BR". */
  lang: string;
  /** True for a machine-generated track. */
  auto: boolean;
  format: "srt" | "vtt";
}

export interface DownloadRequest {
  candidate: MediaCandidate;
  /** Explicit variant choice; when omitted, the profile picks one. */
  variantId?: string;
  /** With a silent `variantId`: save the picture alone instead of adding the best audio. */
  videoOnly?: boolean;
  profileId: string;
  outputDir?: string;
  filename?: string;
  /** When set, only this subtitle track is saved. */
  subtitle?: SubtitleRequest;
}

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "processing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** What a download saves: picture and sound, picture only, sound only, or a subtitle file. */
export type ContentKind = "video-audio" | "video" | "audio" | "subtitles";

/** Where a download was started. */
export type JobOrigin = "extension" | "manager" | "menu" | "cli";

/** Says the last core session ended with downloads still running, which are now paused. */
export interface Notice {
  /** "unexpected": no clean exit (crash, kill, power loss). "restarted": clean exit, e.g. an update. */
  reason: "unexpected" | "restarted";
  pausedCount: number;
  jobIds: string[];
}

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes?: number;
  /** Bytes per second. */
  speed?: number;
  /** Seconds remaining. */
  etaSec?: number;
  /** 0–100. */
  percent?: number;
}

export interface DownloadJob {
  id: string;
  request: DownloadRequest;
  status: DownloadStatus;
  progress: DownloadProgress;
  outputPath?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  origin?: JobOrigin;
  /** When the job last started downloading. */
  lastTryAt?: number;
  /** Final size, or the expected size while running. */
  sizeBytes?: number;
  /** Average speed of the finished download, in bytes per second. */
  avgSpeed?: number;
  /** Download, merge and convert steps, in order. */
  steps?: Step[];
  /** 0 to 100 across all steps. */
  overallPercent?: number;
  /** The CLI exit code matching a failure. */
  errorKind?: number;
  /** This job's own speed cap, outside the global split. */
  limitOverride?: LimitPreset;
  /** What the job saves. Missing on rows from before it was recorded. */
  kind?: ContentKind;
}
