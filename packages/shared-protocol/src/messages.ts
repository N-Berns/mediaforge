import { z } from "zod";
import {
  DownloadJobSchema,
  DownloadProgressSchema,
  DownloadRequestSchema,
  ExtensionSettingsSchema,
  ProbedMediaSchema,
  RequestContextSchema,
  SetupStateSchema,
} from "./schemas.ts";
import { PROTOCOL_VERSION } from "./version.ts";

/** Builds an envelope schema `{ v, id, type, payload }` for one message type. */
const message = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    /** Correlates requests with responses and progress events. */
    id: z.string(),
    type: z.literal(type),
    payload,
  });

const jobRef = z.object({ jobId: z.string() });

// Extension → host
export const HelloMessage = message(
  "hello",
  z.object({ extensionVersion: z.string(), browser: z.enum(["chrome", "firefox", "edge"]) }),
);
export const DownloadStartMessage = message(
  "download.start",
  DownloadRequestSchema.extend({ context: RequestContextSchema.optional() }),
);
export const JobsListMessage = message("jobs.list", z.object({}));
export const JobsSubscribeMessage = message("jobs.subscribe", z.object({}));
export const JobsUnsubscribeMessage = message("jobs.unsubscribe", z.object({}));
export const SettingsGetMessage = message("settings.get", z.object({}));
export const SettingsSetMessage = message("settings.set", ExtensionSettingsSchema.partial());
export const DownloadCancelMessage = message("download.cancel", jobRef);
export const HostInfoMessage = message("host.info", z.object({}));

// Host → extension
export const HelloAckMessage = message(
  "hello.ack",
  z.object({
    hostVersion: z.string(),
    ytDlp: z.object({ available: z.boolean(), version: z.string().optional() }),
    ffmpeg: z.object({ available: z.boolean(), version: z.string().optional() }),
    setup: SetupStateSchema,
    keepRunning: z.boolean(),
  }),
);
export const JobsSnapshotMessage = message(
  "jobs.snapshot",
  z.object({ jobs: z.array(DownloadJobSchema) }),
);
export const SettingsValueMessage = message("settings.value", ExtensionSettingsSchema);
export const SetupProgressMessage = message(
  "setup.progress",
  z.object({
    state: SetupStateSchema,
    tool: z.enum(["yt-dlp", "ffmpeg", "deno"]).optional(),
    phase: z.string().optional(),
    percent: z.number().min(0).max(100).optional(),
    error: z.string().optional(),
  }),
);
export const DownloadProgressMessage = message(
  "download.progress",
  jobRef.extend({
    status: z.enum(["queued", "downloading", "processing"]),
    progress: DownloadProgressSchema,
  }),
);
export const DownloadCompletedMessage = message(
  "download.completed",
  jobRef.extend({ outputPath: z.string() }),
);
export const DownloadFailedMessage = message(
  "download.failed",
  jobRef.extend({ error: z.string(), cancelled: z.boolean().optional() }),
);
export const ErrorMessage = message(
  "error",
  z.object({ code: z.string(), message: z.string(), replyTo: z.string().optional() }),
);

export const MediaProbeMessage = message("media.probe", z.object({ url: z.url() }));
export const MediaInfoMessage = message("media.info", ProbedMediaSchema);

export const ExtensionToHostMessage = z.discriminatedUnion("type", [
  HelloMessage,
  DownloadStartMessage,
  DownloadCancelMessage,
  HostInfoMessage,
  JobsListMessage,
  JobsSubscribeMessage,
  JobsUnsubscribeMessage,
  SettingsGetMessage,
  SettingsSetMessage,
  MediaProbeMessage,
]);
export const HostToExtensionMessage = z.discriminatedUnion("type", [
  HelloAckMessage,
  DownloadProgressMessage,
  DownloadCompletedMessage,
  DownloadFailedMessage,
  ErrorMessage,
  JobsSnapshotMessage,
  SettingsValueMessage,
  SetupProgressMessage,
  MediaInfoMessage,
]);

export type ExtensionToHostMessage = z.infer<typeof ExtensionToHostMessage>;
export type HostToExtensionMessage = z.infer<typeof HostToExtensionMessage>;
export type ProtocolMessage = ExtensionToHostMessage | HostToExtensionMessage;
export type MessageType = ProtocolMessage["type"];
