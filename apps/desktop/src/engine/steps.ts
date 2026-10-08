import type { DownloadProgress } from "@mediaforge/shared-types";
import type { PostprocessEvent, StreamInfo } from "./progress.ts";

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

const POST_KINDS: ReadonlySet<StepKind> = new Set(["merge", "convert"]);
export const isPostStep = (kind: StepKind) => POST_KINDS.has(kind);

/** Maps yt-dlp post-processor names to steps. Others (moving files) are not shown. */
const POSTPROCESSOR_KINDS: Record<string, StepKind> = {
  Merger: "merge",
  ExtractAudio: "convert",
  VideoConvertor: "convert",
  VideoRemuxer: "convert",
};

/** Share of the overall bar that merging and converting take together. */
const POST_SHARE = 0.1;

const streamKind = (stream: StreamInfo): StepKind =>
  stream.video && stream.audio ? "download" : stream.video ? "video" : "audio";

/**
 * Overall progress across steps. Downloads count by size (their own total when known, else the
 * expected size, else the average of the others); merging and converting share a small last slice.
 */
export function overallPercent(steps: readonly Step[]): number | undefined {
  if (steps.length === 0) return undefined;
  const value = (s: Step) =>
    s.state === "done" ? 100 : s.state === "active" ? (s.percent ?? 0) : 0;
  const downloads = steps.filter((s) => !isPostStep(s.kind));
  const posts = steps.filter((s) => isPostStep(s.kind));

  const sizes = downloads.map((s) => s.progress?.totalBytes ?? s.expectedBytes);
  const known = sizes.filter((n): n is number => n !== undefined && n > 0);
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const weights = sizes.map((n) => (n && n > 0 ? n : fallback));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const downloadPart = downloads.length
    ? downloads.reduce((sum, s, i) => sum + value(s) * (weights[i] ?? 0), 0) / totalWeight
    : 100;
  const postPart = posts.length ? posts.reduce((sum, s) => sum + value(s), 0) / posts.length : 100;

  if (!posts.length) return downloadPart;
  if (!downloads.length) return postPart;
  return downloadPart * (1 - POST_SHARE) + postPart * POST_SHARE;
}

/** Follows yt-dlp's output and keeps the list of steps up to date. */
export class StepTracker {
  readonly steps: Step[];
  #streamId: string | undefined;
  #postDuration: number | undefined;
  #overall = 0;

  constructor(planned: readonly PlannedStep[] = []) {
    this.steps = planned.map((p) => ({
      kind: p.kind,
      state: "pending",
      ...(p.bytes !== undefined && { expectedBytes: p.bytes }),
    }));
  }

  get active(): Step | undefined {
    return this.steps.find((s) => s.state === "active");
  }

  /** Overall percent; never goes backwards, even when a later stream turns out bigger. */
  get overall(): number {
    this.#overall = Math.max(this.#overall, overallPercent(this.steps) ?? 0);
    return this.#overall;
  }

  #completeActive(): void {
    const current = this.active;
    if (current) {
      current.state = "done";
      current.percent = 100;
    }
  }

  /** The planned step of this kind still waiting, or a new one placed before merging/converting. */
  #take(kind: StepKind): Step {
    const planned = this.steps.find((s) => s.state === "pending" && s.kind === kind);
    if (planned) return planned;
    const step: Step = { kind, state: "pending" };
    const firstPost = this.steps.findIndex((s) => s.state === "pending" && isPostStep(s.kind));
    const at = isPostStep(kind) || firstPost < 0 ? this.steps.length : firstPost;
    this.steps.splice(at, 0, step);
    return step;
  }

  onDownload(progress: DownloadProgress, stream: StreamInfo | undefined): void {
    const id = stream?.id ?? "";
    let step = this.active;
    if (!step || isPostStep(step.kind) || id !== this.#streamId) {
      this.#completeActive();
      step = this.#take(stream ? streamKind(stream) : "download");
      step.state = "active";
      this.#streamId = id;
    }
    step.progress = progress;
    step.percent = progress.percent;
  }

  /** Returns true when the event started or finished a visible step. */
  onPostprocess(event: PostprocessEvent): boolean {
    const kind = event.name ? POSTPROCESSOR_KINDS[event.name] : undefined;
    if (!kind) return false;
    if (event.status === "started") {
      this.#completeActive();
      const step = this.#take(kind);
      step.state = "active";
      step.percent = 0;
      this.#postDuration = event.duration;
      this.#streamId = undefined;
    } else {
      const step = this.active;
      if (step && isPostStep(step.kind)) {
        step.state = "done";
        step.percent = 100;
      }
    }
    return true;
  }

  /** ffmpeg reported how far into the media it is. */
  onFfmpegTime(seconds: number): void {
    const step = this.active;
    if (!step || !isPostStep(step.kind) || !this.#postDuration) return;
    // Stay below 100 until yt-dlp says the step has finished.
    step.percent = Math.min(99, (seconds / this.#postDuration) * 100);
  }

  /** The file is saved: everything that ran is done, and steps that never ran disappear. */
  complete(): void {
    this.#completeActive();
    for (let i = this.steps.length - 1; i >= 0; i--) {
      if (this.steps[i]?.state === "pending") this.steps.splice(i, 1);
    }
  }

  snapshot(): Step[] {
    return this.steps.map((s) => ({ ...s, ...(s.progress && { progress: { ...s.progress } }) }));
  }
}
