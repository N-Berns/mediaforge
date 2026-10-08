import type { DownloadRequest, OutputProfile } from "@mediaforge/shared-types";
import { stripExtension } from "./paths.ts";

export const PROGRESS_PREFIX = "MFPROGRESS";
export const POSTPROCESS_PREFIX = "MFPOST";
export const FILE_PREFIX = "MFFILE";

/** How yt-dlp ranks formats: tallest first, then mp4/m4a. The format list is requested in this order too. */
export const FORMAT_SORT = "res,ext:mp4:m4a";

export interface BuildArgsInput {
  request: DownloadRequest;
  profile: OutputProfile;
  /** Private directory yt-dlp writes into; the engine moves the result out afterwards. */
  workDir: string;
  ffmpegPath: string;
  /** Exact yt-dlp format selector (e.g. "137+ba/137"); replaces the profile's own choice. */
  formatSelector?: string;
  /** File ffmpeg writes its progress to while merging or converting. */
  ffmpegProgressFile?: string;
  /** `--js-runtimes ...` flags from `jsRuntimeArgs()`; empty when yt-dlp can find its own. */
  jsRuntimeArgs?: string[];
}

/** yt-dlp post-processors that run ffmpeg over the whole file, so their progress is worth showing. */
export const FFMPEG_POSTPROCESSORS = ["Merger", "ExtractAudio", "VideoConvertor", "VideoRemuxer"];

/**
 * Ask each ffmpeg step to write `out_time_us=` lines to a file. yt-dlp splits this value like a
 * shell would, so the path uses forward slashes and quotes. Paths that cannot be quoted safely
 * simply go without merge progress.
 */
function ffmpegProgressArgs(file: string | undefined): string[] {
  if (!file || file.includes('"')) return [];
  const path = file.replaceAll("\\", "/");
  return FFMPEG_POSTPROCESSORS.flatMap((name) => [
    "--postprocessor-args",
    `${name}+ffmpeg_o:-progress "file:${path}" -nostats`,
  ]);
}

/** Swap the profile's `-f` for an explicit selector and drop the now-pointless sort. */
function withSelector(args: string[], selector: string): string[] {
  const out = [...args];
  const f = out.indexOf("-f");
  if (f >= 0) out[f + 1] = selector;
  const sort = out.indexOf("-S");
  if (sort >= 0) out.splice(sort, 2);
  return out;
}

function formatArgs(profile: OutputProfile, maxHeight: number | undefined): string[] {
  if (profile.kind === "audio") {
    const args = [
      "-f",
      profile.container === "m4a" ? "ba[ext=m4a]/ba/b" : "ba/b",
      "-x",
      "--audio-format",
      profile.container,
    ];
    if (profile.audioBitrate) args.push("--audio-quality", `${profile.audioBitrate}K`);
    return args;
  }

  const cap = maxHeight ? `[height<=${maxHeight}]` : "";
  if (profile.postprocess === "none") return ["-f", `b${cap}`];
  const args = ["-f", `bv*${cap}+ba/b${cap}`, "-S", FORMAT_SORT];
  // Transcoding re-encodes after the merge; merging only remuxes into the container.
  args.push(profile.postprocess === "transcode" ? "--recode-video" : "--merge-output-format");
  args.push(profile.container);
  return args;
}

/** Build the yt-dlp command line for one download. Never goes through a shell. */
export function buildYtDlpArgs({
  request,
  profile,
  workDir,
  ffmpegPath,
  formatSelector,
  ffmpegProgressFile,
  jsRuntimeArgs,
}: BuildArgsInput): string[] {
  const url = request.candidate.url;
  const maxHeight = profile.maxHeight;
  const name = request.filename
    ? stripExtension(request.filename, profile.container).replaceAll("%", "%%")
    : "%(title)s";

  return [
    "--no-playlist",
    ...(jsRuntimeArgs ?? []),
    "--newline",
    "--progress",
    "--windows-filenames",
    "--ffmpeg-location",
    ffmpegPath,
    "--progress-template",
    `download:${PROGRESS_PREFIX} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s %(info.format_id)s %(info.vcodec)s %(info.acodec)s`,
    "--progress-template",
    `postprocess:${POSTPROCESS_PREFIX} %(progress.status)s %(progress.postprocessor)s %(info.duration)s`,
    "--print",
    `after_move:${FILE_PREFIX} %(filepath)s`,
    ...ffmpegProgressArgs(ffmpegProgressFile),
    "--paths",
    workDir,
    "-o",
    `${name}.%(ext)s`,
    ...(formatSelector
      ? withSelector(formatArgs(profile, maxHeight), formatSelector)
      : formatArgs(profile, maxHeight)),
    // End of options: a URL starting with "-" must never be read as a flag.
    "--",
    url,
  ];
}
