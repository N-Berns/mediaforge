import { getProfile } from "@mediaforge/media-profiles";
import {
  type ContentKind,
  type DownloadJob,
  type DownloadStatus,
  formatBytes,
  formatRate,
  type JobOrigin,
  type SpeedUnit,
} from "@mediaforge/shared-types";
import type { ManagerSort, SortColumn } from "../../settings.ts";

export type StatusFilter = "active" | "queued" | "paused" | "completed" | "failed" | "cancelled";

export interface Filters {
  statuses: StatusFilter[];
  types: ContentKind[];
  origins: JobOrigin[];
}

export const NO_FILTERS: Filters = { statuses: [], types: [], origins: [] };

export const STATUS_FILTERS: StatusFilter[] = [
  "active",
  "queued",
  "paused",
  "completed",
  "failed",
  "cancelled",
];
export const KINDS: ContentKind[] = ["video-audio", "video", "audio", "subtitles"];
export const ORIGINS: JobOrigin[] = ["extension", "menu", "manager", "cli"];

export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  active: "Active",
  queued: "Queued",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
export const KIND_LABELS: Record<ContentKind, string> = {
  "video-audio": "Video",
  video: "Video only",
  audio: "Audio only",
  subtitles: "Subtitle",
};
export const ORIGIN_LABELS: Record<JobOrigin, string> = {
  extension: "Extension",
  menu: "Menu",
  manager: "Manager",
  cli: "CLI",
};
export type Column = SortColumn;

export const COLUMN_LABELS: Record<Column, string> = {
  name: "Name",
  type: "Type",
  origin: "Origin",
  size: "Size",
  status: "Status",
  speed: "Speed",
  eta: "ETA",
  lastTry: "Last try",
};

/** Each fixed column's width, including the gap after it. */
export const COLUMN_WIDTH: Record<Exclude<Column, "name">, number> = {
  type: 12,
  origin: 13,
  size: 9,
  status: 17,
  speed: 15,
  eta: 9,
  lastTry: 12,
};
export const MIN_NAME_WIDTH = 10;
/** The cursor mark and the `[ ] ` box before the name. */
const ROW_PREFIX_WIDTH = 5;

const NONE = "—";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isRunning = (status: DownloadStatus) => status === "downloading" || status === "processing";
const percentOf = (job: DownloadJob) => Math.floor(job.overallPercent ?? job.progress.percent ?? 0);
const lastPart = (path: string) => path.split(/[\\/]/).pop() || path;

/** Output file name, else the page title, else the link. */
export function rowName(job: DownloadJob): string {
  const { candidate } = job.request;
  return job.outputPath ? lastPart(job.outputPath) : candidate.pageTitle || candidate.url;
}

/** Shown after the name, outside its cut, when the job has its own speed cap. */
export const OVERRIDE_MARK = "⏷";

/**
 * What the job saves. Rows from before the core recorded it fall back to the request: a subtitle,
 * else the profile's kind. Those can never say "Video only".
 */
export function jobKind(job: DownloadJob): ContentKind {
  if (job.kind) return job.kind;
  if (job.request.subtitle) return "subtitles";
  return getProfile(job.request.profileId)?.kind === "audio" ? "audio" : "video-audio";
}

export function statusText(job: DownloadJob): string {
  switch (job.status) {
    case "downloading":
      return `Downloading ${percentOf(job)}%`;
    case "paused":
      return `Paused ${percentOf(job)}%`;
    case "queued":
      return "Queued";
    case "processing":
      return "Processing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

const sizeOf = (job: DownloadJob) => job.sizeBytes ?? job.progress.totalBytes;

export function sizeText(job: DownloadJob): string {
  const size = sizeOf(job);
  return size === undefined ? NONE : formatBytes(size);
}

const speedOf = (job: DownloadJob) =>
  job.status === "downloading"
    ? job.progress.speed
    : job.status === "completed"
      ? job.avgSpeed
      : undefined;

export function speedText(job: DownloadJob, unit: SpeedUnit): string {
  const speed = speedOf(job);
  if (speed === undefined) return NONE;
  const text = formatRate(speed, unit);
  return job.status === "completed" ? `avg ${text}` : text;
}

const etaOf = (job: DownloadJob) =>
  job.status === "downloading" ? job.progress.etaSec : undefined;

export function etaText(job: DownloadJob): string {
  const eta = etaOf(job);
  if (eta === undefined) return NONE;
  const total = Math.max(0, Math.round(eta));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const startOfDay = (time: number) => {
  const d = new Date(time);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** `just now`, the clock time today, `yesterday`, else a short date (with the year if not this one). */
export function lastTryText(at: number | undefined, now: number): string {
  if (at === undefined) return NONE;
  if (now - at < 60_000) return "just now";
  const date = new Date(at);
  const today = startOfDay(now);
  if (at >= today) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  if (at >= startOfDay(today - 1)) return "yesterday";
  const short = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? short
    : `${short} ${date.getFullYear()}`;
}

const STATUS_RANK: Record<DownloadStatus, number> = {
  downloading: 0,
  processing: 0,
  queued: 1,
  paused: 2,
  failed: 3,
  cancelled: 4,
  completed: 5,
};

const sortValue = (job: DownloadJob, column: SortColumn): string | number | undefined => {
  switch (column) {
    case "name":
      return rowName(job).toLowerCase();
    case "type":
      return KINDS.indexOf(jobKind(job));
    case "origin":
      return job.origin && ORIGINS.indexOf(job.origin);
    case "size":
      return sizeOf(job);
    case "status":
      return STATUS_RANK[job.status];
    case "speed":
      return speedOf(job);
    case "eta":
      return etaOf(job);
    case "lastTry":
      return job.lastTryAt;
  }
};

const compareValues = (a: string | number, b: string | number) =>
  typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : Number(a) - Number(b);

/**
 * Sorted copy. Rows with no value in the column go last in both directions; ties fall back to
 * the newest last try, then the id.
 */
export function sortJobs(jobs: readonly DownloadJob[], sort: ManagerSort): DownloadJob[] {
  return [...jobs].sort((a, b) => {
    const va = sortValue(a, sort.column);
    const vb = sortValue(b, sort.column);
    if (va === undefined && vb !== undefined) return 1;
    if (vb === undefined && va !== undefined) return -1;
    if (va !== undefined && vb !== undefined) {
      const order = compareValues(va, vb);
      if (order !== 0) return sort.descending ? -order : order;
    }
    const tries = (b.lastTryAt ?? -1) - (a.lastTryAt ?? -1);
    if (tries !== 0) return tries;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Which way each column sorts on its first press: the useful end first. */
const FIRST_DESCENDING: Record<SortColumn, boolean> = {
  name: false,
  type: false,
  origin: false,
  size: true,
  status: false,
  speed: true,
  eta: false,
  lastTry: true,
};

/** A new column starts at its useful end; the same column again reverses. */
export function nextSort(current: ManagerSort, column: SortColumn): ManagerSort {
  return current.column === column
    ? { column, descending: !current.descending }
    : { column, descending: FIRST_DESCENDING[column] };
}

export function matchesSearch(job: DownloadJob, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    rowName(job).toLowerCase().includes(q) || job.request.candidate.url.toLowerCase().includes(q)
  );
}

const statusMatches = (status: DownloadStatus, filter: StatusFilter) =>
  filter === "active" ? isRunning(status) : status === filter;

export function matchesFilters(job: DownloadJob, filters: Filters): boolean {
  if (filters.statuses.length > 0 && !filters.statuses.some((f) => statusMatches(job.status, f))) {
    return false;
  }
  if (filters.types.length > 0 && !filters.types.includes(jobKind(job))) return false;
  return !(filters.origins.length > 0 && !(job.origin && filters.origins.includes(job.origin)));
}

export const hasFilters = (filters: Filters): boolean =>
  filters.statuses.length > 0 || filters.types.length > 0 || filters.origins.length > 0;

/**
 * Columns with an icon form shrink to it before anything drops: Origin under 120 columns, Type
 * under 100, Status under 70. The rest have none and drop: Last try under 112, ETA under 90,
 * Speed under 80.
 */
export function visibleColumns(width: number): Column[] {
  const columns: Column[] = ["name", "type", "origin", "size", "status"];
  if (width >= 80) columns.push("speed");
  if (width >= 90) columns.push("eta");
  if (width >= 112) columns.push("lastTry");
  return columns;
}

/** The columns `visibleColumns` shows as icons at this width. */
export function compactColumns(width: number): Column[] {
  return [
    ...(width < 100 ? (["type"] as const) : []),
    ...(width < 120 ? (["origin"] as const) : []),
    ...(width < 70 ? (["status"] as const) : []),
  ];
}

/** A column's width as icons: room for its header with the sort arrow, plus the gap. */
const COMPACT_WIDTH: Partial<Record<Exclude<Column, "name">, number>> = {
  type: 7,
  origin: 9,
  status: 9,
};

export function columnWidth(column: Exclude<Column, "name">, compact: boolean): number {
  return (compact && COMPACT_WIDTH[column]) || COLUMN_WIDTH[column];
}

export function nameWidth(
  width: number,
  columns: readonly Column[],
  compact: readonly Column[] = [],
): number {
  const fixed = columns.reduce(
    (sum, column) =>
      column === "name" ? sum : sum + columnWidth(column, compact.includes(column)),
    0,
  );
  return Math.max(MIN_NAME_WIDTH, width - ROW_PREFIX_WIDTH - fixed);
}

/** The first visible row after moving the cursor, scrolling only as far as needed. */
export function scrollWindow(cursor: number, total: number, size: number, top: number): number {
  if (total <= size) return 0;
  let next = Math.min(top, total - size);
  if (cursor < next) next = cursor;
  if (cursor >= next + size) next = cursor - size + 1;
  return Math.max(0, next);
}

/**
 * Ctrl+click: tick every visible row from the anchor to `targetId`, keeping the other ticks.
 * The anchor is the most recently ticked visible row, else the cursor row, else the target.
 */
export function tickRange(
  ticks: string[],
  visibleIds: string[],
  cursorId: string | undefined,
  targetId: string,
): string[] {
  const anchor = [...ticks].reverse().find((id) => visibleIds.includes(id)) ?? cursorId ?? targetId;
  const from = visibleIds.indexOf(anchor);
  const to = visibleIds.indexOf(targetId);
  if (to < 0) return ticks;
  const start = from < 0 ? to : Math.min(from, to);
  const end = from < 0 ? to : Math.max(from, to);
  const added = visibleIds.slice(start, end + 1).filter((id) => !ticks.includes(id));
  return [...ticks, ...added];
}
