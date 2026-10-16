import type { DownloadJob, DownloadStatus } from "@mediaforge/shared-types";

export type Action = "pause" | "resume" | "cancel" | "remove" | "trash" | "limit" | "open";

/** How long a result stays in the status line. */
export const STATUS_MS = 5000;

const RUNNING: DownloadStatus[] = ["queued", "downloading", "processing"];

/** Which rows each action fits. Mirrors what the core accepts, so skips are known up front. */
export function appliesTo(action: Action, job: DownloadJob): boolean {
  switch (action) {
    case "pause":
      return RUNNING.includes(job.status);
    case "resume":
      return job.status === "paused" || job.status === "failed";
    case "cancel":
      return RUNNING.includes(job.status) || job.status === "paused";
    case "remove":
    case "trash":
      return true;
    case "limit":
      return job.status !== "completed" && job.status !== "cancelled";
    case "open":
      return job.status === "completed";
  }
}

/** Ticked visible rows, else the cursor row. */
export function targets(
  visible: readonly DownloadJob[],
  ticks: ReadonlySet<string>,
  cursorId?: string,
): DownloadJob[] {
  const ticked = visible.filter((job) => ticks.has(job.id));
  if (ticked.length > 0) return ticked;
  const cursor = visible.find((job) => job.id === cursorId);
  return cursor ? [cursor] : [];
}

export interface Split {
  ids: string[];
  skipped: number;
}

export function split(action: Action, jobs: readonly DownloadJob[]): Split {
  const ids = jobs.filter((job) => appliesTo(action, job)).map((job) => job.id);
  return { ids, skipped: jobs.length - ids.length };
}

const downloads = (n: number) => `${n} download${n === 1 ? "" : "s"}`;

export function confirmText(
  action: "cancel" | "remove" | "trash" | "clear",
  jobs: readonly DownloadJob[],
): string | undefined {
  const n = jobs.length;
  switch (action) {
    case "cancel":
      return `Cancel ${downloads(n)}? Partial files are deleted. y/N`;
    case "remove": {
      const running = jobs.filter((job) => RUNNING.includes(job.status)).length;
      if (running === 0) return undefined;
      const verb = running === 1 ? "is" : "are";
      return `Remove ${downloads(n)}? ${running} ${verb} still running and will be cancelled. y/N`;
    }
    case "trash":
      return `Move the files of ${downloads(n)} to the trash? y/N`;
    case "clear":
      return `Clear ${n} finished download${n === 1 ? "" : "s"} from the list? Files stay on disk. y/N`;
  }
}

export function tooLargeText(count: number): string {
  const verb = count === 1 ? "is" : "are";
  return `${downloads(count)} ${verb} too large for the Recycle Bin and will be deleted permanently. Delete? y/N`;
}

const WORDS: Record<Action | "clear", { done: string; verb: string }> = {
  pause: { done: "Paused", verb: "pause" },
  resume: { done: "Resumed", verb: "resume" },
  cancel: { done: "Cancelled", verb: "cancel" },
  remove: { done: "Removed", verb: "remove" },
  trash: { done: "Moved to the trash", verb: "move to the trash" },
  limit: { done: "Limit set", verb: "limit" },
  open: { done: "Opened", verb: "open" },
  clear: { done: "Cleared", verb: "clear" },
};

/** The status line after an action: `Paused 2 · 1 skipped`, `… · 1 failed: <first message>`. */
export function resultText(
  action: Action | "clear",
  done: number,
  skipped: number,
  failed: readonly { message: string }[],
): string {
  const words = WORDS[action];
  if (done === 0 && failed.length === 0) return `Nothing to ${words.verb}.`;
  return [
    `${words.done} ${done}`,
    ...(skipped > 0 ? [`${skipped} skipped`] : []),
    ...(failed.length > 0 ? [`${failed.length} failed: ${failed[0]?.message}`] : []),
  ].join(" · ");
}
