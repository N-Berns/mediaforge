import { formatBytes, formatRate, type SpeedUnit } from "@mediaforge/shared-types";
import type { EngineJob } from "./engine/index.ts";

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** One-line description of a job's current state. */
export function formatProgressLine(job: EngineJob, unit: SpeedUnit = "bytes"): string {
  if (job.status === "downloading") {
    const { percent, bytesDownloaded, speed, etaSec } = job.progress;
    return [
      "downloading",
      percent !== undefined ? `${percent.toFixed(1)}%` : formatBytes(bytesDownloaded),
      speed !== undefined && formatRate(speed, unit),
      etaSec !== undefined && `ETA ${formatDuration(etaSec)}`,
    ]
      .filter(Boolean)
      .join("  ");
  }
  return job.status;
}

export interface ProgressViewOptions {
  write: (text: string) => void;
  isTTY: boolean;
  quiet: boolean;
  /** Bytes or bits per second. Default bytes. */
  speedUnit?: SpeedUnit;
}

const CLEAR_LINE = "\r\x1b[K";
const ACTIVE = new Set(["queued", "downloading", "processing"]);

/**
 * Shows job progress on stderr: one updating line on a terminal, one line per
 * status change otherwise (no control codes in logs or pipes).
 */
export function createProgressView({
  write,
  isTTY,
  quiet,
  speedUnit = "bytes",
}: ProgressViewOptions) {
  let lastStatus: string | undefined;
  let dirty = false;

  return {
    update(job: EngineJob): void {
      if (quiet || !ACTIVE.has(job.status)) return;
      if (isTTY) {
        write(`${CLEAR_LINE}${formatProgressLine(job, speedUnit)}`);
        dirty = true;
      } else if (job.status !== lastStatus) {
        write(`${formatProgressLine(job, speedUnit)}\n`);
      }
      lastStatus = job.status;
    },
    /** Remove the live line so the final result prints cleanly. */
    finish(): void {
      if (isTTY && dirty) write(CLEAR_LINE);
      dirty = false;
    },
  };
}
