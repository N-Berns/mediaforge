import { parseArgs } from "node:util";
import { ALL_TOOLS, BinaryNotFoundError, type Tool } from "@mediaforge/binary-resolver";
import { defaultBinDir, missingToolHint, type ResolveTool, resolveTool } from "./binaries.ts";
import {
  browserStatus,
  type HostState,
  type StatusReport,
  systemHostContext,
  systemHostIo,
} from "./browser-hosts.ts";
import type { Io } from "./commands.ts";
import { CliError, ExitCode } from "./exit-codes.ts";
import { detectJsRuntime, type JsRuntime } from "./js-runtime.ts";

export interface ToolReport {
  tool: Tool;
  found: boolean;
  version?: string;
  source?: string;
  path?: string;
  error?: string;
}

/** Tools that downloads can run without. YouTube needs Deno; every other site does not. */
export const OPTIONAL_TOOLS: readonly Tool[] = ["deno"];

export const isRequired = (tool: Tool): boolean => !OPTIONAL_TOOLS.includes(tool);

export interface JsRuntimeReport {
  found: boolean;
  name?: string;
  path?: string;
  version?: string;
}

async function inspect(tool: Tool, resolve: ResolveTool): Promise<ToolReport> {
  try {
    const { version, source, path } = await resolve(tool);
    return { tool, found: true, version, source, path };
  } catch (error) {
    if (error instanceof BinaryNotFoundError) return { tool, found: false, error: error.message };
    throw error;
  }
}

/** Look up every tool the app needs. */
export const inspectTools = (resolve: ResolveTool = resolveTool): Promise<ToolReport[]> =>
  Promise.all(ALL_TOOLS.map((tool) => inspect(tool, resolve)));

const reportRuntime = (runtime: JsRuntime | undefined): JsRuntimeReport =>
  runtime
    ? {
        found: true,
        name: runtime.name,
        path: runtime.path,
        ...(runtime.version !== undefined && { version: runtime.version }),
      }
    : { found: false };

const STATE_TEXT: Record<Exclude<HostState, "not-installed">, string> = {
  registered: "registered",
  missing: "not registered. Run: mediaforge setup",
  stale: "registered for another program. Run: mediaforge setup",
};

/** One line per browser; browsers that look not installed are left out. */
export function browserLines(report: StatusReport): string[] {
  if (report.skipped === "development") {
    return ["browsers    not checked: running from source"];
  }
  if (report.skipped === "unsupported") return [];
  const width = Math.max(0, ...report.browsers.map((b) => b.name.length));
  const lines = report.browsers.flatMap((b) => {
    if (b.state === "not-installed") return [];
    const where = b.state === "stale" && b.path ? ` (${b.path})` : "";
    return [`browser     ${b.name.padEnd(width)}  ${STATE_TEXT[b.state]}${where}`];
  });
  if (report.noChromiumId) {
    lines.push("browser     Chromium browsers not checked: this build has no extension ID yet");
  }
  return lines;
}

function formatReport(reports: ToolReport[], runtime: JsRuntimeReport, binDir: string): string {
  const lines = reports.flatMap((r) => {
    if (r.found) {
      return [`${r.tool.padEnd(7)}  ${r.version ?? "unknown version"}  (${r.source})  ${r.path}`];
    }
    return [
      `${r.tool.padEnd(7)}  NOT FOUND${isRequired(r.tool) ? "" : " (optional)"}`,
      `         ${r.error}`,
      `         ${missingToolHint(r.tool, binDir)}`,
    ];
  });
  if (runtime.found) {
    lines.push(
      `js runtime  ${runtime.name}  ${runtime.version ?? "unknown version"}  ${runtime.path}`,
    );
  } else {
    lines.push(
      "js runtime  NOT FOUND (optional)",
      "            YouTube downloads may offer fewer formats. Run: mediaforge setup (downloads deno), or install Node.js 20 or newer.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runDoctor(
  args: string[],
  io: Io,
  resolve: ResolveTool = resolveTool,
  binDir: string = defaultBinDir(),
  detect: () => Promise<JsRuntime | undefined> = () => detectJsRuntime({ resolve }),
  browsers: () => Promise<StatusReport> = () => browserStatus(systemHostContext(), systemHostIo()),
): Promise<ExitCode> {
  let json: boolean;
  try {
    json =
      parseArgs({ args, options: { json: { type: "boolean" } }, strict: true }).values.json ??
      false;
  } catch (error) {
    throw new CliError(
      `${error instanceof Error ? error.message : String(error)}\nUsage: mediaforge doctor [--json]`,
      ExitCode.Usage,
    );
  }

  const [reports, runtime, hosts] = await Promise.all([
    inspectTools(resolve),
    detect(),
    browsers(),
  ]);
  const jsRuntime = reportRuntime(runtime);
  // The browser registration is reported but never fails doctor: CLI-only use needs none.
  const ok = reports.every((r) => r.found || !isRequired(r.tool));
  if (json) {
    io.stdout(`${JSON.stringify({ ok, tools: reports, jsRuntime, browsers: hosts }, null, 2)}\n`);
  } else {
    const extra = browserLines(hosts);
    io.stdout(
      formatReport(reports, jsRuntime, binDir) + (extra.length ? `${extra.join("\n")}\n` : ""),
    );
  }
  return ok ? ExitCode.Ok : ExitCode.MissingTool;
}
