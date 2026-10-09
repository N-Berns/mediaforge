import { runDoctor } from "./doctor.ts";
import { runDownload } from "./download.ts";
import type { ExitCode } from "./exit-codes.ts";
import { runFormats } from "./formats.ts";
import { runSelfUpdate } from "./self-update.ts";
import { runSetup, runUpdate } from "./tool-commands.ts";

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
    name: "setup",
    summary: "Download missing yt-dlp, ffmpeg and deno",
    run: (args, io) => runSetup(args, io),
  },
  {
    name: "update",
    summary: "Update yt-dlp to the latest nightly",
    run: (args, io) => runUpdate(args, io),
  },
  {
    name: "self-update",
    summary: "Update MediaForge to the newest release",
    run: (args, io) => runSelfUpdate(args, io),
  },
  {
    name: "doctor",
    summary: "Check yt-dlp, ffmpeg and deno availability",
    run: (args, io) => runDoctor(args, io),
  },
];
