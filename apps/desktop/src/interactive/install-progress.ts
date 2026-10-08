import { type InstallProgress, ToolInstallError } from "@mediaforge/binary-resolver";
import { formatBytes } from "../progress-view.ts";
import { PHASE_LABELS } from "../tool-runtime.ts";

/** Share of the download done, or undefined when the size is unknown or it is another phase. */
export function installPercent(progress: InstallProgress): number | undefined {
  return progress.phase === "downloading" && progress.total
    ? ((progress.received ?? 0) / progress.total) * 100
    : undefined;
}

/** One line for the screen: "ffmpeg: downloading 1.0 MB of 2.0 MB". */
export function describeInstallProgress(progress: InstallProgress): string {
  if (progress.phase !== "downloading" || !progress.received) {
    return `${progress.tool}: ${PHASE_LABELS[progress.phase]}`;
  }
  const total = progress.total ? ` of ${formatBytes(progress.total)}` : "";
  return `${progress.tool}: downloading ${formatBytes(progress.received)}${total}`;
}

/** The message and what to do about it, in one sentence for the screen. */
export function describeInstallFailure(error: unknown): string {
  if (error instanceof ToolInstallError) return `${error.message} ${error.hint}`;
  return error instanceof Error ? error.message : String(error);
}
