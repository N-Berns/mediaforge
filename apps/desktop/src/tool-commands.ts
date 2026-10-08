import { ALL_TOOLS, type InstallResult, type Tool } from "@mediaforge/binary-resolver";
import type { Io } from "./commands.ts";
import { CliError, ExitCode } from "./exit-codes.ts";
import { parseCommandArgs } from "./parse.ts";
import {
  type AcquireOutcome,
  acquireTool,
  createInstallPrinter,
  defaultToolRuntime,
  type ToolRuntime,
  toCliError,
  tryResolve,
} from "./tool-runtime.ts";

const SETUP_USAGE = "Usage: mediaforge setup [--yes] [--tools yt-dlp,ffmpeg]";

export function setupUsage(): string {
  return [
    SETUP_USAGE,
    "",
    "Download yt-dlp and ffmpeg when they are missing. Tools that are already available are left alone.",
    "",
    "Options:",
    "  -y, --yes            Do not ask questions. On macOS, skip the Homebrew offer.",
    "      --tools <list>   Only these tools, comma separated (default: yt-dlp,ffmpeg)",
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
    case "homebrew":
      return `${name}  installed with Homebrew  ${outcome.path}`;
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
    const outcome = await acquireTool(tool, rt, { yes: values.yes ?? false, onProgress });
    lines.push(summaryLine(outcome));
  }
  io.stdout(`${lines.join("\n")}\n`);
  return ExitCode.Ok;
}

const UPDATE_USAGE = "Usage: mediaforge update";

export function updateUsage(): string {
  return [
    UPDATE_USAGE,
    "",
    "Download the latest yt-dlp nightly build into MediaForge's tool folder.",
    "ffmpeg is never changed by this command.",
    "",
    "Options:",
    "  -h, --help   Show this help",
    "",
  ].join("\n");
}

const WHO_WINS = {
  env: "MEDIAFORGE_YTDLP_PATH",
  path: "the yt-dlp on your PATH",
  bundled: "the yt-dlp in the bundled folder",
} as const;

export async function runUpdate(
  args: string[],
  io: Io,
  rt: ToolRuntime = defaultToolRuntime(),
): Promise<ExitCode> {
  const { values, positionals } = parseCommandArgs(
    args,
    { help: { type: "boolean", short: "h" } },
    UPDATE_USAGE,
  );
  if (values.help) {
    io.stdout(updateUsage());
    return ExitCode.Ok;
  }
  if (positionals.length > 0) {
    throw new CliError(`Unexpected argument: ${positionals[0]}\n${UPDATE_USAGE}`, ExitCode.Usage);
  }

  const before = await tryResolve("yt-dlp", rt.resolve);
  let result: InstallResult;
  try {
    result = await rt.install("yt-dlp", createInstallPrinter(io.stderr, rt.interactive));
  } catch (error) {
    throw toCliError(error);
  }
  const after = await tryResolve("yt-dlp", rt.resolve);

  io.stdout(
    before?.source === "cache" && before.version === result.version
      ? `yt-dlp is already up to date (${result.version})\n`
      : `yt-dlp updated: ${before?.version ?? "not installed"} to ${result.version}\n`,
  );
  if (after && after.source !== "cache") {
    io.stderr(
      `Note: ${WHO_WINS[after.source]} (${after.path}) is used before the downloaded copy, so this update has no effect on downloads. Remove it, or unset the variable, to use the downloaded one.\n`,
    );
  }
  return ExitCode.Ok;
}
