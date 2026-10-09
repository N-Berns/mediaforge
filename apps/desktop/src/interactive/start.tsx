import { stat } from "node:fs/promises";
import { render } from "ink";
import { defaultBinDir } from "../binaries.ts";
import { inspectTools } from "../doctor.ts";
import { defaultDownloadDeps } from "../download.ts";
import { defaultOutputDir } from "../engine/index.ts";
import { ExitCode } from "../exit-codes.ts";
import { fetchMediaInfo } from "../formats.ts";
import { checkForUpdate, installUpdate } from "../self-update.ts";
import { settingsPath } from "../settings.ts";
import { defaultToolRuntime } from "../tool-runtime.ts";
import { VERSION } from "../version.ts";
import { App } from "./App.tsx";
import { readClipboard } from "./clipboard.ts";
import type { AppDeps } from "./deps.ts";
import { realFolderFs } from "./folder-fs.ts";
import { openFolder } from "./open-folder.ts";

const ENTER_SCREEN = "\x1b[?1049h\x1b[H";
const LEAVE_SCREEN = "\x1b[?1049l";

export function realDeps(): AppDeps {
  // The startup notice and the About page share one check, kept once it works.
  let check: ReturnType<typeof checkForUpdate> | undefined;
  return {
    download: defaultDownloadDeps(),
    fetchInfo: (url) => fetchMediaInfo(url),
    inspectTools: () => inspectTools(),
    installTool: (tool, onProgress) => defaultToolRuntime().install(tool, onProgress),
    checkUpdate: () => {
      const lookup = check ?? checkForUpdate();
      check = lookup;
      lookup.catch(() => {
        if (check === lookup) check = undefined;
      });
      return lookup;
    },
    installUpdate: (info, onProgress) => installUpdate(info, undefined, onProgress),
    readClipboard: () => readClipboard(),
    openFolder,
    fileSize: async (path) => {
      try {
        return (await stat(path)).size;
      } catch {
        return undefined;
      }
    },
    folders: realFolderFs(),
    configPath: settingsPath(process.env),
    target: `${process.platform}-${process.arch}`,
    defaultOutputDir: defaultOutputDir(),
    binDir: defaultBinDir(),
    version: VERSION,
  };
}

/**
 * Run the full-screen interactive app. It uses the terminal's alternate screen,
 * so quitting restores whatever was on screen before.
 */
export async function startInteractive(): Promise<ExitCode> {
  process.stdout.write(ENTER_SCREEN);
  try {
    const app = render(<App deps={realDeps()} />, { exitOnCtrlC: false });
    await app.waitUntilExit();
  } finally {
    process.stdout.write(LEAVE_SCREEN);
  }
  return ExitCode.Ok;
}
