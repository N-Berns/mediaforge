import { type ResolveTool, requireTool, resolveTool } from "./binaries.ts";
import type { Io } from "./commands.ts";
import { FORMAT_SORT } from "./engine/args.ts";
import { type ProcessRunner, runProcess } from "./engine/process.ts";
import { classifyFailure } from "./engine/progress.ts";
import { CliError, ExitCode } from "./exit-codes.ts";
import { parseCommandArgs, parseHttpUrl } from "./parse.ts";
import { formatBytes } from "./progress-view.ts";

const USAGE = "Usage: mediaforge formats <url>";

export interface RawFormat {
  format_id?: string;
  ext?: string;
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  /** Audio bitrate in kbps. */
  abr?: number;
  /** Total bitrate in kbps. */
  tbr?: number;
  /** "https", "m3u8_native", ... */
  protocol?: string;
  filesize?: number;
  filesize_approx?: number;
}

export interface MediaInfo {
  title?: string;
  uploader?: string;
  channel?: string;
  /** Seconds. */
  duration?: number;
  formats?: RawFormat[];
}

/** "avc1.640028" -> "avc1"; "none" or missing -> "-". */
export const codec = (value: string | undefined) =>
  !value || value === "none" ? "-" : (value.split(".")[0] ?? value);

function resolution(f: RawFormat): string {
  if (f.height) return `${f.width ?? "?"}x${f.height}`;
  return f.vcodec === "none" ? "audio only" : "-";
}

export function size(f: RawFormat): string {
  if (f.filesize) return formatBytes(f.filesize);
  return f.filesize_approx ? `~${formatBytes(f.filesize_approx)}` : "-";
}

/** Render yt-dlp's format list as an aligned table (storyboards are left out). */
export function formatFormatsTable(info: MediaInfo): string {
  const rows = (info.formats ?? [])
    .filter((f) => f.ext !== "mhtml")
    .map((f) => [
      f.format_id ?? "-",
      f.ext ?? "-",
      resolution(f),
      f.fps ? String(f.fps) : "-",
      codec(f.vcodec),
      codec(f.acodec),
      size(f),
    ]);
  const table = [["ID", "EXT", "RESOLUTION", "FPS", "VIDEO", "AUDIO", "SIZE"], ...rows];
  const widths = table[0]?.map((_, i) => Math.max(...table.map((r) => r[i]?.length ?? 0))) ?? [];
  const lines = table.map((r) =>
    r
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd(),
  );
  return `${info.title ? `${info.title}\n\n` : ""}${lines.join("\n")}\n`;
}

export interface FormatsDeps {
  resolve: ResolveTool;
  run: ProcessRunner;
}

const defaultFormatsDeps = (): FormatsDeps => ({ resolve: resolveTool, run: runProcess });

/** Ask yt-dlp (`-J`) for a URL's title and formats. Throws a `CliError` on failure. */
export async function fetchMediaInfo(
  url: string,
  deps: FormatsDeps = defaultFormatsDeps(),
): Promise<MediaInfo> {
  const ytDlp = await requireTool("yt-dlp", deps.resolve);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const { exitCode } = await deps.run(
    ytDlp.path,
    // Same sort as a real download, so the list comes back worst to best exactly as yt-dlp ranks it.
    ["-J", "--no-playlist", "--no-warnings", "-S", FORMAT_SORT, "--", url],
    { onStdoutLine: (l) => stdout.push(l), onStderrLine: (l) => stderr.push(l) },
    new AbortController().signal,
  );
  if (exitCode !== 0) {
    const failure = classifyFailure(stderr, exitCode);
    throw new CliError(failure.message, failure.exitCode);
  }
  try {
    return JSON.parse(stdout.join("\n")) as MediaInfo;
  } catch {
    throw new CliError("Could not read yt-dlp's format list.", ExitCode.Failure);
  }
}

export async function runFormats(
  args: string[],
  io: Io,
  deps: FormatsDeps = defaultFormatsDeps(),
): Promise<ExitCode> {
  const { values, positionals } = parseCommandArgs(
    args,
    { help: { type: "boolean", short: "h" } },
    USAGE,
  );
  if (values.help) {
    io.stdout(`${USAGE}\n\nList the formats yt-dlp finds for a URL (informational).\n`);
    return ExitCode.Ok;
  }
  if (positionals.length !== 1) {
    throw new CliError(
      `Expected exactly one URL, got ${positionals.length}.\n${USAGE}`,
      ExitCode.Usage,
    );
  }
  const info = await fetchMediaInfo(parseHttpUrl(positionals[0] as string), deps);
  io.stdout(formatFormatsTable(info));
  return ExitCode.Ok;
}
