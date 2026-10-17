import type { DownloadJob, DownloadStatus, SpeedUnit } from "@mediaforge/shared-types";
import { Box, Text } from "ink";
import type { ManagerSort } from "../../settings.ts";
import { Clickable, type MouseClick } from "../mouse/MouseProvider.tsx";
import { COLORS } from "../theme.ts";
import {
  COLUMN_LABELS,
  COLUMN_WIDTH,
  type Column,
  etaText,
  lastTryText,
  nameWidth,
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
        <Text wrap="truncate-end" color={color}>
          {text}
        </Text>
      </Box>
    </Box>
  );
}

const widthOf = (column: Column, name: number) => (column === "name" ? name : COLUMN_WIDTH[column]);

function cellText(job: DownloadJob, column: Column, unit: SpeedUnit, now: number): string {
  switch (column) {
    case "name":
      return rowName(job);
    case "size":
      return sizeText(job);
    case "status":
      return statusText(job);
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
  active = true,
}: TableProps) {
  const name = nameWidth(width, columns);
  return (
    <Box flexDirection="column" width={width} overflow="hidden">
      <Box width={width} overflow="hidden">
        <Text color={COLORS.muted}>{" [ ] "}</Text>
        {columns.map((column) => (
          <Clickable
            key={column}
            flexShrink={0}
            active={active}
            onClick={() => onHeaderClick?.(column)}
          >
            <Cell
              width={widthOf(column, name)}
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
      {rows.map((job, i) => (
        <Clickable
          key={job.id}
          width={width}
          overflow="hidden"
          active={active}
          onClick={(click) => onRowClick?.(job, click)}
        >
          <Text color={COLORS.accent}>{i === cursor ? ">" : " "}</Text>
          <Text>{ticks.has(job.id) ? "[•] " : "[ ] "}</Text>
          {columns.map((column) =>
            column === "name" && job.limitOverride ? (
              // The mark sits outside the cut, so a long name never hides it.
              <Box key={column} width={name} flexShrink={0}>
                <Cell width={name - 2} text={cellText(job, column, unit, now)} />
                <Text color={COLORS.accent}>{OVERRIDE_MARK}</Text>
              </Box>
            ) : (
              <Cell
                key={column}
                width={widthOf(column, name)}
                text={cellText(job, column, unit, now)}
                {...(column === "status" && { color: STATUS_COLOR[job.status] })}
              />
            ),
          )}
        </Clickable>
      ))}
    </Box>
  );
}
