import type { ExtensionToHostMessage, HostToExtensionMessage } from "@mediaforge/shared-protocol";
import type { EngineJob } from "../engine/index.ts";
import type { ExitCode } from "../exit-codes.ts";
import { type CoreClient, CoreLostError } from "./client.ts";

export type StartPayload = Extract<ExtensionToHostMessage, { type: "download.start" }>["payload"];

export interface WatchedJob {
  readonly id: string;
  readonly settled: Promise<EngineJob>;
  cancel(): Promise<void>;
}

const jobIdOf = (message: HostToExtensionMessage): string | undefined =>
  message.type === "download.progress" ||
  message.type === "download.completed" ||
  message.type === "download.failed" ||
  message.type === "download.paused"
    ? message.payload.jobId
    : undefined;

/** Fold one core frame into the job as the terminal sees it. */
export function applyFrame(job: EngineJob, message: HostToExtensionMessage): EngineJob {
  const now = Date.now();
  switch (message.type) {
    case "download.progress": {
      const { status, progress, steps, overallPercent } = message.payload;
      return {
        ...job,
        status,
        progress,
        ...(steps && { steps }),
        ...(overallPercent !== undefined && { overallPercent }),
        updatedAt: now,
      };
    }
    case "download.completed":
      return {
        ...job,
        status: "completed",
        outputPath: message.payload.outputPath,
        overallPercent: 100,
        updatedAt: now,
      };
    case "download.failed": {
      const { cancelled, error, errorKind } = message.payload;
      return {
        ...job,
        status: cancelled ? "cancelled" : "failed",
        ...(!cancelled && { error }),
        ...(errorKind !== undefined && { errorKind: errorKind as ExitCode }),
        updatedAt: now,
      };
    }
    case "download.paused":
      return {
        ...job,
        status: "paused",
        ...(message.payload.progress && { progress: message.payload.progress }),
        updatedAt: now,
      };
    default:
      return job;
  }
}

/** States that end a watch. Paused: someone else stopped it; it continues only when resumed. */
const FINAL = new Set(["completed", "failed", "cancelled", "paused"]);

/**
 * Submit a download to the core and follow it. `onUpdate` sees every change; `settled` resolves
 * with the final job, or rejects with CoreLostError if the core goes away first.
 */
export async function startJob(
  client: CoreClient,
  payload: StartPayload,
  onUpdate: (job: EngineJob) => void,
): Promise<WatchedJob> {
  let job: EngineJob | undefined;
  /** Frames that arrive between the reply and the listener taking over; never lost. */
  const early: HostToExtensionMessage[] = [];
  let resolveSettled: (job: EngineJob) => void = () => {};
  let rejectSettled: (error: Error) => void = () => {};
  const settled = new Promise<EngineJob>((res, rej) => {
    resolveSettled = res;
    rejectSettled = rej;
  });
  // A watcher that is never awaited must not raise an unhandled rejection.
  settled.catch(() => {});

  const take = (message: HostToExtensionMessage) => {
    if (!job) {
      early.push(message);
      return;
    }
    if (jobIdOf(message) !== job.id) return;
    job = applyFrame(job, message);
    onUpdate(job);
    if (FINAL.has(job.status)) {
      stopPush();
      stopClose();
      resolveSettled(job);
    }
  };
  const stopPush = client.onPush(take);
  const stopClose = client.onClose(() => {
    if (job && !FINAL.has(job.status)) rejectSettled(new CoreLostError());
  });

  let reply: HostToExtensionMessage;
  let id: string | undefined;
  try {
    reply = await client.request("download.start", payload);
    id = jobIdOf(reply);
    if (!id) throw new Error(`Unexpected reply to download.start: ${reply.type}`);
  } catch (error) {
    // Nothing is watched: leave no listener buffering pushes on a long-lived client.
    stopPush();
    stopClose();
    throw error;
  }
  const now = Date.now();
  job = {
    id,
    request: { candidate: payload.candidate, profileId: payload.profileId },
    status: "queued",
    progress: { bytesDownloaded: 0 },
    createdAt: now,
    updatedAt: now,
  };
  take(reply);
  for (const message of early.splice(0)) take(message);

  return {
    id,
    settled,
    cancel: async () => {
      // The core answers only a cancel it cannot honor (job already finished); `settled` says how it ended.
      client.notify("download.cancel", { jobId: id });
    },
  };
}
