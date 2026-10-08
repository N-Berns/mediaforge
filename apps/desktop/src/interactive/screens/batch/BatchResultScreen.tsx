import { basename } from "node:path";
import { Box, Text } from "ink";
import type { EngineJob } from "../../../engine/index.ts";
import { countJobs } from "../../batch.ts";
import { shorten } from "../../clipboard-hint.ts";
import { Frame } from "../../components/Frame.tsx";
import { Menu, type MenuItem, visibleWindow } from "../../components/Menu.tsx";
import { useTerminalSize } from "../../components/use-terminal-size.ts";
import type { Plan } from "../../flow.ts";
import { failureHint } from "../../hints.ts";
import { COLORS, ICONS } from "../../theme.ts";

export type BatchResultAction = "retry" | "open" | "again" | "home" | "quit";

export interface BatchResultScreenProps {
  plans: Plan[];
  /** Final jobs, in the same order as `plans`. */
  jobs: EngineJob[];
  onAction: (action: BatchResultAction) => void;
}

/** What happened to every link: saved files first, then failures with the reason and what to try. */
export function BatchResultScreen({ plans, jobs, onAction }: BatchResultScreenProps) {
  const { columns, rows } = useTerminalSize();
  const counts = countJobs(jobs);
  const width = Math.min(columns, 100) - 8;
  const unfinished = counts.failed + counts.cancelled;
  const allGood = unfinished === 0;

  // Failures first: they are what needs attention.
  const order = jobs
    .map((job, index) => ({ job, plan: plans[index] as Plan }))
    .sort((a, b) => Number(a.job.status === "completed") - Number(b.job.status === "completed"));
  const maxRows = rows ? Math.max(3, rows - 22) : 10;
  const { end } = visibleWindow(0, order.length, maxRows);

  const items: MenuItem<BatchResultAction>[] = [
    ...(unfinished
      ? [
          {
            value: "retry" as const,
            icon: ICONS.retry,
            label: `Try the ${unfinished === 1 ? "failed link" : `${unfinished} failed links`} again`,
            hint: "same choices",
          },
        ]
      : []),
    ...(counts.done ? [{ value: "open" as const, icon: ICONS.folder, label: "Open folder" }] : []),
    { value: "again", icon: ICONS.download, label: "Download more" },
    { value: "home", icon: ICONS.app, label: "Back to home" },
    { value: "quit", icon: ICONS.quit, label: "Quit" },
  ];

  return (
    <Frame
      crumbs={["Home", "Download", "Done"]}
      icon={allGood ? ICONS.ok : ICONS.warn}
      tone={allGood ? "ok" : "warn"}
      title={
        allGood
          ? jobs.length === 1
            ? "Download complete"
            : `All ${jobs.length} downloads complete`
          : `${counts.done} of ${jobs.length} saved, ${unfinished} not saved`
      }
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
      ]}
    >
      <Box flexDirection="column" marginBottom={1}>
        {order.slice(0, end).map(({ job, plan }) => {
          if (job.status === "completed") {
            return (
              <Text key={plan.url}>
                <Text color={COLORS.ok}>{ICONS.ok} </Text>
                {shorten(
                  job.outputPath ? basename(job.outputPath) : (plan.title ?? plan.url),
                  width,
                )}
              </Text>
            );
          }
          const cancelled = job.status === "cancelled";
          return (
            <Box key={plan.url} flexDirection="column">
              <Text>
                <Text color={cancelled ? COLORS.warn : COLORS.error}>
                  {cancelled ? ICONS.warn : ICONS.error}{" "}
                </Text>
                {shorten(plan.title ?? plan.url, width)}
              </Text>
              {cancelled ? (
                <Text color={COLORS.muted}>{"   cancelled"}</Text>
              ) : (
                <>
                  <Text
                    color={COLORS.error}
                  >{`   ${shorten(job.error ?? "Something went wrong.", width - 3)}`}</Text>
                  <Text
                    color={COLORS.muted}
                  >{`   ${shorten(failureHint(job.errorKind, job.error ?? ""), width - 3)}`}</Text>
                </>
              )}
            </Box>
          );
        })}
        {end < order.length ? (
          <Text color={COLORS.muted}>{`  and ${order.length - end} more`}</Text>
        ) : null}
      </Box>
      <Menu<BatchResultAction> onSelect={onAction} onBack={() => onAction("home")} items={items} />
    </Frame>
  );
}
