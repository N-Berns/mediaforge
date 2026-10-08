import { parseArgs } from "node:util";
import { BinaryNotFoundError, type Tool } from "@mediaforge/binary-resolver";
import { defaultBinDir, missingToolHint, type ResolveTool, resolveTool } from "./binaries.ts";
import type { Io } from "./commands.ts";
import { CliError, ExitCode } from "./exit-codes.ts";

const TOOLS: Tool[] = ["yt-dlp", "ffmpeg"];

export interface ToolReport {
  tool: Tool;
  found: boolean;
  version?: string;
  source?: string;
  path?: string;
  error?: string;
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
  Promise.all(TOOLS.map((tool) => inspect(tool, resolve)));

function formatReport(reports: ToolReport[], binDir: string): string {
  const lines = reports.flatMap((r) => {
    if (r.found) {
      return [`${r.tool.padEnd(7)}  ${r.version ?? "unknown version"}  (${r.source})  ${r.path}`];
    }
    return [
      `${r.tool.padEnd(7)}  NOT FOUND`,
      `         ${r.error}`,
      `         ${missingToolHint(r.tool, binDir)}`,
    ];
  });
  return `${lines.join("\n")}\n`;
}

export async function runDoctor(
  args: string[],
  io: Io,
  resolve: ResolveTool = resolveTool,
  binDir: string = defaultBinDir(),
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

  const reports = await inspectTools(resolve);
  const ok = reports.every((r) => r.found);
  io.stdout(
    json ? `${JSON.stringify({ ok, tools: reports }, null, 2)}\n` : formatReport(reports, binDir),
  );
  return ok ? ExitCode.Ok : ExitCode.MissingTool;
}
