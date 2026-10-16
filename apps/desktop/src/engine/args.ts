import type { DownloadRequest, OutputProfile } from "@mediaforge/shared-types";
import { stripExtension } from "./paths.ts";

export const PROGRESS_PREFIX = "MFPROGRESS";
export const POSTPROCESS_PREFIX = "MFPOST";
export const FILE_PREFIX = "MFFILE";

/** How yt-dlp ranks formats: tallest first, then mp4/m4a. The format list is requested in this order too. */
export const FORMAT_SORT = "res,ext:mp4:m4a";

/** What a sniffed stream needs to be fetched the way the browser fetched it. */
export interface RequestContext {
  referer?: string;
  userAgent?: string;
  cookies?: string;
  headers?: Record<string, string>;
}

const MAX_CONTEXT_VALUE = 8192;
const MAX_CONTEXT_TOTAL = 32768;
const MAX_HEADER_NAME = 256;
const MAX_HEADERS = 32;
/** True for any C0 control except TAB, and for DEL. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "cookie",
  "referer",
  "user-agent",
  "proxy-authorization",
  "te",
  "upgrade",
  "expect",
  "keep-alive",
  "trailer",
]);

/** Why this context must not be used, or undefined when it is safe to pass to yt-dlp. */
export function contextError(context: RequestContext): string | undefined {
  const headers = Object.entries(context.headers ?? {});
  if (headers.length > MAX_HEADERS) return "Too many request headers.";
  const values = [
    context.referer,
    context.userAgent,
    context.cookies,
    ...headers.map(([, v]) => v),
  ];
  let total = 0;
  for (const value of values) {
    if (value === undefined) continue;
    if (value.length > MAX_CONTEXT_VALUE) return "A request header value is too long.";
    if (hasControlChar(value)) {
      return "A request header value contains a control character or line break.";
    }
    total += value.length;
  }
  if (total > MAX_CONTEXT_TOTAL) return "The request headers are too large.";
  for (const [name] of headers) {
    if (name.length > MAX_HEADER_NAME) return "A request header name is too long.";
    if (!HEADER_NAME.test(name)) return `Invalid header name: ${name.slice(0, 40)}`;
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      return `Header not allowed: ${name.slice(0, 40)}`;
    }
  }
  return undefined;
}

export function contextArgs(context: RequestContext | undefined): string[] {
  if (!context) return [];
  const args: string[] = [];
  if (context.referer) args.push("--referer", context.referer);
  if (context.userAgent) args.push("--user-agent", context.userAgent);
  if (context.cookies) args.push("--add-header", `Cookie:${context.cookies}`);
  for (const [name, value] of Object.entries(context.headers ?? {})) {
    args.push("--add-header", `${name}:${value}`);
  }
  return args;
}

const MIN_SECRET_LENGTH = 6;
const MIN_PART_LENGTH = 8;

/**
 * Values that must never reach a record, a log or an error message: whole cookie and header
 * values, plus the pieces a tool might echo alone (each cookie pair, its value, an auth token).
 */
export function contextSecrets(context: RequestContext | undefined): string[] {
  if (!context) return [];
  const found = new Set<string>();
  const addWhole = (value: string | undefined) => {
    if (value && value.length >= MIN_SECRET_LENGTH) found.add(value);
  };
  const addPart = (value: string) => {
    const part = value.trim();
    if (part.length >= MIN_PART_LENGTH) found.add(part);
  };
  addWhole(context.cookies);
  for (const pair of (context.cookies ?? "").split(";")) {
    addPart(pair);
    const eq = pair.indexOf("=");
    if (eq >= 0) addPart(pair.slice(eq + 1));
  }
  for (const value of Object.values(context.headers ?? {})) {
    addWhole(value);
    const space = value.trim().indexOf(" ");
    if (space > 0) addPart(value.trim().slice(space + 1));
  }
  return [...found];
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  const longestFirst = [...secrets].sort((a, b) => b.length - a.length);
  for (const secret of longestFirst) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join("[redacted]");
  }
  return out;
}

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
  /** Referer, user agent, cookies and headers to send with the download. */
  context?: RequestContext;
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

/** Escape a language code so yt-dlp's `--sub-langs` reads it literally. */
const escapeLang = (lang: string): string => lang.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");

/** Save one subtitle track and nothing else. */
function subtitleArgs(subtitle: NonNullable<DownloadRequest["subtitle"]>): string[] {
  return [
    "--skip-download",
    subtitle.auto ? "--write-auto-subs" : "--write-subs",
    "--sub-langs",
    escapeLang(subtitle.lang),
    "--convert-subs",
    subtitle.format,
  ];
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
  context,
}: BuildArgsInput): string[] {
  const url = request.candidate.url;
  const maxHeight = profile.maxHeight;
  const name = request.filename
    ? stripExtension(request.filename, profile.container).replaceAll("%", "%%")
    : "%(title)s";

  return [
    "--no-playlist",
    // Resume partial files left by a paused or failed try (yt-dlp's default, stated so it holds).
    "--continue",
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
    ...contextArgs(context),
    "--paths",
    workDir,
    "-o",
    `${name}.%(ext)s`,
    ...(request.subtitle
      ? subtitleArgs(request.subtitle)
      : formatSelector
        ? withSelector(formatArgs(profile, maxHeight), formatSelector)
        : formatArgs(profile, maxHeight)),
    // End of options: a URL starting with "-" must never be read as a flag.
    "--",
    url,
  ];
}
