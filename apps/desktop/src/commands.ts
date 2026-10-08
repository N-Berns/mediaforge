import { runDoctor } from "./doctor.ts";
import { runDownload } from "./download.ts";
import type { ExitCode } from "./exit-codes.ts";
import { runFormats } from "./formats.ts";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface Command {
  name: string;
  summary: string;
  /** Receives the arguments after the command name. */
  run: (args: string[], io: Io) => Promise<ExitCode | undefined>;
}

export const COMMANDS: Command[] = [
  {
    name: "download",
    summary: "Download media from a URL",
    run: (args, io) => runDownload(args, io),
  },
  {
    name: "formats",
    summary: "List the formats available for a URL",
    run: (args, io) => runFormats(args, io),
  },
  {
    name: "doctor",
    summary: "Check yt-dlp and ffmpeg availability",
    run: (args, io) => runDoctor(args, io),
  },
];
