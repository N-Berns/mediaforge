import type { DownloadProgress } from "@mediaforge/shared-types";
import { ExitCode } from "../exit-codes.ts";
import { FILE_PREFIX, POSTPROCESS_PREFIX, PROGRESS_PREFIX } from "./args.ts";

/** yt-dlp prints "NA" (or "None") for fields it does not know. */
const num = (value: string | undefined): number | undefined => {
  if (value === undefined || value === "NA" || value === "None") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/** Which stream a progress line belongs to. */
export interface StreamInfo {
  id: string;
  video: boolean;
  audio: boolean;
}

export interface ParsedProgress {
  progress: DownloadProgress;
  /** Missing when yt-dlp did not report the format. */
  stream?: StreamInfo;
}

const PROGRESS_LINE = new RegExp(
  `^${PROGRESS_PREFIX} (\\S+) (\\S+) (\\S+) (\\S+) (\\S+)(?: (\\S+) (\\S+) (\\S+))?$`,
);

const hasCodec = (value: string | undefined) =>
  value !== undefined && value !== "none" && value !== "NA" && value !== "None";

/** A progress line with the stream it belongs to. */
export function parseProgress(line: string): ParsedProgress | undefined {
  const match = PROGRESS_LINE.exec(line.trim());
  const progress = parseProgressLine(line);
  if (!match || !progress) return undefined;
  const [, , , , , , id, vcodec, acodec] = match;
  if (!id || id === "NA") return { progress };
  return { progress, stream: { id, video: hasCodec(vcodec), audio: hasCodec(acodec) } };
}

export function parseProgressLine(line: string): DownloadProgress | undefined {
  const match = PROGRESS_LINE.exec(line.trim());
  if (!match) return undefined;
  const bytesDownloaded = num(match[1]) ?? 0;
  const totalBytes = num(match[2]) ?? num(match[3]);
  const speed = num(match[4]);
  const etaSec = num(match[5]);
  return {
    bytesDownloaded,
    ...(totalBytes !== undefined && { totalBytes }),
    ...(speed !== undefined && { speed }),
    ...(etaSec !== undefined && { etaSec }),
    ...(totalBytes ? { percent: Math.min(100, (bytesDownloaded / totalBytes) * 100) } : {}),
  };
}

export interface PostprocessEvent {
  status: "started" | "finished";
  /** yt-dlp's post-processor name, e.g. "Merger" or "ExtractAudio". */
  name?: string;
  /** Media length in seconds, used to turn ffmpeg's position into a percent. */
  duration?: number;
}

/** A post-processing start or finish (merge, audio extraction, recode, file moves). */
export function parsePostprocessLine(line: string): PostprocessEvent | undefined {
  const match = new RegExp(
    `^${POSTPROCESS_PREFIX} (started|finished)(?: (\\S+))?(?: (\\S+))?$`,
  ).exec(line.trim());
  if (!match) return undefined;
  const name = match[2] && match[2] !== "NA" ? match[2] : undefined;
  const duration = num(match[3]);
  return {
    status: match[1] as PostprocessEvent["status"],
    ...(name && { name }),
    ...(duration !== undefined && { duration }),
  };
}

/** True when yt-dlp starts a post-processing step (merge, audio extraction, recode). */
export const isPostprocessStart = (line: string): boolean =>
  parsePostprocessLine(line)?.status === "started";

/** Seconds ffmpeg has written so far, from the newest `out_time_us=` in its progress file. */
export function parseFfmpegProgress(text: string): { seconds?: number; done: boolean } {
  const times = [...text.matchAll(/^out_time_us=(\d+)\s*$/gm)];
  const last = times.at(-1)?.[1];
  return {
    ...(last !== undefined && { seconds: Number(last) / 1_000_000 }),
    done: /^progress=end\s*$/m.test(text),
  };
}

/** The final output path yt-dlp prints once the file is in place. */
export function parseFileLine(line: string): string | undefined {
  const prefix = `${FILE_PREFIX} `;
  const trimmed = line.trim();
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : undefined;
}

export interface Failure {
  exitCode: ExitCode;
  message: string;
}

const FILESYSTEM = /no space left|not enough space|errno 28|errno 13|permission denied|disk full/i;
const UNSUPPORTED = /unsupported url/i;
const NETWORK =
  /unable to download|urlopen error|getaddrinfo|name resolution|http error \d+|timed out|connection (reset|refused|aborted)|network is unreachable|transporterror/i;

/** Map yt-dlp's stderr to one of our exit codes plus a readable message. */
export function classifyFailure(stderr: string[], processExitCode: number | null): Failure {
  const text = stderr.join("\n");
  const errorLine = [...stderr].reverse().find((l) => l.startsWith("ERROR:"));
  const message =
    errorLine?.replace(/^ERROR:\s*/, "").trim() ||
    stderr.at(-1)?.trim() ||
    `yt-dlp exited with code ${processExitCode}`;

  if (UNSUPPORTED.test(text)) return { exitCode: ExitCode.UnsupportedSite, message };
  if (FILESYSTEM.test(text)) return { exitCode: ExitCode.FileSystem, message };
  if (NETWORK.test(text)) return { exitCode: ExitCode.Network, message };
  return { exitCode: ExitCode.Failure, message };
}
