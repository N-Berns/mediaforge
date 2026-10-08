import { execFile } from "node:child_process";

export interface ExecTextOptions {
  /** Kill the program after this long. Default 10 seconds. */
  timeoutMs?: number;
  /** Largest stdout to accept, in bytes. Node's default (1 MiB) when omitted. */
  maxBuffer?: number;
}

/**
 * Run a program and return its stdout. It uses the callback form of `execFile` on purpose: inside
 * a pkg binary `util.promisify(execFile)` resolves to the stdout string instead of
 * `{ stdout, stderr }` (pkg patches `execFile`), so `.stdout` was undefined and every tool looked
 * "not runnable".
 */
export function execFileText(
  path: string,
  args: string[],
  { timeoutMs = 10_000, maxBuffer }: ExecTextOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      path,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        encoding: "utf8",
        ...(maxBuffer !== undefined && { maxBuffer }),
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}
