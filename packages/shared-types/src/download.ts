import type { MediaCandidate } from "./media.ts";

export interface DownloadRequest {
  candidate: MediaCandidate;
  /** Explicit variant choice; when omitted, the profile picks one. */
  variantId?: string;
  profileId: string;
  outputDir?: string;
  filename?: string;
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
