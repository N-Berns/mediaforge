import type { HostToExtensionMessage } from "@mediaforge/shared-protocol";

export interface MirrorJob {
  id: string;
  title?: string;
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

/** Fields a viewer can see; `updatedAt` alone never counts as a change. */
const VISIBLE = ["title", "status", "percent", "speed", "outputPath", "error"] as const;

const sameRow = (a: MirrorJob | undefined, b: MirrorJob): boolean =>
  a !== undefined && VISIBLE.every((key) => a[key] === b[key]);

// Timestamps are epoch milliseconds, both from the core and from Date.now() here.
export function createJobMirror() {
  const jobs = new Map<string, MirrorJob>();
  const titles = new Map<string, string>();

  /** Applies a patch and reports whether the visible row changed. */
  const merge = (id: string, patch: Partial<MirrorJob>): boolean => {
    const previous = jobs.get(id);
    const title = patch.title ?? titles.get(id) ?? previous?.title;
    const next: MirrorJob = {
      ...(previous ?? { id, status: "queued", updatedAt: 0 }),
      ...patch,
      id,
      ...(title && { title }),
      updatedAt: Date.now(),
    };
    if (sameRow(previous, next)) return false;
    jobs.set(id, next);
    return true;
  };

  return {
    noteTitle(jobId: string, title: string): void {
      titles.set(jobId, title);
      const existing = jobs.get(jobId);
      if (existing) jobs.set(jobId, { ...existing, title });
    },
    list(): MirrorJob[] {
      return [...jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    apply(message: HostToExtensionMessage): boolean {
      switch (message.type) {
        case "jobs.snapshot": {
          const next = new Map<string, MirrorJob>();
          for (const job of message.payload.jobs) {
            const title = job.request.candidate.pageTitle ?? job.request.candidate.url;
            next.set(job.id, {
              id: job.id,
              title,
              status: job.status,
              ...(job.progress.percent !== undefined && { percent: job.progress.percent }),
              ...(job.progress.speed !== undefined && { speed: job.progress.speed }),
              ...(job.outputPath && { outputPath: job.outputPath }),
              ...(job.error && { error: job.error }),
              updatedAt: job.updatedAt,
            });
          }
          for (const id of [...titles.keys()]) if (!next.has(id)) titles.delete(id);
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
          if (current && TERMINAL.has(current.status)) return false;
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
        default:
          return false;
      }
    },
  };
}
