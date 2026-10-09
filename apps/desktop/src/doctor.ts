import { parseArgs } from "node:util";
import { ALL_TOOLS, BinaryNotFoundError, type Tool } from "@mediaforge/binary-resolver";
import { defaultBinDir, missingToolHint, type ResolveTool, resolveTool } from "./binaries.ts";
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

  const [reports, runtime] = await Promise.all([inspectTools(resolve), detect()]);
  const jsRuntime = reportRuntime(runtime);
  const ok = reports.every((r) => r.found || !isRequired(r.tool));
  io.stdout(
    json
      ? `${JSON.stringify({ ok, tools: reports, jsRuntime }, null, 2)}\n`
      : formatReport(reports, jsRuntime, binDir),
  );
  return ok ? ExitCode.Ok : ExitCode.MissingTool;
}
