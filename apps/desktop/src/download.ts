import type { Tool } from "@mediaforge/binary-resolver";
import { BUILTIN_PROFILES, DEFAULT_PROFILE_ID, getProfile } from "@mediaforge/media-profiles";
import type { MediaCandidate } from "@mediaforge/shared-types";
import type { Io } from "./commands.ts";
import { DownloadEngine, type EngineJob } from "./engine/index.ts";
import { defaultOutputDir } from "./engine/paths.ts";
import { CliError, ExitCode } from "./exit-codes.ts";
import { detectJsRuntimeArgs } from "./js-runtime.ts";
import { kindOfProfile, withKindFolder } from "./kind-folder.ts";
import { parseCommandArgs, parseHttpUrl } from "./parse.ts";
import { createProgressView } from "./progress-view.ts";
import { defaultSettingsStore, type SettingsStore } from "./settings.ts";
import { withUpdateHint } from "./stale-extractor.ts";
import { defaultEnsureTools } from "./tool-runtime.ts";

export const PROFILE_ENV = "MEDIAFORGE_PROFILE";
export const OUTPUT_DIR_ENV = "MEDIAFORGE_OUTPUT_DIR";

const OPTIONS = {
  profile: { type: "string", short: "p" },
  output: { type: "string", short: "o" },
  filename: { type: "string" },
  quiet: { type: "boolean", short: "q" },
  help: { type: "boolean", short: "h" },
} as const;

export function downloadUsage(): string {
  const profiles = BUILTIN_PROFILES.map((p) => `  ${p.id.padEnd(14)}${p.name}`).join("\n");
  return [
    "Usage: mediaforge download <url> [options]",
    "",
    "Options:",
    `  -p, --profile <id>     Output profile (default: ${DEFAULT_PROFILE_ID}, or ${PROFILE_ENV})`,
    `  -o, --output <dir>     Output directory (default: ~/Downloads/MediaForge, or ${OUTPUT_DIR_ENV})`,
    "      --filename <name>  File name without extension (default: the media title)",
    "  -q, --quiet            No progress output",
    "  -h, --help             Show this help",
    "",
    "Profiles:",
    profiles,
    "",
    "Unless turned off in Settings, files go into a Video or Audio folder inside the output directory.",
    "",
    "Order of precedence: flags, then environment variables, then saved settings",
    "(from the interactive menu), then the built-in defaults.",
    "",
  ].join("\n");
}

export interface DownloadDeps {
  createEngine: (
    onUpdate: (job: EngineJob) => void,
    options?: { maxConcurrent?: number },
  ) => DownloadEngine;
  env: Record<string, string | undefined>;
  isTTY: boolean;
  /** Register a Ctrl+C handler; returns a function that removes it. */
  onInterrupt: (handler: () => void) => () => void;
  /** Saved user settings (default folder and quality). */
  settings: SettingsStore;
  /**
   * Make sure the tools exist before work starts. In a terminal it offers to download them;
   * otherwise it fails with exit 3 and `run: mediaforge setup`.
   */
  ensureTools?: (tools: Tool[]) => Promise<void>;
}

export const defaultDownloadDeps = (): DownloadDeps => ({
  createEngine: (onUpdate, options) =>
    new DownloadEngine({ onUpdate, jsRuntimeArgs: detectJsRuntimeArgs, ...options }),
  env: process.env,
  ensureTools: defaultEnsureTools(),
  isTTY: Boolean(process.stderr.isTTY),
  onInterrupt: (handler) => {
    process.on("SIGINT", handler);
    return () => void process.off("SIGINT", handler);
  },
  settings: defaultSettingsStore(),
});

/** A bare URL has no detection data, so the candidate only carries what the engine needs. */
export const candidateFor = (url: string, kind: "video" | "audio"): MediaCandidate => ({
  id: url,
  pageUrl: url,
  url,
  kind,
  streamType: "progressive",
  source: "dom",
  variants: [],
  detectedAt: Date.now(),
});

export async function runDownload(
  args: string[],
  io: Io,
  deps: DownloadDeps = defaultDownloadDeps(),
): Promise<ExitCode> {
  const { values, positionals } = parseCommandArgs(args, OPTIONS, downloadUsage());
  if (values.help) {
    io.stdout(downloadUsage());
    return ExitCode.Ok;
  }
  if (positionals.length !== 1) {
    throw new CliError(
      `Expected exactly one URL, got ${positionals.length}.\n${downloadUsage()}`,
      ExitCode.Usage,
    );
  }

  const url = parseHttpUrl(positionals[0] as string);
  const settings = await deps.settings.load();
  const profileId =
    values.profile ?? deps.env[PROFILE_ENV] ?? settings.quality ?? DEFAULT_PROFILE_ID;
  const profile = getProfile(profileId);
  if (!profile) {
    const ids = BUILTIN_PROFILES.map((p) => p.id).join(", ");
    throw new CliError(`Unknown profile: ${profileId}. Available: ${ids}`, ExitCode.Usage);
  }
  await deps.ensureTools?.(["yt-dlp", "ffmpeg"]);

  const view = createProgressView({
    write: io.stderr,
    isTTY: deps.isTTY,
    quiet: values.quiet ?? false,
  });
  const engine = deps.createEngine((job) => view.update(job));
  const baseDir = values.output ?? deps.env[OUTPUT_DIR_ENV] ?? settings.folder;
  // The type subfolder needs a concrete folder, so name the built-in default when none is set.
  const outputDir = settings.sortByType
    ? withKindFolder(baseDir ?? defaultOutputDir(), kindOfProfile(profile), true)
    : baseDir;
  const { id } = engine.submit({
    candidate: candidateFor(url, profile.kind),
    profileId,
    ...(outputDir && { outputDir }),
    ...(values.filename && { filename: values.filename }),
  });

  const stopListening = deps.onInterrupt(() => engine.cancel(id));
  const job = await engine.whenSettled(id);
  stopListening();
  view.finish();

  if (job?.status === "completed" && job.outputPath) {
    io.stdout(`${job.outputPath}\n`);
    return ExitCode.Ok;
  }
  if (job?.status === "cancelled") {
    io.stderr("Cancelled.\n");
    return ExitCode.Cancelled;
  }
  throw new CliError(
    withUpdateHint(job?.error ?? "Download failed."),
    job?.errorKind ?? ExitCode.Failure,
  );
}
