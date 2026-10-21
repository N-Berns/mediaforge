import { readFile, stat } from "node:fs/promises";
import { release } from "node:os";
import { sendReport } from "@mediaforge/shared-types";
import { render } from "ink";
import { flashWindow } from "../attention.ts";
import { defaultBinDir } from "../binaries.ts";
import {
  enableVtInput,
  resetConsoleInput,
  settleVtInput,
  type VtInputHandle,
} from "../console-mode.ts";
import { applyAutostart } from "../core/autostart.ts";
import { defaultCoreConnector } from "../core/connect.ts";
import { historyPath } from "../core/history.ts";
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
import { readClipboard, writeClipboard } from "./clipboard.ts";
import type { AppDeps } from "./deps.ts";
import { realFolderFs } from "./folder-fs.ts";
import { InputHub } from "./mouse/input.ts";
import { MouseProvider } from "./mouse/MouseProvider.tsx";
import { terminalStdin } from "./mouse/terminal-stdin.ts";
import { openFolder } from "./open-folder.ts";
import { osLabel } from "./report.ts";

const ENTER_SCREEN = "\x1b[?1049h\x1b[H";
const LEAVE_SCREEN = "\x1b[?1049l";

/** Mouse reporting: presses, releases, the wheel and pointer motion, in SGR encoding. */
export const MOUSE_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1003l\x1b[?1000l\x1b[?1006l";

/**
 * Leaves the terminal usable if the process ends without unmounting (a crash): mouse off,
 * normal screen, raw mode off. Raw mode off also resets the Windows console input mode; a
 * Windows mouse child still running (`vt`) could set the mouse bit again later, so it is
 * killed and the input mode reset once more (`resetConsoleInput`).
 */
export function mouseExitHook(
  write: (text: string) => void,
  stdin: { isTTY?: boolean; setRawMode?: (on: boolean) => unknown },
  vt: () => VtInputHandle | undefined = () => undefined,
  platform: NodeJS.Platform = process.platform,
): () => void {
  return () => {
    write(MOUSE_OFF + LEAVE_SCREEN);
    const handle = vt();
    if (platform === "win32" && handle?.running) {
      handle.stop();
      resetConsoleInput(stdin);
    } else if (stdin.isTTY) {
      try {
        stdin.setRawMode?.(false);
      } catch {
        // Not a console any more.
      }
    }
  };
}

/** Signals that end the process without an `exit` event of their own: a kill, a closed terminal. */
const EXIT_SIGNALS = { SIGHUP: 1, SIGTERM: 15 } as const;

/**
 * Runs `onExit` once, whatever ends the process, and exits on SIGTERM or SIGHUP, which skip the
 * `exit` event by default. Returns a function that removes the listeners.
 */
export function exitHooks(
  onExit: () => void,
  proc: Pick<NodeJS.Process, "once" | "removeListener" | "exit"> = process,
): () => void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    onExit();
  };
  const onSignal = (signal: NodeJS.Signals) => {
    once();
    proc.exit(128 + (EXIT_SIGNALS[signal as keyof typeof EXIT_SIGNALS] ?? 0));
  };
  proc.once("exit", once);
  for (const signal of Object.keys(EXIT_SIGNALS)) proc.once(signal, onSignal);
  return () => {
    proc.removeListener("exit", once);
    for (const signal of Object.keys(EXIT_SIGNALS)) proc.removeListener(signal, onSignal);
  };
}

export function realDeps(): AppDeps {
  // The startup notice and the About page share one check, kept once it works.
  let check: ReturnType<typeof checkForUpdate> | undefined;
  return {
    download: { ...defaultDownloadDeps(), core: defaultCoreConnector("menu") },
    fetchInfo: (url) => fetchMediaInfo(url),
    inspectTools: () => inspectTools(),
    installTool: (tool, onProgress, opts) => defaultToolRuntime().install(tool, onProgress, opts),
    checkTools: (opts) => defaultToolRuntime().check(["yt-dlp", "ffmpeg"], opts),
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
    writeClipboard: (text) => writeClipboard(text),
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
    applyAutostart: (enabled) => applyAutostart(enabled),
    notifyCore: async () => {
      try {
        const client = await defaultCoreConnector("menu", { autostart: false })();
        try {
          await client.request("settings.reload", {});
        } finally {
          client.close();
        }
      } catch {
        // No core running: it reads the settings when it starts.
      }
    },
    binDir: defaultBinDir(),
    version: VERSION,
    managerCore: defaultCoreConnector("manager"),
    flash: () => flashWindow(),
    sendReport: (report) => sendReport(report),
    readHistory: async () => {
      try {
        return await readFile(historyPath(process.env), "utf8");
      } catch {
        return undefined;
      }
    },
    osName: osLabel(process.platform, release()),
  };
}

/**
 * Run the full-screen interactive app, on the downloads manager with `manager`. It uses the
 * terminal's alternate screen, so quitting restores whatever was on screen before.
 */
export async function startInteractive(options: { manager?: boolean } = {}): Promise<ExitCode> {
  const hub = new InputHub();
  // Raw mode can go on more than once; only the latest child can still be running.
  let vt: VtInputHandle | undefined;
  const input = terminalStdin(hub, process.stdin, () => {
    vt?.stop();
    vt = enableVtInput();
  });
  const onExit = mouseExitHook(
    (text) => void process.stdout.write(text),
    process.stdin,
    () => vt,
  );
  const removeExitHooks = exitHooks(onExit);
  process.stdout.write(ENTER_SCREEN + MOUSE_ON);
  try {
    const app = render(
      <MouseProvider hub={hub}>
        <App deps={realDeps()} {...(options.manager && { start: "manager" as const })} />
      </MouseProvider>,
      { exitOnCtrlC: false, stdin: input.stream },
    );
    await app.waitUntilExit();
  } finally {
    process.stdout.write(MOUSE_OFF + LEAVE_SCREEN);
    removeExitHooks();
    input.close();
    // On process.stdin itself: the Ink stream would start a new child on raw mode.
    await settleVtInput(vt, process.platform, process.stdin);
  }
  return ExitCode.Ok;
}
