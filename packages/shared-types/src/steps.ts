import type { DownloadProgress } from "./download.ts";

/**
 * One part of a download:
 * - "download": a single file that already has picture and sound
 * - "video" / "audio": separate streams that are merged afterwards (or a stream on its own)
 * - "merge": ffmpeg joining video and audio
 * - "convert": ffmpeg converting (audio extraction, re-encoding)
 */
export type StepKind = "download" | "video" | "audio" | "merge" | "convert";

export type StepState = "pending" | "active" | "done";

export interface Step {
  kind: StepKind;
  state: StepState;
  /** 0 to 100; unknown while a size or length is not reported yet. */
  percent?: number;
  /** Bytes, speed and ETA, for download steps. */
  progress?: DownloadProgress;
  /** Expected size in bytes, from the format list, used to weigh the overall bar. */
  expectedBytes?: number;
}

/** A step known before the download starts, from the chosen format. */
export interface PlannedStep {
  kind: StepKind;
  bytes?: number;
}
