import type { MediaCandidate } from "./media.ts";

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
  | "completed"
  | "failed"
  | "cancelled";

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
}
