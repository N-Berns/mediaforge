import { z } from "zod";
import {
  ContentKindSchema,
  DownloadJobSchema,
  DownloadProgressSchema,
  DownloadRequestSchema,
  ExtensionSettingsSchema,
  JobOriginSchema,
  LimitPresetSchema,
  MAX_STEPS,
  NoticeSchema,
  PlannedStepSchema,
  ProbedMediaSchema,
  RequestContextSchema,
  SetupStateSchema,
  StepSchema,
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

/** Upper bound on ids in one batch request; the manager can tick every row it lists. */
export const MAX_BATCH = 1000;

const jobIds = z.object({ jobIds: z.array(z.string()).min(1).max(MAX_BATCH) });

// Extension → host
export const HelloMessage = message(
  "hello",
  z.object({
    /** Who is talking. The core trusts the connection's handshake role, not this field. */
    client: JobOriginSchema.default("extension"),
    extensionVersion: z.string().optional(),
    browser: z.enum(["chrome", "firefox", "edge"]).optional(),
  }),
);
export const DownloadStartMessage = message(
  "download.start",
  DownloadRequestSchema.extend({
    context: RequestContextSchema.optional(),
    origin: JobOriginSchema.optional(),
    /** Terminal connections only: an exact yt-dlp format selector. */
    formatSelector: z.string().min(1).max(200).optional(),
    /** Terminal connections only: the steps expected for the chosen format. */
    plan: z.array(PlannedStepSchema).max(MAX_STEPS).optional(),
    /** Terminal connections only: what the chosen format saves; a subtitle request says so itself. */
    kind: ContentKindSchema.exclude(["subtitles"]).optional(),
  }),
);
/** Terminal connections only: re-read the settings file and apply "downloads at once". */
export const SettingsReloadMessage = message("settings.reload", z.object({}));
export const JobsListMessage = message("jobs.list", z.object({}));
export const JobsSubscribeMessage = message("jobs.subscribe", z.object({}));
export const JobsUnsubscribeMessage = message("jobs.unsubscribe", z.object({}));
export const SettingsGetMessage = message("settings.get", z.object({}));
export const SettingsSetMessage = message("settings.set", ExtensionSettingsSchema.partial());
export const DownloadCancelMessage = message("download.cancel", jobRef);
export const HostInfoMessage = message("host.info", z.object({}));
/**
 * Show downloads in the file manager: a finished job's file, or the download folder without a
 * job. Never a path: the host finds it in its own records, so a request cannot open anything else.
 */
export const FolderOpenMessage = message("folder.open", z.object({ jobId: z.string().optional() }));
/** Stop queued or running jobs and keep their partial files. */
export const DownloadPauseMessage = message("download.pause", jobIds);
/** Queue paused or failed jobs again under the same ids. */
export const DownloadResumeMessage = message("download.resume", jobIds);
/** Set (a preset) or clear (null) the speed cap of each job, outside the global split. */
export const DownloadSetLimitMessage = message(
  "download.setLimit",
  jobIds.extend({ preset: LimitPresetSchema.nullable() }),
);
/** Cancel active jobs, then drop the rows. Finished files stay on disk. */
export const JobsRemoveMessage = message("jobs.remove", jobIds);
/** Terminal connections only: cancel, move each job's recorded files to the trash, drop the rows. */
export const JobsTrashMessage = message(
  "jobs.trash",
  jobIds.extend({
    /** Set after the user confirmed: files too large for the Recycle Bin are deleted for good. */
    permanent: z.boolean().optional(),
  }),
);
/** Drop every completed row. */
export const JobsClearFinishedMessage = message("jobs.clearFinished", z.object({}));
/** Clear the session notice for every client. */
export const NoticeDismissMessage = message("notice.dismiss", z.object({}));
/** Bring the downloads manager forward: flash an open one (later: open a new window). */
export const AppOpenMessage = message("app.open", z.object({}));

// Host → extension
export const HelloAckMessage = message(
  "hello.ack",
  z.object({
    hostVersion: z.string(),
    ytDlp: z.object({ available: z.boolean(), version: z.string().optional() }),
    ffmpeg: z.object({ available: z.boolean(), version: z.string().optional() }),
    setup: SetupStateSchema,
    keepRunning: z.boolean(),
    notice: NoticeSchema.optional(),
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
    steps: z.array(StepSchema).max(MAX_STEPS).optional(),
    overallPercent: z.number().min(0).max(100).optional(),
  }),
);
export const DownloadCompletedMessage = message(
  "download.completed",
  jobRef.extend({ outputPath: z.string() }),
);
export const DownloadFailedMessage = message(
  "download.failed",
  jobRef.extend({
    error: z.string(),
    cancelled: z.boolean().optional(),
    /** The CLI exit code matching the failure. */
    errorKind: z.number().int().optional(),
  }),
);
export const ErrorMessage = message(
  "error",
  z.object({ code: z.string(), message: z.string(), replyTo: z.string().optional() }),
);

export const MediaProbeMessage = message("media.probe", z.object({ url: z.url() }));
export const MediaInfoMessage = message("media.info", ProbedMediaSchema);
export const FolderOpenedMessage = message("folder.opened", z.object({}));
/** The one reply to a batch request: the ids it could not act on, and why. */
export const JobsResultMessage = message(
  "jobs.result",
  z.object({
    failed: z.array(
      z.object({
        jobId: z.string(),
        message: z.string(),
        /** Why, for failures a client acts on: "too-large" asks the user to confirm `permanent`. */
        code: z.string().optional(),
      }),
    ),
  }),
);
/** A user paused this job; its partial files are kept. */
export const DownloadPausedMessage = message(
  "download.paused",
  jobRef.extend({ progress: DownloadProgressSchema.optional() }),
);
/** The session notice changed: dismissed, or none of its paused jobs remain. */
export const NoticeMessage = message("notice", z.object({ notice: NoticeSchema.optional() }));

/** What app.open did: flashed a manager, opened a new one, or found no way to. */
export const AppOpenedMessage = message(
  "app.opened",
  z.object({ mode: z.enum(["attention", "launched", "no-terminal"]) }),
);
/** Pushed to managers: the user asked for MediaForge from the browser. */
export const AppAttentionMessage = message("app.attention", z.object({}));

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
  SettingsReloadMessage,
  MediaProbeMessage,
  FolderOpenMessage,
  DownloadPauseMessage,
  DownloadResumeMessage,
  DownloadSetLimitMessage,
  JobsRemoveMessage,
  JobsTrashMessage,
  JobsClearFinishedMessage,
  NoticeDismissMessage,
  AppOpenMessage,
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
  FolderOpenedMessage,
  JobsResultMessage,
  DownloadPausedMessage,
  NoticeMessage,
  AppOpenedMessage,
  AppAttentionMessage,
]);

export type ExtensionToHostMessage = z.infer<typeof ExtensionToHostMessage>;
export type HostToExtensionMessage = z.infer<typeof HostToExtensionMessage>;
export type ProtocolMessage = ExtensionToHostMessage | HostToExtensionMessage;
export type MessageType = ProtocolMessage["type"];
