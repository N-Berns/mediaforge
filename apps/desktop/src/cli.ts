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
    "  -h, --help     Show help",
    "  -v, --version  Show version",
    "",
  ].join("\n");
}

export interface RunOptions {
  /** Opens the interactive menu. Provided only when running in a real terminal. */
  interactive?: () => Promise<number>;
}

/** Run the CLI and return the process exit code. Never throws. */
export async function run(argv: string[], io: Io, options: RunOptions = {}): Promise<number> {
  const [first, ...rest] = argv;

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
