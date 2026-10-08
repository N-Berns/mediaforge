import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { CliError, ExitCode } from "./exit-codes.ts";

/** Parse a command's arguments strictly; any problem becomes a usage error that shows `usage`. */
export function parseCommandArgs<const O extends ParseArgsOptionsConfig>(
  args: string[],
  options: O,
  usage: string,
) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`${message}\n${usage}`, ExitCode.Usage);
  }
}

/** Accept only absolute http(s) URLs. */
export function parseHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`Not a valid URL: ${value}`, ExitCode.Usage);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(`Only http and https URLs are supported: ${value}`, ExitCode.Usage);
  }
  return url.toString();
}
