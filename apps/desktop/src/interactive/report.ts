import type { Report, ReportType } from "@mediaforge/shared-types";
import { isRequired, type ToolReport } from "../doctor.ts";

/** Fills the form's browser fields, which only the extension knows. */
export const NOT_FROM_BROWSER = "n/a (app)";

/** "Windows 11", "Windows 10", "Linux 6.8.0-45-generic" from `os.platform()` and `os.release()`. */
export function osLabel(platform: NodeJS.Platform, release: string): string {
  if (platform === "win32") {
    const [major, , build] = release.split(".").map(Number);
    if (major === 10) return (build ?? 0) >= 22000 ? "Windows 11" : "Windows 10";
    return `Windows ${release}`;
  }
  if (platform === "linux") return `Linux ${release}`;
  return `${platform} ${release}`;
}

/** The newest failed download in `history.json`, or undefined when there is none or it is unreadable. */
export function lastFailure(historyText: string): { title: string; error: string } | undefined {
  try {
    const file = JSON.parse(historyText) as { jobs?: unknown };
    if (!Array.isArray(file.jobs)) return undefined;
    let newest: { title: string; error: string; at: number } | undefined;
    for (const job of file.jobs as Array<Record<string, unknown>>) {
      if (job.status !== "failed" || typeof job.error !== "string") continue;
      const at = typeof job.updatedAt === "number" ? job.updatedAt : 0;
      if (newest && newest.at >= at) continue;
      const candidate = (job.request as { candidate?: Record<string, unknown> } | undefined)
        ?.candidate;
      const title =
        (typeof job.outputPath === "string" && job.outputPath) ||
        (typeof candidate?.pageTitle === "string" && candidate.pageTitle) ||
        (typeof candidate?.url === "string" && candidate.url) ||
        String(job.id ?? "unknown");
      newest = { title, error: job.error, at };
    }
    return newest && { title: newest.title, error: newest.error };
  } catch {
    return undefined;
  }
}

export interface DiagnosticsInput {
  version: string;
  target: string;
  os: string;
  tools: ToolReport[];
  failure?: { title: string; error: string } | undefined;
}

/** What "include diagnostics" adds to a report: versions, tools, setup and the last failure. */
export function appDiagnostics(input: DiagnosticsInput): string {
  const missing = input.tools.filter((t) => !t.found && isRequired(t.tool)).map((t) => t.tool);
  return [
    `app: ${input.version} (${input.target})`,
    `os: ${input.os}`,
    ...input.tools.map((t) =>
      t.found
        ? `${t.tool}: ${t.version ?? "unknown version"} (${t.source ?? "unknown source"})`
        : `${t.tool}: not found`,
    ),
    `setup: ${missing.length === 0 ? "complete" : `missing ${missing.join(", ")}`}`,
    input.failure
      ? `last failed download: ${input.failure.title}\n${input.failure.error}`
      : "last failed download: none",
  ].join("\n");
}

/** A report sent from the app: the browser fields say so. */
export function appReport(input: {
  description: string;
  type: ReportType;
  version: string;
  os: string;
  details?: string | undefined;
}): Report {
  return {
    description: input.description,
    type: input.type,
    extensionVersion: NOT_FROM_BROWSER,
    appVersion: input.version,
    os: input.os,
    browser: NOT_FROM_BROWSER,
    details: input.details,
  };
}
