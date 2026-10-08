import type { DownloadProgress } from "@mediaforge/shared-types";
import { ExitCode } from "../exit-codes.ts";
import type { MediaInfo } from "../formats.ts";
import { formatBytes, formatDuration } from "../progress-view.ts";
import { SUPPORTED_SITES_URL } from "../sites.ts";

/** A short "what to try next" for a failed download. */
export function failureHint(kind: ExitCode | undefined, message: string): string {
  switch (kind) {
    case ExitCode.MissingTool:
      return 'yt-dlp or ffmpeg could not be found. Open "Check setup" from the home screen.';
    case ExitCode.UnsupportedSite:
      return `This link is not supported. Check that it points to a video or audio page, and that yt-dlp is up to date. All supported sites: ${SUPPORTED_SITES_URL}`;
    case ExitCode.FileSystem:
      return "Could not write to that folder. Choose another folder or free up disk space.";
    case ExitCode.Network:
      return /\b403\b|forbidden/i.test(message)
        ? "The site refused the download (HTTP 403). Updating yt-dlp usually fixes this."
        : "Check your internet connection, then try again.";
    default:
      return "Try again, or choose a different quality.";
  }
}

/** "3:05" or "1:02:03" from seconds. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Label and value rows describing the media, for the info card. */
export function mediaRows(info: MediaInfo): [string, string][] {
  const rows: [string, string][] = [];
  if (info.title) rows.push(["Title", info.title]);
  const by = info.channel ?? info.uploader;
  if (by) rows.push(["From", by]);
  if (info.duration) rows.push(["Length", formatClock(info.duration)]);
  return rows;
}

/** "12.3 MB of 40.0 MB · 3.2 MB/s · ETA 12s" from whatever is known. */
export function describeProgress(p: DownloadProgress): string {
  return [
    p.totalBytes
      ? `${formatBytes(p.bytesDownloaded)} of ${formatBytes(p.totalBytes)}`
      : formatBytes(p.bytesDownloaded),
    p.speed !== undefined && `${formatBytes(p.speed)}/s`,
    p.etaSec !== undefined && `ETA ${formatDuration(p.etaSec)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export { formatBytes };
