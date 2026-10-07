import type { MediaKind } from "./media.ts";

export type PostProcess = "none" | "merge" | "transcode" | "extract-audio";

/** A named output preset that drives variant selection and FFmpeg processing. */
export interface OutputProfile {
  id: string;
  name: string;
  kind: MediaKind;
  container: string;
  /** Upper bound on video height; omitted means "best available". */
  maxHeight?: number;
  videoCodec?: string;
  audioCodec?: string;
  /** Kilobits per second. */
  audioBitrate?: number;
  postprocess: PostProcess;
}
