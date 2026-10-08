import { join } from "node:path";
import type { OutputProfile } from "@mediaforge/shared-types";

/** What a download contains: picture and sound, picture only, or sound only. */
export type MediaKind = "video-audio" | "video" | "audio";

/** Subfolder each kind is sorted into when "sort by type" is on. */
export const KIND_FOLDERS: Record<MediaKind, string> = {
  "video-audio": "Video",
  video: "Video only",
  audio: "Audio",
};

/** The kind a profile produces when the user did not pick a specific stream. */
export const kindOfProfile = (profile: Pick<OutputProfile, "kind">): MediaKind =>
  profile.kind === "audio" ? "audio" : "video-audio";

/** `dir` itself, or its subfolder for this kind when sorting is on. */
export const withKindFolder = (dir: string, kind: MediaKind, sort: boolean): string =>
  sort ? join(dir, KIND_FOLDERS[kind]) : dir;
