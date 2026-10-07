import type { OutputProfile } from "@mediaforge/shared-types";

export const BUILTIN_PROFILES = [
  {
    id: "best",
    name: "Best quality",
    kind: "video",
    container: "mp4",
    postprocess: "merge",
  },
  {
    id: "mp4-1080p",
    name: "MP4 1080p",
    kind: "video",
    container: "mp4",
    maxHeight: 1080,
    postprocess: "merge",
  },
  {
    id: "mp4-720p",
    name: "MP4 720p",
    kind: "video",
    container: "mp4",
    maxHeight: 720,
    postprocess: "merge",
  },
  {
    id: "audio-mp3-320",
    name: "MP3 320 kbps",
    kind: "audio",
    container: "mp3",
    audioCodec: "libmp3lame",
    audioBitrate: 320,
    postprocess: "extract-audio",
  },
  {
    id: "audio-m4a",
    name: "M4A (original AAC)",
    kind: "audio",
    container: "m4a",
    postprocess: "extract-audio",
  },
] as const satisfies readonly OutputProfile[];

export type BuiltinProfileId = (typeof BUILTIN_PROFILES)[number]["id"];

export const DEFAULT_PROFILE_ID: BuiltinProfileId = "best";

export function getProfile(id: string): OutputProfile | undefined {
  return BUILTIN_PROFILES.find((profile) => profile.id === id);
}
