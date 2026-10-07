import type {
  DownloadProgress,
  DownloadRequest,
  MediaCandidate,
  MediaVariant,
} from "@mediaforge/shared-types";
import { z } from "zod";

export const MediaVariantSchema = z.object({
  id: z.string(),
  label: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bitrate: z.number().nonnegative().optional(),
  codecs: z.string().optional(),
  container: z.string().optional(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  url: z.string().optional(),
});

export const MediaCandidateSchema = z.object({
  id: z.string(),
  pageUrl: z.string(),
  pageTitle: z.string().optional(),
  url: z.string(),
  kind: z.enum(["video", "audio"]),
  streamType: z.enum(["progressive", "hls", "dash"]),
  source: z.enum(["dom", "network", "manifest"]),
  mime: z.string().optional(),
  durationSec: z.number().nonnegative().optional(),
  thumbnail: z.string().optional(),
  variants: z.array(MediaVariantSchema),
  detectedAt: z.number(),
});

export const DownloadRequestSchema = z.object({
  candidate: MediaCandidateSchema,
  variantId: z.string().optional(),
  profileId: z.string(),
  outputDir: z.string().optional(),
  filename: z.string().optional(),
});

export const DownloadProgressSchema = z.object({
  bytesDownloaded: z.number().nonnegative(),
  totalBytes: z.number().nonnegative().optional(),
  speed: z.number().nonnegative().optional(),
  etaSec: z.number().nonnegative().optional(),
  percent: z.number().min(0).max(100).optional(),
});

// Compile-time guarantee that the runtime schemas match the shared domain types.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type _SchemaChecks = [
  Assert<Equals<z.infer<typeof MediaVariantSchema>, MediaVariant>>,
  Assert<Equals<z.infer<typeof MediaCandidateSchema>, MediaCandidate>>,
  Assert<Equals<z.infer<typeof DownloadRequestSchema>, DownloadRequest>>,
  Assert<Equals<z.infer<typeof DownloadProgressSchema>, DownloadProgress>>,
];
