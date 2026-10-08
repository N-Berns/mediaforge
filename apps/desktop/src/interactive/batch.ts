import { getProfile } from "@mediaforge/media-profiles";
import type { EngineJob } from "../engine/index.ts";
import type { ExitCode } from "../exit-codes.ts";
import type { MediaInfo } from "../formats.ts";
import { kindOfProfile } from "../kind-folder.ts";
import type { Draft } from "./flow.ts";
import {
  availableKinds,
  type FormatPick,
  formatChoices,
  type MediaKind,
} from "./format-choices.ts";

/** One link in a batch, with what the lookup found. */
export interface BatchItem {
  url: string;
  info?: MediaInfo;
  /** Why the lookup failed; the link can still be downloaded without details. */
  lookupError?: string;
  lookupErrorKind?: ExitCode;
  /** The quality assigned to this link by the type step (or the saved default). */
  choice?: ItemChoice;
  /** A quality chosen for this link alone, replacing the assigned one. */
  override?: ItemChoice;
}

/** What to download for a link: the profile, an optional exact format, and what it contains. */
export interface ItemChoice {
  profileId: string;
  formatSelector?: string;
  kind: MediaKind;
  /** Short description for the review list, e.g. "Up to 1080p" or "720p  mp4". */
  label: string;
}

export const KIND_LABELS: Record<MediaKind, string> = {
  "video-audio": "Video with audio",
  video: "Video only",
  audio: "Audio only",
};

export type PresetId = "best" | "1080" | "720" | "m4a" | "mp3";

export interface Preset {
  id: PresetId;
  label: string;
  hint: string;
}

/** Qualities that make sense on any site, since every link has its own list of formats. */
export const PRESETS: Record<MediaKind, Preset[]> = {
  "video-audio": [
    { id: "best", label: "Best available", hint: "the highest quality each link offers" },
    { id: "1080", label: "Up to 1080p", hint: "mp4" },
    { id: "720", label: "Up to 720p", hint: "mp4, smaller files" },
  ],
  video: [
    { id: "best", label: "Best available", hint: "no sound" },
    { id: "1080", label: "Up to 1080p", hint: "no sound" },
    { id: "720", label: "Up to 720p", hint: "no sound, smaller files" },
  ],
  audio: [
    { id: "m4a", label: "Best audio (m4a)", hint: "original quality" },
    { id: "mp3", label: "MP3, 320 kbps", hint: "converted" },
  ],
};

/** Turn a preset into what the engine needs. */
export function presetChoice(kind: MediaKind, id: PresetId): ItemChoice {
  const label = PRESETS[kind].find((p) => p.id === id)?.label ?? id;
  if (kind === "audio") {
    return { kind, label, profileId: id === "mp3" ? "audio-mp3-320" : "audio-m4a" };
  }
  if (kind === "video-audio") {
    const profileId = id === "1080" ? "mp4-1080p" : id === "720" ? "mp4-720p" : "best";
    return { kind, label, profileId };
  }
  // Video only: the best stream without sound, under the height limit.
  const cap = id === "1080" ? "[height<=1080]" : id === "720" ? "[height<=720]" : "";
  return { kind, label, profileId: "best", formatSelector: `bv${cap}` };
}

/** A saved profile used as the quality for every link (when the app is set not to ask). */
export function profileChoice(profileId: string): ItemChoice {
  const profile = getProfile(profileId);
  return {
    profileId,
    kind: profile ? kindOfProfile(profile) : "video-audio",
    label: profile?.name ?? profileId,
  };
}

/** A specific format picked from one link's own list. */
export function formatChoice(info: MediaInfo, kind: MediaKind, pick: FormatPick): ItemChoice {
  const row = formatChoices(info, kind).find(
    (c) => c.value.selector === pick.selector && c.value.profileId === pick.profileId,
  );
  return {
    kind,
    profileId: pick.profileId,
    ...(pick.selector && { formatSelector: pick.selector }),
    label: (row?.label ?? "Specific format").replace(/\s+/g, " ").trim(),
  };
}

/** What this link will download: its own pick, else the one assigned to it. */
export const choiceFor = (item: BatchItem): ItemChoice | undefined => item.override ?? item.choice;

export type Support = "yes" | "no" | "unknown";

const hasKinds = (info: MediaInfo): boolean => Object.values(availableKinds(info)).some(Boolean);

/**
 * A link whose lookup listed formats, none of them usable (e.g. only storyboards). A lookup
 * that listed no formats at all is not unusable: the ready-made profiles may still work.
 */
export const isUnusable = (item: BatchItem): boolean =>
  item.info !== undefined && (item.info.formats?.length ?? 0) > 0 && !hasKinds(item.info);

/** Whether a link can give a kind. "unknown" when there are no details to say either way. */
export function supports(item: BatchItem, kind: MediaKind): Support {
  if (!item.info) return "unknown";
  if (isUnusable(item)) return "no";
  if (!hasKinds(item.info)) return "unknown";
  return availableKinds(item.info)[kind] ? "yes" : "no";
}

export const isAssigned = (item: BatchItem): boolean => choiceFor(item) !== undefined;

/** Links that still need a type: nothing assigned yet, and something to download. */
export const waitingItems = (items: readonly BatchItem[]): BatchItem[] =>
  items.filter((item) => !isAssigned(item) && !isUnusable(item));

/** Waiting links that can take this kind. */
export const takers = (items: readonly BatchItem[], kind: MediaKind): BatchItem[] =>
  waitingItems(items).filter((item) => supports(item, kind) !== "no");

/** Give a preset to every waiting link that can take its kind; the others stay waiting. */
export function assignKind(
  items: readonly BatchItem[],
  kind: MediaKind,
  id: PresetId,
): BatchItem[] {
  const choice = presetChoice(kind, id);
  return items.map((item) =>
    !isAssigned(item) && !isUnusable(item) && supports(item, kind) !== "no"
      ? { ...item, choice }
      : item,
  );
}

/** One choice for every link that has none and can be downloaded (the saved default). */
export const assignAll = (items: readonly BatchItem[], choice: ItemChoice): BatchItem[] =>
  items.map((item) => (isAssigned(item) || isUnusable(item) ? item : { ...item, choice }));

/** Forget the assigned choices (per-link overrides stay: the user picked those on purpose). */
export const clearChoices = (items: readonly BatchItem[]): BatchItem[] =>
  items.map(({ choice: _choice, ...rest }) => rest);

export const withOverride = (
  items: readonly BatchItem[],
  index: number,
  choice: ItemChoice,
): BatchItem[] => items.map((item, i) => (i === index ? { ...item, override: choice } : item));

/** The links that will actually be downloaded. */
export const downloadable = (items: readonly BatchItem[]): BatchItem[] =>
  items.filter((item) => !isUnusable(item) && isAssigned(item));

/** A warning for links that cannot give what was chosen, e.g. "video only" from a site with none. */
export function choiceWarning(item: BatchItem, choice: ItemChoice): string | undefined {
  if (!item.info) return undefined;
  if (availableKinds(item.info)[choice.kind]) return undefined;
  return choice.kind === "video"
    ? "no video-only stream here, choose another quality"
    : choice.kind === "audio"
      ? "no separate audio here, it will be taken from the video"
      : "no video found for this link";
}

/** The title when known, else the link itself. */
export const itemTitle = (item: BatchItem): string => item.info?.title ?? item.url;

/** A finished single-download draft for one link of the batch. */
export function itemDraft(item: BatchItem, choice: ItemChoice, outputDir: string): Draft {
  return {
    url: item.url,
    ...(item.info && { info: item.info }),
    profileId: choice.profileId,
    ...(choice.formatSelector && { formatSelector: choice.formatSelector }),
    kind: choice.kind,
    outputDir,
  };
}

export interface BatchCounts {
  done: number;
  failed: number;
  cancelled: number;
  running: number;
  waiting: number;
}

/** How many links are in each state, for the summary lines. */
export function countJobs(jobs: readonly (EngineJob | undefined)[]): BatchCounts {
  const counts: BatchCounts = { done: 0, failed: 0, cancelled: 0, running: 0, waiting: 0 };
  for (const job of jobs) {
    if (!job || job.status === "queued") counts.waiting++;
    else if (job.status === "completed") counts.done++;
    else if (job.status === "failed") counts.failed++;
    else if (job.status === "cancelled") counts.cancelled++;
    else counts.running++;
  }
  return counts;
}

/** Overall percent for the batch: finished links count as complete, the rest by their progress. */
export function batchPercent(jobs: readonly (EngineJob | undefined)[]): number {
  if (jobs.length === 0) return 0;
  const sum = jobs.reduce((total, job) => {
    if (!job) return total;
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return total + 100;
    }
    return total + (job.overallPercent ?? job.progress.percent ?? 0);
  }, 0);
  return sum / jobs.length;
}
