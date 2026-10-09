import { BinaryNotFoundError, type Tool } from "@mediaforge/binary-resolver";
import type { ToolRuntime } from "./tool-runtime.ts";

export interface RuntimeOptions {
  present?: Tool[];
  interactive?: boolean;
  answers?: boolean[];
  installError?: unknown;
}

/** A `ToolRuntime` that keeps its state in memory and records what happened. */
export function makeRuntime(options: RuntimeOptions = {}) {
  const present = new Set<Tool>(options.present ?? []);
  const answers = [...(options.answers ?? [])];
  const log = { installed: [] as Tool[], asked: [] as string[] };
  const rt: ToolRuntime = {
    resolve: async (tool) => {
      if (present.has(tool)) return { tool, path: `/bin/${tool}`, source: "path", version: "1.0" };
      throw new BinaryNotFoundError(tool, ["PATH"]);
    },
    install: async (tool, onProgress) => {
      if (options.installError) throw options.installError;
      onProgress({ tool, phase: "downloading", received: 1 });
      present.add(tool);
      log.installed.push(tool);
      return { tool, version: "2026.10.08", path: `/cache/${tool}`, sha256: "s", url: "u" };
    },
    interactive: options.interactive ?? true,
    ask: async (question) => {
      log.asked.push(question);
      return answers.shift() ?? false;
    },
  };
  return { rt, log, present };
}
