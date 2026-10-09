import { getProfile } from "@mediaforge/media-profiles";
import { Box, Text, useInput } from "ink";
import { useContext, useEffect, useRef, useState } from "react";
import { candidateFor } from "../../../download.ts";
import type { EngineJob } from "../../../engine/index.ts";
import { batchPercent, countJobs } from "../../batch.ts";
import { shorten } from "../../clipboard-hint.ts";
import { Frame } from "../../components/Frame.tsx";
import { visibleWindow } from "../../components/Menu.tsx";
import { ProgressBar } from "../../components/ProgressBar.tsx";
import { Spinner } from "../../components/Spinner.tsx";
import { useTerminalSize } from "../../components/use-terminal-size.ts";
import { useDeps } from "../../deps.ts";
import type { Plan } from "../../flow.ts";
import { NoticeContext } from "../../notice.tsx";
import { COLORS, ICONS, STEP_BAR, STEP_COLORS } from "../../theme.ts";
import { stageLabel } from "../DownloadScreen.tsx";

export interface BatchDownloadScreenProps {
  plans: Plan[];
  /** How many links download at the same time. */
  concurrency: number;
  /** Called once every link has finished, failed or been cancelled; jobs are in plan order. */
  onDone: (jobs: EngineJob[]) => void;
}

/** Short state for a link's row. */
export function rowStatus(job: EngineJob | undefined): string {
  if (!job || job.status === "queued") return "waiting";
  if (job.status === "completed") return "saved";
  if (job.status === "failed") return "failed";
  if (job.status === "cancelled") return "cancelled";
  return stageLabel(job)
    .replace("Downloading", "downloading")
    .replace("Merging video and audio", "merging")
    .replace("Converting", "converting")
    .replace("Finishing", "finishing");
}

function rowLook(job: EngineJob | undefined): { icon: string; color: string } {
  if (!job || job.status === "queued") return { icon: ICONS.off, color: COLORS.muted };
  if (job.status === "completed") return { icon: ICONS.ok, color: COLORS.ok };
  if (job.status === "failed") return { icon: ICONS.error, color: COLORS.error };
  if (job.status === "cancelled") return { icon: ICONS.warn, color: COLORS.warn };
  const active = job.steps?.find((s) => s.state === "active");
  return { icon: ICONS.pointer, color: active ? STEP_COLORS[active.kind] : COLORS.accent };
}

const NAME_WIDTH = 12;
const STATUS_WIDTH = 20;

export function BatchDownloadScreen({ plans, concurrency, onDone }: BatchDownloadScreenProps) {
  const deps = useDeps();
  const { columns, rows } = useTerminalSize();
  const [jobs, setJobs] = useState<(EngineJob | undefined)[]>(() => plans.map(() => undefined));
  const cancelAll = useRef<() => void>(() => {});
  const { clear } = useContext(NoticeContext);
  // A new batch starts clean: an old notice no longer applies.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount
  useEffect(() => clear(), []);

  // The latest callback, so the effect below starts the downloads only once.
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let live = true;
    const index = new Map<string, number>();
    const engine = deps.download.createEngine(
      (update) => {
        const at = index.get(update.id);
        if (!live || at === undefined) return;
        setJobs((all) => all.map((job, i) => (i === at ? update : job)));
      },
      { maxConcurrent: concurrency },
    );
    const ids: string[] = [];
    for (const [at, plan] of plans.entries()) {
      const profile = getProfile(plan.profileId);
      if (!profile) continue;
      // The engine reports a job before submit returns, so register the id on the first update.
      const job = engine.submit(
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
      index.set(job.id, at);
      ids.push(job.id);
      setJobs((all) => all.map((j, i) => (i === at ? (engine.get(job.id) ?? job) : j)));
    }
    cancelAll.current = () => {
      for (const id of ids) engine.cancel(id);
    };
    void Promise.all(ids.map((id) => engine.whenSettled(id))).then((finals) => {
      if (live) done.current(finals.filter((j): j is EngineJob => j !== undefined));
    });
    return () => {
      live = false;
      cancelAll.current();
    };
  }, [deps, plans, concurrency]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) cancelAll.current();
  });

  const width = Math.min(columns, 100) - 4;
  const barWidth = Math.max(10, width - NAME_WIDTH - 6);
  const rowBar = Math.max(8, Math.min(20, Math.floor(width / 5)));
  const titleWidth = Math.max(10, width - 4 - rowBar - 6 - STATUS_WIDTH);
  const counts = countJobs(jobs);
  const maxRows = rows ? Math.max(3, rows - 20) : 10;
  const focus = Math.max(
    0,
    jobs.findIndex(
      (j) => !j || j.status === "queued" || j.status === "downloading" || j.status === "processing",
    ),
  );
  const { start, end } = visibleWindow(focus, plans.length, maxRows);
  const summary = [
    `${counts.done} of ${plans.length} saved`,
    counts.running && `${counts.running} downloading`,
    counts.waiting && `${counts.waiting} waiting`,
    counts.failed && `${counts.failed} failed`,
    counts.cancelled && `${counts.cancelled} cancelled`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Frame
      crumbs={["Home", "Download", "Downloading"]}
      icon={ICONS.download}
      title={`Downloading ${plans.length} links, ${concurrency} at a time`}
      hints={[["Esc", "Cancel all"]]}
      ctrlC="Cancel"
    >
      <Spinner label={summary} />
      <Box marginTop={1}>
        <Text bold color={COLORS.accent}>
          {"Overall".padEnd(NAME_WIDTH)}
        </Text>
        <ProgressBar percent={batchPercent(jobs)} width={barWidth} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        {start > 0 ? (
          <Text color={COLORS.muted}>{`  ${ICONS.warn} ${start} more above`}</Text>
        ) : null}
        {plans.slice(start, end).map((plan, offset) => {
          const job = jobs[start + offset];
          const { icon, color } = rowLook(job);
          const waiting = !job || job.status === "queued";
          const percent =
            job?.status === "completed" ? 100 : (job?.overallPercent ?? job?.progress.percent);
          return (
            <Box key={plan.url}>
              <Text color={color}>{`  ${icon} `}</Text>
              <Text>{shorten(plan.title ?? plan.url, titleWidth).padEnd(titleWidth)} </Text>
              {waiting ? (
                <Text color={COLORS.muted}>{STEP_BAR.empty.repeat(rowBar)} </Text>
              ) : (
                <ProgressBar
                  percent={percent}
                  width={rowBar}
                  color={color}
                  chars={STEP_BAR}
                  bold={false}
                />
              )}
              <Text color={color}>{`  ${rowStatus(job)}`}</Text>
            </Box>
          );
        })}
        {end < plans.length ? (
          <Text color={COLORS.muted}>{`  ${ICONS.download} ${plans.length - end} more below`}</Text>
        ) : null}
      </Box>
    </Frame>
  );
}
