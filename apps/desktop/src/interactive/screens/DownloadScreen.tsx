import { getProfile } from "@mediaforge/media-profiles";
import { useInput } from "ink";
import { useContext, useEffect, useRef, useState } from "react";
import { startJob } from "../../core/job-watch.ts";
import { candidateFor } from "../../download.ts";
import type { EngineJob } from "../../engine/index.ts";
import { Card } from "../components/Card.tsx";
import { Frame } from "../components/Frame.tsx";
import { barWidthFor, JobProgress } from "../components/JobProgress.tsx";
import { useTerminalSize } from "../components/use-terminal-size.ts";
import { useDeps } from "../deps.ts";
import type { Plan } from "../flow.ts";
import { NoticeContext } from "../notice.tsx";
import { useSpeedUnit } from "../speed-unit.ts";
import { startPayload } from "../submit.ts";
import { ICONS } from "../theme.ts";

export interface DownloadScreenProps {
  plan: Plan;
  onDone: (job: EngineJob) => void;
}

export function DownloadScreen({ plan, onDone }: DownloadScreenProps) {
  const deps = useDeps();
  const { columns } = useTerminalSize();
  const speedUnit = useSpeedUnit();
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
    let close = () => {};
    let cancelled = false;
    // Esc before the core answers must still stop the download.
    control.current = {
      cancel: () => {
        cancelled = true;
      },
    };
    const finish = (status: "failed" | "cancelled", error?: unknown) => {
      if (!live) return;
      const now = Date.now();
      onDone({
        id: "",
        request: { candidate: candidateFor(plan.url, profile.kind), profileId: profile.id },
        status,
        progress: { bytesDownloaded: 0 },
        ...(error !== undefined && {
          error: error instanceof Error ? error.message : String(error),
        }),
        createdAt: now,
        updatedAt: now,
      });
    };
    const fail = (error: unknown) => finish("failed", error);
    void (async () => {
      try {
        const client = await deps.download.core();
        close = () => client.close();
        if (!live) return close();
        if (cancelled) {
          close();
          return finish("cancelled");
        }
        const watched = await startJob(client, startPayload(plan, "menu"), (update) => {
          if (live) setJob(update);
        });
        control.current = { cancel: () => void watched.cancel() };
        if (cancelled) void watched.cancel();
        watched.settled.then((final) => live && onDone(final), fail);
      } catch (error) {
        fail(error);
      }
    })();
    return () => {
      // Leaving the screen does not stop the download: it keeps running in the core.
      live = false;
      close();
    };
  }, []);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) control.current.cancel();
  });

  // Frame padding, name column and the percent after each bar.
  const barWidth = barWidthFor(Math.min(columns, 100) - 4);

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
      <JobProgress job={job} unit={speedUnit} barWidth={barWidth} />
    </Frame>
  );
}
