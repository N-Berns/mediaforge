import type {
  DownloadJob,
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

export const DownloadStatusSchema = z.enum([
  "queued",
  "downloading",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export const DownloadJobSchema = z.object({
  id: z.string(),
  request: DownloadRequestSchema,
  status: DownloadStatusSchema,
  progress: DownloadProgressSchema,
  outputPath: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** What a sniffed stream needs to be fetched the way the browser fetched it. */
export const RequestContextSchema = z.object({
  referer: z.string().optional(),
  userAgent: z.string().optional(),
  cookies: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const SetupStateSchema = z.enum(["ready", "installing", "failed"]);

/** The settings the extension may read and write. */
export const ExtensionSettingsSchema = z.object({
  extensionUi: z.enum(["popup", "overlay"]),
  keepRunning: z.boolean(),
  askQuality: z.boolean(),
  folder: z.string().optional(),
  quality: z.string().optional(),
});

export type SetupState = z.infer<typeof SetupStateSchema>;
export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;

export const ProbedFormatSchema = z.object({
  id: z.string(),
  label: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  container: z.string().optional(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  approxBytes: z.number().nonnegative().optional(),
});

/** What the core learned about a page URL from yt-dlp. */
export const ProbedMediaSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  thumbnail: z.string().optional(),
  durationSec: z.number().nonnegative().optional(),
  formats: z.array(ProbedFormatSchema),
});

export type ProbedFormat = z.infer<typeof ProbedFormatSchema>;
export type ProbedMedia = z.infer<typeof ProbedMediaSchema>;

// Compile-time guarantee that the runtime schemas match the shared domain types.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type _SchemaChecks = [
  Assert<Equals<z.infer<typeof MediaVariantSchema>, MediaVariant>>,
  Assert<Equals<z.infer<typeof MediaCandidateSchema>, MediaCandidate>>,
  Assert<Equals<z.infer<typeof DownloadRequestSchema>, DownloadRequest>>,
  Assert<Equals<z.infer<typeof DownloadProgressSchema>, DownloadProgress>>,
  Assert<Equals<z.infer<typeof DownloadJobSchema>, DownloadJob>>,
];
