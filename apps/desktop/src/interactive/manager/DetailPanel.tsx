import {
  type DownloadJob,
  formatLimit,
  type Limits,
  type SpeedUnit,
} from "@mediaforge/shared-types";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import {
  barWidthFor,
  hasStepRows,
  JobProgress,
  progressLines,
} from "../components/JobProgress.tsx";
import { Clickable, HoverText } from "../mouse/MouseProvider.tsx";
import { COLORS } from "../theme.ts";
import { PRESET_NAMES } from "./LimitPicker.tsx";
import { ORIGIN_LABELS, rowName, statusColor, statusText, withoutFlags } from "./model.ts";

const LABEL_WIDTH = 8;
/** The "Details" divider and the blank line under it. */
const CHROME_LINES = 2;

/** The states in which the job no longer runs: the progress block shows where it stopped. */
const ENDED: readonly DownloadJob["status"][] = ["completed", "failed", "cancelled"];

/** The keys of the footer while the panel is open. Esc leads, so a narrow window keeps it. */
export const DETAIL_KEYS: [string, string][] = [
  ["Esc", "Close"],
  ["y", "Copy link"],
  ["Y", "Copy path"],
  ["o", "Open folder"],
  ["↑↓", "Scroll"],
];

/**
 * How the progress block is drawn so that it leaves at least one field line in `room`. The count
 * includes the blank line above it, and drops the stage line of a job that no longer runs.
 */
function progressLayout(
  job: DownloadJob,
  room: number,
): { compact: boolean; hideSteps: boolean; lines: number } | undefined {
  const options = [
    { compact: false, hideSteps: false },
    { compact: true, hideSteps: false },
    { compact: true, hideSteps: true },
  ];
  const ended = ENDED.includes(job.status);
  for (const option of options) {
    if (option.hideSteps && !hasStepRows(job)) continue;
    const base = option.hideSteps
      ? progressLines({ ...job, steps: undefined }, option.compact)
      : progressLines(job, option.compact);
    // Stage line and the gap under it, when the job has one.
    const lines = base + 1 - (ended ? 1 + (option.compact ? 0 : 1) : 0);
    if (lines <= room) return { ...option, lines };
  }
  return undefined;
}

/** Break text into lines of at most `width` characters, at spaces where it can. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let rest = word; rest.length > 0; ) {
      const room = line ? width - line.length - 1 : width;
      if (rest.length <= room) {
        line = line ? `${line} ${rest}` : rest;
        rest = "";
      } else if (line) {
        lines.push(line);
        line = "";
      } else {
        // A word longer than the line (a URL): cut it.
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
    }
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

export interface DetailPanelProps {
  job: DownloadJob;
  unit: SpeedUnit;
  limits: Limits | undefined;
  /** Lines the panel may use; longer content scrolls with ↑↓. */
  height: number;
  width: number;
  onClose: () => void;
  /** The link or the path to the clipboard. */
  onCopy: (field: "url" | "path") => void;
  /** Show the saved file in its folder. */
  onOpenFolder: () => void;
}

/** Everything the table cuts short: full name, link, path, origin, override and error. */
export function DetailPanel({
  job,
  unit,
  limits,
  height,
  width,
  onClose,
  onCopy,
  onOpenFolder,
}: DetailPanelProps) {
  const override = job.limitOverride;
  const limit = override
    ? `${PRESET_NAMES[override]} · ${formatLimit(limits?.[override] ?? null, unit)}`
    : "None (shares the global limit)";
  const color = statusColor(job.status);
  const fields: [string, string, string?][] = [
    ["Name", withoutFlags(rowName(job))],
    ["URL", job.request.candidate.url],
    ["Path", job.outputPath ? withoutFlags(job.outputPath) : "—"],
    ["Origin", job.origin ? ORIGIN_LABELS[job.origin] : "—"],
    ["Limit", limit],
    ["Status", statusText(job), color],
    ...(job.error ? [["Error", job.error, COLORS.failed] as [string, string, string]] : []),
  ];
  const textWidth = Math.max(10, width - 2 - LABEL_WIDTH);
  const lines = fields.flatMap(([label, value, tint]) =>
    wrapText(value, textWidth).map((text, i) => ({
      id: `${label}-${i}`,
      field: label,
      label: i === 0 ? label : "",
      text,
      tint,
    })),
  );
  const ended = ENDED.includes(job.status) ? { color } : undefined;
  // The progress block sits under the fields and keeps its lines; the fields scroll in what is left.
  const progress = progressLayout(job, height - CHROME_LINES - 1);
  const size = Math.max(1, height - CHROME_LINES - (progress?.lines ?? 0));
  const maxTop = Math.max(0, lines.length - size);
  const [top, setTop] = useState(0);

  useInput((input, key) => {
    if (key.escape || key.return) onClose();
    else if (input === "y") onCopy("url");
    else if (input === "Y") onCopy("path");
    else if (input === "o") onOpenFolder();
    else if (key.upArrow) setTop((t) => Math.max(0, t - 1));
    else if (key.downArrow) setTop((t) => Math.min(maxTop, t + 1));
    else if (key.pageUp) setTop((t) => Math.max(0, t - size));
    else if (key.pageDown) setTop((t) => Math.min(maxTop, t + size));
  });

  const first = Math.min(top, maxTop);
  const shown = lines.slice(first, first + size);
  const more = [...(first > 0 ? ["↑"] : []), ...(first < maxTop ? ["↓"] : [])].join("");
  // A finished job has no live percent: a completed one is whole, the others stopped where they were.
  const shownJob = job.status === "completed" ? { ...job, overallPercent: 100 } : job;
  return (
    <Clickable
      flexDirection="column"
      paddingX={1}
      onWheel={(step) => setTop((t) => Math.max(0, Math.min(maxTop, t + step)))}
    >
      <Text color={COLORS.muted} wrap="truncate-end">
        {"── "}
        <Text bold color={COLORS.accent}>
          Details
        </Text>
        {` ${more ? `${more} more ` : ""}`.padEnd(Math.max(1, width - 2 - 10), "─")}
      </Text>
      <Text> </Text>
      {shown.map((line) => (
        <Clickable
          key={line.id}
          {...((line.field === "URL" || line.field === "Path") && {
            onClick: () => onCopy(line.field === "URL" ? "url" : "path"),
          })}
        >
          <Box width={LABEL_WIDTH} flexShrink={0}>
            <Text color={COLORS.muted}>{line.label}</Text>
          </Box>
          <HoverText wrap="truncate-end" {...(line.tint && { color: line.tint })}>
            {line.text}
          </HoverText>
        </Clickable>
      ))}
      {progress ? (
        <>
          <Text> </Text>
          <JobProgress
            job={shownJob}
            unit={unit}
            barWidth={barWidthFor(Math.min(width, 100) - 2)}
            paused={job.status === "paused"}
            compact={progress.compact}
            hideSteps={progress.hideSteps}
            {...(ended && { ended })}
          />
        </>
      ) : null}
    </Clickable>
  );
}
