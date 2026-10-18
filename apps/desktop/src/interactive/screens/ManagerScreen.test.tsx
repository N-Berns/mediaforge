import type { DownloadJob, Notice } from "@mediaforge/shared-types";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { HistoryStore, memoryHistoryFs } from "../../core/history.ts";
import { inProcessCore } from "../../core/in-process.ts";
import type { TrashFn } from "../../core/trash.ts";
import { DownloadEngine, type EngineFs } from "../../engine/index.ts";
import type { ProcessRunner } from "../../engine/process.ts";
import { memorySettingsStore, type Settings } from "../../settings.ts";
import type { AppDeps } from "../deps.ts";
import { DepsContext } from "../deps.ts";
import { NO_FILTERS } from "../manager/model.ts";
import { InputHub } from "../mouse/input.ts";
import { MouseProvider } from "../mouse/MouseProvider.tsx";
import { attachTestStdin, clickAt, wheelAt } from "../mouse/testing.ts";
import { SpeedUnitContext } from "../speed-unit.ts";
import { ManagerScreen, type ManagerScreenProps } from "./ManagerScreen.tsx";

const KEY = {
  enter: "\r",
  esc: "\u001B",
  up: "\u001B[A",
  down: "\u001B[B",
  pageDown: "\u001B[6~",
  home: "\u001B[H",
  end: "\u001B[F",
  del: "\u001B[3~",
  ctrlA: "\u0001",
  right: "\u001B[C",
  left: "\u001B[D",
};

const URL = "https://example.com/watch?v=abc";
const fs: EngineFs = {
  mkdir: async () => {},
  rename: async () => {},
  rm: async () => {},
  exists: async () => false,
  list: async () => [],
  readText: async () => "",
};

type Row = DownloadJob & { files: string[] };

function row(id: string, patch: Partial<Row> & { title?: string; url?: string } = {}): Row {
  const { title, url = URL, ...rest } = patch;
  return {
    id,
    request: {
      candidate: {
        id: url,
        pageUrl: url,
        url,
        ...(title && { pageTitle: title }),
        kind: "video",
        streamType: "progressive",
        source: "dom",
        variants: [],
        detectedAt: 0,
      },
      profileId: "mp4-720p",
    },
    status: "completed",
    progress: { bytesDownloaded: 0 },
    createdAt: 1,
    updatedAt: 1,
    files: [],
    ...rest,
  };
}

/** A download that reports half its progress, then waits until released. */
function slowRunner() {
  const waiting: (() => void)[] = [];
  const runner: ProcessRunner = async (_c, args, h, signal) => {
    h.onStdoutLine("MFPROGRESS 50 100 NA 10 5");
    await new Promise<void>((r) => {
      waiting.push(r);
      signal?.addEventListener("abort", () => r());
    });
    h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip.mp4`);
    return { exitCode: signal?.aborted ? 1 : 0 };
  };
  return {
    runner,
    releaseAll: () => {
      for (const release of waiting.splice(0)) release();
    },
  };
}

interface MountOptions {
  jobs?: Row[];
  notice?: Notice;
  settings?: Partial<Settings>;
  runner?: ProcessRunner;
  trash?: TrashFn;
  columns?: number;
  rows?: number;
  props?: Partial<ManagerScreenProps>;
  /**
   * The double-click clock. By default it moves 1 s on every read, so no two clicks are a
   * double-click however fast the test machine runs; `() => 0` makes every repeat one.
   */
  now?: () => number;
}

const neverDouble = () => {
  let time = 0;
  return () => {
    time += 1000;
    return time;
  };
};

async function mount(options: MountOptions = {}) {
  const store = memorySettingsStore(options.settings);
  const history = await HistoryStore.open({
    path: "/h/history.json",
    fs: memoryHistoryFs({
      "/h/history.json": JSON.stringify({
        version: 1,
        cleanExit: true,
        jobs: options.jobs ?? [],
        ...(options.notice && { notice: options.notice }),
      }),
    }),
    debounceMs: 0,
  });
  const openPath = vi.fn(async () => {});
  const core = inProcessCore({
    settings: store,
    history,
    openPath,
    ...(options.trash && { trash: options.trash }),
    createEngine: (onUpdate) =>
      new DownloadEngine({
        resolve: async (tool) => ({ tool, path: `/bin/${tool}`, source: "path" as const }),
        fs,
        onUpdate,
        run: options.runner ?? slowRunner().runner,
      }),
  });
  const flash = vi.fn();
  const writeClipboard = vi.fn(async () => true);
  const deps = {
    download: {
      env: {},
      isTTY: true,
      settings: store,
      onInterrupt: () => () => {},
      core: core.connect,
    },
    managerCore: core.connectAs("manager"),
    flash,
    writeClipboard,
    version: "1.0.0",
  } as unknown as AppDeps;
  const props: ManagerScreenProps = {
    onBack: vi.fn(),
    onAdd: vi.fn(),
    onSpeedUnit: vi.fn(),
    renderMs: 10,
    retryMs: 300,
    ...options.props,
  };
  const hub = new InputHub();
  const app = render(
    <MouseProvider hub={hub} now={options.now ?? neverDouble()}>
      <DepsContext.Provider value={deps}>
        <SpeedUnitContext.Provider value={options.settings?.speedUnit ?? "bytes"}>
          <ManagerScreen {...props} />
        </SpeedUnitContext.Provider>
      </DepsContext.Provider>
    </MouseProvider>,
  );
  attachTestStdin(hub, app.stdin);
  if (options.columns) {
    Object.defineProperty(app.stdout, "columns", { value: options.columns, configurable: true });
    (app.stdout as unknown as NodeJS.EventEmitter).emit("resize");
  }
  if (options.rows) {
    Object.defineProperty(app.stdout, "rows", { value: options.rows, configurable: true });
    (app.stdout as unknown as NodeJS.EventEmitter).emit("resize");
  }
  const frame = () => app.lastFrame() ?? "";
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      app.stdin.write(key);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const count = (options.jobs ?? []).length;
  await vi.waitFor(() => expect(frame()).toContain(` ${count} item${count === 1 ? "" : "s"}`));
  await vi.waitFor(() => expect(frame()).not.toContain("Connecting to MediaForge"));
  /** Row of the screen whose text contains `text`, and the column where it starts. */
  const find = (text: string) => {
    const lines = frame().split("\n");
    const y = lines.findIndex((line) => line.includes(text));
    return { x: lines[y]?.indexOf(text) ?? -1, y };
  };
  const click = async (x: number, y: number, mods: { ctrl?: boolean } = {}) => {
    app.stdin.write(clickAt(x, y, mods));
    await new Promise((r) => setTimeout(r, 30));
  };
  const wheel = async (step: -1 | 1) => {
    app.stdin.write(wheelAt(10, 3, step));
    await new Promise((r) => setTimeout(r, 30));
  };
  return {
    app,
    frame,
    press,
    store,
    core,
    history,
    props,
    flash,
    openPath,
    writeClipboard,
    find,
    click,
    wheel,
    hub,
  };
}

/** The table lines (those starting with the cursor column), in screen order. */
const tableRows = (frame: string) =>
  frame.split("\n").filter((line) => /^[> ]\[[ •]\]/.test(line) && !line.includes("Name"));

const three = () => [
  row("old", { title: "Trailer", lastTryAt: Date.now() - 3 * 86_400_000, sizeBytes: 23_000_000 }),
  row("new", {
    title: "Big Buck Bunny",
    status: "paused",
    lastTryAt: Date.now() - 1000,
    sizeBytes: 412_000_000,
  }),
  row("mid", {
    title: "Lecture 07",
    lastTryAt: Date.now() - 86_400_000,
    sizeBytes: 58_000_000,
    url: "https://lectures.example.org/07",
  }),
];

describe("ManagerScreen table", () => {
  it("lists jobs newest last try first", async () => {
    const m = await mount({ jobs: three() });
    const rows = tableRows(m.frame());
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Big Buck Bunny");
    expect(rows[1]).toContain("Lecture 07");
    expect(rows[2]).toContain("Trailer");
  });

  it("shows the header counts and limit", async () => {
    const running = row("run", { status: "paused", lastTryAt: 1 });
    const m = await mount({ jobs: [...three(), running], runner: slowRunner().runner });
    expect(m.frame()).toContain("Limit: High (∞) · 4 items · 0 active");
  });

  it("moves the cursor with arrows, PgDn and End", async () => {
    const jobs = Array.from({ length: 30 }, (_, i) =>
      row(`j${i}`, { title: `Item ${String(i).padStart(2, "0")}`, lastTryAt: 1000 - i }),
    );
    const m = await mount({ jobs });
    const cursorRow = () => tableRows(m.frame()).find((line) => line.startsWith(">"));
    expect(cursorRow()).toContain("Item 00");
    await m.press(KEY.down);
    expect(cursorRow()).toContain("Item 01");
    await m.press(KEY.end);
    await vi.waitFor(() => expect(cursorRow()).toContain("Item 29"));
    await m.press(KEY.home, KEY.pageDown);
    await vi.waitFor(() => expect(cursorRow()).not.toContain("Item 00"));
  });

  it("Space ticks the cursor row and Ctrl+A ticks all visible, then clears", async () => {
    const m = await mount({ jobs: three() });
    const ticked = () => tableRows(m.frame()).filter((line) => line.includes("[•]")).length;
    await m.press(" ");
    await vi.waitFor(() => expect(ticked()).toBe(1));
    await m.press(KEY.ctrlA);
    await vi.waitFor(() => expect(ticked()).toBe(3));
    await m.press(KEY.ctrlA);
    await vi.waitFor(() => expect(ticked()).toBe(0));
  });

  it("number keys sort and the same key reverses", async () => {
    const m = await mount({ jobs: three() });
    await m.press("4");
    await vi.waitFor(() => expect(m.frame()).toContain("Size ▼"));
    expect(tableRows(m.frame())[0]).toContain("Big Buck Bunny");
    await m.press("4");
    await vi.waitFor(() => expect(m.frame()).toContain("Size ▲"));
    expect(tableRows(m.frame())[0]).toContain("Trailer");
    await vi.waitFor(async () =>
      expect((await m.store.load()).managerSort).toEqual({ column: "size", descending: false }),
    );
  });

  it("slash searches name and URL; Enter keeps; Esc clears", async () => {
    const m = await mount({ jobs: three() });
    await m.press("/", "l", "e", "c");
    await vi.waitFor(() => expect(tableRows(m.frame())).toHaveLength(1));
    await m.press(KEY.enter);
    await vi.waitFor(() => expect(m.frame()).toContain('search: "lec"'));
    expect(m.frame()).toContain("1 of 3 items");
    await m.press("/", KEY.esc);
    await vi.waitFor(() => expect(tableRows(m.frame())).toHaveLength(3));
    await m.press("/", "l", "e", "c", "t", "u", "r", "e", "s", ".", KEY.enter);
    await vi.waitFor(() => expect(tableRows(m.frame())).toHaveLength(1));
  });

  it("shows the empty filter text", async () => {
    const m = await mount({ jobs: three() });
    await m.press("/", "z", "z", "z", KEY.enter);
    await vi.waitFor(() =>
      expect(m.frame()).toContain("No downloads match. Esc clears the filter."),
    );
  });

  it("shows icons, then drops columns, as the terminal narrows", async () => {
    const narrow = await mount({ jobs: three(), columns: 85 });
    await vi.waitFor(() => expect(narrow.frame()).not.toContain("Last try"));
    expect(narrow.frame()).not.toContain("ETA");
    expect(narrow.frame()).toContain("Speed");
    // Type and Origin stay, as icons.
    expect(narrow.frame()).toContain("Type");
    expect(narrow.frame()).toContain("Origin");
    const rows = tableRows(narrow.frame()).join(" ");
    expect(rows).toContain("►♪");
    expect(rows).not.toContain("Video");
    // Under 70 columns Status shows its icon too.
    const tiny = await mount({ jobs: three(), columns: 60 });
    await vi.waitFor(() => expect(tiny.frame()).toContain("Status"));
    const tinyRows = tableRows(tiny.frame()).join(" ");
    expect(tinyRows).toContain("││");
    expect(tinyRows).not.toMatch(/Completed|Paused|Downloading/);
    const wide = await mount({ jobs: three(), columns: 120 });
    await vi.waitFor(() => expect(wide.frame()).toContain("Last try"));
    expect(wide.frame()).toContain("ETA");
    expect(wide.frame()).toContain("Type");
  });

  it("leaves a blank line between the header and the table", async () => {
    const m = await mount({ jobs: three() });
    const lines = m.frame().split("\n");
    const header = lines.findIndex((line) => line.includes("MediaForge · Downloads"));
    expect(lines[header + 1]?.trim()).toBe("");
    expect(lines[header + 2]).toContain("Name");
  });

  it("shows what each row saves in the Type column", async () => {
    const m = await mount({
      columns: 120,
      jobs: [
        row("o", { title: "Picture", kind: "video", lastTryAt: 3 }),
        row("a", { title: "Sound", kind: "audio", lastTryAt: 2 }),
        row("p", { title: "Older", lastTryAt: 1 }),
      ],
    });
    const rows = tableRows(m.frame());
    expect(rows.find((line) => line.includes("Picture"))).toContain("Video only");
    expect(rows.find((line) => line.includes("Sound"))).toContain("Audio only");
    expect(rows.find((line) => line.includes("Older"))).toMatch(/Older\s+Video\s/);
  });

  it("cuts wide names without breaking alignment", async () => {
    const m = await mount({
      columns: 100,
      jobs: [
        row("cjk", { title: "日本語の名前".repeat(14), sizeBytes: 1_000, lastTryAt: 3 }),
        row("long", {
          url: `https://example.com/${"x".repeat(300)}`,
          sizeBytes: 2_000,
          lastTryAt: 2,
        }),
        row("short", { title: "Short", sizeBytes: 3_000, lastTryAt: 1 }),
      ],
    });
    const lines = m.frame().split("\n");
    const cjk = lines.find((l) => l.includes("日本"));
    expect(cjk).toContain("1.0 kB");
    expect(cjk).toContain("…");
    const header = lines.find((l) => l.includes("Size")) as string;
    const long = lines.find((l) => l.includes("2.0 kB")) as string;
    const short = lines.find((l) => l.includes("3.0 kB")) as string;
    expect(long.indexOf("2.0 kB")).toBe(header.indexOf("Size"));
    expect(short.indexOf("3.0 kB")).toBe(header.indexOf("Size"));
    expect(long.length).toBeLessThanOrEqual(100);
  });

  it("scrolls 2000 rows and keeps the cursor visible", async () => {
    const jobs = Array.from({ length: 2000 }, (_, i) =>
      row(`j${i}`, { title: `Item ${i}`, lastTryAt: 10_000 - i }),
    );
    const m = await mount({ jobs });
    expect(m.frame()).toContain("2000 items");
    await m.press(KEY.end);
    await vi.waitFor(() =>
      expect(tableRows(m.frame()).find((l) => l.startsWith(">"))).toContain("Item 1999"),
    );
  });

  it("shows the reconnect banner and keeps rows", async () => {
    const m = await mount({ jobs: three() });
    m.core.dropAll();
    await vi.waitFor(() => expect(m.frame()).toContain("Reconnecting to MediaForge…"));
    expect(tableRows(m.frame())).toHaveLength(3);
  });

  it("Esc goes back when nothing is open", async () => {
    const m = await mount({ jobs: three() });
    await m.press(KEY.esc);
    await vi.waitFor(() => expect(m.props.onBack).toHaveBeenCalled());
  });
});

/** Start a download through another client, as the extension or the menu would. */
async function startOne(m: Awaited<ReturnType<typeof mount>>, title: string): Promise<string> {
  const client = await m.core.connect();
  const reply = await client.request("download.start", {
    candidate: row("x", { title }).request.candidate,
    profileId: "mp4-720p",
    outputDir: "/dl",
  });
  client.close();
  const id = (reply.payload as { jobId: string }).jobId;
  await vi.waitFor(() => expect(m.history.get(id)?.status).toBe("downloading"));
  await vi.waitFor(() => expect(m.frame()).toContain(title));
  return id;
}

const statusOf = (m: Awaited<ReturnType<typeof mount>>, id: string) => m.history.get(id)?.status;

describe("ManagerScreen layout", () => {
  it("shows the origin with its icon in a wide window", async () => {
    const m = await mount({
      jobs: [row("e", { title: "From the browser", origin: "extension", lastTryAt: 1 })],
      columns: 130,
    });
    await vi.waitFor(() => expect(m.frame()).toContain("Origin"));
    expect(tableRows(m.frame())[0]).toContain("◊ Extension");
  });

  it("keeps the key bar and the version on the last line, under a divider", async () => {
    const m = await mount({ rows: 30, columns: 120 });
    await vi.waitFor(() => expect(m.frame().split("\n")).toHaveLength(29));
    const lines = m.frame().split("\n");
    expect(lines.at(-1)).toContain("? Keys");
    expect(lines.at(-1)?.trimEnd().endsWith("v1.0.0")).toBe(true);
    expect(lines.at(-2)).toMatch(/^─+$/);
  });
});

describe("ManagerScreen actions", () => {
  it("p pauses the cursor row", async () => {
    const m = await mount();
    const id = await startOne(m, "Running one");
    await m.press("p");
    await vi.waitFor(() => expect(statusOf(m, id)).toBe("paused"));
    await vi.waitFor(() => expect(m.frame()).toContain("√ Paused 1"));
  });

  it("p on ticked rows skips the ones that do not apply", async () => {
    const m = await mount({ jobs: [row("done", { title: "Done one", lastTryAt: 1 })] });
    const id = await startOne(m, "Running one");
    await m.press(KEY.ctrlA, "p");
    await vi.waitFor(() => expect(m.frame()).toContain("▲ Paused 1 · 1 skipped"));
    expect(statusOf(m, id)).toBe("paused");
  });

  it("r resumes paused and retries failed", async () => {
    const m = await mount({
      jobs: [
        row("p1", { title: "Paused one", status: "paused", lastTryAt: 2 }),
        row("f1", { title: "Failed one", status: "failed", lastTryAt: 1 }),
      ],
    });
    await m.press(KEY.ctrlA, "r");
    await vi.waitFor(() => expect(m.frame()).toContain("Resumed 2"));
    expect(["queued", "downloading"]).toContain(statusOf(m, "p1"));
    expect(["queued", "downloading"]).toContain(statusOf(m, "f1"));
  });

  it("c asks first and N keeps the job", async () => {
    const m = await mount();
    const id = await startOne(m, "Running one");
    await m.press("c");
    await vi.waitFor(() =>
      expect(m.frame()).toContain("y/N  Cancel 1 download? Partial files are deleted."),
    );
    expect(m.frame()).not.toContain("a Add");
    await m.press("n");
    await vi.waitFor(() => expect(m.frame()).toContain("a Add"));
    expect(statusOf(m, id)).toBe("downloading");
    await m.press("c", "y");
    await vi.waitFor(() => expect(statusOf(m, id)).toBe("cancelled"));
  });

  it("x asks before removing, finished or running", async () => {
    const m = await mount({ jobs: [row("done", { title: "Done one", lastTryAt: 1 })] });
    await m.press("x");
    await vi.waitFor(() =>
      expect(m.frame()).toContain("y/N  Remove 1 download from the list? Files stay on disk."),
    );
    await m.press("n");
    await vi.waitFor(() => expect(m.frame()).not.toContain("y/N"));
    expect(m.history.get("done")).toBeDefined();
    await m.press("x", "y");
    await vi.waitFor(() => expect(m.history.get("done")).toBeUndefined());
    const id = await startOne(m, "Running one");
    await m.press("x");
    await vi.waitFor(() =>
      expect(m.frame()).toContain("y/N  Remove 1? 1 is running and will be cancelled."),
    );
    await m.press("y");
    await vi.waitFor(() => expect(m.history.get(id)).toBeUndefined());
  });

  it("Del moves files to the trash after y", async () => {
    const trash = vi.fn<TrashFn>(async () => ({ failed: [] }));
    const m = await mount({
      trash,
      jobs: [row("done", { title: "Done one", lastTryAt: 1, files: ["/dl/a.mp4"] })],
    });
    await m.press(KEY.del);
    await vi.waitFor(() =>
      expect(m.frame()).toContain("y/N  Delete 1 download from disk? Files go to"),
    );
    await m.press("y");
    await vi.waitFor(() => expect(m.history.get("done")).toBeUndefined());
    expect(trash).toHaveBeenCalledWith(["/dl/a.mp4"], { permanent: false });
  });

  it("Del asks again for too-large files and sends permanent", async () => {
    const trash = vi.fn<TrashFn>(async (paths, options) =>
      options?.permanent
        ? { failed: [] }
        : { failed: paths.map((path) => ({ path, message: "too big", code: "too-large" })) },
    );
    const m = await mount({
      trash,
      jobs: [row("big", { title: "Huge one", lastTryAt: 1, files: ["/dl/huge.mkv"] })],
    });
    await m.press(KEY.del);
    await vi.waitFor(() => expect(m.frame()).toContain("y/N  Delete"));
    await m.press("y");
    await vi.waitFor(() =>
      expect(m.frame()).toContain("y/N  1 is too big for the Recycle Bin. Delete for good?"),
    );
    await m.press("y");
    await vi.waitFor(() => expect(m.history.get("big")).toBeUndefined());
    expect(trash).toHaveBeenLastCalledWith(["/dl/huge.mkv"], { permanent: true });
  });

  it("C clears finished rows after y", async () => {
    const m = await mount({
      jobs: [
        row("d1", { title: "Done one", lastTryAt: 2 }),
        row("p1", { title: "Paused one", status: "paused", lastTryAt: 1 }),
      ],
    });
    await m.press("C");
    await vi.waitFor(() =>
      expect(m.frame()).toContain("y/N  Clear 1 finished? Files stay on disk."),
    );
    await m.press("y");
    await vi.waitFor(() => expect(m.history.get("d1")).toBeUndefined());
    expect(m.history.get("p1")).toBeDefined();
  });

  it("o opens the cursor row's folder only", async () => {
    const m = await mount({
      jobs: [
        row("d1", { title: "Done one", lastTryAt: 2, outputPath: "/dl/one.mp4" }),
        row("d2", { title: "Done two", lastTryAt: 1, outputPath: "/dl/two.mp4" }),
      ],
    });
    await m.press(KEY.ctrlA, "o");
    await vi.waitFor(() => expect(m.openPath).toHaveBeenCalledTimes(1));
    expect(m.openPath).toHaveBeenCalledWith("/dl/one.mp4", { select: true });
    await startOne(m, "Running one");
    await m.press(KEY.ctrlA, KEY.home, "o");
    await vi.waitFor(() => expect(m.frame()).toContain("Nothing to open."));
  });

  it("l cycles the global preset", async () => {
    const m = await mount();
    expect(m.frame()).toContain("Limit: High (∞)");
    await m.press("l");
    await vi.waitFor(() => expect(m.frame()).toContain("Limit: Med (5.0 MB/s)"));
    await vi.waitFor(async () => expect((await m.store.load()).limitPreset).toBe("med"));
  });

  it("L opens the picker and applies the override", async () => {
    const m = await mount({ jobs: [row("p1", { title: "Paused one", status: "paused" })] });
    await m.press("L");
    await vi.waitFor(() => expect(m.frame()).toContain("Med · 5.0 MB/s"));
    await m.press(KEY.up, KEY.up, KEY.enter);
    await vi.waitFor(() => expect(m.history.get("p1")?.limitOverride).toBe("low"));
    await vi.waitFor(() => expect(tableRows(m.frame())[0]).toContain("⏷"));
    await m.press("L");
    await vi.waitFor(() => expect(m.frame()).toContain("Med · 5.0 MB/s"));
    await m.press(KEY.down, KEY.down, KEY.enter);
    await vi.waitFor(() => expect(m.history.get("p1")?.limitOverride).toBeUndefined());
  });

  it("b toggles the speed unit and saves it", async () => {
    const m = await mount({ settings: { limitPreset: "med" } });
    expect(m.frame()).toContain("Limit: Med (5.0 MB/s)");
    await m.press("b");
    await vi.waitFor(() => expect(m.frame()).toContain("Limit: Med (40.0 Mbps)"));
    expect(m.props.onSpeedUnit).toHaveBeenCalledWith("bits");
    await vi.waitFor(async () => expect((await m.store.load()).speedUnit).toBe("bits"));
  });

  it("a prompt acts on the rows it was opened for", async () => {
    const m = await mount();
    const first = await startOne(m, "First one");
    await m.press("c");
    await vi.waitFor(() => expect(m.frame()).toContain("y/N"));
    const second = await startOne(m, "Second one");
    await m.press("y");
    await vi.waitFor(() => expect(statusOf(m, first)).toBe("cancelled"));
    expect(statusOf(m, second)).toBe("downloading");
  });

  it("a lost connection closes the prompt", async () => {
    const m = await mount();
    await startOne(m, "Running one");
    await m.press("c");
    await vi.waitFor(() => expect(m.frame()).toContain("y/N"));
    m.core.dropAll();
    await vi.waitFor(() => expect(m.frame()).toContain("Not connected."));
    expect(m.frame()).not.toContain("y/N");
  });

  it("action keys wait for the reply", async () => {
    const m = await mount();
    const id = await startOne(m, "Running one");
    // Two presses in one burst: the second arrives while the first request is in flight.
    m.app.stdin.write("p");
    m.app.stdin.write("p");
    await vi.waitFor(() => expect(m.frame()).toContain("Paused 1"));
    await new Promise((r) => setTimeout(r, 100));
    expect(m.frame()).not.toContain("Nothing to pause.");
    expect(statusOf(m, id)).toBe("paused");
  });

  it("actions while reconnecting say Not connected", async () => {
    const m = await mount({ jobs: [row("p1", { title: "Paused one", status: "paused" })] });
    m.core.dropAll();
    await vi.waitFor(() => expect(m.frame()).toContain("Reconnecting"));
    await m.press("r");
    await vi.waitFor(() => expect(m.frame()).toContain("Not connected."));
    expect(statusOf(m, "p1")).toBe("paused");
  });
});

const NOTICE = { reason: "unexpected" as const, pausedCount: 2, jobIds: ["n1", "n2"] };
const noticeJobs = () => [
  row("n1", { title: "Notice one", status: "paused", lastTryAt: 2 }),
  row("n2", { title: "Notice two", status: "paused", lastTryAt: 1 }),
];

describe("ManagerScreen panels and banners", () => {
  it("f opens the filter panel and filters live", async () => {
    const m = await mount({
      jobs: [
        row("p1", { title: "Paused one", status: "paused", lastTryAt: 2 }),
        row("d1", { title: "Done one", lastTryAt: 1 }),
      ],
    });
    await m.press("f");
    await vi.waitFor(() => expect(m.frame()).toContain("Origin"));
    // The Status column: Active, Queued, Paused…
    await m.press(KEY.down, KEY.down, " ");
    await vi.waitFor(() => expect(m.frame()).toContain("filter: ││"));
    await m.press(KEY.esc);
    await vi.waitFor(() => expect(tableRows(m.frame())).toHaveLength(1));
    expect(tableRows(m.frame())[0]).toContain("Paused one");
  });

  it("Esc clears search and filters before going back", async () => {
    const m = await mount({ jobs: [row("p1", { title: "Paused one", status: "paused" })] });
    await m.press("f", KEY.down, KEY.down, " ", KEY.enter);
    await vi.waitFor(() => expect(m.frame()).toContain("filter: ││"));
    await m.press(KEY.esc);
    await vi.waitFor(() => expect(m.frame()).not.toContain("filter:"));
    expect(m.props.onBack).not.toHaveBeenCalled();
    await m.press(KEY.esc);
    await vi.waitFor(() => expect(m.props.onBack).toHaveBeenCalled());
  });

  it("Enter shows the detail panel with the full error", async () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const m = await mount({
      jobs: [
        row("f1", { title: "Failed one", status: "failed", error: words, origin: "extension" }),
      ],
    });
    await m.press(KEY.enter);
    await vi.waitFor(() => expect(m.frame()).toContain("Origin"));
    expect(m.frame()).toContain("word0");
    expect(m.frame()).toContain("word59");
    expect(m.frame()).toContain("Extension");
    expect(m.frame()).toContain("None (shares the global limit)");
    expect(m.frame()).toContain("https://example.com/watch?v=abc");
    await m.press(KEY.esc);
    await vi.waitFor(() => expect(m.frame()).not.toContain("word59"));
    expect(m.props.onBack).not.toHaveBeenCalled();
  });

  it("? lists every key", async () => {
    const m = await mount();
    await m.press("?");
    await vi.waitFor(() => expect(m.frame()).toContain("Dismiss the session notice"));
    expect(m.frame()).toContain("Set the override");
    await m.press(KEY.esc);
    await vi.waitFor(() => expect(m.frame()).toContain("a Add"));
  });

  it("shows the session notice banner", async () => {
    const m = await mount({ jobs: noticeJobs(), notice: NOTICE });
    await vi.waitFor(() =>
      expect(m.frame()).toContain("Previous session ended unexpectedly. 2 downloads were paused."),
    );
    expect(m.frame()).toContain("R resume all · z dismiss");
  });

  it("shows the restarted notice text", async () => {
    const m = await mount({ jobs: noticeJobs(), notice: { ...NOTICE, reason: "restarted" } });
    await vi.waitFor(() =>
      expect(m.frame()).toContain("MediaForge was restarted. 2 downloads were paused."),
    );
  });

  it("R resumes the notice jobs", async () => {
    const m = await mount({ jobs: noticeJobs(), notice: NOTICE });
    await m.press("R");
    await vi.waitFor(() => expect(statusOf(m, "n1")).not.toBe("paused"));
    expect(statusOf(m, "n2")).not.toBe("paused");
    await vi.waitFor(() => expect(m.frame()).not.toContain("z dismiss"));
  });

  it("z dismisses the notice", async () => {
    const m = await mount({ jobs: noticeJobs(), notice: NOTICE });
    await m.press("z");
    await vi.waitFor(() => expect(m.frame()).not.toContain("z dismiss"));
    const other = await m.core.connect();
    expect(other.ack.notice).toBeUndefined();
    other.close();
    expect(statusOf(m, "n1")).toBe("paused");
  });

  it("R and z do nothing without a banner", async () => {
    const m = await mount({ jobs: noticeJobs() });
    await m.press("R", "z");
    await new Promise((r) => setTimeout(r, 100));
    expect(statusOf(m, "n1")).toBe("paused");
    expect(statusOf(m, "n2")).toBe("paused");
  });

  it("app.attention flashes and shows the banner", async () => {
    const m = await mount({ props: { attentionMs: 300 } });
    const other = await m.core.connectAs("extension")();
    await other.request("app.open", {});
    other.close();
    await vi.waitFor(() => expect(m.frame()).toContain("Opened from browser"));
    expect(m.flash).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(m.frame()).not.toContain("Opened from browser"), {
      timeout: 2000,
    });
  });
});

describe("ManagerScreen review fixes", () => {
  it("keys work again when the row in the detail panel goes away", async () => {
    const m = await mount({ jobs: [row("d1", { title: "Done one", lastTryAt: 1 })] });
    await m.press(KEY.enter);
    await vi.waitFor(() => expect(m.frame()).toContain("Details"));
    const other = await m.core.connect();
    await other.request("jobs.remove", { jobIds: ["d1"] });
    other.close();
    await vi.waitFor(() => expect(m.frame()).not.toContain("Details"));
    // Ink takes the new key handler a moment after drawing the frame.
    await new Promise((r) => setTimeout(r, 50));
    await m.press("?");
    await vi.waitFor(() => expect(m.frame()).toContain("Dismiss the session notice"));
  });

  it("says so instead of dropping an action while another is in flight", async () => {
    let release: () => void = () => {};
    const trash = vi.fn<TrashFn>(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ failed: [] });
        }),
    );
    const m = await mount({
      trash,
      jobs: [
        row("d1", { title: "Done one", lastTryAt: 2, files: ["/dl/a.mp4"] }),
        row("d2", { title: "Done two", lastTryAt: 1 }),
      ],
    });
    await m.press(KEY.del, "y");
    await vi.waitFor(() => expect(trash).toHaveBeenCalled());
    await m.press(KEY.down, "x");
    await vi.waitFor(() => expect(m.frame()).toContain("Still working on the last action."));
    release();
  });
});

describe("ManagerScreen columns keep their own text", () => {
  it("shows whole speeds, dates and the override mark", async () => {
    const m = await mount({
      columns: 120,
      settings: { speedUnit: "bits" },
      jobs: [
        row("old", {
          title: "A very long lecture title that will never fit in the name column at all",
          avgSpeed: 4_100_000,
          lastTryAt: new Date(2025, 9, 12, 12).getTime(),
          limitOverride: "low",
        }),
      ],
    });
    const line = tableRows(m.frame())[0] ?? "";
    expect(line).toContain("avg 32.8 Mbps");
    expect(line).toContain("Oct 12 2025");
    expect(line).toContain("⏷");
  });
});

describe("ManagerScreen key lock and compact panels", () => {
  /** A trash call that waits until the test releases it, so the manager stays busy. */
  function slowTrash() {
    let release: () => void = () => {};
    const trash = vi.fn<TrashFn>(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ failed: [] });
        }),
    );
    return { trash, release: () => release() };
  }

  const busyMount = async () => {
    const slow = slowTrash();
    const m = await mount({
      trash: slow.trash,
      jobs: [
        row("d1", { title: "Done one", lastTryAt: 2, files: ["/dl/a.mp4"], sizeBytes: 1 }),
        row("d2", { title: "Done two", lastTryAt: 1, sizeBytes: 9 }),
      ],
    });
    await m.press(KEY.del, "y");
    await vi.waitFor(() => expect(slow.trash).toHaveBeenCalled());
    return { m, slow };
  };

  it("sort keys wait while an action runs", async () => {
    const { m, slow } = await busyMount();
    await m.press("2");
    await vi.waitFor(() => expect(m.frame()).toContain("Still working on the last action."));
    expect(m.frame()).not.toContain("Size ▼");
    expect((await m.store.load()).managerSort).toEqual({ column: "lastTry", descending: true });
    slow.release();
  });

  it("Add link waits while an action runs", async () => {
    const { m, slow } = await busyMount();
    await m.press("a");
    await vi.waitFor(() => expect(m.frame()).toContain("Still working on the last action."));
    expect(m.props.onAdd).not.toHaveBeenCalled();
    slow.release();
  });

  it("moving and searching still work while an action runs", async () => {
    const { m, slow } = await busyMount();
    await m.press(KEY.down);
    await vi.waitFor(() =>
      expect(tableRows(m.frame()).find((l) => l.startsWith(">"))).toContain("Done two"),
    );
    await m.press("/", "t", "w", "o", KEY.enter);
    await vi.waitFor(() => expect(tableRows(m.frame())).toHaveLength(1));
    slow.release();
  });

  it("the filter panel shows one column per group, with its own keys", async () => {
    const m = await mount();
    await m.press("f");
    await vi.waitFor(() => expect(m.frame()).toContain("Origin"));
    const lines = m.frame().split("\n");
    const head = lines.find((l) => l.includes("Status")) ?? "";
    for (const name of ["Type", "Origin"]) expect(head).toContain(name);
    expect(m.frame()).not.toContain("Last try");
    const first = lines.find((l) => l.includes("Active")) ?? "";
    expect(first).toContain("Video");
    expect(first).toContain("Extension");
    // The cursor is the table's >, with no highlight.
    expect(first).toContain("> [ ]");
    // Each option of a group starts in the same column.
    const at = (text: string) => lines.find((l) => l.includes(text))?.indexOf(text);
    expect(at("Cancelled")).toBe(at("Active"));
    expect(lines.at(-1)).toContain("Space Toggle");
    expect(lines.at(-1)).not.toContain("a Add");
    // Right to Origin, down to Menu, toggle.
    await m.press(KEY.right, KEY.right, KEY.down, " ");
    await vi.waitFor(() => expect(m.frame()).toContain("filter: ≡"));
  });

  it("the detail panel scrolls a long error instead of growing", async () => {
    const words = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
    const m = await mount({
      jobs: [row("f1", { title: "Failed one", status: "failed", error: words })],
    });
    await m.press(KEY.enter);
    await vi.waitFor(() => expect(m.frame()).toContain("Details"));
    expect(m.frame()).toContain("↓ more");
    expect(m.frame()).not.toContain("w599");
    const height = m.frame().split("\n").length;
    for (let i = 0; i < 40; i++) await m.press(KEY.down);
    await vi.waitFor(() => expect(m.frame()).toContain("w599"));
    expect(m.frame().split("\n").length).toBeLessThanOrEqual(height);
  });
});

describe("ManagerScreen prompts, focus, clear and banners", () => {
  it("a prompt wider than the window wraps instead of being cut", async () => {
    const trash = vi.fn<TrashFn>(async (paths, options) =>
      options?.permanent
        ? { failed: [] }
        : { failed: paths.map((path) => ({ path, message: "too big", code: "too-large" })) },
    );
    const m = await mount({
      columns: 40,
      trash,
      jobs: [row("big", { title: "Huge one", lastTryAt: 1, files: ["/dl/huge.mkv"] })],
    });
    await m.press(KEY.del, "y");
    await vi.waitFor(() => expect(m.frame()).toContain("Delete for good?"));
    expect(m.frame()).toContain("y/N  1 is too big");
  });

  it("does not move the cursor to a new row the search hides", async () => {
    const m = await mount({
      jobs: [
        row("a1", { title: "Alpha", lastTryAt: 2 }),
        row("b1", { title: "Beta", lastTryAt: 1 }),
      ],
      props: { focusId: "b1", view: { ticks: [], search: "alp", filters: NO_FILTERS } },
    });
    await m.press(KEY.esc);
    await vi.waitFor(() => expect(tableRows(m.frame())).toHaveLength(2));
    expect(tableRows(m.frame()).find((l) => l.startsWith(">"))).toContain("Alpha");
  });

  it("uses the focus once and says the note once", async () => {
    const onFocused = vi.fn();
    const m = await mount({
      jobs: [
        row("a1", { title: "Alpha", lastTryAt: 2 }),
        row("b1", { title: "Beta", lastTryAt: 1 }),
      ],
      props: { focusId: "b1", note: "Could not start: nope", onFocused },
    });
    await vi.waitFor(() =>
      expect(tableRows(m.frame()).find((l) => l.startsWith(">"))).toContain("Beta"),
    );
    expect(m.frame()).toContain("Could not start: nope");
    await vi.waitFor(() => expect(onFocused).toHaveBeenCalledTimes(1));
  });

  it("Clear finished clears the rows finished when y is pressed", async () => {
    const slow = slowRunner();
    const m = await mount({
      runner: slow.runner,
      jobs: [row("d1", { title: "Done one", lastTryAt: 1 })],
    });
    const id = await startOne(m, "Running one");
    await m.press("C");
    await vi.waitFor(() => expect(m.frame()).toContain("y/N  Clear 1 finished?"));
    slow.releaseAll();
    await vi.waitFor(() => expect(statusOf(m, id)).toBe("completed"));
    await vi.waitFor(() => expect(m.frame()).toContain("Completed"));
    await new Promise((r) => setTimeout(r, 50));
    await m.press("y");
    await vi.waitFor(() => expect(m.history.get("d1")).toBeUndefined());
    await vi.waitFor(() => expect(m.history.get(id)).toBeUndefined());
    await vi.waitFor(() => expect(m.frame()).toContain("Cleared 2"));
  });

  it("shows every banner at once and R works while the browser banner shows", async () => {
    const m = await mount({
      jobs: [
        row("n1", { title: "Notice one", status: "paused", lastTryAt: 2 }),
        row("n2", { title: "Notice two", status: "paused", lastTryAt: 1 }),
      ],
      notice: { reason: "unexpected", pausedCount: 2, jobIds: ["n1", "n2"] },
      props: { attentionMs: 5000 },
    });
    const other = await m.core.connectAs("extension")();
    await other.request("app.open", {});
    other.close();
    await vi.waitFor(() => expect(m.frame()).toContain("Opened from browser"));
    expect(m.frame()).toContain("R resume all · z dismiss");
    await m.press("R");
    await vi.waitFor(() => expect(statusOf(m, "n1")).not.toBe("paused"));
  });
});

const ten = () =>
  Array.from({ length: 10 }, (_, i) =>
    row(`j${i}`, { title: `Clip ${i}`, lastTryAt: Date.now() - i * 1000 }),
  );
const cursorRow = (frame: string) => tableRows(frame).findIndex((line) => line.startsWith(">"));
const settle = () => new Promise((r) => setTimeout(r, 80));

describe("ManagerScreen mouse", () => {
  it("a click on a row moves the cursor there", async () => {
    const m = await mount({ jobs: ten() });
    const { y } = m.find("Clip 3");
    await m.click(10, y);
    await vi.waitFor(() => expect(cursorRow(m.frame())).toBe(3));
  });

  it("a click on the box ticks the row and moves the cursor", async () => {
    const m = await mount({ jobs: ten() });
    const { y } = m.find("Clip 2");
    await m.click(2, y);
    await vi.waitFor(() => expect(tableRows(m.frame())[2]).toMatch(/^>\[•\]/));
    await m.click(2, y);
    await vi.waitFor(() => expect(tableRows(m.frame())[2]).toMatch(/^>\[ \]/));
  });

  it("Ctrl+click ticks a range from the cursor row", async () => {
    const m = await mount({ jobs: ten() });
    await m.click(10, m.find("Clip 1").y);
    await vi.waitFor(() => expect(cursorRow(m.frame())).toBe(1));
    await m.click(10, m.find("Clip 4").y, { ctrl: true });
    await vi.waitFor(() => {
      const ticked = tableRows(m.frame()).map((line) => line.includes("[•]"));
      expect(ticked).toEqual([false, true, true, true, true, false, false, false, false, false]);
    });
    expect(cursorRow(m.frame())).toBe(4);
  });

  it("a double-click on a row opens its details", async () => {
    const m = await mount({ jobs: ten(), now: () => 0 });
    const { y } = m.find("Clip 5");
    await m.click(10, y);
    await vi.waitFor(() => expect(cursorRow(m.frame())).toBe(5));
    await m.click(10, y);
    await vi.waitFor(() => expect(m.frame()).toContain("Details"));
    expect(m.frame()).toContain("Clip 5");
  });

  it("a click on a column header sorts by it; again reverses", async () => {
    const m = await mount({ jobs: three() });
    const header = m.find("Size");
    await m.click(header.x, header.y);
    await vi.waitFor(() => expect(m.frame()).toContain("Size ▼"));
    expect(tableRows(m.frame())[0]).toContain("Big Buck Bunny");
    await m.click(header.x, header.y);
    await vi.waitFor(() => expect(m.frame()).toContain("Size ▲"));
  });

  it("the wheel moves the cursor 3 rows", async () => {
    const m = await mount({ jobs: ten() });
    await m.wheel(1);
    await vi.waitFor(() => expect(cursorRow(m.frame())).toBe(3));
    await m.wheel(-1);
    await vi.waitFor(() => expect(cursorRow(m.frame())).toBe(0));
  });

  it("several wheel notches in one read all count", async () => {
    const m = await mount({ jobs: ten() });
    m.app.stdin.write(wheelAt(10, 3, 1) + wheelAt(10, 3, 1));
    await vi.waitFor(() => expect(cursorRow(m.frame())).toBe(6));
  });

  it("a key-bar word runs its key", async () => {
    const m = await mount({ jobs: three() });
    const word = m.find("? Keys");
    await m.click(word.x, word.y);
    await vi.waitFor(() => expect(m.frame()).toContain("Move the cursor"));
  });

  it("the key bar names Space and Ctrl+A, and Ctrl+A ticks every row", async () => {
    const m = await mount({ jobs: three() });
    expect(m.frame()).toContain("Space Tick  Ctrl+A All  a Add");
    const all = m.find("Ctrl+A All");
    await m.click(all.x, all.y);
    await vi.waitFor(() =>
      expect(tableRows(m.frame()).filter((line) => line.includes("[•]"))).toHaveLength(3),
    );
  });

  it("the box above the rows ticks every visible row, then unticks them", async () => {
    const m = await mount({ jobs: three() });
    const ticked = () => tableRows(m.frame()).filter((line) => line.includes("[•]")).length;
    const header = m.find("Name");
    await m.press(" ");
    await vi.waitFor(() => expect(ticked()).toBe(1));
    await m.click(2, header.y);
    await vi.waitFor(() => expect(ticked()).toBe(3));
    expect(m.frame().split("\n")[header.y]).toContain("[•]");
    await m.click(2, header.y);
    await vi.waitFor(() => expect(ticked()).toBe(0));
    expect(m.frame().split("\n")[header.y]).toContain("[ ]");
  });

  it("y and N in a prompt answer it", async () => {
    const jobs = [row("run", { title: "Live", status: "downloading", lastTryAt: Date.now() })];
    const m = await mount({ jobs });
    await m.press("c");
    await vi.waitFor(() => expect(m.find("y/N").y).toBeGreaterThan(0));
    const prompt = m.find("y/N");
    await m.click(prompt.x + 2, prompt.y);
    await vi.waitFor(() => expect(m.frame()).not.toContain("y/N"));
    await m.press("c");
    await vi.waitFor(() => expect(m.find("y/N").y).toBeGreaterThan(0));
    await m.click(m.find("y/N").x, m.find("y/N").y);
    await vi.waitFor(() => expect(m.frame()).toContain("Cancelled 1"));
  });

  it("ignores clicks behind a prompt", async () => {
    const m = await mount({ jobs: ten() });
    // Del always asks (x on a completed row would remove it at once).
    await m.press(KEY.del);
    await vi.waitFor(() => expect(m.frame()).toContain("y/N"));
    await m.click(10, m.find("Clip 4").y);
    await m.wheel(1);
    await settle();
    expect(m.frame()).toContain("y/N");
    expect(cursorRow(m.frame())).toBe(0);
  });

  it("ignores clicks on the key bar and the wheel while a panel is open", async () => {
    const m = await mount({ jobs: ten() });
    const keys = m.find("? Keys");
    const add = m.find("a Add");
    await m.press(KEY.enter);
    await vi.waitFor(() => expect(m.frame()).toContain("Origin"));
    const before = m.frame();
    await m.click(keys.x, keys.y);
    await m.click(add.x, add.y);
    await m.wheel(1);
    await settle();
    expect(m.frame()).toBe(before);
    expect(m.frame()).not.toContain("Move the cursor");
    expect(m.props.onAdd).not.toHaveBeenCalled();
    await m.press(KEY.esc);
    await vi.waitFor(() => expect(tableRows(m.frame())).toHaveLength(10));
    expect(cursorRow(m.frame())).toBe(0);
  });
});

describe("ManagerScreen panels and copy", () => {
  it("a click on a filter option toggles it", async () => {
    const m = await mount({ jobs: three() });
    await m.press("f");
    await vi.waitFor(() => expect(m.frame()).toContain("Paused"));
    const option = m.find("Paused");
    await m.click(option.x, option.y);
    await vi.waitFor(() => expect(m.frame()).toContain("filter: ││"));
    await vi.waitFor(() => expect(m.frame()).toContain("1 of 3 items"));
  });

  it("y and Y copy the link and the path from the details", async () => {
    const jobs = [
      row("a", { title: "Clip", outputPath: "/videos/Clip.mp4", lastTryAt: Date.now() }),
    ];
    const m = await mount({ jobs });
    await m.press(KEY.enter, "y");
    await vi.waitFor(() => expect(m.frame()).toContain("Copied the link."));
    expect(m.writeClipboard).toHaveBeenLastCalledWith(URL);
    await m.press("Y");
    await vi.waitFor(() => expect(m.frame()).toContain("Copied the path."));
    expect(m.writeClipboard).toHaveBeenLastCalledWith("/videos/Clip.mp4");
  });

  it("a click on the Path line copies it; no file yet says so", async () => {
    // Failed, so the core does not start it; it has no output path.
    const jobs = [row("a", { title: "Clip", status: "failed", lastTryAt: Date.now() })];
    const m = await mount({ jobs });
    await m.press(KEY.enter);
    await vi.waitFor(() => expect(m.frame()).toContain("Details"));
    const path = m.find("Path");
    await m.click(path.x + 10, path.y);
    await vi.waitFor(() => expect(m.frame()).toContain("No file yet."));
    expect(m.writeClipboard).not.toHaveBeenCalled();
  });

  it("says so when the clipboard cannot be written", async () => {
    const jobs = [row("a", { title: "Clip", lastTryAt: Date.now() })];
    const m = await mount({ jobs });
    m.writeClipboard.mockResolvedValue(false);
    await m.press(KEY.enter, "y");
    await vi.waitFor(() => expect(m.frame()).toContain("Could not copy to the clipboard."));
  });

  it("the key list explains the mouse and Shift+drag", async () => {
    const m = await mount({ jobs: three() });
    await m.press("?");
    await vi.waitFor(() => expect(m.frame()).toContain("Ctrl+click"));
    expect(m.frame()).toContain("Shift+drag selects text");
  });
});
