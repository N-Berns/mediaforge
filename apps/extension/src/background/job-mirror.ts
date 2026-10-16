import type { HostToExtensionMessage } from "@mediaforge/shared-protocol";

export interface MirrorJob {
  id: string;
  title?: string;
  /** What this job is of its page: a format such as "1080p mp4", or "en subtitles". */
  label?: string;
  status: string;
  percent?: number;
  speed?: number;
  outputPath?: string;
  error?: string;
  cancelled?: boolean;
  updatedAt: number;
}

export type JobMirrorApi = ReturnType<typeof createJobMirror>;

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
/** What "Clear finished" hides: a paused job is not running, but late frames must still reach it. */
const CLEARABLE = new Set([...TERMINAL, "paused"]);
/** A job that is queued or running; a cleared row comes back when its job is one again. */
const RUNNING = new Set(["queued", "downloading", "processing"]);

/** Fields a viewer can see; `updatedAt` alone never counts as a change. */
const VISIBLE = ["title", "label", "status", "percent", "speed", "outputPath", "error"] as const;

const sameRow = (a: MirrorJob | undefined, b: MirrorJob): boolean =>
  a !== undefined && VISIBLE.every((key) => a[key] === b[key]);

// Timestamps are epoch milliseconds, both from the core and from Date.now() here.
export function createJobMirror() {
  const jobs = new Map<string, MirrorJob>();
  const titles = new Map<string, string>();
  const labels = new Map<string, string>();
  /** Finished jobs the user cleared; the core's snapshots must not bring them back. */
  const cleared = new Set<string>();

  /** Applies a patch and reports whether the visible row changed. */
  const merge = (id: string, patch: Partial<MirrorJob>): boolean => {
    if (cleared.has(id)) {
      // Cleared while paused, then resumed: show it again.
      if (!patch.status || !RUNNING.has(patch.status)) return false;
      cleared.delete(id);
    }
    const previous = jobs.get(id);
    const title = patch.title ?? titles.get(id) ?? previous?.title;
    const label = labels.get(id) ?? previous?.label;
    const next: MirrorJob = {
      ...(previous ?? { id, status: "queued", updatedAt: 0 }),
      ...patch,
      id,
      ...(title && { title }),
      ...(label && { label }),
      updatedAt: Date.now(),
    };
    if (sameRow(previous, next)) return false;
    jobs.set(id, next);
    return true;
  };

  return {
    noteLabel(jobId: string, label: string): void {
      labels.set(jobId, label);
      const existing = jobs.get(jobId);
      if (existing) jobs.set(jobId, { ...existing, label });
    },
    noteTitle(jobId: string, title: string): void {
      titles.set(jobId, title);
      const existing = jobs.get(jobId);
      if (existing) jobs.set(jobId, { ...existing, title });
    },
    list(): MirrorJob[] {
      return [...jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    /** Hides every finished job from the list; returns whether any row went away. */
    clearFinished(): boolean {
      let removed = false;
      for (const [id, job] of jobs) {
        if (!CLEARABLE.has(job.status)) continue;
        cleared.add(id);
        jobs.delete(id);
        removed = true;
      }
      return removed;
    },
    apply(message: HostToExtensionMessage): boolean {
      switch (message.type) {
        case "jobs.snapshot": {
          const next = new Map<string, MirrorJob>();
          for (const job of message.payload.jobs) {
            if (cleared.has(job.id)) {
              if (!RUNNING.has(job.status)) continue;
              cleared.delete(job.id);
            }
            const title = job.request.candidate.pageTitle ?? job.request.candidate.url;
            next.set(job.id, {
              id: job.id,
              title,
              ...(labels.get(job.id) && { label: labels.get(job.id) as string }),
              status: job.status,
              ...(job.progress.percent !== undefined && { percent: job.progress.percent }),
              ...(job.progress.speed !== undefined && { speed: job.progress.speed }),
              ...(job.outputPath && { outputPath: job.outputPath }),
              ...(job.error && { error: job.error }),
              updatedAt: job.updatedAt,
            });
          }
          for (const id of [...titles.keys()]) if (!next.has(id)) titles.delete(id);
          for (const id of [...labels.keys()]) if (!next.has(id)) labels.delete(id);
          const changed =
            next.size !== jobs.size || [...next].some(([id, row]) => !sameRow(jobs.get(id), row));
          if (!changed) return false;
          jobs.clear();
          for (const [id, row] of next) jobs.set(id, row);
          return true;
        }
        case "download.progress": {
          const { jobId, status, progress } = message.payload;
          // A late frame must not pull a finished job back to "downloading".
          const current = jobs.get(jobId);
          // A resume of a failed job reopens it with a queued frame.
          if (current && TERMINAL.has(current.status)) {
            if (!(current.status === "failed" && status === "queued")) return false;
          }
          return merge(jobId, {
            status,
            ...(progress.percent !== undefined && { percent: progress.percent }),
            ...(progress.speed !== undefined && { speed: progress.speed }),
          });
        }
        case "download.completed":
          return merge(message.payload.jobId, {
            status: "completed",
            percent: 100,
            outputPath: message.payload.outputPath,
          });
        case "download.failed":
          return merge(message.payload.jobId, {
            status: message.payload.cancelled ? "cancelled" : "failed",
            error: message.payload.error,
            ...(message.payload.cancelled && { cancelled: true }),
          });
        case "download.paused": {
          const { jobId, progress } = message.payload;
          return merge(jobId, {
            status: "paused",
            ...(progress?.percent !== undefined && { percent: progress.percent }),
            speed: undefined,
          });
        }
        default:
          return false;
      }
    },
  };
}
