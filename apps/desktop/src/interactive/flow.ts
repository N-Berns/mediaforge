import { DEFAULT_PROFILE_ID, getProfile } from "@mediaforge/media-profiles";
import { OUTPUT_DIR_ENV } from "../download.ts";
import type { PlannedStep } from "../engine/index.ts";
import type { MediaInfo } from "../formats.ts";
import { KIND_FOLDERS, kindOfProfile, type MediaKind, withKindFolder } from "../kind-folder.ts";
import type { Settings } from "../settings.ts";
import { planSteps } from "./plan-steps.ts";

/** What has been chosen so far for one download. */
export interface Draft {
  url: string;
  /** Details from the lookup; absent when the user skipped it. */
  info?: MediaInfo;
  profileId?: string;
  formatSelector?: string;
  /** What the pick contains; when unset it follows from the profile. */
  kind?: MediaKind;
  outputDir?: string;
}

/** Everything needed to start a download. */
export interface Plan {
  url: string;
  title?: string;
  profileId: string;
  formatSelector?: string;
  outputDir: string;
  /** Steps expected for this format, shown as bars before they start. */
  steps?: PlannedStep[];
}

export type Step = "quality" | "folder" | "download";

/** The folder used when the user is not asked: env var, then saved setting, then built-in. */
export function effectiveFolder(
  env: Record<string, string | undefined>,
  settings: Settings,
  builtIn: string,
): string {
  return env[OUTPUT_DIR_ENV] || settings.folder || builtIn;
}

/**
 * Decide the next screen after the link is known: ask for what is still missing,
 * and fill in saved defaults for anything the user chose not to be asked about.
 */
export function nextStep(
  draft: Draft,
  settings: Settings,
  folderDefault: string,
): { draft: Draft; step: Step } {
  const d = { ...draft };
  if (d.profileId === undefined) {
    if (settings.askQuality) return { draft: d, step: "quality" };
    d.profileId = settings.quality ?? DEFAULT_PROFILE_ID;
  }
  if (d.outputDir === undefined) {
    if (settings.askFolder) return { draft: d, step: "folder" };
    d.outputDir = folderDefault;
  }
  return { draft: d, step: "download" };
}

/** What this draft will save: the picked kind, else what its profile produces. */
export function draftKind(draft: Draft): MediaKind {
  if (draft.kind) return draft.kind;
  const profile = draft.profileId === undefined ? undefined : getProfile(draft.profileId);
  return profile ? kindOfProfile(profile) : "video-audio";
}

/** Name of the type subfolder this draft goes into, or undefined when sorting is off. */
export const draftSubfolder = (draft: Draft, sortByType: boolean): string | undefined =>
  sortByType ? KIND_FOLDERS[draftKind(draft)] : undefined;

/** A complete draft as a plan. Throws if something is still missing. */
export function toPlan(draft: Draft, sortByType: boolean): Plan {
  if (draft.profileId === undefined || draft.outputDir === undefined) {
    throw new Error("The download is not fully set up yet.");
  }
  const profile = getProfile(draft.profileId);
  const steps = profile && planSteps(profile, draft.info, draft.formatSelector);
  return {
    url: draft.url,
    ...(draft.info?.title && { title: draft.info.title }),
    profileId: draft.profileId,
    ...(draft.formatSelector && { formatSelector: draft.formatSelector }),
    outputDir: withKindFolder(draft.outputDir, draftKind(draft), sortByType),
    ...(steps && { steps }),
  };
}
