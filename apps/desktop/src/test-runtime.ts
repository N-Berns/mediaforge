import { BinaryNotFoundError, type Tool } from "@mediaforge/binary-resolver";
import type { InstallOptions, ToolRuntime } from "./tool-runtime.ts";

export interface RuntimeOptions {
  present?: Tool[];
  interactive?: boolean;
  answers?: boolean[];
  installError?: unknown;
  /** Tools whose installed copy is not the pinned build; installing one makes it current. */
  outdated?: Tool[];
  /** The `previous` version every fake install reports. */
  previous?: string;
}

/** A `ToolRuntime` that keeps its state in memory and records what happened. */
export function makeRuntime(options: RuntimeOptions = {}) {
  const present = new Set<Tool>(options.present ?? []);
  const outdated = new Set<Tool>(options.outdated ?? []);
  const answers = [...(options.answers ?? [])];
  const log = {
    installed: [] as Tool[],
    installOptions: [] as (InstallOptions | undefined)[],
    asked: [] as string[],
  };
  const rt: ToolRuntime = {
    resolve: async (tool) => {
      if (present.has(tool)) return { tool, path: `/bin/${tool}`, source: "path", version: "1.0" };
      throw new BinaryNotFoundError(tool, ["PATH"]);
    },
    install: async (tool, onProgress, opts) => {
      if (options.installError) throw options.installError;
      onProgress({ tool, phase: "downloading", received: 1 });
      present.add(tool);
      outdated.delete(tool);
      log.installed.push(tool);
      log.installOptions.push(opts);
      return {
        tool,
        version: "2026.10.08",
        path: `/cache/${tool}`,
        sha256: "s",
        url: "u",
        ...(options.previous !== undefined && { previous: options.previous }),
      };
    },
    check: async (tools) =>
      tools.map((tool) => ({ tool, latest: "2026.10.08", upToDate: !outdated.has(tool) })),
    outdated: async (tool) => outdated.has(tool),
    interactive: options.interactive ?? true,
    ask: async (question) => {
      log.asked.push(question);
      return answers.shift() ?? false;
    },
  };
  return { rt, log, present, outdated };
}
