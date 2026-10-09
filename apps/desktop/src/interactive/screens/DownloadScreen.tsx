import { getProfile } from "@mediaforge/media-profiles";
import { Box, Text, useInput } from "ink";
import { useContext, useEffect, useRef, useState } from "react";
import { candidateFor } from "../../download.ts";
import type { EngineJob, Step, StepKind } from "../../engine/index.ts";
import { Card } from "../components/Card.tsx";
import { Frame } from "../components/Frame.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { useTerminalSize } from "../components/use-terminal-size.ts";
import { useDeps } from "../deps.ts";
import type { Plan } from "../flow.ts";
import { describeProgress } from "../hints.ts";
import { NoticeContext } from "../notice.tsx";
import { COLORS, ICONS, STEP_BAR, STEP_COLORS } from "../theme.ts";

export interface DownloadScreenProps {
  plan: Plan;
  onDone: (job: EngineJob) => void;
}

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

/** What the user sees above the bars: the step that is running right now. */
export function stageLabel(job: EngineJob | undefined): string {
  if (!job || job.status === "queued") return "Starting";
  const active = job.steps?.find((s) => s.state === "active");
  if (active) return STEP_ACTIONS[active.kind];
  return job.status === "processing" ? "Finishing" : "Downloading";
}

/** The line under the overall bar: bytes and speed while downloading, the step name otherwise. */
export function activeDetail(job: EngineJob | undefined): string {
  const active = job?.steps?.find((s) => s.state === "active");
  if (active?.progress) return describeProgress(active.progress);
  if (active) return `${STEP_ACTIONS[active.kind]}…`;
  return job && job.status !== "queued" ? describeProgress(job.progress) : " ";
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

/** Width of the name column; the overall bar and the step bars start at the same place. */
const NAME_WIDTH = 12;

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

export function DownloadScreen({ plan, onDone }: DownloadScreenProps) {
  const deps = useDeps();
  const { columns } = useTerminalSize();
  const [job, setJob] = useState<EngineJob>();
  const control = useRef<{ cancel: () => void }>({ cancel: () => {} });
  const { clear } = useContext(NoticeContext);
  // A new download starts clean: an old "cancelled" or "complete" notice no longer applies.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount
  useEffect(() => clear(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the download starts once per mount
  useEffect(() => {
    const profile = getProfile(plan.profileId);
    if (!profile) return;
    let live = true;
    const engine = deps.download.createEngine((update) => {
      if (live) setJob(update);
    });
    const { id } = engine.submit(
      {
        candidate: candidateFor(plan.url, profile.kind),
        profileId: profile.id,
        outputDir: plan.outputDir,
      },
      {
        ...(plan.formatSelector && { formatSelector: plan.formatSelector }),
        ...(plan.steps && { plan: plan.steps }),
      },
    );
    control.current = { cancel: () => void engine.cancel(id) };
    void engine.whenSettled(id)?.then((final) => live && onDone(final));
    return () => {
      live = false;
      engine.cancel(id);
    };
  }, []);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) control.current.cancel();
  });

  // Frame padding, name column and the percent after each bar.
  const barWidth = Math.max(10, Math.min(columns, 100) - 4 - NAME_WIDTH - 6);
  const steps = job?.steps ?? [];
  // A single step is the whole download, so a second bar would only repeat the first.
  const showSteps = steps.length > 1;

  return (
    <Frame
      crumbs={["Home", "Download", "Downloading"]}
      icon={ICONS.download}
      title="Downloading"
      hints={[["Esc", "Cancel download"]]}
      ctrlC="Cancel"
    >
      <Card
        rows={[
          ["Title", plan.title ?? plan.url],
          ["Saving to", plan.outputDir],
        ]}
      />
      <Spinner label={stageLabel(job)} />
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text bold color={COLORS.accent}>
            {"Overall".padEnd(NAME_WIDTH)}
          </Text>
          <ProgressBar percent={job?.overallPercent ?? job?.progress.percent} width={barWidth} />
        </Box>
        <Text color={COLORS.muted}>
          {" ".repeat(NAME_WIDTH)}
          {activeDetail(job)}
        </Text>
      </Box>
      {showSteps ? (
        <Box marginTop={1} flexDirection="column">
          {stepKeys(steps).map(([key, step]) => (
            <StepRow key={key} step={step} width={barWidth} />
          ))}
        </Box>
      ) : null}
    </Frame>
  );
}
