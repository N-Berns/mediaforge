import type { DownloadJob, DownloadStatus, SpeedUnit } from "@mediaforge/shared-types";
import { Box, Text } from "ink";
import type { ManagerSort } from "../../settings.ts";
import { Clickable, HoverText, type MouseClick } from "../mouse/MouseProvider.tsx";
import { COLORS } from "../theme.ts";
import { KIND_ICONS, ORIGIN_ICONS, STATUS_STYLE } from "./icons.ts";
import {
  COLUMN_LABELS,
  type Column,
  columnWidth,
  compactColumns,
  etaText,
  jobKind,
  KIND_LABELS,
  lastTryText,
  nameWidth,
  ORIGIN_LABELS,
  OVERRIDE_MARK,
  rowName,
  sizeText,
  speedText,
  statusText,
} from "./model.ts";

/** Cells of the `[ ]` box in a row: column 0 is the cursor mark. */
export const BOX_COLUMNS = [1, 2, 3];
/** Rows the cursor moves per wheel notch. */
export const WHEEL_ROWS = 3;

const STATUS_COLOR: Partial<Record<DownloadStatus, string>> = {
  downloading: COLORS.accent,
  processing: COLORS.accent,
  queued: COLORS.muted,
  paused: COLORS.paused,
  completed: COLORS.ok,
  failed: COLORS.error,
  cancelled: COLORS.warn,
};

/** One fixed-width cell, cut by display width so wide characters keep the columns aligned. */
function Cell({ width, text, color }: { width: number; text: string; color?: string }) {
  return (
    <Box width={width} flexShrink={0}>
      <Box width={Math.max(1, width - 1)}>
        <HoverText wrap="truncate-end" color={color}>
          {text}
        </HoverText>
      </Box>
    </Box>
  );
}

/** The status as its filter icon, with the percent where there is one: "▼ 42%", "▌▌ 71%", "√". */
function statusIcon(job: DownloadJob): string {
  const filter =
    job.status === "downloading" || job.status === "processing" ? "active" : job.status;
  const icon = STATUS_STYLE[filter].icon;
  return job.status === "downloading" || job.status === "paused"
    ? `${icon} ${statusText(job).replace(/^\D+/, "")}`
    : icon;
}

function cellText(
  job: DownloadJob,
  column: Column,
  unit: SpeedUnit,
  now: number,
  compact: readonly Column[],
): string {
  const icons = compact.includes(column);
  switch (column) {
    case "name":
      return rowName(job);
    case "type":
      return icons ? KIND_ICONS[jobKind(job)].trim() : KIND_LABELS[jobKind(job)];
    case "origin":
      if (!job.origin) return "—";
      return icons
        ? ORIGIN_ICONS[job.origin]
        : `${ORIGIN_ICONS[job.origin]} ${ORIGIN_LABELS[job.origin]}`;
    case "size":
      return sizeText(job);
    case "status":
      return icons ? statusIcon(job) : statusText(job);
    case "speed":
      return speedText(job, unit);
    case "eta":
      return etaText(job);
    case "lastTry":
      return lastTryText(job.lastTryAt, now);
  }
}

export interface TableProps {
  rows: DownloadJob[];
  columns: Column[];
  width: number;
  /** Index of the cursor row within `rows`, or -1. */
  cursor: number;
  ticks: ReadonlySet<string>;
  sort: ManagerSort;
  unit: SpeedUnit;
  now: number;
  onRowClick?: (job: DownloadJob, click: MouseClick) => void;
  onHeaderClick?: (column: Column) => void;
  /** Every visible row is ticked: the header box shows it. */
  allTicked?: boolean;
  /** A click on the header box: tick every visible row, or untick them all. */
  onTickAllClick?: () => void;
  /** False while a panel or prompt is up: the table takes no clicks. */
  active?: boolean;
}

/** The column header and the visible rows. `rows` is already the scrolled window. */
export function Table({
  rows,
  columns,
  width,
  cursor,
  ticks,
  sort,
  unit,
  now,
  onRowClick,
  onHeaderClick,
  allTicked = false,
  onTickAllClick,
  active = true,
}: TableProps) {
  const compact = compactColumns(width);
  const name = nameWidth(width, columns, compact);
  const widthOf = (column: Column) =>
    column === "name" ? name : columnWidth(column, compact.includes(column));
  return (
    <Box flexDirection="column" width={width} overflow="hidden">
      <Box width={width} overflow="hidden">
        <Text> </Text>
        <Clickable flexShrink={0} active={active} onClick={() => onTickAllClick?.()}>
          <HoverText color={COLORS.muted}>{allTicked ? "[•] " : "[ ] "}</HoverText>
        </Clickable>
        {columns.map((column) => (
          <Clickable
            key={column}
            flexShrink={0}
            active={active}
            onClick={() => onHeaderClick?.(column)}
          >
            <Cell
              width={widthOf(column)}
              color={COLORS.muted}
              text={
                column === sort.column
                  ? `${COLUMN_LABELS[column]} ${sort.descending ? "▼" : "▲"}`
                  : COLUMN_LABELS[column]
              }
            />
          </Clickable>
        ))}
      </Box>
      {/* A row's worth of space keeps the headers apart from the first download. */}
      <Text> </Text>
      {rows.map((job, i) => (
        <Clickable
          key={job.id}
          width={width}
          overflow="hidden"
          active={active}
          onClick={(click) => onRowClick?.(job, click)}
        >
          <HoverText color={COLORS.accent}>{i === cursor ? ">" : " "}</HoverText>
          <HoverText>{ticks.has(job.id) ? "[•] " : "[ ] "}</HoverText>
          {columns.map((column) =>
            column === "name" && job.limitOverride ? (
              // The mark sits outside the cut, so a long name never hides it.
              <Box key={column} width={name} flexShrink={0}>
                <Cell width={name - 2} text={cellText(job, column, unit, now, compact)} />
                <HoverText color={COLORS.accent}>{OVERRIDE_MARK}</HoverText>
              </Box>
            ) : (
              <Cell
                key={column}
                width={widthOf(column)}
                text={cellText(job, column, unit, now, compact)}
                {...(column === "status" && { color: STATUS_COLOR[job.status] })}
              />
            ),
          )}
        </Clickable>
      ))}
    </Box>
  );
}
