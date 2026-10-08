import { BinaryNotFoundError, type Tool } from "@mediaforge/binary-resolver";
import type { ToolRuntime } from "./tool-runtime.ts";

export interface RuntimeOptions {
  present?: Tool[];
  interactive?: boolean;
  answers?: boolean[];
  platform?: NodeJS.Platform;
  brew?: boolean;
  /** Make `brew install` succeed without putting ffmpeg on PATH. */
  brewLeavesNothing?: boolean;
  installError?: unknown;
}

/** A `ToolRuntime` that keeps its state in memory and records what happened. */
export function makeRuntime(options: RuntimeOptions = {}) {
  const present = new Set<Tool>(options.present ?? []);
  const answers = [...(options.answers ?? [])];
  const log = { installed: [] as Tool[], asked: [] as string[], brewRuns: 0 };
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
    platform: options.platform ?? "linux",
    interactive: options.interactive ?? true,
    ask: async (question) => {
      log.asked.push(question);
      return answers.shift() ?? false;
    },
    brew: {
      available: async () => options.brew ?? false,
      install: async () => {
        log.brewRuns++;
        if (!options.brewLeavesNothing) present.add("ffmpeg");
      },
    },
  };
  return { rt, log, present };
}
