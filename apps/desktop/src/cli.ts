import { NATIVE_HOST_NAME } from "@mediaforge/shared-protocol";
import { COMMANDS, type Io } from "./commands.ts";
import { CliError, ExitCode } from "./exit-codes.ts";
import { errorTip } from "./sites.ts";
import { VERSION } from "./version.ts";

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return [
    "Usage: mediaforge [command] [options]",
    "",
    "Run without a command in a terminal to open the interactive menu.",
    "",
    "Commands:",
    ...lines,
    "",
    "Options:",
    "  --manager      Open the downloads manager",
    "  -h, --help     Show help",
    "  -v, --version  Show version",
    "",
  ].join("\n");
}

export interface RunOptions {
  /** Opens the interactive menu. Provided only when running in a real terminal. */
  interactive?: (options?: { manager?: boolean }) => Promise<number>;
  /** The long-lived background core (`--core`). */
  core?: () => Promise<number>;
  /** The browser native-messaging relay (`--native-host`). */
  relay?: () => Promise<number>;
}

/**
 * Chrome cannot pass flags to a native host on Windows; it passes the extension origin as the
 * first argument instead.
 */
export const isRelayInvocation = (first: string | undefined): boolean =>
  first === "--native-host" || /^(chrome|moz)-extension:\/\//.test(first ?? "");

const HOST_MANIFEST_FILE = `${NATIVE_HOST_NAME}.json`.toLowerCase();

/**
 * True when the browser started this program as its native messaging host. Chrome passes the
 * extension origin; Firefox passes the host manifest path and then the add-on id.
 */
export function isRelayArgv(argv: string[]): boolean {
  const [first, second] = argv;
  if (isRelayInvocation(first)) return true;
  if (typeof first !== "string" || typeof second !== "string") return false;
  const base = first.split(/[\\/]/).pop()?.toLowerCase();
  return base === HOST_MANIFEST_FILE;
}

/** Run the CLI and return the process exit code. Never throws. */
export async function run(argv: string[], io: Io, options: RunOptions = {}): Promise<number> {
  const [first, ...rest] = argv;

  // Background modes are not commands: they stay out of the help text and COMMANDS.
  if (first === "--core" || isRelayArgv(argv)) {
    const mode = first === "--core" ? options.core : options.relay;
    if (!mode) {
      io.stderr(`${first} is not available here.\n`);
      return ExitCode.Usage;
    }
    try {
      return await mode();
    } catch (error) {
      io.stderr(`Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
      return ExitCode.Failure;
    }
  }

  if (first === "--manager") {
    if (!options.interactive) {
      io.stderr("--manager needs a terminal.\n");
      return ExitCode.Usage;
    }
    try {
      return await options.interactive({ manager: true });
    } catch (error) {
      io.stderr(`Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
      return ExitCode.Failure;
    }
  }

  if (first === "-h" || first === "--help") {
    io.stdout(helpText());
    return ExitCode.Ok;
  }
  if (first === "-v" || first === "--version") {
    io.stdout(`${VERSION}\n`);
    return ExitCode.Ok;
  }
  if (first === undefined && !options.interactive) {
    io.stdout(helpText());
    return ExitCode.Ok;
  }

  const command = first === undefined ? undefined : COMMANDS.find((c) => c.name === first);
  if (first !== undefined && !command) {
    io.stderr(`Unknown command: ${first}\n\n${helpText()}`);
    return ExitCode.Usage;
  }

  try {
    if (!command) return await (options.interactive as () => Promise<number>)();
    return (await command.run(rest, io)) ?? ExitCode.Ok;
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`${error.message}\n${errorTip(error.exitCode)}`);
      return error.exitCode;
    }
    io.stderr(`Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.Failure;
  }
}
