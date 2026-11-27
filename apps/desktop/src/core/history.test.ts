import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type HistoryJob, HistoryStore, historyPath, memoryHistoryFs } from "./history.ts";

const PATH = "/cfg/history.json";

const job = (id: string, patch: Partial<HistoryJob> = {}): HistoryJob => ({
  id,
  request: {
    candidate: {
      id: "u",
      pageUrl: "https://e.com/v",
      url: "https://e.com/v",
      kind: "video",
      streamType: "progressive",
      source: "dom",
      variants: [],
      detectedAt: 0,
    },
    profileId: "best",
  },
  status: "completed",
  progress: { bytesDownloaded: 0 },
  createdAt: 1,
  updatedAt: 1,
  files: [],
  ...patch,
});

const fileOf = (jobs: HistoryJob[], cleanExit: boolean, extra: object = {}) =>
  JSON.stringify({ version: 1, cleanExit, jobs, ...extra });

const open = (files: Record<string, string> = {}, onError = vi.fn()) => {
  const fs = memoryHistoryFs(files);
  return { fs, onError, store: HistoryStore.open({ path: PATH, fs, debounceMs: 0, onError }) };
};

describe("historyPath", () => {
  it("sits beside the settings file", () => {
    expect(historyPath({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")).toMatch(
      /MediaForge[\\/]history\.json$/,
    );
    expect(historyPath({ XDG_CONFIG_HOME: "/home/a/.config" }, "linux")).toBe(
      join("/home/a/.config", "mediaforge", "history.json"),
    );
  });
});

describe("HistoryStore", () => {
  it("starts empty when there is no file", async () => {
    const { store } = open();
    expect((await store).jobs()).toEqual([]);
  });

  it("round-trips jobs through the file", async () => {
    const { fs, store } = open();
    const s = await store;
    s.upsert(job("a"), { save: true });
    await s.flush();
    const again = await HistoryStore.open({ path: PATH, fs, debounceMs: 0 });
    expect(again.jobs().map((j) => j.id)).toEqual(["a"]);
  });

  it("writes through a temp file and a rename", async () => {
    const { fs, store } = open();
    const rename = vi.spyOn(fs, "rename");
    const s = await store;
    s.upsert(job("a"), { save: true });
    await s.flush();
    expect(rename).toHaveBeenCalledWith(`${PATH}.tmp`, PATH);
  });

  it("does not write for progress-only changes", async () => {
    const { fs, store } = open();
    const write = vi.spyOn(fs, "writeFile");
    const s = await store;
    s.upsert(job("a", { status: "downloading" }), { save: false });
    await s.flush();
    expect(write).not.toHaveBeenCalled();
    expect(s.get("a")?.status).toBe("downloading");
  });

  it("moves an unreadable file aside and starts empty", async () => {
    const { fs, store } = open({ [PATH]: "{not json" });
    const s = await store;
    expect(s.jobs()).toEqual([]);
    expect(fs.files.get(`${PATH}.bak`)).toBe("{not json");
    expect(s.readOnly).toBe(false);
  });

  it("drops single rows that do not parse and keeps the rest", async () => {
    const raw = JSON.stringify({
      version: 1,
      cleanExit: true,
      jobs: [job("good"), { id: "bad" }],
    });
    const { store } = open({ [PATH]: raw });
    expect((await store).jobs().map((j) => j.id)).toEqual(["good"]);
  });

  it("drops a row whose id could point outside its work folder", async () => {
    const raw = JSON.stringify({
      version: 1,
      cleanExit: true,
      jobs: [job("good"), job("../x"), job("a/b")],
    });
    const { store } = open({ [PATH]: raw });
    expect((await store).jobs().map((j) => j.id)).toEqual(["good"]);
  });

  it("leaves a newer version alone and never writes it", async () => {
    const newer = JSON.stringify({ version: 2, cleanExit: true, jobs: [] });
    const { fs, store, onError } = open({ [PATH]: newer });
    const s = await store;
    expect(s.readOnly).toBe(true);
    s.upsert(job("a"), { save: true });
    await s.markRunning();
    await s.close();
    expect(fs.files.get(PATH)).toBe(newer);
    expect(onError).toHaveBeenCalled();
  });

  it("leaves a newer version alone even when its header has another shape", async () => {
    const newer = JSON.stringify({ version: 2, cleanExit: "x", jobs: {} });
    const { fs, store, onError } = open({ [PATH]: newer });
    const s = await store;
    expect(s.readOnly).toBe(true);
    await s.close();
    expect(fs.files.get(PATH)).toBe(newer);
    expect(fs.files.has(`${PATH}.bak`)).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("keeps keys it does not know on a row through load and save", async () => {
    const row = { ...job("a"), limitOverride: "low" };
    const { fs, store } = open({ [PATH]: fileOf([row as HistoryJob], true) });
    const s = await store;
    s.upsert(job("b"), { save: true });
    await s.flush();
    const again = await HistoryStore.open({ path: PATH, fs, debounceMs: 0 });
    expect(again.get("a")).toMatchObject({ limitOverride: "low" });
  });

  it("pauses jobs that were active after an unclean exit and says so", async () => {
    const raw = fileOf(
      [
        job("q", { status: "queued" }),
        job("d", { status: "downloading", progress: { bytesDownloaded: 5, percent: 40 } }),
        job("p", { status: "processing" }),
        job("c", { status: "completed" }),
      ],
      false,
    );
    const s = await open({ [PATH]: raw }).store;
    expect(s.get("d")).toMatchObject({ status: "paused", progress: { percent: 40 } });
    expect(s.get("q")?.status).toBe("paused");
    expect(s.get("p")?.status).toBe("paused");
    expect(s.get("c")?.status).toBe("completed");
    expect(s.notice()).toEqual({ reason: "unexpected", pausedCount: 3, jobIds: ["q", "d", "p"] });
  });

  it("calls a clean exit with jobs still active a restart", async () => {
    const raw = fileOf([job("d", { status: "downloading" })], true);
    const s = await open({ [PATH]: raw }).store;
    expect(s.notice()).toEqual({ reason: "restarted", pausedCount: 1, jobIds: ["d"] });
  });

  it("keeps an earlier notice when nothing new was paused", async () => {
    const notice = { reason: "unexpected", pausedCount: 1, jobIds: ["d"] };
    const raw = fileOf([job("d", { status: "paused" })], true, { notice });
    const s = await open({ [PATH]: raw }).store;
    expect(s.notice()).toEqual(notice);
  });

  it("records running, then a clean exit", async () => {
    const { fs, store } = open();
    const s = await store;
    await s.markRunning();
    expect(JSON.parse(fs.files.get(PATH) as string).cleanExit).toBe(false);
    await s.close();
    expect(JSON.parse(fs.files.get(PATH) as string).cleanExit).toBe(true);
  });

  it("keeps working in memory when a write fails, and retries on the next change", async () => {
    const { fs, store, onError } = open();
    const s = await store;
    const write = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("ENOSPC"));
    s.upsert(job("a"), { save: true });
    await s.flush();
    expect(onError).toHaveBeenCalled();
    expect(s.get("a")).toBeDefined();
    s.upsert(job("b"), { save: true });
    await s.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.files.get(PATH) as string).jobs).toHaveLength(2);
  });

  it("coalesces saves within the debounce window", async () => {
    vi.useFakeTimers();
    try {
      const fs = memoryHistoryFs();
      const write = vi.spyOn(fs, "writeFile");
      const s = await HistoryStore.open({ path: PATH, fs, debounceMs: 1000 });
      s.upsert(job("a"), { save: true });
      s.upsert(job("b"), { save: true });
      s.upsert(job("c"), { save: true });
      await vi.advanceTimersByTimeAsync(1000);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the format selector and plan across a save and reload", async () => {
    const { fs, store } = open();
    const s = await store;
    s.upsert(job("a", { formatSelector: "137+ba/137", plan: [{ kind: "video", bytes: 9 }] }), {
      save: true,
    });
    await s.flush();
    const again = await HistoryStore.open({ path: PATH, fs, debounceMs: 0 });
    expect(again.get("a")).toMatchObject({
      formatSelector: "137+ba/137",
      plan: [{ kind: "video", bytes: 9 }],
    });
  });

  it("drops rows whose format selector or plan is malformed", async () => {
    const raw = fileOf(
      [
        job("good"),
        { ...job("bad1"), formatSelector: 5 },
        { ...job("bad2"), plan: [{ kind: "x" }] },
      ] as never,
      true,
    );
    const s = await open({ [PATH]: raw }).store;
    expect(s.jobs().map((j) => j.id)).toEqual(["good"]);
  });

  it("removes a row and saves", async () => {
    const { fs, store } = open();
    const s = await store;
    s.upsert(job("a"), { save: true });
    s.upsert(job("b"), { save: true });
    await s.flush();
    expect(s.remove("a")).toBe(true);
    expect(s.remove("missing")).toBe(false);
    await s.flush();
    expect(JSON.parse(fs.files.get(PATH) as string).jobs.map((j: { id: string }) => j.id)).toEqual([
      "b",
    ]);
  });

  it("sets and clears the notice and saves it", async () => {
    const { fs, store } = open();
    const s = await store;
    s.setNotice({ reason: "unexpected", pausedCount: 1, jobIds: ["a"] });
    await s.flush();
    expect(JSON.parse(fs.files.get(PATH) as string).notice).toEqual({
      reason: "unexpected",
      pausedCount: 1,
      jobIds: ["a"],
    });
    s.setNotice(undefined);
    await s.flush();
    expect(s.notice()).toBeUndefined();
    expect(JSON.parse(fs.files.get(PATH) as string).notice).toBeUndefined();
  });
});

describe("HistoryStore read and write safety", () => {
  it("never saves over a file it could not read", async () => {
    const original = fileOf([job("keep")], true);
    const fs = memoryHistoryFs({ [PATH]: original });
    const busy = Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    fs.readFile = async () => {
      throw busy;
    };
    const onError = vi.fn();
    const s = await HistoryStore.open({ path: PATH, fs, debounceMs: 0, onError });
    expect(onError).toHaveBeenCalledWith(busy);
    expect(s.readOnly).toBe(true);
    s.upsert(job("a"), { save: true });
    await s.close();
    expect(fs.files.get(PATH)).toBe(original);
  });

  it("opens empty when the bad file cannot be moved aside and no onError is given", async () => {
    const fs = memoryHistoryFs({ [PATH]: "{not json" });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("EPERM"));
    const s = await HistoryStore.open({ path: PATH, fs, debounceMs: 0 });
    expect(s.jobs()).toEqual([]);
  });
});

describe("HistoryStore file validation", () => {
  it("keeps files and workDir across a save and reload", async () => {
    const { fs, store } = open();
    const s = await store;
    s.upsert(job("a", { files: ["/x/a.mp4"], workDir: "/x/w" }), { save: true });
    await s.flush();
    const again = await HistoryStore.open({ path: PATH, fs, debounceMs: 0 });
    expect(again.get("a")).toMatchObject({ files: ["/x/a.mp4"], workDir: "/x/w" });
  });

  it("loads a row without files as an empty list", async () => {
    const row: Partial<HistoryJob> = { ...job("a") };
    delete row.files;
    const { store } = open({
      [PATH]: JSON.stringify({ version: 1, cleanExit: true, jobs: [row] }),
    });
    expect((await store).get("a")?.files).toEqual([]);
  });

  it("drops a row whose files has a non-string entry", async () => {
    const raw = JSON.stringify({
      version: 1,
      cleanExit: true,
      jobs: [job("good"), { ...job("bad"), files: ["/a", 3] }],
    });
    const { store } = open({ [PATH]: raw });
    expect((await store).jobs().map((j) => j.id)).toEqual(["good"]);
  });

  it("drops a row whose workDir is not a string", async () => {
    const raw = JSON.stringify({
      version: 1,
      cleanExit: true,
      jobs: [job("good"), { ...job("bad"), workDir: 5 }],
    });
    const { store } = open({ [PATH]: raw });
    expect((await store).jobs().map((j) => j.id)).toEqual(["good"]);
  });

  it.each([
    ["a bad notice", { version: 1, cleanExit: true, notice: { reason: "nope" }, jobs: [] }],
    ["a non-integer version", { version: 1.5, cleanExit: true, jobs: [] }],
    ["a non-array jobs", { version: 1, cleanExit: true, jobs: {} }],
  ])("moves a file with %s aside", async (_label, body) => {
    const raw = JSON.stringify(body);
    const { fs, store } = open({ [PATH]: raw });
    const s = await store;
    expect(fs.files.get(`${PATH}.bak`)).toBe(raw);
    expect(s.jobs()).toEqual([]);
  });
});
