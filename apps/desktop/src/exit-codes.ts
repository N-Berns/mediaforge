/** Process exit codes. Errors go to stderr, results to stdout. */
export const ExitCode = {
  Ok: 0,
  Failure: 1,
  Usage: 2,
  MissingTool: 3,
  Network: 4,
  UnsupportedSite: 5,
  FileSystem: 6,
  /** Stopped by the user (Ctrl+C), following the shell convention of 128 + SIGINT. */
  Cancelled: 130,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Thrown by commands to end the run with a specific exit code and message. */
export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode = ExitCode.Failure) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}
