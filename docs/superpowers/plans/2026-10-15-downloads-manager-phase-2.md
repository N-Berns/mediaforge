# Downloads Manager, Phase 2: Job Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The core can pause, resume, retry, cancel, remove and trash downloads (alone or in batches), clear finished rows and dismiss the session notice, over the existing protocol, on Windows and Linux.

**Architecture:** `DownloadEngine` gains a dormant state: a paused or failed job keeps its entry and its work folder, and `resume` queues it again under the same id. On start, `CoreService` hands every paused and failed history row back to the engine (`restore`), so jobs from earlier sessions behave like this session's. New batch requests reply once with `jobs.result`. A platform helper moves files to the Recycle Bin or the freedesktop Trash. The terminal watchers (CLI, menu) and the extension's job mirror learn the new `paused` push.

**Tech Stack:** TypeScript (Node 24, ESM), zod 4 (in `shared-protocol` only), vitest, Ink 8 + React 19, Biome, pnpm workspaces.

**Spec:** [docs/superpowers/specs/2026-10-15-downloads-manager-design.md](../specs/2026-10-15-downloads-manager-design.md). This plan covers the spec's phase 2 only. Phase 1 ([plan](2026-10-15-downloads-manager-phase-1.md)) is done: protocol v3, connection roles, `HistoryStore`, `CoreClient`, the CLI and menu running in the core.

## Decisions taken in this plan (all confirmed by the user, 2026-10-15)

The spec settles most of phase 2. These points it leaves open; each has a recommended answer that the tasks below implement. Change any of them before execution starts.

| # | Question | This plan does | Why |
| --- | --- | --- | --- |
| D1 | Name of the batch reply | `jobs.result` with `{ failed: Array<{ jobId, message }> }` | Spec gives the payload, not the type name. |
| D2 | Protocol version | Stays 3 | Every change is additive. Phase 1 already bumped once for the whole feature, as the spec says. An extension from phase 1 drops the frames it cannot parse (`native-client.ts:236`). |
| D3 (confirmed) | Which role may send what | `jobs.trash` is terminal only (`forbidden` for the relay). Pause, resume, cancel, remove, clear finished and notice dismiss are allowed for both. | Trash is the only destructive request; the popup (phase 4) never trashes. |
| D4 (confirmed) | Cookies and headers on resume | Never written to `history.json`. Resume in the same core session reuses them from memory; resume after a core restart runs without them. | Writing cookies to disk is a new secret at rest. A login-gated download that fails after a restart can be started again from the browser. |
| D5 | Resuming the exact format | `history.json` rows gain core-only `formatSelector` and `plan` | `DownloadRequest` has no selector field, so without them a menu or CLI job would resume with the profile's default format. |
| D6 | Partial files of removed jobs | `jobs.remove` and `jobs.trash` delete the work folder (partial files) of a paused or failed job for good. Finished output files follow the spec (remove keeps them, trash recycles them). | Partial files cannot be played and would otherwise stay hidden in `.mediaforge-<id>` folders forever. |
| D7 | A watched job gets paused by another client | The CLI prints `Paused. It can be resumed later from MediaForge.` and exits with `ExitCode.Cancelled` (130). The menu shows the notice `Download paused` and goes back, like a cancel. | Scripts already treat 130 as "stopped by the user"; no new exit code. |
| D8 | Extension popup in phase 2 | The job mirror shows `paused` from the new push, and a cleared row comes back when its job runs again. No new buttons (phase 4). | Without it, a job paused from the manager (phase 3) would look stuck as "downloading" in the popup. |
| D9 | Telling clients about removed rows | After `jobs.remove`, `jobs.trash` and `jobs.clearFinished`, the core pushes a fresh `jobs.snapshot` to every subscribed client. | Spec defines no removal push; the snapshot already exists and every client handles it. |
| D10 (confirmed) | Recycle Bin call on Windows | `SHFileOperationW` with `FOF_ALLOWUNDO \| FOF_NOCONFIRMATION \| FOF_NOERRORUI \| FOF_SILENT`, through one hidden `powershell -NoProfile` per batch, and only on fixed drives. | Spec names `Microsoft.VisualBasic…DeleteFile(path, OnlyErrorDialogs, SendToRecycleBin)`, but `OnlyErrorDialogs` opens an error dialog from the background service on a locked file. On drives without a Recycle Bin (network, most USB sticks) both APIs delete for good without asking, so those are refused. |
| D11 | Passing paths to PowerShell | The script is fixed text sent as `-EncodedCommand`; the paths go in as base64 of UTF-8 JSON on stdin; results come back the same way. | Spec: "never interpolated into scripts". Windows PowerShell 5.1 reads stdin in the OEM code page, so plain text would mangle non-ASCII names. |

## Global Constraints

- Platforms: Windows and Linux. No macOS-specific code.
- Pause keeps partial files and is resumable. Cancel removes them and is final.
- Resume resumes paused jobs and retries failed jobs under the same id and settings.
- `download.resume`: other statuses are reported as failures.
- `jobs.remove`: cancels active ones, then drops the rows. Files stay on disk.
- `jobs.trash`: cancels active ones, moves every recorded file of each job to the trash, drops the rows.
- `jobs.clearFinished`: drops every `completed` row.
- `notice.dismiss`: clears the session notice for every client.
- Batch requests reply once, listing per-id failures: `{ failed: Array<{ jobId, message }> }`.
- `download.paused` `{ jobId }` is pushed when a job was paused by a user (not by a limit restart).
- `notice` `{ notice?: Notice }` is pushed when the notice is dismissed or no paused jobs from it remain.
- `jobs.trash` takes job ids, never paths. The core deletes only paths in that job's `files` list. An unknown id is reported as a failure, not an error frame.
- Delete from disk moves files to the Recycle Bin (Windows) or the freedesktop Trash (Linux).
- Linux trash: move to `$XDG_DATA_HOME/Trash/files` (default `~/.local/share/Trash`) and write the matching `.trashinfo`. Files on another mount use that mount's `.Trash-$UID`.
- Paths and arguments are passed as process arguments or data, never interpolated into scripts.
- The core is the only writer of `history.json`. Paused jobs do not keep the core alive.
- Repo rules: never run `git commit`. Each task's last step prints a commit message for the user, in the format from `CLAUDE.md`. Run `pnpm exec biome check --write <paths>` on files changed through Bash. Run `pnpm lint` before finishing.

## Review Focus

1. **Pause or cancel while yt-dlp is just starting or just finishing.** A pause that lands after yt-dlp exited 0 must not turn a finished download into a paused one, and a pause must never delete the work folder. Test in Task 3.
2. **Resume after a core restart.** A job paused in session N resumes in session N+1 with the same id, folder and exact format. Test in Task 5.
3. **Trash with a file that is locked, missing or already in the trash.** A locked file fails for its own job only and the row stays; a missing file counts as already gone. Tests in Tasks 4 and 6.
4. **Trash on a drive with no Recycle Bin or another Linux mount.** Never a silent permanent delete on Windows; on Linux the file goes to that mount's `.Trash-$UID`. Tests in Task 4.
5. **Batch requests with duplicate, unknown or mixed-status ids.** One reply, each id handled once, the valid ones still applied. Tests in Tasks 5 and 6.

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `packages/shared-protocol/src/messages.ts` | Modify | Job-control requests, `jobs.result`, `download.paused`, `notice`. |
| `packages/shared-protocol/src/parse.test.ts` | Modify | Tests for the new messages. |
| `apps/desktop/src/core/history.ts` | Modify | Core-only `formatSelector` and `plan`; `remove`, `setNotice`. |
| `apps/desktop/src/engine/engine.ts` | Modify | `pause`, `resume`, `restore`, `remove`; dormant jobs keep their work folder. |
| `apps/desktop/src/engine/args.ts` | Modify | Pass `--continue` explicitly. |
| `apps/desktop/src/core/trash.ts` | Create | `createTrash(platform)`: Windows Recycle Bin and freedesktop Trash. |
| `apps/desktop/src/core/service.ts` | Modify | Job-control requests, restore on start, `download.paused` push, notice clearing, snapshot push, trash. |
| `apps/desktop/src/core/run-core.ts` | Modify | Real `trash` dependency. |
| `apps/desktop/src/core/in-process.ts` | Modify | Default `trash` for tests. |
| `apps/desktop/src/core/job-watch.ts` | Modify | `download.paused` ends a watch. |
| `apps/desktop/src/download.ts` | Modify | A paused job ends the CLI with 130. |
| `apps/desktop/src/interactive/App.tsx`, `apps/desktop/src/interactive/BatchFlow.tsx` | Modify | A paused job ends the menu screens like a cancel. |
| `apps/extension/src/background/job-mirror.ts` | Modify | `download.paused`; un-clear a job that runs again. |
| `docs/desktop-cli-checklist.md` | Modify | Manual checks for phase 2. |

---

### Task 1: Job-control messages

**Files:**
- Modify: `packages/shared-protocol/src/messages.ts`
- Test: `packages/shared-protocol/src/parse.test.ts`

**Interfaces:**
- Produces (from `@mediaforge/shared-protocol`):
  - `MAX_BATCH = 1000` (exported).
  - Requests: `download.pause`, `download.resume`, `jobs.remove`, `jobs.trash` with payload `{ jobIds: string[] }` (1 to `MAX_BATCH` ids); `jobs.clearFinished` and `notice.dismiss` with payload `{}`.
  - Host messages: `jobs.result` `{ failed: Array<{ jobId: string; message: string }> }`; `download.paused` `{ jobId: string; progress?: DownloadProgress }`; `notice` `{ notice?: Notice }`.
  - `PROTOCOL_VERSION` stays `3`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared-protocol/src/parse.test.ts` (reuse the file's imports of `PROTOCOL_VERSION`, `parseExtensionMessage`, `parseHostMessage`; add `MAX_BATCH` to the import):

```ts
describe("job control", () => {
  const env = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "1", type, payload });

  it.each(["download.pause", "download.resume", "jobs.remove", "jobs.trash"])(
    "accepts %s with job ids and refuses an empty or oversized list",
    (type) => {
      expect(parseExtensionMessage(env(type, { jobIds: ["a", "b"] })).ok).toBe(true);
      expect(parseExtensionMessage(env(type, { jobIds: [] })).ok).toBe(false);
      const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => `j${i}`);
      expect(parseExtensionMessage(env(type, { jobIds: many })).ok).toBe(false);
    },
  );

  it.each(["jobs.clearFinished", "notice.dismiss"])("accepts %s with an empty payload", (type) => {
    expect(parseExtensionMessage(env(type, {})).ok).toBe(true);
  });

  it("parses the batch reply, the paused push and the notice push", () => {
    expect(
      parseHostMessage(env("jobs.result", { failed: [{ jobId: "a", message: "No such download." }] }))
        .ok,
    ).toBe(true);
    expect(
      parseHostMessage(env("download.paused", { jobId: "a", progress: { bytesDownloaded: 5, percent: 50 } }))
        .ok,
    ).toBe(true);
    expect(parseHostMessage(env("download.paused", { jobId: "a" })).ok).toBe(true);
    expect(parseHostMessage(env("notice", {})).ok).toBe(true);
    expect(
      parseHostMessage(
        env("notice", { notice: { reason: "restarted", pausedCount: 1, jobIds: ["a"] } }),
      ).ok,
    ).toBe(true);
  });

  it("keeps protocol version 3", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/shared-protocol/src/parse.test.ts -t "job control"`
Expected: FAIL. `MAX_BATCH` is not exported and the new types do not parse.

- [ ] **Step 3: Implement**

In `packages/shared-protocol/src/messages.ts`, below `const jobRef = …`, add:

```ts
/** Upper bound on ids in one batch request; the manager can tick every row it lists. */
export const MAX_BATCH = 1000;

const jobIds = z.object({ jobIds: z.array(z.string()).min(1).max(MAX_BATCH) });
```

With the other extension → host messages:

```ts
/** Stop queued or running jobs and keep their partial files. */
export const DownloadPauseMessage = message("download.pause", jobIds);
/** Queue paused or failed jobs again under the same ids. */
export const DownloadResumeMessage = message("download.resume", jobIds);
/** Cancel active jobs, then drop the rows. Finished files stay on disk. */
export const JobsRemoveMessage = message("jobs.remove", jobIds);
/** Terminal connections only: cancel, move each job's recorded files to the trash, drop the rows. */
export const JobsTrashMessage = message("jobs.trash", jobIds);
/** Drop every completed row. */
export const JobsClearFinishedMessage = message("jobs.clearFinished", z.object({}));
/** Clear the session notice for every client. */
export const NoticeDismissMessage = message("notice.dismiss", z.object({}));
```

With the host → extension messages (after `FolderOpenedMessage`):

```ts
/** The one reply to a batch request: the ids it could not act on, and why. */
export const JobsResultMessage = message(
  "jobs.result",
  z.object({ failed: z.array(z.object({ jobId: z.string(), message: z.string() })) }),
);
/** A user paused this job; its partial files are kept. */
export const DownloadPausedMessage = message(
  "download.paused",
  jobRef.extend({ progress: DownloadProgressSchema.optional() }),
);
/** The session notice changed: dismissed, or none of its paused jobs remain. */
export const NoticeMessage = message("notice", z.object({ notice: NoticeSchema.optional() }));
```

Add the six requests to the `ExtensionToHostMessage` union and the three host messages to the `HostToExtensionMessage` union. `DownloadProgressSchema` and `NoticeSchema` are already imported; add the import if one is missing.

- [ ] **Step 4: Run the tests and the type check**

Run: `pnpm vitest run packages/shared-protocol && pnpm typecheck`
Expected: the protocol tests PASS. `tsc -b` fails in `apps/desktop/src/core/service.ts` at the exhaustive `#dispatch` switch (`never`), because the six requests have no case yet. Add one temporary case for all six that replies `this.#error(state, message.id, "unsupported", "Not available yet.")`; Task 5 replaces it. Fix any other exhaustive switch the compiler names (for example in the extension) by ignoring the new host types. Then `pnpm typecheck && pnpm test` PASS.

- [ ] **Step 5: Commit message for the user**

```markdown
✨ shared-protocol: add job-control requests and pushes

## Description

The downloads manager needs to pause, resume, remove and trash jobs,
clear finished rows and dismiss the session notice. The new requests
take batches of job ids and get one reply listing the ids that could
not be acted on. All changes are additive, so the protocol stays at
version 3.

## Test

pnpm vitest run packages/shared-protocol
```

---

### Task 2: History rows remember the format; remove and notice setters

**Files:**
- Modify: `apps/desktop/src/core/history.ts`
- Test: `apps/desktop/src/core/history.test.ts`

**Interfaces:**
- Consumes: `PlannedStepSchema` from `@mediaforge/shared-protocol`; `PlannedStep` from `@mediaforge/shared-types`.
- Produces:
  - `HistoryJob` gains optional core-only `formatSelector?: string` and `plan?: PlannedStep[]`.
  - `HistoryStore.remove(id: string): boolean` (true when a row was dropped; schedules a save).
  - `HistoryStore.setNotice(notice: Notice | undefined): void` (schedules a save).

- [ ] **Step 1: Write the failing tests**

Append inside `describe("HistoryStore", …)` in `apps/desktop/src/core/history.test.ts` (the file's `job`, `open`, `PATH` and `fileOf` helpers already exist):

```ts
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
      [job("good"), { ...job("bad1"), formatSelector: 5 }, { ...job("bad2"), plan: [{ kind: "x" }] }] as never,
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/core/history.test.ts`
Expected: FAIL. `remove` and `setNotice` are not functions; the malformed rows are kept.

- [ ] **Step 3: Implement**

In `apps/desktop/src/core/history.ts`:

Imports: add `PlannedStepSchema` to the `@mediaforge/shared-protocol` import, and `PlannedStep` to the `@mediaforge/shared-types` type import.

`HistoryJob`:

```ts
export type HistoryJob = DownloadJob & {
  /** Every file the job wrote. The only paths a later delete may touch. */
  files: string[];
  /** Folder holding partial files while paused or failed. */
  workDir?: string;
  /** The exact yt-dlp format chosen at start (terminal selector or probed variant), for resume. */
  formatSelector?: string;
  /** The steps expected for that format, for resume. */
  plan?: PlannedStep[];
};
```

In `parseJob`, after the `workDir` check:

```ts
  if (o.formatSelector !== undefined && typeof o.formatSelector !== "string") return undefined;
  const plan = o.plan === undefined ? undefined : PlannedStepSchema.array().safeParse(o.plan);
  if (plan && !plan.success) return undefined;
```

and in its returned object, after the `workDir` spread:

```ts
    ...(typeof o.formatSelector === "string" && { formatSelector: o.formatSelector }),
    ...(plan?.success && { plan: plan.data }),
```

In `HistoryStore`, after `upsert`:

```ts
  /** Drop a row. Returns false when there was none. */
  remove(id: string): boolean {
    const removed = this.#jobs.delete(id);
    if (removed) this.#schedule();
    return removed;
  }
```

and after `notice()`:

```ts
  /** Replace or clear the session notice. */
  setNotice(notice: Notice | undefined): void {
    this.#notice = notice;
    this.#schedule();
  }
```

`#write` already writes the notice only when it is set, so a cleared notice disappears from the file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/core/history.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit message for the user**

```markdown
✨ remember each download's format in the history

## Description

Resuming a paused menu or CLI download must fetch the same format it
started with, so each history row now keeps the exact format and its
planned steps (core-only, never sent to clients). The store can also
drop rows and clear the session notice, for the job-control requests.

## Test

pnpm vitest run apps/desktop/src/core/history.test.ts
```

---

### Task 3: Pause, resume and restore in the engine

**Files:**
- Modify: `apps/desktop/src/engine/engine.ts`, `apps/desktop/src/engine/args.ts`
- Test: `apps/desktop/src/engine/engine.test.ts`, `apps/desktop/src/engine/args.test.ts`

**Interfaces:**
- Produces:
  - `EngineJob` gains `workDir?: string` (set when the job first starts; never sent to clients).
  - `DownloadEngine.pause(id: string): boolean`: queued, downloading or processing → `paused`; partial files kept. False otherwise.
  - `DownloadEngine.resume(id: string): boolean`: paused or failed → `queued` under the same id, `error` and `errorKind` cleared. False otherwise.
  - `DownloadEngine.restore(job: EngineJob, options?: { formatSelector?: string; plan?: PlannedStep[] }): void`: adds a paused or failed job from an earlier session without starting it. Ignores other statuses and known ids.
  - `DownloadEngine.remove(id: string): Promise<void>`: cancels an active job and waits for it; deletes a paused or failed job's work folder; forgets the job. Unknown ids are a no-op.
  - `DownloadEngine.cancel(id)` now also accepts a paused job: it deletes the work folder and ends `cancelled`.
  - A failed job keeps its work folder (it can be retried). Completed and cancelled jobs still lose it.
  - `whenSettled(id)` resolves on completed, failed or cancelled only; a paused job is not settled. Resuming a failed job gives it a new settle promise.
  - `buildYtDlpArgs` always passes `--continue`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/desktop/src/engine/engine.test.ts`. Use the file's existing helpers (`request()`, `found`, `fakeFs()`); where a name differs, use the real one with that role. The blocking runner below resolves only when the test says so or when the signal aborts:

```ts
describe("pause and resume", () => {
  /** A runner that waits for `finish(code)` or an abort, and records every call's args. */
  function gatedRunner() {
    const calls: { args: string[]; finish: (exitCode: number) => void }[] = [];
    const run: ProcessRunner = (_cmd, args, handlers, signal) =>
      new Promise((resolve) => {
        const finish = (exitCode: number) => resolve({ exitCode });
        calls.push({ args, finish });
        if (signal.aborted) return finish(1);
        signal.addEventListener("abort", () => finish(1));
        handlers.onStdoutLine("MFPROGRESS 50 100 NA 10 5");
      });
    return { run, calls };
  }

  it("pauses a running job, keeps its work folder, and resumes it under the same id", async () => {
    const { fs, removed } = fakeFs();
    const { run, calls } = gatedRunner();
    const updates: EngineJob[] = [];
    const engine = new DownloadEngine({ resolve: found, fs, run, onUpdate: (j) => updates.push(j) });
    const { id } = engine.submit(request());
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(engine.pause(id)).toBe(true);
    await vi.waitFor(() => expect(engine.get(id)?.status).toBe("paused"));
    expect(engine.get(id)?.progress.percent).toBe(50);
    expect(removed).toEqual([]);
    expect(engine.get(id)?.workDir).toMatch(new RegExp(`\\.mediaforge-${id}$`));

    expect(engine.resume(id)).toBe(true);
    expect(engine.get(id)?.status).not.toBe("paused");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.args).toContain("--continue");
    expect(calls[1]?.args[calls[1].args.indexOf("--paths") + 1]).toBe(engine.get(id)?.workDir);
    engine.cancel(id);
    await engine.whenSettled(id);
  });

  it("pauses a queued job without running it", () => {
    const { fs } = fakeFs();
    const { run } = gatedRunner();
    const engine = new DownloadEngine({ resolve: found, fs, run, maxConcurrent: 1 });
    engine.submit(request());
    const second = engine.submit(request()).id;
    expect(engine.pause(second)).toBe(true);
    expect(engine.get(second)?.status).toBe("paused");
    expect(engine.pause(second)).toBe(false);
  });

  it("does not turn a download that already finished into a paused one", async () => {
    const { fs } = fakeFs();
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      run: async (_c, args, h) => {
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip.mp4`);
        return { exitCode: 0 };
      },
    });
    const { id } = engine.submit(request());
    const final = await engine.whenSettled(id);
    expect(final?.status).toBe("completed");
    expect(engine.pause(id)).toBe(false);
  });

  it("keeps a failed job's work folder and retries it with a fresh settle", async () => {
    const { fs, removed } = fakeFs();
    let attempt = 0;
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      run: async (_c, args, h) => {
        attempt += 1;
        if (attempt === 1) {
          h.onStderrLine("ERROR: Unable to download: HTTP Error 503");
          return { exitCode: 1 };
        }
        h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip.mp4`);
        return { exitCode: 0 };
      },
    });
    const { id } = engine.submit(request());
    expect((await engine.whenSettled(id))?.status).toBe("failed");
    expect(removed).toEqual([]);

    expect(engine.resume(id)).toBe(true);
    expect(engine.get(id)?.error).toBeUndefined();
    expect((await engine.whenSettled(id))?.status).toBe("completed");
  });

  it("cancelling a paused job removes its partial files", async () => {
    const { fs, removed } = fakeFs();
    const { run, calls } = gatedRunner();
    const engine = new DownloadEngine({ resolve: found, fs, run });
    const { id } = engine.submit(request());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    engine.pause(id);
    await vi.waitFor(() => expect(engine.get(id)?.status).toBe("paused"));
    const workDir = engine.get(id)?.workDir;

    expect(engine.cancel(id)).toBe(true);
    expect((await engine.whenSettled(id))?.status).toBe("cancelled");
    await vi.waitFor(() => expect(removed).toContain(workDir));
  });

  it("restores a paused job from an earlier session and resumes it with its format", async () => {
    const { fs } = fakeFs();
    const { run, calls } = gatedRunner();
    const engine = new DownloadEngine({ resolve: found, fs, run });
    const now = Date.now();
    engine.restore(
      {
        id: "old",
        request: request(),
        status: "paused",
        progress: { bytesDownloaded: 5, percent: 40 },
        createdAt: now,
        updatedAt: now,
      },
      { formatSelector: "137+ba/137" },
    );
    expect(engine.get("old")?.status).toBe("paused");
    expect(calls).toHaveLength(0);

    expect(engine.resume("old")).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.args.join(" ")).toContain("137+ba/137");
    expect(calls[0]?.args[calls[0].args.indexOf("--paths") + 1]).toMatch(/\.mediaforge-old$/);
    engine.cancel("old");
    await engine.whenSettled("old");
  });

  it("ignores restore for running statuses and for known ids", () => {
    const engine = new DownloadEngine({ resolve: found, fs: fakeFs().fs });
    const now = Date.now();
    const base = { request: request(), progress: { bytesDownloaded: 0 }, createdAt: now, updatedAt: now };
    engine.restore({ ...base, id: "q", status: "queued" });
    expect(engine.get("q")).toBeUndefined();
    engine.restore({ ...base, id: "p", status: "paused" });
    engine.restore({ ...base, id: "p", status: "failed" });
    expect(engine.get("p")?.status).toBe("paused");
  });

  it("removes jobs: cancels active ones, deletes dormant partials, forgets them", async () => {
    const { fs, removed } = fakeFs();
    const { run, calls } = gatedRunner();
    const engine = new DownloadEngine({ resolve: found, fs, run });
    const running = engine.submit(request()).id;
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await engine.remove(running);
    expect(engine.get(running)).toBeUndefined();

    const now = Date.now();
    engine.restore({
      id: "gone",
      request: request(),
      status: "failed",
      progress: { bytesDownloaded: 0 },
      createdAt: now,
      updatedAt: now,
    });
    await engine.remove("gone");
    expect(engine.get("gone")).toBeUndefined();
    expect(removed.some((p) => p.endsWith(".mediaforge-gone"))).toBe(true);
    await expect(engine.remove("unknown")).resolves.toBeUndefined();
  });
});
```

Import `ProcessRunner` from `./process.ts` and `EngineJob` from `./engine.ts` if the file does not already. If `fakeFs()` does not expose the paths passed to `rm`, extend it to collect them in a `removed: string[]` array and return it.

In `apps/desktop/src/engine/args.test.ts`, add to the existing `buildYtDlpArgs` tests:

```ts
  it("always continues partial files", () => {
    expect(buildYtDlpArgs(baseInput())).toContain("--continue");
  });
```

where `baseInput()` stands for the file's existing way of building a `BuildArgsInput`; use the real helper.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/engine`
Expected: FAIL. `pause`, `resume`, `restore` and `remove` are not functions; `--continue` is missing; the failed job's folder is removed.

- [ ] **Step 3: Implement `--continue`**

In `apps/desktop/src/engine/args.ts` `buildYtDlpArgs`, add `"--continue",` right after `"--no-playlist",`, with the comment `// Resume partial files left by a paused or failed try (yt-dlp's default, stated so it holds).`

- [ ] **Step 4: Implement the engine changes**

In `apps/desktop/src/engine/engine.ts`:

`EngineJob`:

```ts
export interface EngineJob extends DownloadJob {
  /** Exit code matching the failure, set when `status` is "failed". */
  errorKind?: ExitCode;
  /** Where this job's partial files live. Set when it first starts; core-only. */
  workDir?: string;
}
```

`Entry` gains:

```ts
  /** Why the controller was aborted: a pause keeps the partial files, a cancel removes them. */
  stopReason: "pause" | "cancel" | undefined;
```

Give `stopReason: undefined` in `submit`'s `this.#entries.set(...)`.

Status sets, next to `TERMINAL`:

```ts
/** Jobs that are queued or running. */
const ACTIVE = new Set(["queued", "downloading", "processing"]);
/** Jobs that keep their entry and partial files until resumed, cancelled or removed. */
const DORMANT = new Set(["paused", "failed"]);
```

A helper on the class, used by `#execute`, `cancel` and `remove`:

```ts
  #workDirOf(job: EngineJob): string {
    return join(resolve(job.request.outputDir ?? this.#outputDir), `.mediaforge-${job.id}`);
  }

  /** A promise that resolves when the job next completes, fails or is cancelled. */
  #newSettle(entry: Pick<Entry, "settled" | "settle">): void {
    entry.settled = new Promise<EngineJob>((res) => {
      entry.settle = res;
    });
  }
```

Replace the settle setup in `submit` with an entry built first and `#newSettle(entry)` on it, so the two code paths share it:

```ts
    const entry: Entry = {
      job,
      controller: new AbortController(),
      settled: Promise.resolve(job),
      settle: () => {},
      stopReason: undefined,
      formatSelector: options.formatSelector,
      plan: options.plan,
      context: options.context,
    };
    this.#newSettle(entry);
    this.#entries.set(job.id, entry);
```

New public methods, after `cancel`:

```ts
  /** Stop a queued or running job and keep its partial files, so `resume` can continue it. */
  pause(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry || !ACTIVE.has(entry.job.status)) return false;
    const queued = this.#queue.indexOf(id);
    if (queued >= 0) {
      this.#queue.splice(queued, 1);
      this.#update(entry, { status: "paused" });
    } else {
      entry.stopReason = "pause";
      entry.controller.abort();
    }
    return true;
  }

  /** Queue a paused or failed job again under the same id; yt-dlp continues its partial files. */
  resume(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry || !DORMANT.has(entry.job.status)) return false;
    // A failed job's settle already fired; the new try gets its own.
    if (entry.job.status === "failed") this.#newSettle(entry);
    entry.controller = new AbortController();
    entry.stopReason = undefined;
    const { error: _error, errorKind: _errorKind, ...rest } = entry.job;
    entry.job = { ...rest, status: "queued", updatedAt: Date.now() };
    this.#onUpdate?.({ ...entry.job });
    this.#queue.push(id);
    this.#pump();
    return true;
  }

  /** Take back a paused or failed job from an earlier session, without starting it. */
  restore(job: EngineJob, options: { formatSelector?: string; plan?: PlannedStep[] } = {}): void {
    if (this.#entries.has(job.id) || !DORMANT.has(job.status)) return;
    const entry: Entry = {
      job: { ...job },
      controller: new AbortController(),
      settled: Promise.resolve(job),
      settle: () => {},
      stopReason: undefined,
      formatSelector: options.formatSelector,
      plan: options.plan,
      // Cookies and headers are never stored, so a restored job runs without them.
      context: undefined,
    };
    this.#newSettle(entry);
    this.#entries.set(job.id, entry);
  }

  /**
   * Forget a job. An active one is cancelled first and waited for; a paused or failed one loses
   * its partial files. Unknown ids do nothing.
   */
  async remove(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) return;
    if (ACTIVE.has(entry.job.status)) {
      this.cancel(id);
      await entry.settled;
    } else if (DORMANT.has(entry.job.status)) {
      await this.#fs.rm(this.#workDirOf(entry.job)).catch(() => {});
    }
    this.#entries.delete(id);
  }
```

`cancel` becomes:

```ts
  /** Cancel a queued, running or paused job. False when it is unknown or already finished. */
  cancel(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry || TERMINAL.has(entry.job.status)) return false;
    if (entry.job.status === "paused") {
      const workDir = this.#workDirOf(entry.job);
      this.#finish(entry, { status: "cancelled" });
      void this.#fs.rm(workDir).catch(() => {});
      return true;
    }
    const queued = this.#queue.indexOf(id);
    if (queued >= 0) {
      this.#queue.splice(queued, 1);
      this.#finish(entry, { status: "cancelled" });
    } else {
      entry.stopReason = "cancel";
      entry.controller.abort();
    }
    return true;
  }
```

`#finish` keeps the request context for a failed job, so a retry in the same session still has its cookies:

```ts
  #finish(entry: Entry, patch: Partial<EngineJob>): void {
    this.#update(entry, patch);
    // The secrets are no longer needed once the job is over for good. A failed job may be retried.
    if (entry.job.status !== "failed") entry.context = undefined;
    entry.settle({ ...entry.job });
  }
```

In `#execute`:

- Replace `const workDir = join(outputDir, \`.mediaforge-${job.id}\`);` with `const workDir = this.#workDirOf(job);` (keep `outputDir`, it is still used for the final path).
- Replace `this.#update(entry, { status: "downloading" });` with `this.#update(entry, { status: "downloading", workDir });`.
- Both places that map an aborted signal to `{ status: "cancelled" }` become:

```ts
        outcome = { status: entry.stopReason === "pause" ? "paused" : "cancelled" };
```

(in the `catch`, keep the existing failure object for the non-aborted branch).

- Replace the tail (from the `// Always remove the working folder` comment to the end of the method) with:

```ts
    // Partial files stay for a paused job (resume continues them) and a failed one (retry does).
    if (outcome.status !== "paused" && outcome.status !== "failed") {
      await this.#fs.rm(workDir).catch(() => {});
    }
    if (outcome.status === "paused") {
      entry.stopReason = undefined;
      this.#update(entry, outcome);
    } else {
      this.#finish(entry, outcome);
    }
```

A pause that arrives after yt-dlp exited 0 cannot change the outcome: `pause` aborts the controller, but `#execute` checks `controller.signal.aborted` only before it looks at the exit code, and the controller of a finished job is never aborted because `pause` refuses non-active statuses. Keep the existing order (`if (controller.signal.aborted) … else if (exitCode === 0 …)`): an abort that raced a successful exit still yields `paused`, which is safe because the partial and finished files stay in the work folder and resume picks them up.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/engine && pnpm typecheck`
Expected: PASS. Existing engine tests that asserted the work folder is removed after a failure need their expectation changed to "kept"; change only those expectations.

- [ ] **Step 6: Commit message for the user**

```markdown
✨ let the engine pause, resume and retry downloads

## Description

Pausing stops yt-dlp but keeps the partial files, and resuming queues
the same job again so yt-dlp continues where it stopped. A failed job
also keeps its partial files so a retry does not start over. Jobs from
an earlier session can be handed back to the engine without starting
them, and a removed job takes its partial files with it.

## Test

pnpm vitest run apps/desktop/src/engine
```

---

### Task 4: Move files to the Recycle Bin or the Trash

**Files:**
- Create: `apps/desktop/src/core/trash.ts`
- Test: `apps/desktop/src/core/trash.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TrashResult {
  /** Paths that could not be moved, with a reason. Missing files are not failures. */
  failed: Array<{ path: string; message: string }>;
}
export type TrashFn = (paths: string[]) => Promise<TrashResult>;

/** Runs one program with data on stdin; resolves with its exit code and stdout. */
export type TrashRunner = (
  command: string,
  args: string[],
  stdin: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const WINDOWS_TRASH_SCRIPT: string;
export function windowsTrashCommand(): { command: string; args: string[] };
export function windowsTrash(run?: TrashRunner): TrashFn;

export interface LinuxTrashDeps {
  env: Record<string, string | undefined>;
  home: string;
  uid: number;
  now: () => Date;
  /** Device id of an existing path; the default reads `stat().dev`. Tests fake other mounts. */
  deviceOf?: (path: string) => Promise<number>;
}
export function linuxTrash(deps: LinuxTrashDeps): TrashFn;

/** The trash for this platform. */
export function createTrash(platform?: NodeJS.Platform): TrashFn;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/core/trash.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  linuxTrash,
  type TrashRunner,
  WINDOWS_TRASH_SCRIPT,
  windowsTrash,
  windowsTrashCommand,
} from "./trash.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "mf-trash-"));
  dirs.push(d);
  return d;
};

describe("windows trash", () => {
  it("runs a fixed hidden PowerShell script and never puts a path on the command line", () => {
    const { command, args } = windowsTrashCommand();
    expect(command).toBe("powershell.exe");
    expect(args).toEqual(
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-EncodedCommand"]),
    );
    const encoded = args[args.indexOf("-EncodedCommand") + 1] as string;
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(WINDOWS_TRASH_SCRIPT);
  });

  it("sends the paths as base64 JSON on stdin and reads failures back", async () => {
    let seenStdin = "";
    let seenArgs: string[] = [];
    const run: TrashRunner = async (_command, args, stdin) => {
      seenArgs = args;
      seenStdin = stdin;
      const failed = [{ path: "C:\\dl\\ü.mp4", message: "in use" }];
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify(failed), "utf8").toString("base64"),
        stderr: "",
      };
    };
    const paths = ["C:\\dl\\ü.mp4", "C:\\dl\\b.mp4"];
    const result = await windowsTrash(run)(paths);
    expect(JSON.parse(Buffer.from(seenStdin, "base64").toString("utf8"))).toEqual(paths);
    expect(seenArgs.join(" ")).not.toContain("dl");
    expect(result.failed).toEqual([{ path: "C:\\dl\\ü.mp4", message: "in use" }]);
  });

  it("fails every path when PowerShell cannot run", async () => {
    const run: TrashRunner = async () => ({ exitCode: 1, stdout: "", stderr: "boom" });
    const result = await windowsTrash(run)(["C:\\a", "C:\\b"]);
    expect(result.failed.map((f) => f.path)).toEqual(["C:\\a", "C:\\b"]);
    expect(result.failed[0]?.message).toMatch(/Recycle Bin/);
  });

  it("refuses drives without a Recycle Bin and never deletes for good", () => {
    expect(WINDOWS_TRASH_SCRIPT).toContain("DriveType");
    expect(WINDOWS_TRASH_SCRIPT).toContain("0x0040"); // FOF_ALLOWUNDO
    expect(WINDOWS_TRASH_SCRIPT).toContain("0x0400"); // FOF_NOERRORUI
    expect(WINDOWS_TRASH_SCRIPT).not.toContain("OnlyErrorDialogs");
  });
});

describe("linux trash", () => {
  const deps = (root: string, extra: Partial<Parameters<typeof linuxTrash>[0]> = {}) => ({
    env: { XDG_DATA_HOME: join(root, "data") },
    home: join(root, "home"),
    uid: 1000,
    now: () => new Date(2026, 9, 15, 9, 5, 7),
    ...extra,
  });

  it("moves the file into XDG_DATA_HOME/Trash and writes a matching trashinfo", async () => {
    const root = await temp();
    await mkdir(join(root, "dl"), { recursive: true });
    const file = join(root, "dl", "My clip #1.mp4");
    await writeFile(file, "x");

    const result = await linuxTrash(deps(root))([file]);

    expect(result.failed).toEqual([]);
    await expect(stat(file)).rejects.toThrow();
    const trash = join(root, "data", "Trash");
    expect(await readdir(join(trash, "files"))).toEqual(["My clip #1.mp4"]);
    const info = await readFile(join(trash, "info", "My clip #1.mp4.trashinfo"), "utf8");
    expect(info).toBe(
      `[Trash Info]\nPath=${file.split("/").map(encodeURIComponent).join("/")}\nDeletionDate=2026-10-15T09:05:07\n`,
    );
  });

  it("falls back to ~/.local/share/Trash without XDG_DATA_HOME", async () => {
    const root = await temp();
    const file = join(root, "a.mp4");
    await writeFile(file, "x");
    await linuxTrash(deps(root, { env: {} }))([file]);
    expect(await readdir(join(root, "home", ".local", "share", "Trash", "files"))).toEqual([
      "a.mp4",
    ]);
  });

  it("gives a second file of the same name a new trash name", async () => {
    const root = await temp();
    const trash = linuxTrash(deps(root));
    for (const n of [1, 2]) {
      await mkdir(join(root, `d${n}`), { recursive: true });
      await writeFile(join(root, `d${n}`, "a.mp4"), String(n));
      await trash([join(root, `d${n}`, "a.mp4")]);
    }
    expect((await readdir(join(root, "data", "Trash", "files"))).sort()).toEqual([
      "a.2.mp4",
      "a.mp4",
    ]);
  });

  it("counts a missing file as already gone", async () => {
    const root = await temp();
    const result = await linuxTrash(deps(root))([join(root, "nope.mp4")]);
    expect(result.failed).toEqual([]);
  });

  it("uses the other mount's .Trash-UID with a path relative to that mount", async () => {
    const root = await temp();
    const mount = join(root, "mnt");
    await mkdir(join(mount, "media"), { recursive: true });
    const file = join(mount, "media", "a.mp4");
    await writeFile(file, "x");
    // Everything under `mount` is device 2; the rest is device 1.
    const deviceOf = async (path: string) => (path.startsWith(mount) ? 2 : 1);

    const result = await linuxTrash(deps(root, { deviceOf }))([file]);

    expect(result.failed).toEqual([]);
    expect(await readdir(join(mount, ".Trash-1000", "files"))).toEqual(["a.mp4"]);
    const info = await readFile(join(mount, ".Trash-1000", "info", "a.mp4.trashinfo"), "utf8");
    expect(info).toContain("Path=media/a.mp4\n");
  });

  it("reports a file it cannot move and still moves the others", async () => {
    const root = await temp();
    await mkdir(join(root, "dir.mp4"));
    const ok = join(root, "ok.mp4");
    await writeFile(ok, "x");
    const result = await linuxTrash(deps(root))([join(root, "dir.mp4"), ok]);
    expect(result.failed.map((f) => f.path)).toEqual([join(root, "dir.mp4")]);
    await expect(stat(ok)).rejects.toThrow();
  });
});
```

Linux tests run on Windows too: they use `join` paths and real files, and never rely on sticky bits (the `.Trash/$uid` branch is covered by code review, not a test, because it needs a real mount).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/core/trash.test.ts`
Expected: FAIL, "Cannot find module './trash.ts'".

- [ ] **Step 3: Implement**

Create `apps/desktop/src/core/trash.ts`:

```ts
import { spawn } from "node:child_process";
import { lstat, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";

export interface TrashResult {
  /** Paths that could not be moved, with a reason. Missing files are not failures. */
  failed: Array<{ path: string; message: string }>;
}

export type TrashFn = (paths: string[]) => Promise<TrashResult>;

/** Runs one program with data on stdin; resolves with its exit code and stdout. */
export type TrashRunner = (
  command: string,
  args: string[],
  stdin: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// --- Windows ---------------------------------------------------------------------------------

/**
 * Reads base64 UTF-8 JSON paths from stdin and recycles each with SHFileOperation, with no
 * dialogs. Only fixed drives have a Recycle Bin that FOF_ALLOWUNDO honors; anywhere else the call
 * would delete for good, so those paths are refused. Writes base64 UTF-8 JSON failures to stdout.
 */
export const WINDOWS_TRASH_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MediaForgeTrash {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT {
    public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo;
    public ushort fFlags; [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
    public IntPtr hNameMappings; public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  public static int Recycle(string path) {
    var op = new SHFILEOPSTRUCT();
    op.wFunc = 3; // FO_DELETE
    op.pFrom = path + "\\0\\0";
    // FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT
    op.fFlags = (ushort)(0x0040 | 0x0010 | 0x0400 | 0x0004);
    int code = SHFileOperation(ref op);
    return code != 0 ? code : (op.fAnyOperationsAborted ? -1 : 0);
  }
}
'@
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$failed = New-Object System.Collections.ArrayList
foreach ($p in @($text | ConvertFrom-Json)) {
  try {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    if (Test-Path -LiteralPath $p -PathType Container) { throw 'This is a folder, not a file.' }
    $drive = New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($p))
    if ($p.StartsWith('\\\\') -or $drive.DriveType -ne 'Fixed') {
      throw 'This drive has no Recycle Bin, so the file was left in place.'
    }
    $code = [MediaForgeTrash]::Recycle($p)
    if ($code -ne 0) { throw ('Windows could not move it to the Recycle Bin (code ' + $code + ').') }
    if (Test-Path -LiteralPath $p) { throw 'The file is in use.' }
  } catch {
    [void]$failed.Add(@{ path = $p; message = $_.Exception.Message })
  }
}
$json = ConvertTo-Json -InputObject @($failed) -Compress
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
`;

/** `powershell.exe` with the fixed script; no path or user text is part of the command line. */
export function windowsTrashCommand(): { command: string; args: string[] } {
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(WINDOWS_TRASH_SCRIPT, "utf16le").toString("base64"),
    ],
  };
}

const spawnRunner: TrashRunner = (command, args, stdin) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => resolve({ exitCode: -1, stdout, stderr: message(error) }));
    child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin);
  });

/** One PowerShell call per batch. */
export function windowsTrash(run: TrashRunner = spawnRunner): TrashFn {
  return async (paths) => {
    if (paths.length === 0) return { failed: [] };
    const { command, args } = windowsTrashCommand();
    const stdin = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
    const everyPath = (reason: string): TrashResult => ({
      failed: paths.map((path) => ({ path, message: reason })),
    });
    const { exitCode, stdout } = await run(command, args, stdin);
    if (exitCode !== 0) return everyPath("Could not reach the Windows Recycle Bin.");
    try {
      const parsed: unknown = JSON.parse(Buffer.from(stdout.trim(), "base64").toString("utf8"));
      if (!Array.isArray(parsed)) throw new Error("not a list");
      return {
        failed: parsed.map((item) => ({
          path: String((item as { path?: unknown }).path),
          message: String((item as { message?: unknown }).message),
        })),
      };
    } catch {
      return everyPath("Could not read the Windows Recycle Bin's answer.");
    }
  };
}

// --- Linux (freedesktop.org Trash specification 1.0) -----------------------------------------

export interface LinuxTrashDeps {
  env: Record<string, string | undefined>;
  home: string;
  uid: number;
  now: () => Date;
  /** Device id of an existing path; the default reads `stat().dev`. Tests fake other mounts. */
  deviceOf?: (path: string) => Promise<number>;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local time, `YYYY-MM-DDThh:mm:ss`, as the spec asks. */
const deletionDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;

/** Percent-encode each path segment, keeping the separators. */
const encodePath = (path: string) => path.split(sep).map(encodeURIComponent).join("/");

const isMissing = (error: unknown) => (error as { code?: string }).code === "ENOENT";

export function linuxTrash(deps: LinuxTrashDeps): TrashFn {
  const deviceOf = deps.deviceOf ?? (async (path: string) => (await stat(path)).dev);
  const homeTrash = join(deps.env.XDG_DATA_HOME || join(deps.home, ".local", "share"), "Trash");

  /** The closest existing folder at or above `path`. */
  const existingAncestor = async (path: string): Promise<string> => {
    let current = path;
    for (;;) {
      try {
        await stat(current);
        return current;
      } catch {
        const parent = dirname(current);
        if (parent === current) return current;
        current = parent;
      }
    }
  };

  /** The top folder of the mount holding `path`: climb while the device stays the same. */
  const mountTop = async (path: string, device: number): Promise<string> => {
    let current = dirname(path);
    for (;;) {
      const parent = dirname(current);
      if (parent === current || (await deviceOf(parent)) !== device) return current;
      current = parent;
    }
  };

  /** Which trash folder takes `file`, and the path to record in its trashinfo. */
  const trashFor = async (file: string): Promise<{ dir: string; recorded: string }> => {
    const device = await deviceOf(file);
    if ((await deviceOf(await existingAncestor(homeTrash))) === device) {
      return { dir: homeTrash, recorded: file };
    }
    const top = await mountTop(file, device);
    const shared = join(top, ".Trash");
    try {
      const info = await lstat(shared);
      // Usable only as a real, sticky folder; never through a symlink.
      if (info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o1000) !== 0) {
        return { dir: join(shared, String(deps.uid)), recorded: relative(top, file) };
      }
    } catch {
      // No shared trash on this mount: use the per-user one below.
    }
    return { dir: join(top, `.Trash-${deps.uid}`), recorded: relative(top, file) };
  };

  const moveOne = async (file: string): Promise<void> => {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(file);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (info.isDirectory()) throw new Error("This is a folder, not a file.");
    const { dir, recorded } = await trashFor(file);
    const filesDir = join(dir, "files");
    const infoDir = join(dir, "info");
    await mkdir(filesDir, { recursive: true, mode: 0o700 });
    await mkdir(infoDir, { recursive: true, mode: 0o700 });
    const name = basename(file);
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const body = `[Trash Info]\nPath=${encodePath(recorded)}\nDeletionDate=${deletionDate(deps.now())}\n`;
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${stem}.${n}${ext}`;
      const infoPath = join(infoDir, `${candidate}.trashinfo`);
      try {
        // Creating the info file exclusively reserves the name, as the spec asks.
        await writeFile(infoPath, body, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as { code?: string }).code === "EEXIST") continue;
        throw error;
      }
      try {
        await rename(file, join(filesDir, candidate));
      } catch (error) {
        await unlink(infoPath).catch(() => {});
        throw error;
      }
      return;
    }
  };

  return async (paths) => {
    const failed: TrashResult["failed"] = [];
    for (const path of paths) {
      try {
        await moveOne(path);
      } catch (error) {
        failed.push({ path, message: message(error) });
      }
    }
    return { failed };
  };
}

/** The trash for this platform. */
export function createTrash(platform: NodeJS.Platform = process.platform): TrashFn {
  if (platform === "win32") return windowsTrash();
  return linuxTrash({
    env: process.env,
    home: homedir(),
    uid: userInfo().uid,
    now: () => new Date(),
  });
}
```

`encodePath` splits on `sep`. On Linux that is `/`, as the spec needs. Under the Windows test runner `join` produces `\` paths, which `encodePath` splits on `\` and joins with `/`; the expected `Path=` line in the test builds the same string with `file.split("/")`, so on Windows replace that expectation with `file.split(sep)` if it fails there (keep the encoding rule, not the separator, as the thing tested).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/core/trash.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit message for the user**

```markdown
✨ move downloads to the Recycle Bin or the Trash

## Description

Deleting a download from the manager must be undoable. On Windows the
files go to the Recycle Bin through one hidden PowerShell call per
batch, with no dialogs, and drives without a Recycle Bin are refused
instead of deleted for good. On Linux the files go to the freedesktop
Trash, including the per-mount trash for other drives. Paths travel as
data, never as script text.

## Test

pnpm vitest run apps/desktop/src/core/trash.test.ts
```

---

### Task 5: Job control in the core service

**Files:**
- Modify: `apps/desktop/src/core/service.ts`
- Test: `apps/desktop/src/core/service.test.ts`

**Interfaces:**
- Consumes: messages from Task 1; `HistoryStore.remove`, `setNotice`, `HistoryJob.formatSelector/plan` (Task 2); `DownloadEngine.pause/resume/restore/remove` and paused-aware `cancel` (Task 3).
- Produces:
  - `CoreService` restores every `paused` and `failed` history row into the engine in its constructor.
  - `download.pause`, `download.resume`, `jobs.remove`, `jobs.clearFinished` replies: `jobs.result`.
  - `notice.dismiss` reply: `notice` `{}` to the asker; `notice` `{}` pushed to every other active client.
  - `download.paused` `{ jobId, progress }` pushed like other job frames.
  - After `jobs.remove` and `jobs.clearFinished`: a fresh `jobs.snapshot` pushed to every subscribed client.
  - The notice clears itself (with a `notice` `{}` push) once none of its job ids is still paused.
  - Error/failure texts: unknown id → `No such download.`; pause refused → `Only queued or running downloads can be paused.`; resume refused → `Only paused or failed downloads can be resumed.`

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/core/service.test.ts`. The file's `setup(options)` is async and returns `t` with `send`, `sent`, `fake` (the fake engine), `history`, `historyFs` and `update`; `startPayload` and `candidate` exist from phase 1. The fake engine needs the new methods: add to the object `fakeEngine` returns:

```ts
    pause: vi.fn((id: string) => known.has(id) && ["queued", "downloading", "processing"].includes(known.get(id)?.status ?? "")),
    resume: vi.fn((id: string) => ["paused", "failed"].includes(known.get(id)?.status ?? "")),
    restore: vi.fn(),
    remove: vi.fn(async () => {}),
```

where `known` stands for however the fake engine already tracks submitted jobs and their statuses (the helper `t.update(id, patch)` changes them); use the real structure. Then add:

```ts
const row = (id: string, status: string, extra: object = {}) => ({
  id,
  request: { candidate, profileId: "best" },
  status,
  progress: { bytesDownloaded: 0 },
  createdAt: 1,
  updatedAt: 1,
  files: [],
  ...extra,
});
const historyOf = (rows: object[], extra: object = {}) =>
  JSON.stringify({ version: 1, cleanExit: true, jobs: rows, ...extra });
const resultOf = (sent: HostToExtensionMessage[]) =>
  sent.find((m) => m.type === "jobs.result")?.payload;

describe("job control", () => {
  it("hands paused and failed rows back to the engine on start, with their format", async () => {
    const t = await setup({
      historyFile: historyOf([
        row("p", "paused", { formatSelector: "137+ba/137", plan: [{ kind: "video" }] }),
        row("f", "failed"),
        row("c", "completed"),
      ]),
    });
    const restored = t.fake.engine.restore.mock.calls.map(([job, options]) => [job.id, options]);
    expect(restored).toEqual([
      ["p", { formatSelector: "137+ba/137", plan: [{ kind: "video" }] }],
      ["f", {}],
    ]);
    // Core-only fields never reach the engine's job or the protocol.
    expect(t.fake.engine.restore.mock.calls[0]?.[0]).not.toHaveProperty("files");
  });

  it("remembers the format a terminal chose, so a resume can use it", async () => {
    const t = await setup({ role: "terminal" });
    await t.send(
      "download.start",
      startPayload({ formatSelector: "137+ba/137", plan: [{ kind: "video" }], outputDir: resolve("/dl") }),
    );
    expect(t.history.get("job-1")).toMatchObject({
      formatSelector: "137+ba/137",
      plan: [{ kind: "video" }],
    });
  });

  it("pauses a batch and reports unknown and refused ids once each", async () => {
    const t = await setup({ role: "terminal" });
    await t.send("download.start", startPayload());
    t.update("job-1", { status: "downloading" });
    await t.send("download.start", startPayload(), "r2");
    t.update("job-2", { status: "completed", outputPath: "/dl/a.mp4" });
    t.sent.length = 0;

    await t.send("download.pause", { jobIds: ["job-1", "job-1", "job-2", "nope"] });

    expect(t.fake.engine.pause).toHaveBeenCalledTimes(2);
    expect(resultOf(t.sent)).toEqual({
      failed: [
        { jobId: "job-2", message: "Only queued or running downloads can be paused." },
        { jobId: "nope", message: "No such download." },
      ],
    });
  });

  it("pushes download.paused when a job pauses", async () => {
    const t = await setup({ role: "terminal" });
    await t.send("download.start", startPayload());
    t.update("job-1", { status: "downloading", progress: { bytesDownloaded: 5, percent: 50 } });
    t.update("job-1", { status: "paused" });
    expect(t.sent.at(-1)).toMatchObject({
      type: "download.paused",
      payload: { jobId: "job-1", progress: { percent: 50 } },
    });
  });

  it("resumes paused and failed jobs and refuses the rest", async () => {
    const t = await setup({ historyFile: historyOf([row("p", "paused"), row("c", "completed")]) });
    // The fake engine learns restored rows through `restore`; mirror their status for `resume`.
    await t.send("download.resume", { jobIds: ["p", "c"] });
    expect(t.fake.engine.resume).toHaveBeenCalledWith("p");
    expect(resultOf(t.sent)).toEqual({
      failed: [{ jobId: "c", message: "Only paused or failed downloads can be resumed." }],
    });
  });

  it("removes rows, keeps their files, and pushes a fresh snapshot to subscribers", async () => {
    const t = await setup({
      historyFile: historyOf([row("a", "completed", { files: ["/dl/a.mp4"] }), row("b", "paused")]),
    });
    await t.send("jobs.subscribe");
    t.sent.length = 0;
    await t.send("jobs.remove", { jobIds: ["a", "b", "nope"] });
    expect(t.fake.engine.remove).toHaveBeenCalledWith("a");
    expect(t.fake.engine.remove).toHaveBeenCalledWith("b");
    expect(t.history.jobs()).toEqual([]);
    expect(resultOf(t.sent)).toEqual({ failed: [{ jobId: "nope", message: "No such download." }] });
    const snap = t.sent.find((m) => m.type === "jobs.snapshot");
    expect(snap?.type === "jobs.snapshot" && snap.payload.jobs).toEqual([]);
  });

  it("clears completed rows only", async () => {
    const t = await setup({
      historyFile: historyOf([row("a", "completed"), row("b", "failed"), row("c", "cancelled")]),
    });
    await t.send("jobs.clearFinished");
    expect(t.history.jobs().map((j) => j.id).sort()).toEqual(["b", "c"]);
    expect(resultOf(t.sent)).toEqual({ failed: [] });
  });

  it("dismisses the notice for everyone", async () => {
    const notice = { reason: "unexpected", pausedCount: 1, jobIds: ["p"] };
    const t = await setup({ historyFile: historyOf([row("p", "paused")], { notice }) });
    await t.send("notice.dismiss");
    expect(t.history.notice()).toBeUndefined();
    expect(t.sent.at(-1)).toMatchObject({ type: "notice", payload: {} });
  });

  it("clears the notice by itself once none of its jobs is paused", async () => {
    const notice = { reason: "unexpected", pausedCount: 1, jobIds: ["p"] };
    const t = await setup({ historyFile: historyOf([row("p", "paused")], { notice }) });
    await t.send("jobs.subscribe");
    t.update("p", { status: "queued" });
    expect(t.history.notice()).toBeUndefined();
    expect(t.sent.some((m) => m.type === "notice")).toBe(true);
  });

  it("cancels a paused job", async () => {
    const t = await setup({ historyFile: historyOf([row("p", "paused")]) });
    await t.send("download.cancel", { jobId: "p" });
    expect(t.fake.engine.cancel).toHaveBeenCalledWith("p");
  });
});
```

`t.update(id, patch)` must also work for restored rows: if the fake engine only knows jobs it submitted, make `restore` record the job in the same map so `update` can drive it. `resolve` comes from `node:path` (already imported in this file from phase 1).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/core/service.test.ts -t "job control"`
Expected: FAIL. The temporary `unsupported` case from Task 1 answers every new request.

- [ ] **Step 3: Implement**

In `apps/desktop/src/core/service.ts`:

`toProtocolJob` drops every core-only field, and a twin builds the engine's view:

```ts
const toProtocolJob = ({
  files: _files,
  workDir: _workDir,
  formatSelector: _formatSelector,
  plan: _plan,
  ...job
}: HistoryJob): DownloadJob => job;

const toEngineJob = (row: HistoryJob): EngineJob => toProtocolJob(row) as EngineJob;

const UNKNOWN = "No such download.";
```

Constructor, after `this.#engine = deps.createEngine(...)`:

```ts
    // Paused and failed jobs from earlier sessions can be resumed like this session's.
    for (const row of deps.history.jobs()) {
      if (row.status !== "paused" && row.status !== "failed") continue;
      this.#engine.restore(toEngineJob(row), {
        ...(row.formatSelector && { formatSelector: row.formatSelector }),
        ...(row.plan && { plan: row.plan }),
      });
    }
```

In `#start`, the row patch after `submit` also stores the format:

```ts
    const row = this.#deps.history.get(job.id);
    if (row) {
      this.#deps.history.upsert(
        {
          ...row,
          origin,
          ...(selector && { formatSelector: selector }),
          ...(plan && { plan }),
        },
        { save: true },
      );
    }
```

In `#record`, keep the core-only fields across updates. Replace the `files`/`workDir` lines of the row literal with:

```ts
      files: job.outputPath ? [job.outputPath] : (before?.files ?? []),
      ...((job.workDir ?? before?.workDir) && { workDir: job.workDir ?? before?.workDir }),
      ...(before?.formatSelector && { formatSelector: before.formatSelector }),
      ...(before?.plan && { plan: before.plan }),
```

(`...job` spreads `workDir` from the engine job too; the explicit line keeps the earlier value when the engine has none.)

In `#onJob`, after `this.#record(job);`, add `this.#settleNotice();`.

In `#sendJob`, replace the phase-1 `paused` branch:

```ts
    } else if (job.status === "paused") {
      this.#reply(state, id, "download.paused", { jobId: job.id, progress: job.progress });
```

Replace the temporary Task 1 case in `#dispatch` with:

```ts
      case "download.pause":
        return this.#batch(state, message.id, message.payload.jobIds, (jobId) =>
          this.#engine.pause(jobId) ? undefined : "Only queued or running downloads can be paused.",
        );
      case "download.resume":
        return this.#batch(state, message.id, message.payload.jobIds, (jobId) =>
          this.#engine.resume(jobId) ? undefined : "Only paused or failed downloads can be resumed.",
        );
      case "jobs.remove":
        await this.#batch(state, message.id, message.payload.jobIds, async (jobId) => {
          await this.#engine.remove(jobId);
          this.#deps.history.remove(jobId);
          return undefined;
        });
        return this.#afterRemoval();
      case "jobs.clearFinished": {
        for (const row of this.#deps.history.jobs()) {
          if (row.status !== "completed") continue;
          await this.#engine.remove(row.id);
          this.#deps.history.remove(row.id);
        }
        this.#reply(state, message.id, "jobs.result", { failed: [] });
        return this.#afterRemoval();
      }
      case "jobs.trash":
        // Task 6.
        return this.#error(state, message.id, "unsupported", "Not available yet.");
      case "notice.dismiss":
        this.#deps.history.setNotice(undefined);
        this.#reply(state, message.id, "notice", {});
        return this.#broadcast("notice", {}, state);
```

New private helpers:

```ts
  /**
   * Run `act` once per distinct id that history knows, and answer with one `jobs.result`. Unknown
   * ids fail with UNKNOWN; `act` returns a reason when it could not act on a known id.
   */
  async #batch(
    state: ClientState,
    id: string,
    jobIds: string[],
    act: (jobId: string) => string | undefined | Promise<string | undefined>,
  ): Promise<void> {
    const failed: { jobId: string; message: string }[] = [];
    for (const jobId of new Set(jobIds)) {
      const problem = this.#deps.history.get(jobId) ? await act(jobId) : UNKNOWN;
      if (problem) failed.push({ jobId, message: problem });
    }
    this.#reply(state, id, "jobs.result", { failed });
    this.#deps.onActivity();
  }

  /** Send a frame to every client that has spoken, except `skip`. */
  #broadcast<T extends HostToExtensionMessage["type"]>(
    type: T,
    payload: Extract<HostToExtensionMessage, { type: T }>["payload"],
    skip?: ClientState,
  ): void {
    for (const state of this.#clients) {
      if (state === skip || !state.active) continue;
      this.#reply(state, this.#deps.newId(), type, payload);
    }
  }

  /** Rows went away: subscribers get the new list, and the notice may no longer apply. */
  #afterRemoval(): void {
    for (const state of this.#clients) {
      if (!state.active || !state.subscribedAll) continue;
      const id = this.#deps.newId();
      this.#reply(state, id, "jobs.snapshot", { jobs: this.#snapshot(id) });
    }
    this.#settleNotice();
  }

  /** Clear the notice, for everyone, once none of the jobs it names is still paused. */
  #settleNotice(): void {
    const notice = this.#deps.history.notice();
    if (!notice) return;
    if (notice.jobIds.some((id) => this.#deps.history.get(id)?.status === "paused")) return;
    this.#deps.history.setNotice(undefined);
    this.#broadcast("notice", {});
  }
```

`download.cancel` needs no change: the engine's `cancel` now accepts paused jobs.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/core && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Restart-resume test against the real engine**

Add to `apps/desktop/src/core/job-watch.test.ts` (it drives a real `CoreService` and `DownloadEngine` through `inProcessCore`; reuse its `found`, `fs`, `payload` helpers and add a `HistoryStore` shared between two cores):

```ts
it("resumes a job paused in an earlier core session with its id, folder and format", async () => {
  const historyFs = memoryHistoryFs();
  const history = () => HistoryStore.open({ path: "/h/history.json", fs: historyFs, debounceMs: 0 });
  const seen: string[][] = [];
  const hang: ProcessRunner = (_c, args, _h, signal) =>
    new Promise((resolve) => {
      seen.push(args);
      signal.addEventListener("abort", () => resolve({ exitCode: 1 }));
    });

  // Session 1: start with an exact format, then the core goes away mid-download.
  const first = inProcessCore({
    history: await history(),
    createEngine: (onUpdate) => new DownloadEngine({ resolve: found, fs, onUpdate, run: hang }),
  });
  const watched = await startJob(await first.connect(), { ...payload(), formatSelector: "137+ba/137" }, () => {});
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  await (await first.service).shutdown(); // writes the file; the job is still "downloading" in it

  // Session 2: the row comes back paused and resumes under the same id.
  const second = inProcessCore({
    history: await history(),
    createEngine: (onUpdate) => new DownloadEngine({ resolve: found, fs, onUpdate, run: hang }),
  });
  const client = await second.connect();
  const reply = await client.request("download.resume", { jobIds: [watched.id] });
  expect(reply).toMatchObject({ type: "jobs.result", payload: { failed: [] } });
  await vi.waitFor(() => expect(seen).toHaveLength(2));
  expect(seen[1]?.join(" ")).toContain("137+ba/137");
  expect(seen[1]?.[seen[1].indexOf("--paths") + 1]).toBe(seen[0]?.[seen[0].indexOf("--paths") + 1]);
  await client.request("download.cancel", { jobId: watched.id }).catch(() => {});
});
```

`HistoryStore.open` turns the `downloading` row into `paused` because the file says it was running. Import `memoryHistoryFs`, `HistoryStore` from `./history.ts` and `vi` from vitest if missing. `download.cancel` gets no reply on success, so its rejection by timeout is caught; if the client's timeout makes the test slow, use `client.notify("download.cancel", …)` instead.

Run: `pnpm vitest run apps/desktop/src/core/job-watch.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit message for the user**

```markdown
✨ pause, resume, remove and clear jobs from any client

## Description

The core now answers the job-control requests: pause and resume
(retrying failed jobs too), remove, clear finished, and dismiss the
session notice. Paused and failed jobs from earlier sessions resume
like this session's, with the same id, folder and format. Clients
learn about pauses, removed rows and a cleared notice through pushes.

## Test

pnpm vitest run apps/desktop/src/core
```

---

### Task 6: Trash in the core service

**Files:**
- Modify: `apps/desktop/src/core/service.ts`, `apps/desktop/src/core/run-core.ts`, `apps/desktop/src/core/in-process.ts`
- Test: `apps/desktop/src/core/service.test.ts`

**Interfaces:**
- Consumes: `TrashFn`, `createTrash` (Task 4); `#batch`, `#afterRemoval` (Task 5).
- Produces: `CoreServiceDeps.trash: TrashFn`; `RunCoreDeps.trash?: TrashFn` (default `createTrash()`); `jobs.trash` handled: relay → `forbidden`; terminal → cancel or forget each job, one trash call for all their files, rows dropped unless one of their files failed.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/core/service.test.ts`, give `setup` a `trash` option and dependency:

```ts
interface SetupOptions {
  // ...existing fields...
  trash?: TrashFn;
}
```

and in `setup`, pass `trash: options.trash ?? (async () => ({ failed: [] }))` into `new CoreService({...})`. Import `type TrashFn` from `./trash.ts`. Then add:

```ts
describe("trash", () => {
  it("refuses the relay", async () => {
    const t = await setup({ historyFile: historyOf([row("a", "completed", { files: ["/dl/a.mp4"] })]) });
    await t.send("jobs.trash", { jobIds: ["a"] });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "forbidden" } });
    expect(t.history.get("a")).toBeDefined();
  });

  it("moves only the recorded files of each job, in one call, and drops the rows", async () => {
    const calls: string[][] = [];
    const t = await setup({
      role: "terminal",
      trash: async (paths) => {
        calls.push(paths);
        return { failed: [] };
      },
      historyFile: historyOf([
        row("a", "completed", { files: ["/dl/a.mp4"], outputPath: "/dl/a.mp4" }),
        row("b", "paused", { files: [], workDir: "/dl/.mediaforge-b" }),
      ]),
    });
    await t.send("jobs.trash", { jobIds: ["a", "b", "nope"] });
    expect(calls).toEqual([["/dl/a.mp4"]]);
    expect(t.fake.engine.remove).toHaveBeenCalledWith("b");
    expect(t.history.jobs()).toEqual([]);
    expect(resultOf(t.sent)).toEqual({ failed: [{ jobId: "nope", message: "No such download." }] });
  });

  it("keeps the row of a job whose file could not be moved", async () => {
    const t = await setup({
      role: "terminal",
      trash: async () => ({ failed: [{ path: "/dl/a.mp4", message: "The file is in use." }] }),
      historyFile: historyOf([
        row("a", "completed", { files: ["/dl/a.mp4"] }),
        row("b", "completed", { files: ["/dl/b.mp4"] }),
      ]),
    });
    await t.send("jobs.trash", { jobIds: ["a", "b"] });
    expect(t.history.jobs().map((j) => j.id)).toEqual(["a"]);
    expect(resultOf(t.sent)).toEqual({
      failed: [{ jobId: "a", message: "Could not move /dl/a.mp4 to the trash: The file is in use." }],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/core/service.test.ts -t trash`
Expected: FAIL. `jobs.trash` answers `unsupported` and the relay is not refused.

- [ ] **Step 3: Implement**

In `apps/desktop/src/core/service.ts`:

```ts
import type { TrashFn } from "./trash.ts";
```

`CoreServiceDeps` gains:

```ts
  /** Moves files to the Recycle Bin or the Trash. */
  trash: TrashFn;
```

Replace the Task 5 placeholder case:

```ts
      case "jobs.trash":
        if (state.role !== "terminal") return this.#forbidden(state, message.id);
        await this.#trash(state, message.id, message.payload.jobIds);
        return this.#afterRemoval();
```

and add:

```ts
  /**
   * Stop or forget each job, move every file it recorded to the trash in one call, and drop the
   * rows whose files all went. Only paths in a job's own `files` list are ever touched.
   */
  async #trash(state: ClientState, id: string, jobIds: string[]): Promise<void> {
    const history = this.#deps.history;
    const filesOf = new Map<string, string[]>();
    const failed: { jobId: string; message: string }[] = [];
    for (const jobId of new Set(jobIds)) {
      if (!history.get(jobId)) {
        failed.push({ jobId, message: UNKNOWN });
        continue;
      }
      await this.#engine.remove(jobId);
      filesOf.set(jobId, history.get(jobId)?.files ?? []);
    }
    const all = [...new Set([...filesOf.values()].flat())];
    const result = all.length > 0 ? await this.#deps.trash(all) : { failed: [] };
    const problems = new Map(result.failed.map((f) => [f.path, f.message]));
    for (const [jobId, files] of filesOf) {
      const stuck = files.find((file) => problems.has(file));
      if (stuck) {
        failed.push({
          jobId,
          message: `Could not move ${stuck} to the trash: ${problems.get(stuck)}`,
        });
        continue;
      }
      history.remove(jobId);
    }
    this.#reply(state, id, "jobs.result", { failed });
    this.#deps.onActivity();
  }
```

In `apps/desktop/src/core/run-core.ts`: import `{ createTrash, type TrashFn } from "./trash.ts"`; `RunCoreDeps` gains `/** Default: the platform's Recycle Bin or Trash. */ trash?: TrashFn;`; pass `trash: deps.trash ?? createTrash(),` into `new CoreService({...})`.

In `apps/desktop/src/core/in-process.ts`, add `trash: async () => ({ failed: [] }),` to the default deps (before `...deps`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/core && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit message for the user**

```markdown
✨ trash downloads from the core

## Description

Terminal clients can now delete downloads from disk: the core stops
or forgets each job, moves every file it recorded to the Recycle Bin
or the Trash in one call, and drops the rows. A locked file fails for
its own job only and keeps the row. The browser relay may not ask.

## Test

pnpm vitest run apps/desktop/src/core
```

---

### Task 7: Terminal watchers handle a paused job

**Files:**
- Modify: `apps/desktop/src/core/job-watch.ts`, `apps/desktop/src/download.ts`, `apps/desktop/src/interactive/App.tsx`, `apps/desktop/src/interactive/BatchFlow.tsx`
- Test: `apps/desktop/src/core/job-watch.test.ts`, `apps/desktop/src/download.test.ts`, `apps/desktop/src/interactive/App.test.tsx`

**Interfaces:**
- Consumes: `download.paused` push (Task 5).
- Produces: `applyFrame` folds `download.paused` into `status: "paused"` (with its progress); `startJob`'s `settled` resolves when the job is paused. CLI: a paused job prints `Paused. It can be resumed later from MediaForge.` to stderr and returns `ExitCode.Cancelled`. Menu: a paused single download shows the notice `Download paused` and goes back; a batch where every job ended cancelled or paused shows `Downloads paused` if any was paused, else `Downloads cancelled`.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/core/job-watch.test.ts`:

```ts
it("ends the watch when another client pauses the job", async () => {
  const { connect } = core(
    (_c, _a, _h, signal) =>
      new Promise((resolve) => signal.addEventListener("abort", () => resolve({ exitCode: 1 }))),
  );
  const watched = await startJob(await connect(), payload(), () => {});
  const other = await connect();
  await vi.waitFor(async () => {
    const reply = await other.request("download.pause", { jobIds: [watched.id] });
    expect(reply).toMatchObject({ payload: { failed: [] } });
  });
  expect((await watched.settled).status).toBe("paused");
});
```

In `apps/desktop/src/download.test.ts` (reuse `setup`; the in-process core is `t.deps.core`):

```ts
it("exits as cancelled when the download is paused from elsewhere", async () => {
  const hang: ProcessRunner = (_c, _a, _h, signal) =>
    new Promise((resolve) => signal.addEventListener("abort", () => resolve({ exitCode: 1 })));
  const t = setup(hang);
  const connect = t.deps.core;
  t.deps.core = async () => {
    const client = await connect();
    client.onPush((m) => {
      if (m.type === "download.progress" && m.payload.status === "downloading") {
        void connect().then((other) =>
          other.request("download.pause", { jobIds: [m.payload.jobId] }),
        );
      }
    });
    return client;
  };
  await expect(runDownload(["https://example.com/v"], t.io, t.deps)).resolves.toBe(
    ExitCode.Cancelled,
  );
  expect(t.stderr()).toMatch(/Paused\. It can be resumed later from MediaForge\./);
});
```

`t.stderr()` stands for however the file reads captured stderr (for example joined `t.io` writes); use the real helper. In `App.test.tsx`, add one test in the style of the phase-1 test "shows a failure when the core goes away during a download": start a download with a hanging runner, pause it through a second `t.core.connect()` client once the runner was called, and assert the home screen shows `Download paused`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/core/job-watch.test.ts apps/desktop/src/download.test.ts apps/desktop/src/interactive/App.test.tsx`
Expected: FAIL. The watcher ignores `download.paused` and never settles; the CLI hangs (vitest times out).

- [ ] **Step 3: Implement**

`apps/desktop/src/core/job-watch.ts`:

```ts
const jobIdOf = (message: HostToExtensionMessage): string | undefined =>
  message.type === "download.progress" ||
  message.type === "download.completed" ||
  message.type === "download.failed" ||
  message.type === "download.paused"
    ? message.payload.jobId
    : undefined;
```

`applyFrame` gains, before `default`:

```ts
    case "download.paused":
      return {
        ...job,
        status: "paused",
        ...(message.payload.progress && { progress: message.payload.progress }),
        updatedAt: now,
      };
```

and the watch ends on a pause:

```ts
/** States that end a watch. Paused: someone else stopped it; it continues only when resumed. */
const FINAL = new Set(["completed", "failed", "cancelled", "paused"]);
```

`apps/desktop/src/download.ts`, after the `cancelled` branch of `runDownload`:

```ts
    if (job.status === "paused") {
      io.stderr("Paused. It can be resumed later from MediaForge.\n");
      return ExitCode.Cancelled;
    }
```

`apps/desktop/src/interactive/App.tsx`, the `DownloadScreen` `onDone`:

```tsx
            onDone={(job) => {
              // The result page reports success and failure itself, so its notice shows only once
              // the user leaves it. A cancelled or paused download has no page: say so on the one
              // before.
              if (job.status === "cancelled") notices.notify("warn", "Download cancelled");
              else if (job.status === "paused") notices.notify("warn", "Download paused");
              else if (job.status === "completed") notices.notify("ok", "Download complete");
              else notices.notify("error", "Download failed");
              if (job.status === "cancelled" || job.status === "paused") nav.back();
              else nav.replace({ name: "result", plan: screen.plan, draft: screen.draft, job });
            }}
```

`apps/desktop/src/interactive/BatchFlow.tsx` (around line 210), replace the all-cancelled check:

```tsx
            const stopped = (j: EngineJob) => j.status === "cancelled" || j.status === "paused";
            if (jobs.length > 0 && jobs.every(stopped)) {
              notices.notify(
                "warn",
                jobs.some((j) => j.status === "paused") ? "Downloads paused" : "Downloads cancelled",
              );
```

keeping the rest of that branch as it is. Import `EngineJob` if the file does not already.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/core apps/desktop/src/download.test.ts apps/desktop/src/interactive && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit message for the user**

```markdown
🐛 stop waiting when a watched download is paused elsewhere

## Description

Once the manager can pause any job, a CLI or menu download may be
paused while its terminal watches it. The CLI now ends with the
cancelled exit code and a hint that the job can be resumed, and the
menu goes back with a "Download paused" notice, instead of waiting
forever.

## Test

pnpm vitest run apps/desktop/src/core/job-watch.test.ts apps/desktop/src/download.test.ts
```

---

### Task 8: Extension job mirror understands pauses

**Files:**
- Modify: `apps/extension/src/background/job-mirror.ts`
- Test: `apps/extension/src/background/job-mirror.test.ts`

**Interfaces:**
- Consumes: `download.paused` (Task 1).
- Produces: the mirror shows a paused row from `download.paused`; a row the user cleared comes back when a progress frame or a snapshot shows its job queued, downloading or processing again. `TERMINAL` (late-frame guard) and `CLEARABLE` keep their phase-1 meaning.

- [ ] **Step 1: Write the failing tests**

Add to `apps/extension/src/background/job-mirror.test.ts`, using the file's existing helpers `msg(type, payload)` and `row(id, status)`:

```ts
it("shows a paused job from the paused push", () => {
  const mirror = createJobMirror();
  mirror.apply(msg("download.progress", { jobId: "a", status: "downloading", progress: { bytesDownloaded: 5, percent: 40 } }));
  expect(mirror.apply(msg("download.paused", { jobId: "a", progress: { bytesDownloaded: 5, percent: 40 } }))).toBe(true);
  expect(mirror.list()[0]).toMatchObject({ id: "a", status: "paused", percent: 40 });
});

it("brings back a cleared paused job once it runs again", () => {
  const mirror = createJobMirror();
  mirror.apply(msg("download.paused", { jobId: "a" }));
  mirror.clearFinished();
  expect(mirror.list()).toEqual([]);
  mirror.apply(msg("download.progress", { jobId: "a", status: "queued", progress: { bytesDownloaded: 0 } }));
  expect(mirror.list().map((j) => j.id)).toEqual(["a"]);
});

it("keeps a cleared completed job hidden from later snapshots", () => {
  const mirror = createJobMirror();
  mirror.apply(msg("download.completed", { jobId: "a", outputPath: "/a.mp4" }));
  mirror.clearFinished();
  mirror.apply(msg("jobs.snapshot", { jobs: [row("a", "completed")] }));
  expect(mirror.list()).toEqual([]);
});
```


- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/extension/src/background/job-mirror.test.ts`
Expected: FAIL. `download.paused` returns false; the cleared job stays hidden.

- [ ] **Step 3: Implement**

In `apps/extension/src/background/job-mirror.ts`:

```ts
/** A job that is queued or running; a cleared row comes back when its job is one again. */
const RUNNING = new Set(["queued", "downloading", "processing"]);
```

In `merge`, replace `if (cleared.has(id)) return false;` with:

```ts
    if (cleared.has(id)) {
      // Cleared while paused, then resumed: show it again.
      if (!patch.status || !RUNNING.has(patch.status)) return false;
      cleared.delete(id);
    }
```

In the `jobs.snapshot` case, replace `if (cleared.has(job.id)) continue;` with:

```ts
            if (cleared.has(job.id)) {
              if (!RUNNING.has(job.status)) continue;
              cleared.delete(job.id);
            }
```

Add a case before `default`:

```ts
        case "download.paused": {
          const { jobId, progress } = message.payload;
          return merge(jobId, {
            status: "paused",
            ...(progress?.percent !== undefined && { percent: progress.percent }),
            speed: undefined,
          });
        }
```

If `exactOptionalPropertyTypes` rejects `speed: undefined`, drop that line and instead delete `speed` from the merged row for paused jobs in `merge` (`if (next.status === "paused") delete next.speed;`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/extension && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit message for the user**

```markdown
✨ extension: show paused downloads in the popup list

## Description

The core now pushes a pause when a user stops a job. The popup's job
list shows it as paused instead of stuck downloading, and a paused job
the user cleared comes back once it runs again.

## Test

pnpm vitest run apps/extension/src/background/job-mirror.test.ts
```

---

### Task 9: Manual checklist

**Files:**
- Modify: `docs/desktop-cli-checklist.md`

- [ ] **Step 1: Add the phase 2 checks**

Append a section, using the file's heading level and checkbox style:

```markdown
## Job control (downloads manager phase 2)

Phase 2 has no buttons yet: send the requests with a small script through `CoreClient` (terminal role), or wait for the manager in phase 3.

- [ ] Pause a large real download: yt-dlp stops, `.mediaforge-<id>` keeps its `.part` file, the row is paused.
- [ ] Resume it: the same id continues from the partial file (the byte count does not restart at 0).
- [ ] Kill the core during a download, start it again, resume the paused job: it continues in the same folder with the same format.
- [ ] A failed download (pull the network cable) keeps its partial file; resume retries and continues.
- [ ] Cancel a paused job: its `.mediaforge-<id>` folder is gone.
- [ ] Remove a completed job: the row goes, the file stays.
- [ ] Trash a completed job on Windows: the file is in the Recycle Bin and restores to its folder.
- [ ] Trash a file that is open in a video player on Windows: the job is reported as failed, the row stays, no dialog appears.
- [ ] Trash a file on a USB stick or network drive on Windows: refused with "no Recycle Bin"; the file stays.
- [ ] Trash a completed job on Linux: the file is in the desktop's Trash and restores to its folder.
- [ ] Trash a file on another mount on Linux: it lands in that mount's `.Trash-<uid>` and the file manager's Trash shows it.
- [ ] Dismiss the notice: `history.json` has no `notice`, and a new popup or terminal does not see it.
- [ ] Resume every job a notice named: the notice clears by itself.
- [ ] Pause a `mediaforge download` job from another client: the CLI prints the paused hint and exits 130.
```

- [ ] **Step 2: Commit message for the user**

```markdown
📝 add manual checks for pausing, resuming and trashing downloads

## Test

Read through docs/desktop-cli-checklist.md
```
