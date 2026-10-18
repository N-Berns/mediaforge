import type { ContentKind, JobOrigin } from "@mediaforge/shared-types";
import { COLORS, ICONS } from "../theme.ts";
import type { Filters, StatusFilter } from "./model.ts";

/** The icon and color each status filter has, matching the table's status colors. */
export const STATUS_STYLE: Record<StatusFilter, { icon: string; color: string }> = {
  active: { icon: ICONS.download, color: COLORS.accent },
  queued: { icon: ICONS.info, color: COLORS.muted },
  paused: { icon: ICONS.paused, color: COLORS.paused },
  completed: { icon: ICONS.ok, color: COLORS.ok },
  failed: { icon: ICONS.error, color: COLORS.failed },
  cancelled: { icon: ICONS.stop, color: COLORS.error },
};

/** The download menu's type icons. */
export const KIND_ICONS: Record<ContentKind, string> = {
  "video-audio": ICONS.kindVideoAudio,
  video: ICONS.kindVideo,
  audio: ICONS.kindAudio,
  subtitles: ICONS.type,
};

export const ORIGIN_ICONS: Record<JobOrigin, string> = {
  extension: ICONS.format,
  menu: ICONS.settings,
  manager: ICONS.app,
  cli: ICONS.paste,
};

/** The active filters as colored icons, for the header: status, then type, then origin. */
export function filterIcons(filters: Filters): { text: string; color: string }[] {
  return [
    ...filters.statuses.map((s) => ({ text: STATUS_STYLE[s].icon, color: STATUS_STYLE[s].color })),
    ...filters.types.map((k) => ({ text: KIND_ICONS[k].trim(), color: COLORS.accent })),
    ...filters.origins.map((o) => ({ text: ORIGIN_ICONS[o], color: COLORS.accent })),
  ];
}
