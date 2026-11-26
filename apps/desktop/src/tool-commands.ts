import {
  ALL_TOOLS,
  type InstallResult,
  type Tool,
  type ToolCheck,
  YTDLP_CHANNELS,
  type YtDlpChannel,
} from "@mediaforge/binary-resolver";
import type { Io } from "./commands.ts";
import { CliError, ExitCode } from "./exit-codes.ts";
import { parseCommandArgs } from "./parse.ts";
import { defaultSettingsStore, type SettingsStore } from "./settings.ts";
import {
  type AcquireOutcome,
  acquireTool,
  createInstallPrinter,
  defaultToolRuntime,
  type ToolRuntime,
  toCliError,
  tryResolve,
} from "./tool-runtime.ts";

const SETUP_USAGE = "Usage: mediaforge setup [--yes] [--tools yt-dlp,ffmpeg,deno]";

export function setupUsage(): string {
  return [
    SETUP_USAGE,
    "",
    "Download yt-dlp, ffmpeg and deno (the JavaScript runtime YouTube needs) when they are missing. Tools that are already available are left alone.",
    "",
    "Options:",
    "  -y, --yes            Accepted for scripts. Setup never asks questions.",
    "      --tools <list>   Only these tools, comma separated (default: yt-dlp,ffmpeg,deno)",
    "  -h, --help           Show this help",
    "",
  ].join("\n");
}

/** Read `--tools`: a comma list of known tool names, or every tool when absent. */
export function parseToolList(value: string | undefined): Tool[] {
  if (value === undefined) return [...ALL_TOOLS];
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !ALL_TOOLS.includes(name as Tool));
  if (names.length === 0 || unknown.length > 0) {
    throw new CliError(
      `Unknown tool: ${unknown.join(", ") || "(none given)"}. Choose from: ${ALL_TOOLS.join(", ")}.\n${SETUP_USAGE}`,
      ExitCode.Usage,
    );
  }
  return [...new Set(names)] as Tool[];
}

function summaryLine(outcome: AcquireOutcome): string {
  const name = outcome.tool.padEnd(6);
  switch (outcome.status) {
    case "present":
      return `${name}  already available  ${outcome.version ?? "unknown version"}  (${outcome.source})  ${outcome.path}`;
    case "installed":
      return `${name}  downloaded  ${outcome.version}  ${outcome.path}`;
  }
}

const SETUP_OPTIONS = {
  yes: { type: "boolean", short: "y" },
  tools: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export async function runSetup(
  args: string[],
  io: Io,
  rt: ToolRuntime = defaultToolRuntime(),
): Promise<ExitCode> {
  const { values, positionals } = parseCommandArgs(args, SETUP_OPTIONS, SETUP_USAGE);
  if (values.help) {
    io.stdout(setupUsage());
    return ExitCode.Ok;
  }
  if (positionals.length > 0) {
    throw new CliError(`Unexpected argument: ${positionals[0]}\n${SETUP_USAGE}`, ExitCode.Usage);
  }

  const tools = parseToolList(values.tools);
  const onProgress = createInstallPrinter(io.stderr, rt.interactive);
  const lines: string[] = [];
  for (const tool of tools) {
    const outcome = await acquireTool(tool, rt, { onProgress });
    lines.push(summaryLine(outcome));
  }
  io.stdout(`${lines.join("\n")}\n`);
  return ExitCode.Ok;
}

const UPDATE_USAGE = "Usage: mediaforge update [--channel stable|nightly|master] [--check]";

export function updateUsage(): string {
  return [
    UPDATE_USAGE,
    "",
    "Download the latest yt-dlp from your channel into MediaForge's tool folder.",
    "Plain update never changes ffmpeg. --check looks at yt-dlp and ffmpeg and installs nothing.",
    "",
    "Options:",
    "      --channel <name>  yt-dlp build to use: stable, nightly or master. Saved for next time.",
    "                        Default: the saved channel (stable at first).",
    "      --check           Show installed and latest versions without installing anything.",
    "                        With --channel, checks that channel without saving it.",
    "  -h, --help            Show this help",
    "",
  ].join("\n");
}

function parseChannel(value: string | undefined): YtDlpChannel | undefined {
  if (value === undefined) return undefined;
  if (!YTDLP_CHANNELS.includes(value as YtDlpChannel)) {
    throw new CliError(
      `Unknown channel: ${value}. Choose from: ${YTDLP_CHANNELS.join(", ")}.\n${UPDATE_USAGE}`,
      ExitCode.Usage,
    );
  }
  return value as YtDlpChannel;
}

const WHO_WINS = {
  env: "MEDIAFORGE_YTDLP_PATH",
  path: "the yt-dlp on your PATH",
  bundled: "the yt-dlp in the bundled folder",
} as const;

function shadowNote(
  after: { source: keyof typeof WHO_WINS | "cache"; path: string },
  check: boolean,
): string | undefined {
  if (after.source === "cache") return undefined;
  const effect = check
    ? "so the downloaded copy is not the one in use"
    : "so this update has no effect on downloads";
  const fix = after.source === "env" ? "Unset it" : "Remove it";
  return `Note: ${WHO_WINS[after.source]} (${after.path}) is used before the downloaded copy, ${effect}. ${fix} to use the downloaded one.\n`;
}

function checkLine(check: ToolCheck, channel: YtDlpChannel): string {
  const name = check.tool.padEnd(6);
  const installed = check.installed ?? "not installed";
  const tag = check.tool === "yt-dlp" ? ` (${channel})` : "";
  if (check.error !== undefined) {
    return `${name}  ${installed}  could not check: ${check.error}`;
  }
  if (check.upToDate) return `${name}  ${installed} up to date`;
  return `${name}  ${installed} -> ${check.latest ?? "unknown"}${tag}  update available`;
}

export async function runUpdate(
  args: string[],
  io: Io,
  rt: ToolRuntime = defaultToolRuntime(),
  store: SettingsStore = defaultSettingsStore(),
): Promise<ExitCode> {
  const { values, positionals } = parseCommandArgs(
    args,
    {
      channel: { type: "string" },
      check: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    UPDATE_USAGE,
  );
  if (values.help) {
    io.stdout(updateUsage());
    return ExitCode.Ok;
  }
  if (positionals.length > 0) {
    throw new CliError(`Unexpected argument: ${positionals[0]}\n${UPDATE_USAGE}`, ExitCode.Usage);
  }
  const requested = parseChannel(values.channel);
  const settings = await store.load();
  const channel = requested ?? settings.ytDlpChannel;

  if (values.check) {
    const checks = await rt.check(["yt-dlp", "ffmpeg"], { channel });
    io.stdout(`${checks.map((check) => checkLine(check, channel)).join("\n")}\n`);
    const note = await resolvedNote(rt, true);
    if (note) io.stderr(note);
    return ExitCode.Ok;
  }

  let result: InstallResult;
  try {
    result = await rt.install("yt-dlp", createInstallPrinter(io.stderr, rt.interactive), {
      channel,
    });
  } catch (error) {
    throw toCliError(error);
  }
  if (requested !== undefined && requested !== settings.ytDlpChannel) {
    // Reload: another process may have changed settings during a long download.
    await store.save({ ...(await store.load()), ytDlpChannel: requested });
  }

  io.stdout(
    result.previous === result.version
      ? `yt-dlp is already up to date (${result.version}, ${channel})\n`
      : `yt-dlp updated: ${result.previous ?? "not installed"} to ${result.version} (${channel})\n`,
  );
  const note = await resolvedNote(rt, false);
  if (note) io.stderr(note);
  return ExitCode.Ok;
}

async function resolvedNote(rt: ToolRuntime, check: boolean): Promise<string | undefined> {
  const after = await tryResolve("yt-dlp", rt.resolve);
  return after ? shadowNote(after, check) : undefined;
}
