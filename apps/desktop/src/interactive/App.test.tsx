import { type Tool, ToolInstallError } from "@mediaforge/binary-resolver";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { DownloadDeps } from "../download.ts";
import { DownloadEngine, type EngineFs } from "../engine/index.ts";
import type { ProcessRunner } from "../engine/process.ts";
import { CliError, ExitCode } from "../exit-codes.ts";
import type { MediaInfo } from "../formats.ts";
import type { UpdateInfo } from "../self-update.ts";
import { memorySettingsStore, type Settings } from "../settings.ts";
import { App } from "./App.tsx";
import type { AppDeps } from "./deps.ts";
import type { FolderFs } from "./folder-browser.ts";
import { memoryFolderFs } from "./folder-fs.ts";

const KEY = {
  enter: "\r",
  esc: "\u001B",
  up: "\u001B[A",
  down: "\u001B[B",
  ctrlV: "\u0016",
  ctrlU: "\u0015",
};

const URL = "https://example.com/watch?v=abc";
const found = async (tool: Tool) => ({ tool, path: `/bin/${tool}`, source: "path" as const });
const fs: EngineFs = {
  mkdir: async () => {},
  rename: async () => {},
  rm: async () => {},
  exists: async () => false,
  list: async () => [],
  readText: async () => "",
};

const succeed: ProcessRunner = async (_c, args, h) => {
  h.onStdoutLine("MFPROGRESS 50 100 NA 10 5");
  h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip.mp4`);
  return { exitCode: 0 };
};

const INFO: MediaInfo = {
  title: "My Test Video",
  channel: "Test Channel",
  duration: 125,
  formats: [
    { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", filesize: 1000 },
    { format_id: "136", ext: "mp4", height: 720, vcodec: "avc1.4d", acodec: "none" },
    { format_id: "137", ext: "mp4", height: 1080, vcodec: "avc1.64", acodec: "none" },
  ],
};

interface Options {
  runner?: ProcessRunner;
  clipboard?: string | undefined;
  info?: (url: string) => Promise<MediaInfo>;
  settings?: Partial<Settings>;
  tools?: AppDeps["inspectTools"];
  folders?: FolderFs;
  /** Tools that start out missing. The default `installTool` removes a tool from this set. */
  missing?: Tool[];
  installTool?: AppDeps["installTool"];
  /** What the release check finds; "offline" makes it fail. Default: already the newest. */
  update?: Partial<UpdateInfo> | "offline";
  installUpdate?: AppDeps["installUpdate"];
}

function setup(options: Options = {}) {
  const seenArgs: string[][] = [];
  const opened: string[] = [];
  const store = memorySettingsStore(options.settings);
  const runner = options.runner ?? succeed;
  const engineOptions: ({ maxConcurrent?: number } | undefined)[] = [];
  const download: DownloadDeps = {
    env: {},
    isTTY: true,
    settings: store,
    onInterrupt: () => () => {},
    createEngine: (onUpdate, engineOpts) => {
      engineOptions.push(engineOpts);
      return new DownloadEngine({
        resolve: found,
        fs,
        onUpdate,
        ...engineOpts,
        run: (c, a, h, s) => {
          seenArgs.push(a);
          return runner(c, a, h, s);
        },
      });
    },
  };
  const missing = new Set<Tool>(options.missing ?? []);
  const installed: Tool[] = [];
  const updated: string[] = [];
  const deps: AppDeps = {
    download,
    fetchInfo: options.info ?? (async () => INFO),
    inspectTools:
      options.tools ??
      (async () => [
        missing.has("yt-dlp")
          ? { tool: "yt-dlp", found: false, error: "yt-dlp not found" }
          : {
              tool: "yt-dlp",
              found: true,
              version: "2026.1.1",
              // A downloaded yt-dlp lives in the tool cache; otherwise it is found on PATH.
              source: installed.includes("yt-dlp") ? "cache" : "path",
              path: "/bin/yt-dlp",
            },
        missing.has("ffmpeg")
          ? { tool: "ffmpeg", found: false, error: "ffmpeg not found" }
          : { tool: "ffmpeg", found: true, version: "9.0", source: "bundled", path: "/bin/ffmpeg" },
        missing.has("deno")
          ? { tool: "deno", found: false, error: "deno not found" }
          : { tool: "deno", found: true, version: "2.9.7", source: "cache", path: "/cache/deno" },
      ]),
    installTool:
      options.installTool ??
      (async (tool) => {
        installed.push(tool);
        missing.delete(tool);
        return { tool, version: "1", path: `/cache/${tool}`, sha256: "s", url: "u" };
      }),
    checkUpdate: async () => {
      if (options.update === "offline") throw new Error("offline");
      return {
        current: "9.9.9",
        latest: "9.9.9",
        tag: "v9.9.9",
        newer: false,
        installable: true,
        ...options.update,
      };
    },
    installUpdate:
      options.installUpdate ??
      (async (info) => {
        updated.push(info.latest);
      }),
    readClipboard: async () => ("clipboard" in options ? options.clipboard : URL),
    openFolder: async (p) => void opened.push(p),
    fileSize: async () => 5 * 1024 * 1024,
    folders:
      options.folders ??
      memoryFolderFs({ "/": ["downloads", "music"], "/downloads": [], "/music": [] }),
    configPath: "/config/mediaforge/config.json",
    target: "linux-x64",
    defaultOutputDir: "/downloads",
    binDir: "/app/bin",
    version: "9.9.9",
  };
  const app = render(<App deps={deps} />);
  return { app, deps, store, seenArgs, opened, engineOptions, installed, updated };
}

type TestApp = ReturnType<typeof setup>["app"];

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until some text is on screen. Text appears a few milliseconds before the new screen
 * starts listening for keys, so wait a moment longer before the test presses anything.
 */
async function waitFor(app: TestApp, text: string, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (app.lastFrame()?.includes(text)) {
      await tick(25);
      return;
    }
    await tick();
  }
  throw new Error(`Timed out waiting for "${text}". Last screen:\n${app.lastFrame()}`);
}

/** Move the highlight down until the row with this label is selected. */
async function moveTo(app: TestApp, label: string) {
  for (let i = 0; i < 12; i++) {
    const frame = app.lastFrame() ?? "";
    // The selection pointer sits at a fixed column; some unselected rows also use ► as their icon.
    const selected = frame
      .split("\n")
      .some((line) => line.startsWith("  ► ") && line.includes(label));
    if (selected) return;
    await press(app, KEY.down);
  }
  throw new Error(`Could not select "${label}". Last screen:\n${app.lastFrame()}`);
}

async function press(app: TestApp, ...keys: string[]) {
  for (const key of keys) {
    app.stdin.write(key);
    await tick(30);
  }
}

describe("home", () => {
  it("shows the title bar, the menu with icons, and key hints", async () => {
    const { app } = setup();
    await waitFor(app, "What would you like to do?");
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("█▀▄▀█ █▀▀ █▀▄ █ ▄▀█ █▀▀ █▀█ █▀█ █▀▀ █▀▀");
    expect(frame).toContain("█░▀░█ ██▄ █▄▀ █ █▀█ █▀░ █▄█ █▀▄ █▄█ ██▄");
    expect(frame).toContain("v9.9.9");
    for (const label of ["Download media", "Settings", "Check setup", "About", "Quit"]) {
      expect(frame).toContain(label);
    }
    expect(frame).toContain("►");
    expect(frame).toContain("Move");
    app.unmount();
  });

  it("replaces the screen instead of stacking history", async () => {
    const { app } = setup();
    await waitFor(app, "What would you like to do?");
    await press(app, KEY.down, KEY.enter);
    await waitFor(app, "Default download folder");
    expect(app.lastFrame()).not.toContain("What would you like to do?");
    app.unmount();
  });
});

describe("link step", () => {
  it("offers the clipboard link first and uses it", async () => {
    const { app } = setup();
    await waitFor(app, "What would you like to do?");
    await press(app, KEY.enter);
    await waitFor(app, "Use the link from the clipboard");
    await waitFor(app, URL);
    await press(app, KEY.enter);
    await waitFor(app, "My Test Video");
    app.unmount();
  });

  it("disables the clipboard choice when there is no link", async () => {
    const { app } = setup({ clipboard: "just some words" });
    await waitFor(app, "What would you like to do?");
    await press(app, KEY.enter);
    await waitFor(app, "no link found");
    // The first selectable choice is typing a link.
    await press(app, KEY.enter);
    await waitFor(app, "Type or paste one or more links");
    app.unmount();
  });

  it("accepts a pasted link, rejects an invalid one, and Esc goes back", async () => {
    const { app } = setup({ clipboard: undefined });
    await waitFor(app, "What would you like to do?");
    await press(app, KEY.enter);
    await waitFor(app, "no link found");
    await press(app, KEY.enter);
    await waitFor(app, "Type or paste one or more links");

    await press(app, "nope", KEY.enter);
    await waitFor(app, "No link found");

    await press(app, KEY.esc);
    await waitFor(app, "What do you want to download?");
    app.unmount();
  });

  it("pastes with Ctrl+V by reading the clipboard", async () => {
    const { app } = setup({ clipboard: "text before https://example.com/clip?x=1 after" });
    await waitFor(app, "What would you like to do?");
    await press(app, KEY.enter);
    await waitFor(app, "Use the link from the clipboard");
    // moveTo checks what is highlighted, so a key lost on a slow machine cannot pick the wrong row.
    await moveTo(app, "Type or paste links");
    await press(app, KEY.enter);
    await waitFor(app, "Type or paste one or more links");
    await press(app, KEY.ctrlV);
    // URL splits onto its own line; the non-URL words stay on the line above.
    await waitFor(app, "https://example.com/clip?x=1");
    app.unmount();
  });

  it("accepts text pasted by the terminal as typed input", async () => {
    const { app } = setup({ clipboard: undefined });
    await waitFor(app, "What would you like to do?");
    await press(app, KEY.enter);
    await waitFor(app, "no link found");
    await press(app, KEY.enter);
    await waitFor(app, "Type or paste one or more links");
    await press(app, "https://example.com/pasted");
    await waitFor(app, "https://example.com/pasted");
    app.unmount();
  });
});

describe("supported sites hint", () => {
  it("is shown on the link screen, both before and while typing", async () => {
    const { app } = setup({ clipboard: undefined });
    await waitFor(app, "What would you like to do?");
    await press(app, KEY.enter);
    await waitFor(app, "Copy one link");
    expect(app.lastFrame()).toContain("supportedsites.md");
    await press(app, KEY.enter);
    await waitFor(app, "Type or paste one or more links");
    expect(app.lastFrame()).toContain("supportedsites.md");
    app.unmount();
  });

  it("is linked from the error when a link is not supported", async () => {
    const t = setup({
      info: async () => {
        throw new CliError("Unsupported URL: https://x", ExitCode.UnsupportedSite);
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Could not read details for this link");
    expect(t.app.lastFrame()).toContain("supportedsites.md");
    t.app.unmount();
  });
});

describe("back stack", () => {
  /** Home, clipboard link, lookup, then wait for the type screen. */
  async function toQuality(options: Options = {}) {
    const t = setup(options);
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "What do you want to save?");
    return t;
  }

  it("walks back one page per Esc, including the format list", async () => {
    const { app } = await toQuality();
    await press(app, KEY.enter);
    await waitFor(app, "Choose a video quality");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");

    await press(app, KEY.esc);
    await waitFor(app, "Choose a video quality");
    await press(app, KEY.esc);
    await waitFor(app, "What do you want to save?");
    await press(app, KEY.esc);
    await waitFor(app, "What do you want to download?");
    await press(app, KEY.esc);
    await waitFor(app, "What would you like to do?");
    app.unmount();
  });

  it("asks before quitting when Esc is pressed on Home, and stays on N", async () => {
    const { app } = setup();
    await waitFor(app, "What would you like to do?");
    await press(app, KEY.esc);
    await waitFor(app, "Quit MediaForge?");
    await press(app, "n");
    await waitFor(app, "What would you like to do?");
    app.unmount();
  });

  it("goes Home from the result screen with Esc", async () => {
    const { app } = await toQuality();
    await press(app, KEY.enter);
    await waitFor(app, "Choose a video quality");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    await press(app, KEY.enter);
    await waitFor(app, "Download complete");
    await press(app, KEY.esc);
    await waitFor(app, "What would you like to do?");
    app.unmount();
  });

  it("cancelling a download returns to the page before it", async () => {
    const hang: ProcessRunner = (_c, _a, _h, signal) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve({ exitCode: 1 }), { once: true }),
      );
    const { app } = await toQuality({ runner: hang });
    await press(app, KEY.enter);
    await waitFor(app, "Choose a video quality");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    await press(app, KEY.enter);
    await waitFor(app, "Cancel download");
    await press(app, KEY.esc);
    await waitFor(app, "Where should it be saved?");
    // Nothing else says the download was cancelled, so the page shows a notice.
    expect(app.lastFrame()).toContain("Download cancelled");
    app.unmount();
  });

  it("shows the completed notice after leaving the result page, not on it", async () => {
    const { app } = await toQuality();
    await press(app, KEY.enter);
    await waitFor(app, "Choose a video quality");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    await press(app, KEY.enter);
    await waitFor(app, "Download complete");
    // The result page has its own card; the title is the only "Download complete" on it.
    expect(app.lastFrame()?.match(/Download complete/g)).toHaveLength(1);
    await press(app, KEY.esc);
    await waitFor(app, "What would you like to do?");
    expect(app.lastFrame()).toContain("Download complete");
    app.unmount();
  });
});

describe("download flow", () => {
  async function toQuality(options: Options = {}) {
    const t = setup(options);
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "What do you want to save?");
    return t;
  }

  /** Pick a type on the first screen and wait for its format list. */
  async function toFormats(kind: string, title: string, options: Options = {}) {
    const t = await toQuality(options);
    await moveTo(t.app, kind);
    await press(t.app, KEY.enter);
    await waitFor(t.app, title);
    return t;
  }

  it("shows what is being downloaded, then goes through folder, progress and result", async () => {
    const { app, seenArgs } = await toQuality();
    const quality = app.lastFrame() ?? "";
    expect(quality).toContain("My Test Video");
    expect(quality).toContain("Test Channel");
    expect(quality).toContain("2:05");
    expect(quality).toContain("Video with audio");
    expect(quality).toContain("Video only");
    expect(quality).toContain("Audio only");

    await press(app, KEY.enter);
    await waitFor(app, "Choose a video quality");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    expect(app.lastFrame()).toContain("/downloads");
    await press(app, KEY.enter);

    await waitFor(app, "Download complete");
    const done = app.lastFrame() ?? "";
    expect(done).toContain("Clip.mp4");
    expect(done).toContain("5.0 MB");
    expect(done).toContain("Open folder");
    expect(seenArgs).toHaveLength(1);
    app.unmount();
  });

  it("lets the user open the folder from the result screen", async () => {
    const { app, opened } = await toFormats("Video with audio", "Choose a video quality");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    await press(app, KEY.enter);
    await waitFor(app, "Download complete");
    await press(app, KEY.enter);
    await tick(50);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/Clip\.mp4$/);
    app.unmount();
  });

  it("downloads a specific video format with the exact selector", async () => {
    const { app, seenArgs } = await toFormats("Video with audio", "Choose a video quality");
    await moveTo(app, "720p");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    await press(app, KEY.enter);
    await waitFor(app, "Download complete");
    const args = seenArgs[0] as string[];
    expect(args[args.indexOf("-f") + 1]).toBe("136+ba/136");
    app.unmount();
  });

  it("downloads video only without adding audio", async () => {
    const { app, seenArgs } = await toFormats("Video only", "no sound");
    await moveTo(app, "720p");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    await press(app, KEY.enter);
    await waitFor(app, "Download complete");
    const args = seenArgs[0] as string[];
    expect(args[args.indexOf("-f") + 1]).toBe("136");
    app.unmount();
  });

  it("offers audio formats and converts to the chosen one", async () => {
    const { app, seenArgs } = await toFormats("Audio only", "Choose an audio format");
    await moveTo(app, "MP3");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    await press(app, KEY.enter);
    await waitFor(app, "Download complete");
    const args = seenArgs[0] as string[];
    expect(args[args.indexOf("--audio-format") + 1]).toBe("mp3");
    app.unmount();
  });

  it("goes back from the format list to the type screen", async () => {
    const { app } = await toFormats("Audio only", "Choose an audio format");
    await press(app, KEY.esc);
    await waitFor(app, "What do you want to save?");
    app.unmount();
  });

  it("sorts into a type folder, and says so on the folder screen", async () => {
    const { app, seenArgs } = await toFormats("Video only", "no sound");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    expect(app.lastFrame()).toContain('"Video only" folder');
    await press(app, KEY.enter);
    await waitFor(app, "Download complete");
    const args = seenArgs[0] as string[];
    expect((args[args.indexOf("--paths") + 1] as string).replaceAll("\\", "/")).toContain(
      "downloads/Video only/",
    );
    app.unmount();
  });

  it("saves straight into the folder when sorting is off", async () => {
    const { app, seenArgs } = await toFormats("Audio only", "Choose an audio format", {
      settings: { sortByType: false },
    });
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    expect(app.lastFrame()).not.toContain("folder inside the one you choose");
    await press(app, KEY.enter);
    await waitFor(app, "Download complete");
    const args = seenArgs[0] as string[];
    expect((args[args.indexOf("--paths") + 1] as string).replaceAll("\\", "/")).toMatch(
      /downloads\/\.mediaforge-/,
    );
    app.unmount();
  });

  it("skips questions that saved settings turn off", async () => {
    const t = setup({ settings: { askQuality: false, askFolder: false, quality: "mp4-720p" } });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download complete");
    const args = t.seenArgs[0] as string[];
    expect(args[args.indexOf("-f") + 1]).toBe("bv*[height<=720]+ba/b[height<=720]");
    t.app.unmount();
  });

  it("explains a failed lookup and can continue without details", async () => {
    const t = setup({
      info: async () => {
        throw new CliError("unable to download: HTTP Error 403: Forbidden", ExitCode.Network);
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Could not read details for this link");
    expect(t.app.lastFrame()).toContain("Updating yt-dlp usually fixes this");

    await press(t.app, KEY.down, KEY.enter);
    await waitFor(t.app, "Choose a quality");
    // Without details there is no specific-format option.
    expect(t.app.lastFrame()).not.toContain("specific format");
    t.app.unmount();
  });

  it("shows the error, a hint, and retries with the same choices", async () => {
    let calls = 0;
    const { app, seenArgs } = await toFormats("Video with audio", "Choose a video quality", {
      runner: async (c, a, h, s) => {
        calls++;
        if (calls === 1) {
          h.onStderrLine("ERROR: unable to download video data: HTTP Error 403: Forbidden");
          return { exitCode: 1 };
        }
        return succeed(c, a, h, s);
      },
    });
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    await press(app, KEY.enter);
    await waitFor(app, "Download failed");
    const failed = app.lastFrame() ?? "";
    expect(failed).toContain("HTTP Error 403");
    expect(failed).toContain("Updating yt-dlp usually fixes this");
    expect(failed).toContain("Try again");

    await press(app, KEY.enter);
    await waitFor(app, "Download complete");
    expect(seenArgs).toHaveLength(2);
    app.unmount();
  });

  it("goes back from the quality screen to the link screen", async () => {
    const { app } = await toQuality();
    await press(app, KEY.esc);
    await waitFor(app, "What do you want to download?");
    app.unmount();
  });
});

describe("settings", () => {
  async function openSettings(options: Options = {}) {
    const t = setup(options);
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.down, KEY.enter);
    await waitFor(t.app, "Default download folder");
    return t;
  }

  it("toggles whether to ask each time and saves it", async () => {
    const t = await openSettings();
    await moveTo(t.app, "Ask for the folder each time");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Saved");
    expect((await t.store.load()).askFolder).toBe(false);
    expect(t.app.lastFrame()).toContain("No, use the default");
    t.app.unmount();
  });

  it("saves a default quality", async () => {
    const t = await openSettings();
    await moveTo(t.app, "Default quality");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Enter Save");
    await moveTo(t.app, "MP4 1080p");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Saved");
    expect((await t.store.load()).quality).toBe("mp4-1080p");
    t.app.unmount();
  });

  it("turns type folders off and on", async () => {
    const t = await openSettings();
    await moveTo(t.app, "Sort into folders by type");
    expect(t.app.lastFrame()).toContain("Video, Video only, Audio");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Saved");
    expect((await t.store.load()).sortByType).toBe(false);
    t.app.unmount();
  });

  it("resets only after confirmation", async () => {
    const t = await openSettings({ settings: { folder: "/x", askQuality: false } });
    await moveTo(t.app, "Reset to built-in defaults");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Reset all settings?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Default download folder");
    expect((await t.store.load()).folder).toBe("/x");

    await moveTo(t.app, "Reset to built-in defaults");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Reset all settings?");
    await press(t.app, KEY.down, KEY.enter);
    await waitFor(t.app, "Saved");
    expect(await t.store.load()).toEqual({
      askFolder: true,
      askQuality: true,
      sortByType: true,
      concurrency: 2,
    });
    t.app.unmount();
  });

  it("goes back to the home screen with Esc", async () => {
    const t = await openSettings();
    await press(t.app, KEY.esc);
    await waitFor(t.app, "What would you like to do?");
    t.app.unmount();
  });
});

describe("folder picker", () => {
  const TREE = {
    "/": ["downloads", "music", "secret"],
    "/downloads": ["Existing", "extra"],
    "/downloads/Existing": [],
    "/downloads/extra": [],
    "/music": [],
    "/secret": [],
    "/h": [".cache", "src"],
    "/m": ["alpha", "alps"],
    "/m/alpha": [],
    "/m/alps": [],
  };
  const TAB = "\t";
  const CTRL_N = "\u000E";

  async function toPicker(options: Options = {}) {
    const t = setup({ folders: memoryFolderFs(TREE, { unreadable: ["/secret"] }), ...options });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.down, KEY.enter);
    await waitFor(t.app, "Default download folder");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Choose a folder");
    return t;
  }

  it("opens on the current folder and lists what is in it", async () => {
    const t = await toPicker();
    const frame = t.app.lastFrame() ?? "";
    expect(frame).toContain("/downloads/");
    expect(frame).toContain("Existing");
    expect(frame).toContain("extra");
    expect(frame).toContain("Ctrl+V pastes");
    t.app.unmount();
  });

  it("narrows the list as you type, and Tab completes into the folder", async () => {
    const t = await toPicker();
    await press(t.app, "Exi");
    await waitFor(t.app, "/downloads/Exi");
    expect(t.app.lastFrame()).not.toContain("extra");
    await press(t.app, TAB);
    await waitFor(t.app, "/downloads/Existing/");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Saved");
    expect((await t.store.load()).folder).toBe("/downloads/Existing");
    t.app.unmount();
  });

  it("moves the highlight with the arrow keys before completing", async () => {
    const t = await toPicker({ settings: { folder: "/m" } });
    await press(t.app, "al");
    await waitFor(t.app, "alps");
    await press(t.app, KEY.down, TAB);
    await waitFor(t.app, "/m/alps/");
    t.app.unmount();
  });

  it("picks the folder shown in the box on Enter", async () => {
    const t = await toPicker();
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Saved");
    expect((await t.store.load()).folder).toBe("/downloads");
    t.app.unmount();
  });

  it("says a folder does not exist, and Ctrl+N creates it", async () => {
    const t = await toPicker();
    await press(t.app, "Fresh", KEY.enter);
    await waitFor(t.app, "does not exist");
    expect(t.app.lastFrame()).toContain("Ctrl+N");
    await press(t.app, CTRL_N);
    await waitFor(t.app, "Saved");
    expect((await t.store.load()).folder).toBe("/downloads/Fresh");
    t.app.unmount();
  });

  it("does not create a folder when its parent is missing", async () => {
    const t = await toPicker();
    await press(t.app, "a:b/c", CTRL_N);
    await waitFor(t.app, "does not exist");
    expect((await t.store.load()).folder).toBeUndefined();
    t.app.unmount();
  });

  it("replaces the box with a pasted full path", async () => {
    const t = await toPicker({ clipboard: "/music" });
    await press(t.app, KEY.ctrlV);
    await waitFor(t.app, "Choose a folder");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Saved");
    expect((await t.store.load()).folder).toBe("/music");
    t.app.unmount();
  });

  it("clears the box with Ctrl+U and edits with Backspace", async () => {
    const t = await toPicker();
    await press(t.app, "\u007F");
    await waitFor(t.app, "/downloads");
    await press(t.app, KEY.ctrlU);
    await waitFor(t.app, "Start with /");
    t.app.unmount();
  });

  it("says why when a folder cannot be opened", async () => {
    const t = await toPicker({ settings: { folder: "/" } });
    await press(t.app, "secret/");
    await waitFor(t.app, "Permission denied");
    t.app.unmount();
  });

  it("shows hidden folders once the name starts with a dot", async () => {
    const t = await toPicker({ settings: { folder: "/h" } });
    expect(t.app.lastFrame()).toContain("src");
    expect(t.app.lastFrame()).not.toContain(".cache");
    await press(t.app, ".");
    await waitFor(t.app, ".cache");
    t.app.unmount();
  });

  it("completes a drive on Windows", async () => {
    const fs = memoryFolderFs(
      { "C:\\": ["Users"], "D:\\": ["Games"] },
      { platform: "win32", drives: ["C:\\", "D:\\"] },
    );
    const t = setup({ folders: fs, settings: { folder: "C:\\" } });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.down, KEY.enter);
    await waitFor(t.app, "Default download folder");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Choose a folder");
    await press(t.app, KEY.ctrlU, "d");
    await waitFor(t.app, "D:\\");
    await press(t.app, TAB);
    await waitFor(t.app, "Games");
    t.app.unmount();
  });

  it("goes back to Settings with Esc without saving", async () => {
    const t = await toPicker();
    await press(t.app, KEY.esc);
    await waitFor(t.app, "Default download folder");
    expect((await t.store.load()).folder).toBeUndefined();
    t.app.unmount();
  });

  it("is also offered on the download folder step", async () => {
    const t = setup({ folders: memoryFolderFs(TREE) });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "What do you want to save?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Choose a video quality");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Where should it be saved?");
    await moveTo(t.app, "Choose another folder");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Choose a folder");
    await press(t.app, "Exi", TAB);
    await waitFor(t.app, "/downloads/Existing/");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download complete");
    t.app.unmount();
  });
});

describe("check setup", () => {
  it("shows each tool with its version and source", async () => {
    const { app } = setup();
    await waitFor(app, "What would you like to do?");
    await press(app, KEY.down, KEY.down, KEY.enter);
    await waitFor(app, "Everything is ready.");
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("yt-dlp");
    expect(frame).toContain("2026.1.1");
    expect(frame).toContain("(bundled)");
    app.unmount();
  });

  it("points to the download button for a missing tool, with no PATH talk", async () => {
    const { app } = setup({
      tools: async () => [
        { tool: "yt-dlp", found: true, version: "1", source: "path", path: "/bin/yt-dlp" },
        { tool: "ffmpeg", found: false, error: "ffmpeg not found" },
      ],
    });
    await waitFor(app, "What would you like to do?");
    await press(app, KEY.down, KEY.down, KEY.enter);
    await waitFor(app, "Some tools are missing");
    expect(app.lastFrame()).toContain('Choose "Download missing tools" below.');
    expect(app.lastFrame()).not.toContain("MEDIAFORGE_FFMPEG_PATH");
    app.unmount();
  });

  it("falls back to the manual fixes once a download has failed", async () => {
    const { app } = setup({
      tools: async () => [
        { tool: "yt-dlp", found: true, version: "1", source: "path", path: "/bin/yt-dlp" },
        { tool: "ffmpeg", found: false, error: "ffmpeg not found" },
      ],
      installTool: async () => {
        throw new ToolInstallError(
          "offline",
          "Could not reach github.com.",
          "Check your internet.",
        );
      },
    });
    await waitFor(app, "What would you like to do?");
    await press(app, KEY.down, KEY.down, KEY.enter);
    await waitFor(app, "Download missing tools");
    await press(app, KEY.enter);
    await waitFor(app, "Could not reach github.com.");
    expect(app.lastFrame()).toContain("MEDIAFORGE_FFMPEG_PATH");
    app.unmount();
  });
});

describe("missing tools", () => {
  it("offers to download them before the first download, then continues", async () => {
    const t = setup({ missing: ["yt-dlp", "ffmpeg"] });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download missing tools");
    expect(t.app.lastFrame()).toContain("yt-dlp and ffmpeg");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Continue");
    expect(t.installed).toEqual(["yt-dlp", "ffmpeg"]);
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    t.app.unmount();
  });

  it("shows the reason and keeps the choice when a download fails", async () => {
    const t = setup({
      missing: ["yt-dlp"],
      installTool: async () => {
        throw new ToolInstallError(
          "offline",
          "Could not reach github.com.",
          "Check your internet connection, then try again.",
        );
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download missing tools");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Could not reach github.com.");
    expect(t.app.lastFrame()).toContain("Check your internet connection");
    expect(t.app.lastFrame()).toContain("Download missing tools");
    expect(t.app.lastFrame()).not.toContain("Continue");
    t.app.unmount();
  });

  it("is also offered from Check setup, without a Continue choice", async () => {
    const t = setup({ missing: ["ffmpeg"] });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.down, KEY.down, KEY.enter);
    await waitFor(t.app, "Download missing tools");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Everything is ready.");
    expect(t.installed).toEqual(["ffmpeg"]);
    expect(t.app.lastFrame()).not.toContain("Continue");
    t.app.unmount();
  });

  it("opens the link screen without waiting for a slow tool check", async () => {
    const t = setup({ tools: () => new Promise(() => {}) });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    t.app.unmount();
  });

  it("moves to the setup prompt when a slow check finds a missing tool", async () => {
    const t = setup({
      tools: async () => {
        await tick(300);
        return [{ tool: "yt-dlp", found: false, error: "yt-dlp not found" }];
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download missing tools");
    t.app.unmount();
  });

  it("stays on the link screen when a slow check finds nothing missing", async () => {
    const t = setup({
      tools: async () => {
        await tick(300);
        return [{ tool: "yt-dlp", found: true, version: "1", source: "path", path: "/bin/yt-dlp" }];
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await tick(400);
    expect(t.app.lastFrame()).toContain(URL);
    t.app.unmount();
  });

  it("goes straight to the link screen when nothing is missing", async () => {
    const t = setup();
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    expect(t.installed).toEqual([]);
    t.app.unmount();
  });
});

describe("stale extractor", () => {
  const STALE =
    "ERROR: [generic] Unable to extract title; please report this issue on https://github.com/yt-dlp/yt-dlp/issues . Confirm you are on the latest version using yt-dlp -U";
  const SKIP_QUESTIONS = { askQuality: false, askFolder: false, quality: "mp4-720p" } as const;

  it("offers to update yt-dlp, and retries the download after the update", async () => {
    let calls = 0;
    const t = setup({
      settings: SKIP_QUESTIONS,
      runner: async (c, a, h, s) => {
        calls++;
        if (calls === 1) {
          h.onStderrLine(STALE);
          return { exitCode: 1 };
        }
        return succeed(c, a, h, s);
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download failed");
    const failed = t.app.lastFrame() ?? "";
    expect(failed).toContain("Update yt-dlp and retry");
    // Nothing happens until the user picks it: "Try again" is the highlighted choice.
    expect(t.installed).toEqual([]);
    expect(failed).toMatch(/► .*Try again/);

    await moveTo(t.app, "Update yt-dlp and retry");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download complete");
    expect(t.installed).toEqual(["yt-dlp"]);
    expect(calls).toBe(2);
    t.app.unmount();
  });

  it("does not offer the update for failures that an update would not fix", async () => {
    const t = setup({
      settings: SKIP_QUESTIONS,
      runner: async (_c, _a, h) => {
        h.onStderrLine("ERROR: [Errno 28] No space left on device");
        return { exitCode: 1 };
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download failed");
    expect(t.app.lastFrame()).not.toContain("Update yt-dlp and retry");
    t.app.unmount();
  });

  it("shows why the update failed and lets the user go back", async () => {
    const t = setup({
      settings: SKIP_QUESTIONS,
      runner: async (_c, _a, h) => {
        h.onStderrLine(STALE);
        return { exitCode: 1 };
      },
      installTool: async () => {
        throw new ToolInstallError(
          "offline",
          "Could not reach github.com.",
          "Check your internet connection, then try again.",
        );
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download failed");
    await moveTo(t.app, "Update yt-dlp and retry");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Could not reach github.com.");
    await press(t.app, KEY.esc);
    await waitFor(t.app, "Download failed");
    t.app.unmount();
  });

  /** Download, fail with the stale error, and open the update screen. */
  async function toUpdate(options: Options) {
    const t = setup({ settings: SKIP_QUESTIONS, ...options });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, URL);
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download failed");
    await moveTo(t.app, "Update yt-dlp and retry");
    await press(t.app, KEY.enter);
    return t;
  }

  it("runs the update again from its own Try again after a failed update", async () => {
    let installs = 0;
    let calls = 0;
    const t = await toUpdate({
      runner: async (c, a, h, s) => {
        calls++;
        if (calls === 1) {
          h.onStderrLine(STALE);
          return { exitCode: 1 };
        }
        return succeed(c, a, h, s);
      },
      installTool: async (tool) => {
        if (++installs === 1) {
          throw new ToolInstallError("offline", "Could not reach github.com.", "Try again.");
        }
        return { tool, version: "1", path: `/cache/${tool}`, sha256: "s", url: "u" };
      },
      tools: async () => [
        { tool: "yt-dlp", found: true, version: "1", source: "cache", path: "/cache/yt-dlp" },
        { tool: "ffmpeg", found: true, version: "9.0", source: "bundled", path: "/bin/ffmpeg" },
      ],
    });
    await waitFor(t.app, "Could not reach github.com.");
    await moveTo(t.app, "Try again");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download complete");
    expect(installs).toBe(2);
    expect(calls).toBe(2);
    t.app.unmount();
  });

  it("does not retry on its own when another yt-dlp takes priority over the downloaded one", async () => {
    let calls = 0;
    const t = await toUpdate({
      runner: async (c, a, h, s) => {
        calls++;
        if (calls === 1) {
          h.onStderrLine(STALE);
          return { exitCode: 1 };
        }
        return succeed(c, a, h, s);
      },
      // The yt-dlp on PATH wins over the cache, before and after the update.
      tools: async () => [
        { tool: "yt-dlp", found: true, version: "1", source: "path", path: "/usr/bin/yt-dlp" },
        { tool: "ffmpeg", found: true, version: "9.0", source: "bundled", path: "/bin/ffmpeg" },
      ],
    });
    await waitFor(t.app, "Retry the download anyway");
    const notice = t.app.lastFrame() ?? "";
    expect(notice).toContain("path (/usr/bin/yt-dlp)");
    expect(notice).toContain("Retry the download anyway");
    expect(calls).toBe(1);

    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download complete");
    expect(calls).toBe(2);
    t.app.unmount();
  });

  it("goes back from the priority notice without retrying", async () => {
    let calls = 0;
    const t = await toUpdate({
      runner: async (_c, _a, h) => {
        calls++;
        h.onStderrLine(STALE);
        return { exitCode: 1 };
      },
      tools: async () => [
        { tool: "yt-dlp", found: true, version: "1", source: "path", path: "/usr/bin/yt-dlp" },
        { tool: "ffmpeg", found: true, version: "9.0", source: "bundled", path: "/bin/ffmpeg" },
      ],
    });
    await waitFor(t.app, "Retry the download anyway");
    await press(t.app, KEY.esc);
    await waitFor(t.app, "Download failed");
    expect(calls).toBe(1);
    t.app.unmount();
  });

  it("retries straight away when the tool check cannot run after the update", async () => {
    let calls = 0;
    let checks = 0;
    const t = await toUpdate({
      runner: async (c, a, h, s) => {
        calls++;
        if (calls === 1) {
          h.onStderrLine(STALE);
          return { exitCode: 1 };
        }
        return succeed(c, a, h, s);
      },
      tools: async () => {
        // Home's check passes; the check after the update fails.
        if (++checks > 1) throw new Error("probe failed");
        return [
          { tool: "yt-dlp", found: true, version: "1", source: "path", path: "/usr/bin/yt-dlp" },
          { tool: "ffmpeg", found: true, version: "9.0", source: "bundled", path: "/bin/ffmpeg" },
        ];
      },
    });
    await waitFor(t.app, "Download complete");
    expect(calls).toBe(2);
    t.app.unmount();
  });
});

describe("home tool check", () => {
  it("ignores further picks while the tools are being checked", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = setup({
      tools: async () => {
        await gate;
        return [
          { tool: "yt-dlp", found: true, version: "1", source: "path", path: "/bin/yt-dlp" },
          { tool: "ffmpeg", found: true, version: "9", source: "bundled", path: "/bin/ffmpeg" },
        ];
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter, KEY.enter);
    release();
    await waitFor(t.app, "What do you want to download?");
    // One screen was pushed, so one Esc is back at Home.
    await press(t.app, KEY.esc);
    await waitFor(t.app, "What would you like to do?");
    t.app.unmount();
  });

  it("still opens the link screen when the tool check fails", async () => {
    const t = setup({
      tools: async () => {
        throw new Error("probe failed");
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "What do you want to download?");
    t.app.unmount();
  });

  it("accepts another pick once the check is over", async () => {
    // Call 1 is the check that starts with the app; calls 2 and 3 are the two picks.
    let checks = 0;
    const t = setup({
      tools: async () => {
        if (++checks === 2) throw new Error("probe failed");
        return [
          { tool: "yt-dlp", found: true, version: "1", source: "path", path: "/bin/yt-dlp" },
          { tool: "ffmpeg", found: true, version: "9", source: "bundled", path: "/bin/ffmpeg" },
        ];
      },
    });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "What do you want to download?");
    await press(t.app, KEY.esc);
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "What do you want to download?");
    expect(checks).toBe(3);
    t.app.unmount();
  });
});

describe("about", () => {
  it("shows the app, tools, developer, sites link and notices", async () => {
    const { app } = setup();
    await waitFor(app, "What would you like to do?");
    await moveTo(app, "About");
    await press(app, KEY.enter);
    await waitFor(app, "About MediaForge");
    // The tool versions load a moment later. ("yt-dlp" alone would match Home's hint text.)
    await waitFor(app, "2026.1.1");
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("9.9.9");
    expect(frame).toContain("linux-x64");
    expect(frame).toContain("/config/mediaforge/config.json");
    expect(frame).toContain("N-Berns");
    expect(frame).toContain("supportedsites.md");
    expect(frame).toContain("Unlicense");
    expect(frame).toContain("LGPL");
    await press(app, KEY.esc);
    await waitFor(app, "What would you like to do?");
    app.unmount();
  });
});

describe("updating MediaForge", () => {
  const NEWER = { latest: "10.0.0", tag: "v10.0.0", newer: true };

  async function openAbout(options: Options) {
    const t = setup(options);
    await waitFor(t.app, "What would you like to do?");
    await moveTo(t.app, "About");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "About MediaForge");
    return t;
  }

  it("tells the user at startup that a newer version exists", async () => {
    const { app } = setup({ update: NEWER });
    await waitFor(app, "MediaForge 10.0.0 is available. Open About to update.");
    app.unmount();
  });

  it("says nothing at startup when it is up to date or offline", async () => {
    for (const update of [undefined, "offline" as const]) {
      const { app } = setup({ update });
      await waitFor(app, "What would you like to do?");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(app.lastFrame()).not.toContain("is available");
      app.unmount();
    }
  });

  it("shows 'up to date' on About, and a quiet message when offline", async () => {
    const current = await openAbout({});
    await waitFor(current.app, "MediaForge is up to date.");
    expect(current.app.lastFrame()).not.toContain("Update to");
    current.app.unmount();

    const offline = await openAbout({ update: "offline" });
    await waitFor(offline.app, "Could not check for updates.");
    offline.app.unmount();
  });

  it("offers the update on About and installs it on Enter", async () => {
    const t = await openAbout({ update: NEWER });
    await waitFor(t.app, "Version 10.0.0 is available (you have 9.9.9).");
    await waitFor(t.app, "Update to 10.0.0");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Updated to 10.0.0. Restart MediaForge to use it.");
    expect(t.updated).toEqual(["10.0.0"]);
    expect(t.app.lastFrame()).not.toContain("Update to 10.0.0");
    t.app.unmount();
  });

  it("shows the reason when the update fails, and can try again", async () => {
    let attempts = 0;
    const t = await openAbout({
      update: NEWER,
      installUpdate: async () => {
        attempts++;
        if (attempts === 1) {
          throw new ToolInstallError(
            "offline",
            "Could not reach github.com.",
            "Check your internet.",
          );
        }
      },
    });
    await waitFor(t.app, "Update to 10.0.0");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Could not reach github.com.");
    await waitFor(t.app, "Try again");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Updated to 10.0.0.");
    t.app.unmount();
  });

  it("sends the user from About to Check setup, which downloads the missing tools", async () => {
    const t = await openAbout({ missing: ["deno"] });
    await waitFor(t.app, "not found (needed for YouTube)");
    await waitFor(t.app, "Download missing tools");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Check setup");
    await waitFor(t.app, "Everything is ready.");
    expect(t.installed).toEqual(["deno"]);
    // Back goes to Home, not to About.
    await press(t.app, KEY.esc);
    await waitFor(t.app, "What would you like to do?");
    t.app.unmount();
  });

  it("does not offer the button when MediaForge runs through Node", async () => {
    const t = await openAbout({ update: { ...NEWER, installable: false } });
    await waitFor(t.app, "Version 10.0.0 is available");
    expect(t.app.lastFrame()).toContain("only in the installed program");
    expect(t.app.lastFrame()).not.toContain("Update to");
    t.app.unmount();
  });
});

describe("bulk download", () => {
  const LINKS = ["https://www.youtube.com/watch?v=1", "https://www.twitch.tv/videos/2"];
  const titled = async (url: string): Promise<MediaInfo> => ({
    ...INFO,
    title: url.includes("twitch") ? "Stream Video" : "Tube Video",
  });

  /** Home, then the clipboard choice with both links, then wait for the given screen. */
  async function start(options: Options, until: string) {
    const t = setup({ clipboard: LINKS.join("\n"), info: titled, ...options });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Use the 2 links from the clipboard");
    expect(t.app.lastFrame()).toContain("youtube.com, twitch.tv");
    await press(t.app, KEY.enter);
    await waitFor(t.app, until);
    return t;
  }

  async function toReview(options: Options = {}) {
    const t = await start(options, "What do you want to save from these 2 links?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Ready to download 2 links");
    return t;
  }

  async function startDownloads(app: TestApp) {
    await moveTo(app, "Start downloading");
    await press(app, KEY.enter);
    await waitFor(app, "Where should it be saved?");
    expect(app.lastFrame()).toContain("Each file goes into a Video, Video only or Audio folder");
    await press(app, KEY.enter);
  }

  it("downloads links from different sites with one choice, using the saved number at once", async () => {
    const t = await toReview({ settings: { concurrency: 3 } });
    const review = t.app.lastFrame() ?? "";
    expect(review).toContain("Tube Video");
    expect(review).toContain("Stream Video");
    expect(review).toContain("twitch.tv");
    await startDownloads(t.app);
    await waitFor(t.app, "All 2 downloads complete");
    expect(t.seenArgs).toHaveLength(2);
    expect(t.engineOptions).toContainEqual({ maxConcurrent: 3 });
    t.app.unmount();
  });

  it("lists the links found while typing and skips text that is not a link", async () => {
    const t = setup({ clipboard: undefined });
    await waitFor(t.app, "What would you like to do?");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "no link found");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Type or paste one or more links");
    expect(t.app.lastFrame()).toContain("paste several links at once");
    await press(t.app, "https://a.com/1 https://b.tv/2 junk");
    await waitFor(t.app, "2 links found");
    const frame = t.app.lastFrame() ?? "";
    expect(frame).toContain("b.tv");
    expect(frame).toContain("Skipped (not a link): junk");
    t.app.unmount();
  });

  it("gives one link its own quality", async () => {
    const t = await toReview();
    await moveTo(t.app, "Stream Video");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "What do you want to save?");
    await moveTo(t.app, "Audio only");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Choose an audio format");
    await moveTo(t.app, "MP3");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "(changed)");
    await startDownloads(t.app);
    await waitFor(t.app, "All 2 downloads complete");
    const audio = t.seenArgs.filter((a) => a.includes("--audio-format"));
    expect(audio).toHaveLength(1);
    expect(audio[0]?.at(-1)).toBe(LINKS[1]);
    t.app.unmount();
  });

  it("keeps going when a link fails, then retries only the failed one", async () => {
    let failOnce = true;
    const t = await toReview({
      runner: async (c, a, h, s) => {
        if (failOnce && a.at(-1)?.includes("twitch")) {
          failOnce = false;
          h.onStderrLine("ERROR: unable to download video data: HTTP Error 403: Forbidden");
          return { exitCode: 1 };
        }
        return succeed(c, a, h, s);
      },
    });
    await startDownloads(t.app);
    await waitFor(t.app, "1 of 2 saved, 1 not saved");
    expect(t.app.lastFrame()).toContain("HTTP Error 403");
    await waitFor(t.app, "Try the failed link again");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Download complete");
    expect(t.seenArgs).toHaveLength(3);
    expect(t.seenArgs[2]?.at(-1)).toBe(LINKS[1]);
    t.app.unmount();
  });

  it("explains links whose details could not be read and can continue without them", async () => {
    const t = await start(
      {
        info: async (url) => {
          if (url.includes("twitch"))
            throw new CliError("Unsupported URL", ExitCode.UnsupportedSite);
          return titled(url);
        },
      },
      "Could not read details for 1 of 2 links",
    );
    expect(t.app.lastFrame()).toContain("Unsupported URL");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "What do you want to save from these 2 links?");
    t.app.unmount();
  });

  const TRACK: MediaInfo = {
    title: "Sound Track",
    formats: [{ format_id: "0", ext: "mp3", vcodec: "none", acodec: "mp3" }],
  };
  const STORYBOARD: MediaInfo = {
    title: "Odd Page",
    formats: [{ format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none" }],
  };
  const mixed = async (url: string): Promise<MediaInfo> =>
    url.includes("twitch") ? TRACK : titled(url);

  it("applies a type only to the links that can use it, then asks for the rest", async () => {
    const t = await start({ info: mixed }, "What do you want to save from these 2 links?");
    const first = t.app.lastFrame() ?? "";
    expect(first).toContain("Video with audio · 1 of 2 links");
    expect(first).toContain("Audio only · 2 of 2 links");

    await press(t.app, KEY.enter);
    await waitFor(t.app, "1 link still needs a type");
    expect(t.app.lastFrame()).toContain("Video with audio · 0 of 1 link");

    await press(t.app, KEY.enter);
    await waitFor(t.app, "Ready to download 2 links");
    const review = t.app.lastFrame() ?? "";
    expect(review).toContain("Video with audio: Best available");
    expect(review).toContain("Audio only: Best audio (m4a)");
    t.app.unmount();
  });

  it("does not offer to start when no link has anything to download", async () => {
    // Nothing can be assigned, so the type step is skipped straight to Review.
    const t = await start({ info: async () => STORYBOARD }, "Nothing to download");
    const frame = t.app.lastFrame() ?? "";
    expect(frame).toContain("no downloadable formats");
    expect(frame).not.toContain("Start downloading");
    // Esc still leaves: the batch has nowhere earlier to go, so it returns to the link screen.
    await press(t.app, KEY.esc);
    await waitFor(t.app, "What do you want to download?");
    t.app.unmount();
  });

  it("walks back through the batch instead of toggling between two screens", async () => {
    const t = await toReview();
    await press(t.app, KEY.esc);
    await waitFor(t.app, "What do you want to save from these 2 links?");
    // The undone pick is gone: nothing is assigned yet.
    expect(t.app.lastFrame()).toContain("Video with audio · 2 of 2 links");
    await press(t.app, KEY.esc);
    await waitFor(t.app, "What do you want to download?");
    await press(t.app, KEY.esc);
    await waitFor(t.app, "What would you like to do?");
    t.app.unmount();
  });

  it("keeps links without details assignable to any type", async () => {
    const t = await start(
      {
        info: async (url) => {
          if (url.includes("twitch")) throw new CliError("403", ExitCode.Network);
          return titled(url);
        },
      },
      "Could not read details for 1 of 2 links",
    );
    await press(t.app, KEY.enter);
    await waitFor(t.app, "What do you want to save from these 2 links?");
    expect(t.app.lastFrame()).toContain("Video only · 2 of 2 links");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Ready to download 2 links");
    t.app.unmount();
  });

  it("keeps the earlier results when a retry is cancelled", async () => {
    let twitchRuns = 0;
    const t = await toReview({
      runner: (c, a, h, s) => {
        if (!a.at(-1)?.includes("twitch")) return succeed(c, a, h, s);
        // The first run fails; the retry hangs until it is cancelled.
        if (twitchRuns++ === 0) {
          h.onStderrLine("ERROR: unable to download video data: HTTP Error 403: Forbidden");
          return Promise.resolve({ exitCode: 1 });
        }
        return new Promise((resolve) =>
          s.addEventListener("abort", () => resolve({ exitCode: 1 }), { once: true }),
        );
      },
    });
    await startDownloads(t.app);
    await waitFor(t.app, "1 of 2 saved, 1 not saved");
    await waitFor(t.app, "Try the failed link again");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Downloading 1 links");
    await tick(150);
    await press(t.app, KEY.esc);
    await waitFor(t.app, "1 of 2 saved, 1 not saved");
    t.app.unmount();
  });

  it("shows what was saved when a batch is cancelled after some links finished", async () => {
    let calls = 0;
    const t = await toReview({
      runner: (c, a, h, s) => {
        calls++;
        if (calls === 1) return succeed(c, a, h, s);
        return new Promise((resolve) =>
          s.addEventListener("abort", () => resolve({ exitCode: 1 }), { once: true }),
        );
      },
    });
    await startDownloads(t.app);
    await waitFor(t.app, "Overall");
    await tick(150);
    await press(t.app, KEY.esc);
    await waitFor(t.app, "saved");
    expect(t.app.lastFrame()).toContain("1 of 2 saved");
    t.app.unmount();
  });
});
