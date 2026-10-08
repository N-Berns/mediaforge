import type { EngineJob } from "./engine/index.ts";

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}

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
export function formatProgressLine(job: EngineJob): string {
  if (job.status === "downloading") {
    const { percent, bytesDownloaded, speed, etaSec } = job.progress;
    return [
      "downloading",
      percent !== undefined ? `${percent.toFixed(1)}%` : formatBytes(bytesDownloaded),
      speed !== undefined && `${formatBytes(speed)}/s`,
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
}

const CLEAR_LINE = "\r\x1b[K";
const ACTIVE = new Set(["queued", "downloading", "processing"]);

/**
 * Shows job progress on stderr: one updating line on a terminal, one line per
 * status change otherwise (no control codes in logs or pipes).
 */
export function createProgressView({ write, isTTY, quiet }: ProgressViewOptions) {
  let lastStatus: string | undefined;
  let dirty = false;

  return {
    update(job: EngineJob): void {
      if (quiet || !ACTIVE.has(job.status)) return;
      if (isTTY) {
        write(`${CLEAR_LINE}${formatProgressLine(job)}`);
        dirty = true;
      } else if (job.status !== lastStatus) {
        write(`${formatProgressLine(job)}\n`);
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
