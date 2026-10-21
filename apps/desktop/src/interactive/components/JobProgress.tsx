import type {
  DownloadJob,
  DownloadProgress,
  SpeedUnit,
  Step,
  StepKind,
} from "@mediaforge/shared-types";
import { Box, Text } from "ink";
import { describeProgress } from "../hints.ts";
import { COLORS, ICONS, STEP_BAR, STEP_COLORS } from "../theme.ts";
import { ProgressBar } from "./ProgressBar.tsx";
import { Spinner } from "./Spinner.tsx";

/** The parts of a job this block reads; an engine job and a manager row both fit. */
export type ProgressJob = Pick<DownloadJob, "status" | "progress" | "steps" | "overallPercent">;

const STEP_NAMES: Record<StepKind, string> = {
  download: "Download",
  video: "Video",
  audio: "Audio",
  merge: "Merge",
  convert: "Convert",
};

const STEP_ACTIONS: Record<StepKind, string> = {
  download: "Downloading",
  video: "Downloading video",
  audio: "Downloading audio",
  merge: "Merging video and audio",
  convert: "Converting",
};

/** Width of the name column; the overall bar and the step bars start at the same place. */
export const NAME_WIDTH = 12;
/** The percent after each bar, with its space. */
const PERCENT_WIDTH = 6;

/** Bar width for a block that has `available` columns: the name column and percent come off. */
export function barWidthFor(available: number): number {
  return Math.max(10, available - NAME_WIDTH - PERCENT_WIDTH);
}

/** What the user sees above the bars: the step that is running right now. */
export function stageLabel(job: ProgressJob | undefined): string {
  if (!job || job.status === "queued") return "Starting";
  const active = job.steps?.find((s) => s.state === "active");
  if (active) return STEP_ACTIONS[active.kind];
  return job.status === "processing" ? "Finishing" : "Downloading";
}

/** The line under the overall bar: bytes and speed while downloading, the step name otherwise. */
export function activeDetail(job: ProgressJob | undefined, unit: SpeedUnit = "bytes"): string {
  const active = job?.steps?.find((s) => s.state === "active");
  if (active?.progress) return describeProgress(active.progress, unit);
  if (active) return `${STEP_ACTIONS[active.kind]}…`;
  return job && job.status !== "queued" ? describeProgress(job.progress, unit) : " ";
}

/** A paused job moves no bytes: keep the amount done, swap speed and ETA for "paused". */
function pausedDetail(job: ProgressJob, unit: SpeedUnit): string {
  const active = job.steps?.find((s) => s.state === "active");
  const source: DownloadProgress = active?.progress ?? job.progress;
  const { speed: _speed, etaSec: _eta, ...still } = source;
  return `${describeProgress(still, unit)} · paused`;
}

/** Stable keys: the kind, plus a count when a kind repeats ("video", "video-2"). */
function stepKeys(steps: readonly Step[]): [string, Step][] {
  const seen = new Map<StepKind, number>();
  return steps.map((step) => {
    const n = (seen.get(step.kind) ?? 0) + 1;
    seen.set(step.kind, n);
    return [n === 1 ? step.kind : `${step.kind}-${n}`, step];
  });
}

function StepRow({ step, width }: { step: Step; width: number }) {
  const done = step.state === "done";
  const waiting = step.state === "pending";
  const color = done ? COLORS.ok : waiting ? COLORS.muted : STEP_COLORS[step.kind];
  const icon = done ? ICONS.ok : waiting ? ICONS.off : ICONS.pointer;
  return (
    <Box>
      <Text color={color}>{`  ${icon} ${STEP_NAMES[step.kind]}`.padEnd(NAME_WIDTH)}</Text>
      {waiting ? (
        <Text color={COLORS.muted}>
          {STEP_BAR.empty.repeat(width)}
          {"  waiting"}
        </Text>
      ) : (
        <ProgressBar
          percent={done ? 100 : step.percent}
          width={width}
          color={color}
          chars={STEP_BAR}
          bold={false}
        />
      )}
    </Box>
  );
}

/** A single step is the whole download, so a second bar would only repeat the first. */
export const hasStepRows = (job: ProgressJob | undefined): boolean => (job?.steps?.length ?? 0) > 1;

/** Lines `JobProgress` takes: stage, overall bar and detail, then the step rows if shown. */
export function progressLines(job: ProgressJob | undefined, compact = false): number {
  const gap = compact ? 0 : 1;
  const base = 1 + gap + 2;
  return hasStepRows(job) && job?.steps ? base + gap + job.steps.length : base;
}

export interface JobProgressProps {
  job: ProgressJob | undefined;
  unit: SpeedUnit;
  /** Width of each bar; see `barWidthFor`. */
  barWidth: number;
  /** Frozen: the bar stays, speed and ETA give way to "paused". */
  paused?: boolean;
  /** Without the blank lines between stage, overall bar and step rows. */
  compact?: boolean;
  /** Leave the step rows out (no room for them). */
  hideSteps?: boolean;
}

/** Stage label, overall bar with its detail line, and per-step bars: shared by every screen. */
export function JobProgress({
  job,
  unit,
  barWidth,
  paused = false,
  compact = false,
  hideSteps = false,
}: JobProgressProps) {
  const gap = compact ? 0 : 1;
  const steps = job?.steps ?? [];
  const detail = paused && job ? pausedDetail(job, unit) : activeDetail(job, unit);
  return (
    <>
      {paused ? <Text color={COLORS.muted}>Paused</Text> : <Spinner label={stageLabel(job)} />}
      <Box marginTop={gap} flexDirection="column">
        <Box>
          <Text bold color={COLORS.accent}>
            {"Overall".padEnd(NAME_WIDTH)}
          </Text>
          <ProgressBar percent={job?.overallPercent ?? job?.progress.percent} width={barWidth} />
        </Box>
        <Text color={COLORS.muted}>
          {" ".repeat(NAME_WIDTH)}
          {detail}
        </Text>
      </Box>
      {steps.length > 1 && !hideSteps ? (
        <Box marginTop={gap} flexDirection="column">
          {stepKeys(steps).map(([key, step]) => (
            <StepRow key={key} step={step} width={barWidth} />
          ))}
        </Box>
      ) : null}
    </>
  );
}
