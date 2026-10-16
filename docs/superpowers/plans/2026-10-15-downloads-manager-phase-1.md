# Downloads Manager, Phase 1: History and Core-Owned Jobs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every MediaForge download (extension, interactive menu, CLI) runs inside the background core and is recorded in a persistent `history.json`; jobs interrupted by a core exit come back as `paused` with a session notice.

**Architecture:** The core becomes the only owner of `DownloadEngine` and of a new `HistoryStore`. Terminal programs (the interactive menu and `mediaforge download`) become IPC clients through a new `CoreClient`, connecting over the existing named pipe or socket with a `terminal` role declared in the handshake. The browser relay declares `relay`, so it keeps today's restrictions. The protocol version is bumped once for all the shape changes.

**Tech Stack:** TypeScript (Node 24, ESM), zod 4, vitest, Ink 8 + React 19, Biome, pnpm workspaces.

**Spec:** [docs/superpowers/specs/2026-10-15-downloads-manager-design.md](../specs/2026-10-15-downloads-manager-design.md). This plan covers the spec's phase 1 only.

## Global Constraints

- Platforms: Windows and Linux. No macOS-specific code.
- The core is the only writer of `history.json`. The file lives beside the settings file (`config.json`): `%APPDATA%\MediaForge\history.json` on Windows, `$XDG_CONFIG_HOME/mediaforge/history.json` on Linux.
- History writes are atomic (temp file, then rename) and debounced to about 1 s. Progress ticks are not written; status changes are.
- A history file that fails to parse is renamed `history.json.bak` and the core starts with an empty list. A `version` newer than 1 is left untouched and the core runs without saving history.
- Jobs `queued`, `downloading` or `processing` when the core last stopped come back as `paused`. Nothing auto-resumes.
- Notice reason: `unexpected` when the last session had no clean exit; `restarted` when it exited cleanly with jobs still active.
- Connection role: `relay` or `terminal`, sent in handshake step 4. A missing or unknown role means `relay`.
- Relay connections keep today's rules. Only terminal connections may send `formatSelector`, `plan`, an output folder outside the saved folder, or `settings.reload`. Relay connections that try get error code `forbidden`.
- `mediaforge download` Ctrl+C cancels the job. Exit codes are unchanged for scripts.
- "Downloads at once" applies live: on the core's settings poll and on `settings.reload`. Running jobs are never stopped.
- `PROTOCOL_VERSION` goes from 2 to 3.
- Repo rules: never run `git commit`. Each task's last step prints a commit message for the user, in the format from `CLAUDE.md`. Run `pnpm exec biome check --write <paths>` on files changed through Bash. Run `pnpm lint` before finishing.

## Review Focus

1. **Write failure (disk full, file locked by antivirus).** The core must keep running and keep the history in memory, and retry on the next change. Test in Task 3.
2. **Second core instance.** A core that loses the pipe race must not open or rewrite `history.json`. Test in Task 6.
3. **Core cannot start or be reached.** `mediaforge download` must fail within the connect deadline with a clear message and `ExitCode.Failure`, not hang. Test in Task 8.
4. **Core dies while a terminal watches a job.** The CLI exits non-zero with "lost connection", and the menu shows a failure instead of spinning forever. Tests in Tasks 8 and 9.
5. **Older core still running after an update.** A terminal that gets `invalid-message` on `hello` must say the background service is a different version, not show raw zod text. Test in Task 7.

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `packages/shared-types/src/steps.ts` | Create | `StepKind`, `StepState`, `Step`, `PlannedStep` (moved from the engine). |
| `packages/shared-types/src/download.ts` | Modify | `paused` status, `JobOrigin`, `Notice`, new optional `DownloadJob` fields. |
| `packages/shared-types/src/index.ts` | Modify | Export `steps.ts`. |
| `packages/shared-protocol/src/schemas.ts` | Modify | Schemas for the above. |
| `packages/shared-protocol/src/messages.ts` | Modify | `hello.client`, `download.start` extras, progress and failed extras, `hello.ack.notice`, `settings.reload`. |
| `packages/shared-protocol/src/version.ts` | Modify | `PROTOCOL_VERSION = 3`. |
| `apps/desktop/src/engine/steps.ts` | Modify | Re-export step types from shared-types. |
| `apps/desktop/src/engine/engine.ts` | Modify | `setMaxConcurrent`. `EngineJob` slimmed to `DownloadJob & { errorKind?: ExitCode }`. |
| `apps/desktop/src/core/ipc.ts` | Modify | Role in handshake. |
| `apps/desktop/src/core/history.ts` | Create | `HistoryStore`: load, recover, debounced atomic save, `.bak`, read-only mode. |
| `apps/desktop/src/core/service.ts` | Modify | History-backed snapshot, origins, role rules, notice, `settings.reload`, `shutdown()`. |
| `apps/desktop/src/core/run-core.ts` | Modify | Open history after winning the pipe, mark clean exit, apply concurrency on poll, pass role. |
| `apps/desktop/src/core/relay.ts` | Modify | Connect with `role: "relay"`. |
| `apps/desktop/src/core/connect.ts` | Create | `connectWithAutostart`, `defaultCoreConnector`. |
| `apps/desktop/src/core/client.ts` | Create | `CoreClient`: hello, request/reply, pushes, close. |
| `apps/desktop/src/core/job-watch.ts` | Create | `startJob`: submit, fold frames into an `EngineJob`, settle, cancel. |
| `apps/desktop/src/core/in-process.ts` | Create | `inProcessCore`: a real `CoreService` behind an in-memory connection, for tests. |
| `apps/desktop/src/download.ts` | Modify | CLI submits through the core. |
| `apps/desktop/src/interactive/screens/DownloadScreen.tsx` | Modify | Watch a core job. |
| `apps/desktop/src/interactive/screens/batch/BatchDownloadScreen.tsx` | Modify | Watch core jobs; no own concurrency. |
| `apps/desktop/src/interactive/BatchFlow.tsx` | Modify | Stop passing `concurrency`. |
| `apps/desktop/src/interactive/screens/SettingsScreen.tsx` | Modify | Send `settings.reload` after saving. |
| `apps/desktop/src/interactive/start.tsx` | Modify | Real connectors in `realDeps`. |
| `apps/extension/src/background/native-client.ts` | Modify | Send `client: "extension"` in `hello`. |
| `docs/desktop-cli-checklist.md` | Modify | Manual checks for phase 1. |

---

### Task 1: Protocol and shared types

**Files:**
- Create: `packages/shared-types/src/steps.ts`
- Modify: `packages/shared-types/src/download.ts`, `packages/shared-types/src/index.ts`
- Modify: `packages/shared-protocol/src/schemas.ts`, `packages/shared-protocol/src/messages.ts`, `packages/shared-protocol/src/version.ts`
- Modify: `apps/desktop/src/engine/steps.ts`, `apps/desktop/src/engine/engine.ts:25-32`
- Modify: `apps/extension/src/background/native-client.ts` (hello payload)
- Test: `packages/shared-protocol/src/parse.test.ts`

**Interfaces:**
- Produces (types, from `@mediaforge/shared-types`):
  - `DownloadStatus` gains `"paused"`.
  - `type JobOrigin = "extension" | "manager" | "menu" | "cli"`.
  - `interface Notice { reason: "unexpected" | "restarted"; pausedCount: number; jobIds: string[] }`.
  - `StepKind`, `StepState`, `Step`, `PlannedStep` (same shapes as today's `apps/desktop/src/engine/steps.ts`).
  - `DownloadJob` gains optional `origin`, `lastTryAt`, `sizeBytes`, `avgSpeed`, `steps`, `overallPercent`, `errorKind: number`.
- Produces (protocol, from `@mediaforge/shared-protocol`): `PROTOCOL_VERSION === 3`; schemas `JobOriginSchema`, `NoticeSchema`, `StepSchema`, `PlannedStepSchema`; message `SettingsReloadMessage` (`"settings.reload"`, payload `{}`); `hello.payload.client` (defaults to `"extension"`; `extensionVersion` and `browser` become optional); `download.start.payload` gains optional `origin`, `formatSelector`, `plan`; `download.progress.payload` gains optional `steps`, `overallPercent`; `download.failed.payload` gains optional `errorKind`; `hello.ack.payload` gains optional `notice`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared-protocol/src/parse.test.ts`:

```ts
describe("protocol v3", () => {
  const env = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "1", type, payload });

  it("is version 3", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });

  it("defaults hello.client to extension and accepts a terminal hello", () => {
    const ext = parseExtensionMessage(env("hello", { extensionVersion: "1", browser: "firefox" }));
    expect(ext.ok && ext.value.type === "hello" && ext.value.payload.client).toBe("extension");
    const cli = parseExtensionMessage(env("hello", { client: "cli" }));
    expect(cli.ok).toBe(true);
  });

  it("accepts download.start with origin, formatSelector and plan", () => {
    const parsed = parseExtensionMessage(
      env("download.start", {
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
        origin: "menu",
        formatSelector: "137+ba/137",
        plan: [{ kind: "video", bytes: 10 }, { kind: "audio" }, { kind: "merge" }],
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("accepts settings.reload", () => {
    expect(parseExtensionMessage(env("settings.reload", {})).ok).toBe(true);
  });

  it("accepts a paused job in a snapshot and a notice in hello.ack", () => {
    const job = {
      id: "j",
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
      status: "paused",
      progress: { bytesDownloaded: 5, percent: 50 },
      createdAt: 1,
      updatedAt: 2,
      origin: "cli",
      lastTryAt: 1,
      errorKind: 4,
    };
    expect(parseHostMessage(env("jobs.snapshot", { jobs: [job] })).ok).toBe(true);
    const ack = parseHostMessage(
      env("hello.ack", {
        hostVersion: "1",
        ytDlp: { available: true },
        ffmpeg: { available: true },
        setup: "ready",
        keepRunning: false,
        notice: { reason: "unexpected", pausedCount: 1, jobIds: ["j"] },
      }),
    );
    expect(ack.ok).toBe(true);
  });

  it("carries steps on progress and errorKind on failure", () => {
    expect(
      parseHostMessage(
        env("download.progress", {
          jobId: "j",
          status: "downloading",
          progress: { bytesDownloaded: 1 },
          steps: [{ kind: "download", state: "active", percent: 10 }],
          overallPercent: 10,
        }),
      ).ok,
    ).toBe(true);
    expect(
      parseHostMessage(env("download.failed", { jobId: "j", error: "x", errorKind: 6 })).ok,
    ).toBe(true);
  });
});
```

Make sure `PROTOCOL_VERSION`, `parseExtensionMessage` and `parseHostMessage` are imported at the top of the file (add them to the existing import if missing).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/shared-protocol/src/parse.test.ts`
Expected: FAIL. `expected 2 to be 3`, plus parse failures for the new fields.

- [ ] **Step 3: Move the step types into shared-types**

Create `packages/shared-types/src/steps.ts`:

```ts
import type { DownloadProgress } from "./download.ts";

/**
 * One part of a download:
 * - "download": a single file that already has picture and sound
 * - "video" / "audio": separate streams that are merged afterwards (or a stream on its own)
 * - "merge": ffmpeg joining video and audio
 * - "convert": ffmpeg converting (audio extraction, re-encoding)
 */
export type StepKind = "download" | "video" | "audio" | "merge" | "convert";

export type StepState = "pending" | "active" | "done";

export interface Step {
  kind: StepKind;
  state: StepState;
  /** 0 to 100; unknown while a size or length is not reported yet. */
  percent?: number;
  /** Bytes, speed and ETA, for download steps. */
  progress?: DownloadProgress;
  /** Expected size in bytes, from the format list, used to weigh the overall bar. */
  expectedBytes?: number;
}

/** A step known before the download starts, from the chosen format. */
export interface PlannedStep {
  kind: StepKind;
  bytes?: number;
}
```

In `apps/desktop/src/engine/steps.ts`, delete the local `StepKind`, `StepState`, `Step` and `PlannedStep` declarations (and their doc comments) and replace them with:

```ts
import type { PlannedStep, Step, StepKind } from "@mediaforge/shared-types";

export type { PlannedStep, Step, StepKind, StepState } from "@mediaforge/shared-types";
```

Keep the existing `DownloadProgress` and `./progress.ts` imports only if the file still uses them.

Add to `packages/shared-types/src/index.ts`:

```ts
export type * from "./steps.ts";
```

- [ ] **Step 4: Extend the download types**

In `packages/shared-types/src/download.ts`, add the import at the top and replace `DownloadStatus` and `DownloadJob`:

```ts
import type { Step } from "./steps.ts";

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "processing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** Where a download was started. */
export type JobOrigin = "extension" | "manager" | "menu" | "cli";

/** Says the last core session ended with downloads still running, which are now paused. */
export interface Notice {
  /** "unexpected": no clean exit (crash, kill, power loss). "restarted": clean exit, e.g. an update. */
  reason: "unexpected" | "restarted";
  pausedCount: number;
  jobIds: string[];
}

export interface DownloadJob {
  id: string;
  request: DownloadRequest;
  status: DownloadStatus;
  progress: DownloadProgress;
  outputPath?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  origin?: JobOrigin;
  /** When the job last started downloading. */
  lastTryAt?: number;
  /** Final size, or the expected size while running. */
  sizeBytes?: number;
  /** Average speed of the finished download, in bytes per second. */
  avgSpeed?: number;
  /** Download, merge and convert steps, in order. */
  steps?: Step[];
  /** 0 to 100 across all steps. */
  overallPercent?: number;
  /** The CLI exit code matching a failure. */
  errorKind?: number;
}
```

In `apps/desktop/src/engine/engine.ts`, replace the `EngineJob` interface (lines 25-32) with:

```ts
export interface EngineJob extends DownloadJob {
  /** Exit code matching the failure, set when `status` is "failed". */
  errorKind?: ExitCode;
}
```

- [ ] **Step 5: Update the schemas**

In `packages/shared-protocol/src/schemas.ts`:

Add `JobOrigin`, `Notice`, `PlannedStep` and `Step` to the `@mediaforge/shared-types` type import. Then replace `DownloadStatusSchema` and `DownloadJobSchema`, and add the new schemas, so the section reads:

```ts
export const DownloadStatusSchema = z.enum([
  "queued",
  "downloading",
  "processing",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const JobOriginSchema = z.enum(["extension", "manager", "menu", "cli"]);

const StepKindSchema = z.enum(["download", "video", "audio", "merge", "convert"]);

export const StepSchema = z.object({
  kind: StepKindSchema,
  state: z.enum(["pending", "active", "done"]),
  percent: z.number().min(0).max(100).optional(),
  progress: DownloadProgressSchema.optional(),
  expectedBytes: z.number().nonnegative().optional(),
});

export const PlannedStepSchema = z.object({
  kind: StepKindSchema,
  bytes: z.number().nonnegative().optional(),
});

/** A job has a handful of steps; the cap keeps a hostile frame small. */
const MAX_STEPS = 16;

export const DownloadJobSchema = z.object({
  id: z.string(),
  request: DownloadRequestSchema,
  status: DownloadStatusSchema,
  progress: DownloadProgressSchema,
  outputPath: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  origin: JobOriginSchema.optional(),
  lastTryAt: z.number().optional(),
  sizeBytes: z.number().nonnegative().optional(),
  avgSpeed: z.number().nonnegative().optional(),
  steps: z.array(StepSchema).max(MAX_STEPS).optional(),
  overallPercent: z.number().min(0).max(100).optional(),
  errorKind: z.number().int().optional(),
});

export const NoticeSchema = z.object({
  reason: z.enum(["unexpected", "restarted"]),
  pausedCount: z.number().int().nonnegative(),
  jobIds: z.array(z.string()),
});
```

`StepSchema` uses `DownloadProgressSchema`, so it must come after it. Extend `_SchemaChecks`:

```ts
export type _SchemaChecks = [
  Assert<Equals<z.infer<typeof MediaVariantSchema>, MediaVariant>>,
  Assert<Equals<z.infer<typeof MediaCandidateSchema>, MediaCandidate>>,
  Assert<Equals<z.infer<typeof DownloadRequestSchema>, DownloadRequest>>,
  Assert<Equals<z.infer<typeof DownloadProgressSchema>, DownloadProgress>>,
  Assert<Equals<z.infer<typeof DownloadJobSchema>, DownloadJob>>,
  Assert<Equals<z.infer<typeof JobOriginSchema>, JobOrigin>>,
  Assert<Equals<z.infer<typeof NoticeSchema>, Notice>>,
  Assert<Equals<z.infer<typeof StepSchema>, Step>>,
  Assert<Equals<z.infer<typeof PlannedStepSchema>, PlannedStep>>,
];
```

Export `MAX_STEPS` if `messages.ts` needs it (Step 6 does).

- [ ] **Step 6: Update the messages**

In `packages/shared-protocol/src/messages.ts`, import the new schemas (`JobOriginSchema`, `NoticeSchema`, `PlannedStepSchema`, `StepSchema`, `MAX_STEPS`) and change these definitions:

```ts
export const HelloMessage = message(
  "hello",
  z.object({
    /** Who is talking. The core trusts the connection's handshake role, not this field. */
    client: JobOriginSchema.default("extension"),
    extensionVersion: z.string().optional(),
    browser: z.enum(["chrome", "firefox", "edge"]).optional(),
  }),
);
export const DownloadStartMessage = message(
  "download.start",
  DownloadRequestSchema.extend({
    context: RequestContextSchema.optional(),
    origin: JobOriginSchema.optional(),
    /** Terminal connections only: an exact yt-dlp format selector. */
    formatSelector: z.string().min(1).max(200).optional(),
    /** Terminal connections only: the steps expected for the chosen format. */
    plan: z.array(PlannedStepSchema).max(MAX_STEPS).optional(),
  }),
);
/** Terminal connections only: re-read the settings file and apply "downloads at once". */
export const SettingsReloadMessage = message("settings.reload", z.object({}));
```

```ts
export const HelloAckMessage = message(
  "hello.ack",
  z.object({
    hostVersion: z.string(),
    ytDlp: z.object({ available: z.boolean(), version: z.string().optional() }),
    ffmpeg: z.object({ available: z.boolean(), version: z.string().optional() }),
    setup: SetupStateSchema,
    keepRunning: z.boolean(),
    notice: NoticeSchema.optional(),
  }),
);
```

```ts
export const DownloadProgressMessage = message(
  "download.progress",
  jobRef.extend({
    status: z.enum(["queued", "downloading", "processing"]),
    progress: DownloadProgressSchema,
    steps: z.array(StepSchema).max(MAX_STEPS).optional(),
    overallPercent: z.number().min(0).max(100).optional(),
  }),
);
```

```ts
export const DownloadFailedMessage = message(
  "download.failed",
  jobRef.extend({
    error: z.string(),
    cancelled: z.boolean().optional(),
    /** The CLI exit code matching the failure. */
    errorKind: z.number().int().optional(),
  }),
);
```

Add `SettingsReloadMessage` to the `ExtensionToHostMessage` union.

Set `packages/shared-protocol/src/version.ts` to:

```ts
/** Bump when a message shape changes incompatibly. */
export const PROTOCOL_VERSION = 3;
```

- [ ] **Step 7: Send the client name from the extension**

In `apps/extension/src/background/native-client.ts`, change the hello payload sent in `open()`:

```ts
    send(
      "hello",
      {
        client: "extension",
        extensionVersion: options.extensionVersion,
        browser: options.browser,
      },
      helloId,
    );
```

- [ ] **Step 8: Run the tests and the type check**

Run: `pnpm vitest run packages/shared-protocol && pnpm typecheck`
Expected: the protocol tests PASS. `tsc -b` reports errors where code switches over `DownloadStatus` exhaustively, or where `CoreService.#start` now receives `origin`, `formatSelector` and `plan` in its destructured request. For every error outside `apps/desktop/src/core/service.ts`, fix it now. Show `paused` as the word "Paused" wherever a status gets a label, and treat it like `cancelled` wherever code asks "is this job still running". In `service.ts`, strip the new fields so the request type still fits `DownloadRequest`. Task 5 uses them:

```ts
    const { context, outputDir: requestedDir, origin, formatSelector: _fs, plan: _plan, ...request } =
      message.payload;
    void origin;
```

Then run: `pnpm typecheck && pnpm test`
Expected: PASS. Tests that assert `PROTOCOL_VERSION === 2` or hello payloads without `client` need their expected values updated to the new shape. Change only the expected values, not the behavior.

- [ ] **Step 9: Commit message for the user**

```markdown
🏷️ shared-protocol: add paused status, job origin and session notice

## Description

The downloads manager needs one job shape for every client: a paused
status, where a job came from, its steps and its exit code, plus a
notice when the last core session ended with downloads running. All
shape changes land in one protocol bump, so the extension and the exe
change version together once.

## Test

pnpm vitest run packages/shared-protocol && pnpm typecheck

BREAKING CHANGE: PROTOCOL_VERSION is now 3; an older extension shows the incompatible state until updated
```

---

### Task 2: Connection role in the IPC handshake

**Files:**
- Modify: `apps/desktop/src/core/ipc.ts` (`ListenOptions`, `listenCore`, `ConnectOptions`, `connectCore`)
- Modify: `apps/desktop/src/core/relay.ts:237` (`runDefaultRelay`)
- Test: `apps/desktop/src/core/ipc.test.ts`

**Interfaces:**
- Produces: `export type ConnectionRole = "relay" | "terminal"`. `ListenOptions.onConnection: (conn: Connection, role: ConnectionRole) => void`. `ConnectOptions.role?: ConnectionRole` (default `"relay"`).

- [ ] **Step 1: Write the failing tests**

Add to `apps/desktop/src/core/ipc.test.ts`. Reuse the file's existing `testPath`, `servers` and `connect` helpers:

```ts
describe("connection role", () => {
  const serve = async (token: string, roles: string[]) => {
    const path = testPath();
    const server = await listenCore({
      path,
      token,
      onConnection: (_conn, role) => roles.push(role),
    });
    servers.push(server);
    return path;
  };

  it("reports the role the client declared", async () => {
    const token = newToken();
    const roles: string[] = [];
    const path = await serve(token, roles);
    await connect({ path, token, role: "terminal" });
    await connect({ path, token, role: "relay" });
    await vi.waitFor(() => expect(roles).toEqual(["terminal", "relay"]));
  });

  it("treats a client that declares no role as a relay", async () => {
    const token = newToken();
    const roles: string[] = [];
    const path = await serve(token, roles);
    await connect({ path, token });
    await vi.waitFor(() => expect(roles).toEqual(["relay"]));
  });

  it("treats an unknown role as a relay", async () => {
    const token = newToken();
    const roles: string[] = [];
    const path = await serve(token, roles);
    await connect({ path, token, role: "admin" as never });
    await vi.waitFor(() => expect(roles).toEqual(["relay"]));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/core/ipc.test.ts -t "connection role"`
Expected: FAIL. `roles` stays `[undefined, undefined]` or the type check fails on `role`.

- [ ] **Step 3: Implement**

In `apps/desktop/src/core/ipc.ts`, add `ConnectionRole` and `roleOf`, and change the handshake comment, `ListenOptions`, `listenCore` and `connectCore`:

```ts
/**
 * Who is on the other end. The relay carries frames from the browser, so it gets the extension's
 * limits; a terminal is the user's own program. The client states it in step 4, below the protocol,
 * so nothing a page or extension sends can change it.
 */
export type ConnectionRole = "relay" | "terminal";

const roleOf = (value: unknown): ConnectionRole =>
  typeof value === "object" &&
  value !== null &&
  (value as { role?: unknown }).role === "terminal"
    ? "terminal"
    : "relay";
```

In the handshake comment, change step 4 to:

```
 *   4. client -> core  { proof: HMAC(token, "client|" + nonceS + "|" + nonceC), role }
```

and add after the list: ` * \`role\` is "relay" or "terminal"; anything else, or none, counts as "relay".`

`ListenOptions`:

```ts
  /** Called once per authenticated client, with the role it stated in the handshake. */
  onConnection: (conn: Connection, role: ConnectionRole) => void;
```

In `listenCore`, make `authenticate` return the role (or `undefined` on failure):

```ts
  const authenticate = async (socket: net.Socket): Promise<ConnectionRole | undefined> => {
    const hello = await readFrame(socket, HANDSHAKE_MAX_BYTES);
    const nonceC = hexField(hello.message, "hello");
    if (nonceC === undefined) return undefined;
    const nonceS = newNonce();
    socket.write(
      encodeMessage({ proof: coreProof(token, nonceC), nonce: nonceS }, HANDSHAKE_MAX_BYTES),
    );
    const reply = await readFrame(socket, HANDSHAKE_MAX_BYTES);
    if (!proofMatches(hexField(reply.message, "proof"), clientProof(token, nonceS, nonceC))) {
      return undefined;
    }
    return roleOf(reply.message);
  };
```

and in the server callback:

```ts
      authenticate(socket).then(
        (role) => {
          clearTimeout(timer);
          if (role === undefined || socket.destroyed) {
            socket.destroy();
            return;
          }
          const conn = wrapSocket(socket);
          conn.send({ ok: true });
          onConnection(conn, role);
        },
```

`ConnectOptions` gains:

```ts
  /** The role stated in the handshake. Defaults to "relay", the least trusted. */
  role?: ConnectionRole;
```

In `connectCore`, destructure `role = "relay"` and send it with the proof:

```ts
      socket.write(
        encodeMessage({ proof: clientProof(token, nonceS, nonceC), role }, HANDSHAKE_MAX_BYTES),
      );
```

In `apps/desktop/src/core/relay.ts` `runDefaultRelay`, pass the role explicitly:

```ts
      return connectCore({ path, token, timeoutMs: 1000, role: "relay" });
```

In `apps/desktop/src/core/run-core.ts`, change the `onConnection` callback signature to `(conn, role)` and, for now, ignore `role` (`void role;`). Task 6 uses it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/core/ipc.test.ts apps/desktop/src/core/relay.test.ts apps/desktop/src/core/run-core.test.ts`
Expected: PASS. Existing tests that hand-build the step 4 frame without `role` still pass, because no role means relay.

- [ ] **Step 5: Commit message for the user**

```markdown
🔒️ state the connection role in the core handshake

## Description

Terminal programs will send the core requests the browser must never
be allowed to make (any folder, a raw format selector). The role rides
in the authenticated handshake, below the protocol, so a page or the
extension cannot claim it. No role means relay, the least trusted.

## Test

pnpm vitest run apps/desktop/src/core/ipc.test.ts
```


---

### Task 3: History store

**Files:**
- Create: `apps/desktop/src/core/history.ts`
- Test: `apps/desktop/src/core/history.test.ts`

**Interfaces:**
- Consumes: `DownloadJob`, `Notice` from `@mediaforge/shared-types`; `DownloadJobSchema`, `NoticeSchema` from `@mediaforge/shared-protocol`; `settingsPath` from `../settings.ts`.
- Produces:
  - `export type HistoryJob = DownloadJob & { files: string[]; workDir?: string }`
  - `export interface HistoryFs { readFile(path: string): Promise<string>; writeFile(path: string, data: string): Promise<void>; rename(from: string, to: string): Promise<void> }`
  - `export function historyPath(env: Record<string, string | undefined>, platform?: NodeJS.Platform, home?: string): string`
  - `export function memoryHistoryFs(files?: Record<string, string>): HistoryFs & { files: Map<string, string> }`
  - `export class HistoryStore` with `static open(options: HistoryOptions): Promise<HistoryStore>`, `readonly readOnly: boolean`, `jobs(): HistoryJob[]`, `get(id: string): HistoryJob | undefined`, `upsert(job: HistoryJob, options: { save: boolean }): void`, `notice(): Notice | undefined`, `markRunning(): Promise<void>`, `close(): Promise<void>`, `flush(): Promise<void>`
  - `interface HistoryOptions { path: string; fs: HistoryFs; debounceMs?: number; onError?: (error: unknown) => void }`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/core/history.test.ts`:

```ts
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
      "/home/a/.config/mediaforge/history.json",
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/core/history.test.ts`
Expected: FAIL, "Cannot find module './history.ts'".

- [ ] **Step 3: Implement**

Create `apps/desktop/src/core/history.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DownloadJobSchema, NoticeSchema } from "@mediaforge/shared-protocol";
import type { DownloadJob, Notice } from "@mediaforge/shared-types";
import { z } from "zod";
import { settingsPath } from "../settings.ts";

/** A job as the core remembers it: the protocol job plus what only the core may see. */
export type HistoryJob = DownloadJob & {
  /** Every file the job wrote. The only paths a later delete may touch. */
  files: string[];
  /** Folder holding partial files while paused. */
  workDir?: string;
};

export interface HistoryFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface HistoryOptions {
  path: string;
  fs: HistoryFs;
  /** Wait this long after a change before writing. Default 1000 ms. */
  debounceMs?: number;
  /** Told about read and write failures; the store keeps going without them. */
  onError?: (error: unknown) => void;
}

const VERSION = 1;
const DEFAULT_DEBOUNCE_MS = 1000;
const ACTIVE = new Set(["queued", "downloading", "processing"]);

const HistoryJobSchema = DownloadJobSchema.extend({
  files: z.array(z.string()).default([]),
  workDir: z.string().optional(),
});

const HeaderSchema = z.object({
  version: z.number().int(),
  cleanExit: z.boolean().default(true),
  notice: NoticeSchema.optional(),
  jobs: z.array(z.unknown()).default([]),
});

/** `history.json`, in the same folder as the settings file. */
export function historyPath(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return join(dirname(settingsPath(env, platform, home)), "history.json");
}

const realFs: HistoryFs = {
  readFile: (path) => readFile(path, "utf8"),
  // The folder may not exist before the first write.
  writeFile: async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, "utf8");
  },
  rename,
};

export const defaultHistoryFs = (): HistoryFs => realFs;

/** An in-memory file system, for tests. `files` holds what was written. */
export function memoryHistoryFs(
  initial: Record<string, string> = {},
): HistoryFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    writeFile: async (path, data) => void files.set(path, data),
    rename: async (from, to) => {
      const text = files.get(from);
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files.delete(from);
      files.set(to, text);
    },
  };
}

interface Loaded {
  jobs: HistoryJob[];
  cleanExit: boolean;
  notice: Notice | undefined;
  readOnly: boolean;
}

async function load(options: HistoryOptions): Promise<Loaded> {
  const empty: Loaded = { jobs: [], cleanExit: true, notice: undefined, readOnly: false };
  let text: string;
  try {
    text = await options.fs.readFile(options.path);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") options.onError?.(error);
    return empty;
  }
  let header: z.infer<typeof HeaderSchema>;
  try {
    header = HeaderSchema.parse(JSON.parse(text));
  } catch (error) {
    options.onError?.(error);
    // Keep the broken file for a human to look at; start over beside it.
    await options.fs.rename(options.path, `${options.path}.bak`).catch(options.onError);
    return empty;
  }
  if (header.version > VERSION) {
    options.onError?.(
      new Error(`history.json is version ${header.version}; this MediaForge reads ${VERSION}.`),
    );
    return { ...empty, readOnly: true };
  }
  const jobs: HistoryJob[] = [];
  for (const raw of header.jobs) {
    const parsed = HistoryJobSchema.safeParse(raw);
    if (parsed.success) jobs.push(parsed.data as HistoryJob);
  }
  return { jobs, cleanExit: header.cleanExit, notice: header.notice, readOnly: false };
}

/**
 * Every download the core knows about, kept in `history.json`. Only the core writes it. Changes
 * apply in memory at once; saving is debounced, atomic (temp file, then rename), and a failed write
 * is retried on the next change.
 */
export class HistoryStore {
  readonly readOnly: boolean;
  readonly #options: HistoryOptions;
  readonly #jobs = new Map<string, HistoryJob>();
  #notice: Notice | undefined;
  #cleanExit = true;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** The write in progress, so writes never overlap. */
  #writing: Promise<void> = Promise.resolve();
  #dirty = false;

  private constructor(options: HistoryOptions, loaded: Loaded) {
    this.#options = options;
    this.readOnly = loaded.readOnly;
    for (const job of loaded.jobs) this.#jobs.set(job.id, job);
    this.#notice = loaded.notice;
    // Jobs that were running when the core stopped come back paused, never auto-resumed.
    const paused: string[] = [];
    for (const job of this.#jobs.values()) {
      if (!ACTIVE.has(job.status)) continue;
      job.status = "paused";
      paused.push(job.id);
    }
    if (paused.length > 0) {
      this.#notice = {
        reason: loaded.cleanExit ? "restarted" : "unexpected",
        pausedCount: paused.length,
        jobIds: paused,
      };
      this.#dirty = true;
    }
  }

  static async open(options: HistoryOptions): Promise<HistoryStore> {
    return new HistoryStore(options, await load(options));
  }

  jobs(): HistoryJob[] {
    return [...this.#jobs.values()].map((job) => ({ ...job }));
  }

  get(id: string): HistoryJob | undefined {
    const job = this.#jobs.get(id);
    return job && { ...job };
  }

  /** Add or replace a job. `save: false` keeps it in memory only (progress ticks). */
  upsert(job: HistoryJob, options: { save: boolean }): void {
    this.#jobs.set(job.id, { ...job });
    if (options.save) this.#schedule();
  }

  notice(): Notice | undefined {
    return this.#notice;
  }

  /** Written at once on start: a crash from here on is "unexpected". */
  async markRunning(): Promise<void> {
    this.#cleanExit = false;
    this.#dirty = true;
    await this.flush();
  }

  /** Written on a normal shutdown. */
  async close(): Promise<void> {
    this.#cleanExit = true;
    this.#dirty = true;
    await this.flush();
  }

  /** Write now if a save is pending. */
  async flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#write();
  }

  #schedule(): void {
    this.#dirty = true;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#write();
    }, this.#options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  #write(): Promise<void> {
    this.#writing = this.#writing.then(async () => {
      if (this.readOnly || !this.#dirty) return;
      this.#dirty = false;
      const body = JSON.stringify({
        version: VERSION,
        cleanExit: this.#cleanExit,
        ...(this.#notice && { notice: this.#notice }),
        jobs: [...this.#jobs.values()],
      });
      const temp = `${this.#options.path}.tmp`;
      try {
        await this.#options.fs.writeFile(temp, body);
        await this.#options.fs.rename(temp, this.#options.path);
      } catch (error) {
        // Stay dirty, so the next change tries again.
        this.#dirty = true;
        this.#options.onError?.(error);
      }
    });
    return this.#writing;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/core/history.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit message for the user**

```markdown
✨ add a persistent download history to the core

## Description

The downloads manager lists every download across restarts, so the
core needs a record that survives it. The store writes atomically and
debounced, never crashes the core on a bad disk, sets aside a corrupt
file, refuses to overwrite a newer format, and turns downloads that
were running when the core stopped into paused ones with a notice.

## Test

pnpm vitest run apps/desktop/src/core/history.test.ts
```

---

### Task 4: Live concurrency in the engine

**Files:**
- Modify: `apps/desktop/src/engine/engine.ts` (`#maxConcurrent`, new `setMaxConcurrent`)
- Test: `apps/desktop/src/engine/engine.test.ts`

**Interfaces:**
- Produces: `DownloadEngine.setMaxConcurrent(n: number): void`. Clamps to at least 1, starts queued jobs if the limit went up, and never stops running jobs.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/engine/engine.test.ts`. Use the file's existing helpers (`request()`, `found`, `fs`). This runner blocks until released:

```ts
describe("setMaxConcurrent", () => {
  it("starts more queued jobs when raised, and never stops running ones when lowered", async () => {
    const releases: (() => void)[] = [];
    const engine = new DownloadEngine({
      resolve: found,
      fs,
      maxConcurrent: 1,
      run: () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ exitCode: 1 }));
        }),
    });
    const ids = [1, 2, 3].map(() => engine.submit(request()).id);
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    engine.setMaxConcurrent(3);
    await vi.waitFor(() => expect(releases).toHaveLength(3));

    engine.setMaxConcurrent(1);
    expect(ids.map((id) => engine.get(id)?.status)).toEqual([
      "downloading",
      "downloading",
      "downloading",
    ]);
    for (const release of releases) release();
    await Promise.all(ids.map((id) => engine.whenSettled(id)));
  });

  it("treats values below 1 as 1", () => {
    const engine = new DownloadEngine({ resolve: found, fs });
    expect(() => engine.setMaxConcurrent(0)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/desktop/src/engine/engine.test.ts -t setMaxConcurrent`
Expected: FAIL, "engine.setMaxConcurrent is not a function".

- [ ] **Step 3: Implement**

In `apps/desktop/src/engine/engine.ts`, drop `readonly` from `#maxConcurrent` and add after `cancel`:

```ts
  /** Change how many jobs run at once. Raising it starts queued jobs; lowering it stops none. */
  setMaxConcurrent(n: number): void {
    this.#maxConcurrent = Math.max(1, Math.floor(n));
    this.#pump();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/engine/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit message for the user**

```markdown
✨ let the engine change downloads-at-once while running

## Description

Once the core owns every download, a changed "downloads at once" must
apply without restarting it. Raising the limit starts queued jobs at
once; lowering it only holds back new ones.

## Test

pnpm vitest run apps/desktop/src/engine/engine.test.ts
```

---

### Task 5: Core service on history, roles and notice

**Files:**
- Modify: `apps/desktop/src/core/service.ts`
- Test: `apps/desktop/src/core/service.test.ts`

**Interfaces:**
- Consumes: `HistoryStore`, `memoryHistoryFs`, `HistoryJob` (Task 3); `ConnectionRole` (Task 2); `DownloadEngine.setMaxConcurrent` (Task 4); protocol fields (Task 1).
- Produces:
  - `CoreServiceDeps.history: HistoryStore`
  - `CoreService.attach(client: ServiceClient, role?: ConnectionRole): ClientHandle` (default `"relay"`)
  - `CoreService.applySettings(): Promise<void>`: reads settings and calls `engine.setMaxConcurrent(settings.concurrency)`.
  - `CoreService.shutdown(): Promise<void>`: `history.close()`.
  - Error code `forbidden` for terminal-only requests from a relay.

Behavior to implement:
1. `#onJob` writes every engine update into history. Origin comes from a `#origins` map filled in `#start`. `lastTryAt` is set when the status changes to `downloading`. `sizeBytes` comes from `progress.totalBytes` when known. On `completed`: `files = [outputPath]`, and `avgSpeed = sizeBytes / seconds since lastTryAt` when both are known and positive. The row is saved when the status changed, and kept in memory only otherwise.
2. `#snapshot` reads `history.jobs()` instead of `engine.list()`. Same newest-200 and byte cap.
3. `#openFolder` looks the job up in history, so jobs from earlier sessions still open.
4. `hello.ack` includes `notice` when there is one.
5. `#start`:
   - Relay connections that send `formatSelector` or `plan` get `forbidden`.
   - Relay connections keep today's folder rule and the sort-by-type folder.
   - Terminal connections must send an absolute `outputDir` when they send one. It is used as given, with no sort folder added, because the terminal already chose its subfolder.
   - Terminal `formatSelector` and `plan` go to `engine.submit`.
   - Origin is `"extension"` for relays whatever the payload says. For terminals it's `payload.origin ?? "cli"`.
6. `settings.reload`: relay gets `forbidden`. Terminal: `applySettings()`, then reply `settings.value` like `settings.get`.
7. Pushes carry `steps` and `overallPercent` on `download.progress`, and `errorKind` on `download.failed`.

- [ ] **Step 1: Update the test harness**

In `apps/desktop/src/core/service.test.ts`, extend `SetupOptions` and `setup()`:

```ts
import { HistoryStore, memoryHistoryFs } from "./history.ts";
import type { ConnectionRole } from "./ipc.ts";
```

```ts
interface SetupOptions {
  // ...existing fields...
  role?: ConnectionRole;
  /** Raw history.json content to start from. */
  historyFile?: string;
}
```

`setup` becomes `async`, because the store opens asynchronously. Every existing `const t = setup(...)` becomes `const t = await setup(...)`. This is a mechanical change across the file:

```ts
async function setup(options: SetupOptions = {}) {
  // ...existing lines up to `const settings = memorySettingsStore(options.settings);`...
  const historyFs = memoryHistoryFs(
    options.historyFile ? { "/h/history.json": options.historyFile } : {},
  );
  const history = await HistoryStore.open({ path: "/h/history.json", fs: historyFs, debounceMs: 0 });
  const service = new CoreService({
    // ...existing deps...
    history,
  });
  const sent: HostToExtensionMessage[] = [];
  const handle = service.attach({ send: (m) => sent.push(m) }, options.role);
  // ...rest unchanged...
  return { /* existing fields */, history, historyFs };
}
```

Add `setMaxConcurrent: vi.fn()` to the object returned by `fakeEngine`.

- [ ] **Step 2: Write the failing tests**

Append to `apps/desktop/src/core/service.test.ts`:

```ts
const startPayload = (extra: object = {}) => ({ candidate, profileId: "best", ...extra });

describe("history", () => {
  it("records a started job with its origin and saves status changes", async () => {
    const t = await setup({ role: "terminal" });
    await t.send("download.start", startPayload({ origin: "menu", outputDir: resolve("/dl") }));
    t.advance(1000);
    t.update("job-1", { status: "downloading" });
    expect(t.history.get("job-1")).toMatchObject({ origin: "menu", lastTryAt: expect.any(Number) });
  });

  it("forces origin extension for relay connections", async () => {
    const t = await setup();
    await t.send("download.start", startPayload({ origin: "cli" }));
    expect(t.history.get("job-1")?.origin).toBe("extension");
  });

  it("records the file and average speed of a finished job", async () => {
    const t = await setup({ role: "terminal" });
    await t.send("download.start", startPayload());
    t.update("job-1", { status: "downloading" });
    t.update("job-1", { progress: { bytesDownloaded: 500, totalBytes: 1000 } });
    t.advance(2000);
    t.update("job-1", { status: "completed", outputPath: "/dl/a.mp4", updatedAt: 0 });
    const row = t.history.get("job-1");
    expect(row).toMatchObject({ files: ["/dl/a.mp4"], sizeBytes: 1000 });
    expect(row?.avgSpeed).toBeGreaterThan(0);
  });

  it("lists jobs from earlier sessions in the snapshot", async () => {
    const old = {
      id: "old",
      request: { candidate, profileId: "best" },
      status: "completed",
      progress: { bytesDownloaded: 0 },
      createdAt: 1,
      updatedAt: 1,
      files: [],
    };
    const t = await setup({
      historyFile: JSON.stringify({ version: 1, cleanExit: true, jobs: [old] }),
    });
    await t.send("jobs.list");
    const snap = t.sent.find((m) => m.type === "jobs.snapshot");
    expect(snap?.type === "jobs.snapshot" && snap.payload.jobs.map((j) => j.id)).toEqual(["old"]);
  });

  it("sends the session notice in hello.ack", async () => {
    const running = {
      id: "r",
      request: { candidate, profileId: "best" },
      status: "downloading",
      progress: { bytesDownloaded: 0 },
      createdAt: 1,
      updatedAt: 1,
      files: [],
    };
    const t = await setup({
      historyFile: JSON.stringify({ version: 1, cleanExit: false, jobs: [running] }),
    });
    await t.send("hello", { client: "extension" });
    expect(t.sent[0]).toMatchObject({
      type: "hello.ack",
      payload: { notice: { reason: "unexpected", pausedCount: 1, jobIds: ["r"] } },
    });
  });
});

describe("roles", () => {
  it("refuses a format selector or plan from the relay", async () => {
    const t = await setup();
    await t.send("download.start", startPayload({ formatSelector: "137" }));
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "forbidden" } });
    await t.send("download.start", startPayload({ plan: [{ kind: "download" }] }), "r2");
    expect(t.sent[1]).toMatchObject({ type: "error", payload: { code: "forbidden" } });
    expect(t.fake.submitted).toHaveLength(0);
  });

  it("passes a terminal's selector, plan and folder through unchanged", async () => {
    const t = await setup({ role: "terminal", settings: { sortByType: true } });
    const dir = resolve("/anywhere/Video");
    await t.send(
      "download.start",
      startPayload({ formatSelector: "137+ba/137", plan: [{ kind: "video" }], outputDir: dir }),
    );
    expect(t.fake.submitted[0]).toMatchObject({ outputDir: dir });
    expect(t.fake.submitOptions[0]).toMatchObject({
      formatSelector: "137+ba/137",
      plan: [{ kind: "video" }],
    });
  });

  it("refuses a relative folder from a terminal", async () => {
    const t = await setup({ role: "terminal" });
    await t.send("download.start", startPayload({ outputDir: "relative/dir" }));
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "invalid-output-dir" } });
  });

  it("refuses settings.reload from the relay and applies it for a terminal", async () => {
    const relay = await setup({ settings: { concurrency: 3 } });
    await relay.send("settings.reload");
    expect(relay.sent[0]).toMatchObject({ type: "error", payload: { code: "forbidden" } });

    const term = await setup({ role: "terminal", settings: { concurrency: 3 } });
    await term.send("settings.reload");
    expect(term.fake.engine.setMaxConcurrent).toHaveBeenCalledWith(3);
    expect(term.sent[0]?.type).toBe("settings.value");
  });
});

describe("push extras", () => {
  it("carries steps on progress and errorKind on failure", async () => {
    const t = await setup({ role: "terminal" });
    await t.send("download.start", startPayload());
    t.update("job-1", {
      status: "downloading",
      steps: [{ kind: "download", state: "active", percent: 5 }],
      overallPercent: 5,
    });
    expect(progressFrames(t.sent).at(-1)).toMatchObject({
      payload: { steps: [{ kind: "download" }], overallPercent: 5 },
    });
    t.update("job-1", { status: "failed", error: "nope", errorKind: 6 });
    expect(t.sent.at(-1)).toMatchObject({ type: "download.failed", payload: { errorKind: 6 } });
  });
});

describe("shutdown", () => {
  it("records a clean exit", async () => {
    const t = await setup();
    await t.history.markRunning();
    await t.service.shutdown();
    expect(JSON.parse(t.historyFs.files.get("/h/history.json") as string).cleanExit).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/core/service.test.ts`
Expected: the new tests FAIL (missing `history` dep, `forbidden` not produced, `shutdown` undefined). Existing tests pass after the harness change.

- [ ] **Step 4: Implement**

In `apps/desktop/src/core/service.ts`:

Imports:

```ts
import { isAbsolute, resolve } from "node:path";
import type { DownloadJob, JobOrigin } from "@mediaforge/shared-types";
import type { HistoryJob, HistoryStore } from "./history.ts";
import type { ConnectionRole } from "./ipc.ts";
```

`CoreServiceDeps` gains:

```ts
  /** Every job, across sessions. The service writes each engine update into it. */
  history: HistoryStore;
```

`ClientState` gains `role: ConnectionRole;`. The service gains:

```ts
  /** Where each job of this session was started. */
  readonly #origins = new Map<string, JobOrigin>();
```

`toProtocolJob` takes a `HistoryJob` and drops the core-only fields:

```ts
const toProtocolJob = ({ files: _files, workDir: _workDir, ...job }: HistoryJob): DownloadJob =>
  job;
```

`attach`:

```ts
  /** Registers a client. Sends nothing: the client speaks first. */
  attach(client: ServiceClient, role: ConnectionRole = "relay"): ClientHandle {
    const state: ClientState = {
      client,
      role,
      active: false,
      subscribedAll: false,
      jobs: new Set(),
    };
```

New public methods:

```ts
  /** Re-read the settings and apply the ones that take effect live. */
  async applySettings(): Promise<void> {
    const settings = await this.#deps.settings.load();
    this.#engine.setMaxConcurrent(settings.concurrency);
  }

  /** Record a clean exit. Called once, when the core shuts down normally. */
  async shutdown(): Promise<void> {
    await this.#deps.history.close();
  }
```

Add to `#dispatch`:

```ts
      case "settings.reload":
        if (state.role !== "terminal") return this.#forbidden(state, message.id);
        await this.applySettings();
        return this.#sendSettings(state, message.id);
```

```ts
  #forbidden(state: ClientState, id: string): void {
    this.#error(state, id, "forbidden", "Only MediaForge itself may ask for this.");
  }
```

`#snapshot`: replace the `this.#engine.list()` source with `this.#deps.history.jobs()`. Keep the rest unchanged.

`#openFolder`: replace `const job = this.#engine.get(jobId);` with `const job = this.#deps.history.get(jobId);`.

`#hello`: add the notice to the ack payload:

```ts
    const notice = this.#deps.history.notice();
    this.#reply(state, id, "hello.ack", {
      hostVersion: this.#deps.version,
      ytDlp,
      ffmpeg,
      setup: this.#deps.provisioner.status().state,
      keepRunning: settings.keepRunning,
      ...(notice && { notice }),
    });
```

`#start`: replace the destructuring line from Task 1 and add the role checks before any other validation:

```ts
    const {
      context,
      outputDir: requestedDir,
      origin: askedOrigin,
      formatSelector: terminalSelector,
      plan,
      ...request
    } = message.payload;
    const terminal = state.role === "terminal";
    if (!terminal && (terminalSelector !== undefined || plan !== undefined)) {
      this.#forbidden(state, message.id);
      return;
    }
```

After `const settings = await this.#deps.settings.load();`, compute the output folder per role. The terminal branch is new; the relay branch is today's code moved into `else`:

```ts
    let outputDir: string | undefined;
    if (terminal) {
      if (requestedDir !== undefined && !isAbsolute(requestedDir)) {
        this.#error(state, message.id, "invalid-output-dir", "The folder must be a full path.");
        return;
      }
      // A terminal already chose its type subfolder; the folder is used as given.
      outputDir = requestedDir;
    } else {
      // `||`, not `??`: an empty string means "no folder chosen" in both modes.
      let base = settings.folder || undefined;
      if (requestedDir) {
        const problem = outputDirError(
          process.platform,
          requestedDir,
          settings.folder || defaultOutputDir(),
        );
        if (problem) {
          this.#error(state, message.id, "invalid-output-dir", problem);
          return;
        }
        base = resolve(requestedDir);
      }
      outputDir = settings.sortByType
        ? withKindFolder(
            base || defaultOutputDir(),
            request.subtitle ? "subtitles" : kindOfProfile(profile),
            true,
          )
        : base;
    }
    const selector = terminal ? terminalSelector : formatSelector;
    const job = this.#engine.submit(
      { ...request, profileId, ...(outputDir && { outputDir }) },
      {
        ...(selector && { formatSelector: selector }),
        ...(plan && { plan }),
        ...(context && { context }),
      },
    );
```

The engine reports the job from inside `submit`, before `#origins` is set. So set the origin by pre-registering it. Generate nothing new: record it right after `submit` and patch the history row, which `#onJob` already wrote:

```ts
    const origin: JobOrigin = terminal ? (askedOrigin ?? "cli") : "extension";
    this.#origins.set(job.id, origin);
    const row = this.#deps.history.get(job.id);
    if (row) this.#deps.history.upsert({ ...row, origin }, { save: true });
    state.jobs.add(job.id);
    this.#sendJob(state, job, message.id);
```

`#onJob`: write history first, then do the existing throttled fan-out:

```ts
  #record(job: EngineJob): void {
    const history = this.#deps.history;
    const before = history.get(job.id);
    const origin = this.#origins.get(job.id) ?? before?.origin;
    const startedNow = job.status === "downloading" && before?.status !== "downloading";
    const lastTryAt = startedNow ? this.#deps.now() : before?.lastTryAt;
    const sizeBytes = job.progress.totalBytes ?? before?.sizeBytes;
    const row: HistoryJob = {
      ...job,
      ...(origin && { origin }),
      ...(lastTryAt !== undefined && { lastTryAt }),
      ...(sizeBytes !== undefined && { sizeBytes }),
      files: job.outputPath ? [job.outputPath] : (before?.files ?? []),
      ...(before?.workDir && { workDir: before.workDir }),
    };
    if (job.status === "completed" && sizeBytes && lastTryAt !== undefined) {
      const seconds = (this.#deps.now() - lastTryAt) / 1000;
      if (seconds > 0) row.avgSpeed = sizeBytes / seconds;
    }
    history.upsert(row, { save: before?.status !== job.status });
  }

  #onJob(job: EngineJob): void {
    this.#record(job);
    if (TERMINAL.has(job.status)) {
      this.#lastProgress.delete(job.id);
      this.#origins.delete(job.id);
    } else {
      // ...existing throttle code unchanged...
    }
    // ...existing fan-out unchanged...
  }
```

`#sendJob`: add the extras:

```ts
    } else if (job.status === "failed") {
      this.#reply(state, id, "download.failed", {
        jobId: job.id,
        error: job.error ?? "Download failed.",
        ...(job.errorKind !== undefined && { errorKind: job.errorKind }),
      });
```

```ts
    } else {
      this.#reply(state, id, "download.progress", {
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        ...(job.steps && { steps: job.steps }),
        ...(job.overallPercent !== undefined && { overallPercent: job.overallPercent }),
      });
    }
```

The engine never reports `paused` in phase 1, but the type now allows it. Give it a fan-out branch that sends nothing:

```ts
    } else if (job.status === "paused") {
      // Phase 2 adds `download.paused`; nothing pauses a running job before then.
      return;
    } else {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/core/service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit message for the user**

```markdown
✨ back the core's job list with history and client roles

## Description

The core now records every job it runs, lists jobs from earlier
sessions, and tells clients when the last session ended with downloads
paused. Terminal connections may choose any folder and an exact format
for the menu and CLI; the relay keeps the extension's limits and is
refused anything more.

## Test

pnpm vitest run apps/desktop/src/core/service.test.ts
```

---

### Task 6: Wire history, roles and live settings into the running core

**Files:**
- Modify: `apps/desktop/src/core/run-core.ts`
- Test: `apps/desktop/src/core/run-core.test.ts`

**Interfaces:**
- Consumes: `HistoryStore.open`, `historyPath`, `defaultHistoryFs` (Task 3); `CoreService.attach(client, role)`, `applySettings()`, `shutdown()` (Task 5).
- Produces: `RunCoreDeps.historyFile: string` and `RunCoreDeps.historyFs?: HistoryFs`.

Behavior:
- History opens only after `listenCore` succeeds. A second instance that gets `EADDRINUSE` returns before touching the file.
- `markRunning()` runs right after opening.
- `onConnection(conn, role)` passes `role` to `service.attach`.
- Every poll tick calls `live.applySettings()`. Failures are ignored.
- `finish()` waits for `live.shutdown()` (the clean-exit write) before settling. The existing grace timer still bounds it.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/core/run-core.test.ts`, add `historyFile: "/h/history.json"` and `historyFs: memoryHistoryFs()` to the default deps in the existing `launch` helper, then add:

```ts
describe("history", () => {
  it("records running on start and a clean exit on shutdown", async () => {
    const historyFs = memoryHistoryFs();
    const stop = new AbortController();
    const done = launch({ historyFs, shutdown: stop.signal });
    await vi.waitFor(() =>
      expect(JSON.parse(historyFs.files.get("/h/history.json") ?? "{}").cleanExit).toBe(false),
    );
    stop.abort();
    await done;
    expect(JSON.parse(historyFs.files.get("/h/history.json") as string).cleanExit).toBe(true);
  });

  it("never opens history when another core holds the pipe", async () => {
    const first = launch({});
    await waitForListening();
    const historyFs = memoryHistoryFs();
    const read = vi.spyOn(historyFs, "readFile");
    await expect(launch({ historyFs })).resolves.toBe(ExitCode.Ok);
    expect(read).not.toHaveBeenCalled();
    await stopCore(first);
  });

  it("applies downloads-at-once on every poll", async () => {
    const setMaxConcurrent = vi.fn();
    const settings = memorySettingsStore({ concurrency: 1 });
    const stop = new AbortController();
    const done = launch({
      settings,
      pollMs: 10,
      shutdown: stop.signal,
      createEngine: () => ({ ...fakeEngine(), setMaxConcurrent }) as never,
    });
    await settings.save({ ...(await settings.load()), concurrency: 4 });
    await vi.waitFor(() => expect(setMaxConcurrent).toHaveBeenCalledWith(4));
    stop.abort();
    await done;
  });
});
```

`launch`, `fakeEngine`, `waitForListening` and `stopCore` refer to the file's existing helpers. Where a helper with that exact role has a different name, use the existing one. Do not add duplicates. If no "wait until listening" helper exists, poll `connectCore` with the test token, the way the file's other two-instance test does.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/core/run-core.test.ts -t history`
Expected: FAIL. `historyFile` is not a known dep, and no file gets written.

- [ ] **Step 3: Implement**

In `apps/desktop/src/core/run-core.ts`:

```ts
import { defaultHistoryFs, type HistoryFs, HistoryStore, historyPath } from "./history.ts";
```

`RunCoreDeps` gains:

```ts
  /** Where the download history lives. */
  historyFile: string;
  /** Default: the real file system. */
  historyFs?: HistoryFs;
```

Inside the `try` after `await writeToken(...)`, before `startProvisioning`, open the history:

```ts
    // Opened only once the pipe is ours: a second instance must never touch the file.
    const history = await HistoryStore.open({
      path: deps.historyFile,
      fs: deps.historyFs ?? defaultHistoryFs(),
    });
    await history.markRunning();
```

and pass `history` into `new CoreService({...})`.

`onConnection` becomes `(conn, role) => { ... handle = service.attach({ send: ... }, role); ... }`.

In the poll interval:

```ts
    const poll = setInterval(() => {
      check();
      refresh();
      live.applySettings().catch(() => {});
    }, deps.pollMs);
```

In `finish(code)`, flush history before settling:

```ts
      const flushed = live.shutdown().catch(() => {});
      for (const conn of [...connections]) quietly(() => conn.close());
      server.close(() => void flushed.then(settle));
```

The existing `fallback` timer still calls `settle()` after `graceMs`, so a stuck disk cannot hold the core open.

In `runDefaultCore`, add `historyFile: historyPath(env),` to the `runCore({...})` deps.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/core`
Expected: PASS.

- [ ] **Step 5: Commit message for the user**

```markdown
✨ keep download history across core restarts

## Description

The running core now opens its history only after it owns the pipe,
marks the session as running, records a clean exit on shutdown, gives
each connection the role it proved, and applies a changed "downloads
at once" on its regular settings poll.

## Test

pnpm vitest run apps/desktop/src/core
```

---

### Task 7: CoreClient and connecting with autostart

**Files:**
- Create: `apps/desktop/src/core/client.ts`, `apps/desktop/src/core/connect.ts`, `apps/desktop/src/core/in-process.ts`, `apps/desktop/src/core/job-watch.ts`
- Test: `apps/desktop/src/core/client.test.ts`, `apps/desktop/src/core/connect.test.ts`, `apps/desktop/src/core/job-watch.test.ts`

**Interfaces:**
- Consumes: `Connection`, `connectCore`, `pipePath`, `readToken`, `tokenPath` (ipc.ts); `coreSpawnCommand` (autostart.ts); `CoreService`, `CoreServiceDeps` (service.ts); `HistoryStore`, `memoryHistoryFs` (history.ts).
- Produces:

```ts
// client.ts
export type HelloAck = Extract<HostToExtensionMessage, { type: "hello.ack" }>["payload"];
export class CoreRequestError extends Error { readonly code: string }
export class CoreVersionError extends Error {}
export class CoreLostError extends Error {}
export interface CoreClient {
  readonly ack: HelloAck;
  /** Resolves with the first frame that answers `type` (same id), rejects on an error frame. */
  request(type: ExtensionToHostMessage["type"], payload: unknown): Promise<HostToExtensionMessage>;
  onPush(listener: (message: HostToExtensionMessage) => void): () => void;
  /** Called once when the connection closes. */
  onClose(listener: () => void): () => void;
  close(): void;
}
export function openCoreClient(
  conn: Connection,
  options: { client: JobOrigin; newId?: () => string; timeoutMs?: number },
): Promise<CoreClient>;

// connect.ts
export class CoreUnavailableError extends Error {}
export interface AutostartConnectDeps {
  connect: () => Promise<Connection>;
  spawnCore: () => void;
  timeoutMs: number;
  retryMs: number;
}
export function connectWithAutostart(deps: AutostartConnectDeps): Promise<Connection>;
export type CoreConnector = () => Promise<CoreClient>;
export function defaultCoreConnector(client: JobOrigin, options?: { autostart?: boolean }): CoreConnector;

// job-watch.ts
export type StartPayload = Extract<ExtensionToHostMessage, { type: "download.start" }>["payload"];
export interface WatchedJob {
  readonly id: string;
  /** Resolves with the final job, or rejects with CoreLostError if the connection drops first. */
  readonly settled: Promise<EngineJob>;
  cancel(): Promise<void>;
}
export function startJob(
  client: CoreClient,
  payload: StartPayload,
  onUpdate: (job: EngineJob) => void,
): Promise<WatchedJob>;

// in-process.ts (tests and dev tools)
export function inProcessCore(
  deps: Partial<CoreServiceDeps> & Pick<CoreServiceDeps, "createEngine">,
): { connect: CoreConnector; service: Promise<CoreService> };
```

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/core/connect.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { CoreUnavailableError, connectWithAutostart } from "./connect.ts";
import type { Connection } from "./ipc.ts";

const conn = {} as Connection;

describe("connectWithAutostart", () => {
  it("connects without starting a core when one answers", async () => {
    const spawnCore = vi.fn();
    const got = await connectWithAutostart({
      connect: async () => conn,
      spawnCore,
      timeoutMs: 1000,
      retryMs: 1,
    });
    expect(got).toBe(conn);
    expect(spawnCore).not.toHaveBeenCalled();
  });

  it("starts the core once and retries until it answers", async () => {
    const spawnCore = vi.fn();
    let attempts = 0;
    const got = await connectWithAutostart({
      connect: async () => {
        attempts += 1;
        if (attempts < 4) throw new Error("ENOENT");
        return conn;
      },
      spawnCore,
      timeoutMs: 1000,
      retryMs: 1,
    });
    expect(got).toBe(conn);
    expect(spawnCore).toHaveBeenCalledTimes(1);
  });

  it("gives up after the deadline with a clear error", async () => {
    await expect(
      connectWithAutostart({
        connect: async () => {
          throw new Error("ENOENT");
        },
        spawnCore: () => {},
        timeoutMs: 30,
        retryMs: 5,
      }),
    ).rejects.toBeInstanceOf(CoreUnavailableError);
  });
});
```

Create `apps/desktop/src/core/client.test.ts`:

```ts
import { PROTOCOL_VERSION } from "@mediaforge/shared-protocol";
import { describe, expect, it } from "vitest";
import { CoreLostError, CoreRequestError, CoreVersionError, openCoreClient } from "./client.ts";
import type { Connection } from "./ipc.ts";

/** A connection whose far end is a scripted core. */
function scripted(reply: (message: { id: string; type: string }) => unknown[]) {
  let onMessage: (m: unknown) => void = () => {};
  let onClose: () => void = () => {};
  const conn: Connection = {
    send: (m) => {
      for (const r of reply(m as { id: string; type: string })) queueMicrotask(() => onMessage(r));
    },
    onMessage: (h) => {
      onMessage = h;
    },
    onClose: (h) => {
      onClose = h;
    },
    close: () => onClose(),
  };
  return { conn, push: (m: unknown) => onMessage(m), drop: () => onClose() };
}

const ack = (id: string) => ({
  v: PROTOCOL_VERSION,
  id,
  type: "hello.ack",
  payload: {
    hostVersion: "1",
    ytDlp: { available: true },
    ffmpeg: { available: true },
    setup: "ready",
    keepRunning: false,
  },
});

describe("openCoreClient", () => {
  it("says hello as the given client and exposes the ack", async () => {
    const seen: unknown[] = [];
    const { conn } = scripted((m) => {
      seen.push(m);
      return m.type === "hello" ? [ack(m.id)] : [];
    });
    const client = await openCoreClient(conn, { client: "cli" });
    expect(client.ack.hostVersion).toBe("1");
    expect(seen[0]).toMatchObject({ type: "hello", payload: { client: "cli" } });
  });

  it("explains a version mismatch instead of passing on the parser text", async () => {
    const { conn } = scripted((m) => [
      {
        v: PROTOCOL_VERSION,
        id: "e",
        type: "error",
        payload: { code: "invalid-message", message: "v: Invalid input", replyTo: m.id },
      },
    ]);
    await expect(openCoreClient(conn, { client: "cli" })).rejects.toBeInstanceOf(
      CoreVersionError,
    );
  });

  it("treats a frame with another protocol version as a version mismatch", async () => {
    const { conn } = scripted((m) => [{ ...ack(m.id), v: PROTOCOL_VERSION - 1 }]);
    await expect(openCoreClient(conn, { client: "cli" })).rejects.toBeInstanceOf(
      CoreVersionError,
    );
  });

  it("rejects a request with the core's error code", async () => {
    const { conn } = scripted((m) =>
      m.type === "hello"
        ? [ack(m.id)]
        : [
            {
              v: PROTOCOL_VERSION,
              id: "e",
              type: "error",
              payload: { code: "forbidden", message: "no", replyTo: m.id },
            },
          ],
    );
    const client = await openCoreClient(conn, { client: "cli" });
    await expect(client.request("settings.reload", {})).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(client.request("settings.reload", {})).rejects.toBeInstanceOf(CoreRequestError);
  });

  it("rejects pending requests with CoreLostError when the connection drops", async () => {
    const s = scripted((m) => (m.type === "hello" ? [ack(m.id)] : []));
    const client = await openCoreClient(s.conn, { client: "cli" });
    const pending = client.request("jobs.list", {});
    s.drop();
    await expect(pending).rejects.toBeInstanceOf(CoreLostError);
  });
});
```

Create `apps/desktop/src/core/job-watch.test.ts`. It drives a real `CoreService` with a real `DownloadEngine` through `inProcessCore`:

```ts
import { resolve } from "node:path";
import type { Tool } from "@mediaforge/binary-resolver";
import { describe, expect, it } from "vitest";
import { DownloadEngine, type EngineFs } from "../engine/index.ts";
import type { ProcessRunner } from "../engine/process.ts";
import { candidateFor } from "../download.ts";
import { inProcessCore } from "./in-process.ts";
import { startJob } from "./job-watch.ts";

const found = async (tool: Tool) => ({ tool, path: `/bin/${tool}`, source: "path" as const });
const fs: EngineFs = {
  mkdir: async () => {},
  rename: async () => {},
  rm: async () => {},
  exists: async () => false,
  list: async () => [],
  readText: async () => "",
};

const core = (run: ProcessRunner) =>
  inProcessCore({
    createEngine: (onUpdate) => new DownloadEngine({ resolve: found, fs, onUpdate, run }),
  });

const payload = () => ({
  candidate: candidateFor("https://example.com/v", "video"),
  profileId: "best",
  origin: "cli" as const,
  outputDir: resolve("/dl"),
});

describe("startJob", () => {
  it("follows a job to completion", async () => {
    const { connect } = core(async (_c, args, h) => {
      h.onStdoutLine("MFPROGRESS 50 100 NA 10 5");
      h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip.mp4`);
      return { exitCode: 0 };
    });
    const client = await connect();
    const statuses: string[] = [];
    const watched = await startJob(client, payload(), (job) => statuses.push(job.status));
    const final = await watched.settled;
    expect(final.status).toBe("completed");
    expect(final.outputPath).toMatch(/Clip\.mp4$/);
    expect(statuses).toContain("downloading");
  });

  it("reports the exit code of a failure", async () => {
    const { connect } = core(async (_c, _a, h) => {
      h.onStderrLine("ERROR: Unsupported URL: https://example.com/v");
      return { exitCode: 1 };
    });
    const final = await (await startJob(await connect(), payload(), () => {})).settled;
    expect(final.status).toBe("failed");
    expect(final.errorKind).toBeTypeOf("number");
  });

  it("cancels", async () => {
    const { connect } = core(
      (_c, _a, _h, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve({ exitCode: 1 }))),
    );
    const watched = await startJob(await connect(), payload(), () => {});
    await watched.cancel();
    expect((await watched.settled).status).toBe("cancelled");
  });

  it("rejects settled with CoreLostError when the core goes away", async () => {
    const { connect } = core(() => new Promise(() => {}));
    const client = await connect();
    const watched = await startJob(client, payload(), () => {});
    client.close();
    await expect(watched.settled).rejects.toMatchObject({ name: "CoreLostError" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/core/connect.test.ts apps/desktop/src/core/client.test.ts apps/desktop/src/core/job-watch.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `client.ts`**

```ts
import { randomUUID } from "node:crypto";
import {
  type ExtensionToHostMessage,
  type HostToExtensionMessage,
  PROTOCOL_VERSION,
  parseHostMessage,
} from "@mediaforge/shared-protocol";
import type { JobOrigin } from "@mediaforge/shared-types";
import type { Connection } from "./ipc.ts";

export type HelloAck = Extract<HostToExtensionMessage, { type: "hello.ack" }>["payload"];

export class CoreRequestError extends Error {
  override name = "CoreRequestError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class CoreVersionError extends Error {
  override name = "CoreVersionError";
  constructor() {
    super(
      "The MediaForge background service is a different version. Close it from Task Manager " +
        "(or sign out and back in) and try again.",
    );
  }
}

export class CoreLostError extends Error {
  override name = "CoreLostError";
  constructor() {
    super("Lost the connection to the MediaForge background service.");
  }
}

export interface CoreClient {
  readonly ack: HelloAck;
  request(type: ExtensionToHostMessage["type"], payload: unknown): Promise<HostToExtensionMessage>;
  onPush(listener: (message: HostToExtensionMessage) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

interface Pending {
  resolve: (message: HostToExtensionMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Wrap an authenticated connection to the core and say hello. Rejects with CoreVersionError when
 * the core speaks another protocol version, and with CoreLostError when it hangs up first.
 */
export async function openCoreClient(
  conn: Connection,
  options: { client: JobOrigin; newId?: () => string; timeoutMs?: number },
): Promise<CoreClient> {
  const newId = options.newId ?? randomUUID;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<string, Pending>();
  const pushListeners = new Set<(message: HostToExtensionMessage) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;
  let versionMismatch = false;

  const failAll = (error: Error) => {
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(error);
    }
  };

  conn.onMessage((raw) => {
    const v = (raw as { v?: unknown } | null)?.v;
    if (v !== PROTOCOL_VERSION) {
      versionMismatch = true;
      failAll(new CoreVersionError());
      return;
    }
    const parsed = parseHostMessage(raw);
    if (!parsed.ok) return;
    const message = parsed.value;
    const key = message.type === "error" ? (message.payload.replyTo ?? "") : message.id;
    const waiting = pending.get(key);
    if (waiting) {
      pending.delete(key);
      clearTimeout(waiting.timer);
      if (message.type === "error") {
        waiting.reject(
          message.payload.code === "invalid-message"
            ? new CoreVersionError()
            : new CoreRequestError(message.payload.code, message.payload.message),
        );
      } else waiting.resolve(message);
      return;
    }
    for (const listener of pushListeners) listener(message);
  });
  conn.onClose(() => {
    closed = true;
    failAll(versionMismatch ? new CoreVersionError() : new CoreLostError());
    for (const listener of closeListeners) listener();
  });

  const request = (
    type: ExtensionToHostMessage["type"],
    payload: unknown,
  ): Promise<HostToExtensionMessage> => {
    if (closed) return Promise.reject(new CoreLostError());
    const id = newId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CoreRequestError("timeout", "MediaForge did not answer in time."));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        conn.send({ v: PROTOCOL_VERSION, id, type, payload });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const hello = await request("hello", { client: options.client });
  if (hello.type !== "hello.ack") throw new CoreVersionError();

  return {
    ack: hello.payload,
    request,
    onPush: (listener) => {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },
    onClose: (listener) => {
      if (closed) queueMicrotask(listener);
      else closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close: () => conn.close(),
  };
}
```

- [ ] **Step 4: Implement `connect.ts`**

```ts
import { spawn } from "node:child_process";
import type { JobOrigin } from "@mediaforge/shared-types";
import { coreSpawnCommand } from "./autostart.ts";
import { type CoreClient, openCoreClient } from "./client.ts";
import { type Connection, connectCore, pipePath, readToken, tokenPath } from "./ipc.ts";

export class CoreUnavailableError extends Error {
  override name = "CoreUnavailableError";
  constructor() {
    super("Could not start or reach the MediaForge background service.");
  }
}

export interface AutostartConnectDeps {
  /** One attempt. Rejects when nothing answers. */
  connect: () => Promise<Connection>;
  /** Start a detached core. Called at most once. */
  spawnCore: () => void;
  timeoutMs: number;
  retryMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Connect to the core, starting it once if it does not answer, until `timeoutMs` runs out. */
export async function connectWithAutostart(deps: AutostartConnectDeps): Promise<Connection> {
  const deadline = Date.now() + deps.timeoutMs;
  let spawned = false;
  for (;;) {
    try {
      return await deps.connect();
    } catch {
      if (!spawned) {
        spawned = true;
        try {
          deps.spawnCore();
        } catch {
          // The retry loop answers for a core that never comes up.
        }
      }
      if (Date.now() >= deadline) throw new CoreUnavailableError();
      await sleep(deps.retryMs);
    }
  }
}

export type CoreConnector = () => Promise<CoreClient>;

/**
 * The real core, as a terminal client. With `autostart: false` it only joins a running core and
 * rejects when there is none (used to nudge a core without starting one).
 */
export function defaultCoreConnector(
  client: JobOrigin,
  options: { autostart?: boolean } = {},
): CoreConnector {
  return async () => {
    const env = process.env;
    const path = pipePath(process.platform, env);
    const once = async () => {
      const token = await readToken(tokenPath(env));
      if (!token) throw new Error("No core token yet.");
      return connectCore({ path, token, timeoutMs: 1000, role: "terminal" });
    };
    const conn =
      options.autostart === false
        ? await once()
        : await connectWithAutostart({
            connect: once,
            spawnCore: () => {
              const { command, args } = coreSpawnCommand(process.execPath, process.argv[1]);
              const child = spawn(command, args, {
                detached: true,
                stdio: "ignore",
                windowsHide: true,
              });
              child.on("error", () => {});
              child.unref();
            },
            timeoutMs: 10_000,
            retryMs: 100,
          });
    return openCoreClient(conn, { client });
  };
}
```

- [ ] **Step 5: Implement `in-process.ts`**

```ts
import { randomUUID } from "node:crypto";
import { memorySettingsStore } from "../settings.ts";
import type { CoreClient } from "./client.ts";
import { openCoreClient } from "./client.ts";
import type { CoreConnector } from "./connect.ts";
import { HistoryStore, memoryHistoryFs } from "./history.ts";
import type { Connection } from "./ipc.ts";
import type { Provisioner } from "./provisioner.ts";
import { CoreService, type CoreServiceDeps } from "./service.ts";

const readyProvisioner: Provisioner = {
  status: () => ({ state: "ready" }),
  onChange: () => () => {},
  ready: async () => ({ state: "ready" }),
  refreshIfStale: async () => {},
};

/**
 * A real CoreService behind an in-memory connection with the terminal role. Tests use it to drive
 * the CLI and the menu exactly as the real core would, with a fake engine runner.
 */
export function inProcessCore(
  deps: Partial<CoreServiceDeps> & Pick<CoreServiceDeps, "createEngine">,
): { connect: CoreConnector; service: Promise<CoreService> } {
  const service = (async () =>
    new CoreService({
      settings: memorySettingsStore(),
      provisioner: readyProvisioner,
      version: "0.0.0-test",
      probeTool: async () => ({ available: true }),
      probe: async (url) => ({ url, formats: [] }),
      applyAutostart: async () => {},
      openPath: async () => {},
      onActivity: () => {},
      now: () => Date.now(),
      newId: () => randomUUID(),
      history: await HistoryStore.open({
        path: "/memory/history.json",
        fs: memoryHistoryFs(),
        debounceMs: 0,
      }),
      ...deps,
    }))();

  const connect = async (): Promise<CoreClient> => {
    const core = await service;
    let toClient: (message: unknown) => void = () => {};
    const closeHandlers: (() => void)[] = [];
    let closed = false;
    // Frames are cloned, as a real pipe would serialize them.
    const handle = core.attach(
      {
        send: (m) => {
          if (!closed) queueMicrotask(() => toClient(structuredClone(m)));
        },
      },
      "terminal",
    );
    const close = () => {
      if (closed) return;
      closed = true;
      handle.detach();
      for (const h of closeHandlers) queueMicrotask(h);
    };
    const conn: Connection = {
      send: (m) => void handle.handle(structuredClone(m)),
      onMessage: (h) => {
        toClient = h;
      },
      onClose: (h) => void closeHandlers.push(h),
      close,
    };
    return openCoreClient(conn, { client: "cli" });
  };
  return { connect, service };
}
```

Callers that need a specific `client` name pass it through `startJob`'s payload `origin`. The hello's `client` only labels the connection.

- [ ] **Step 6: Implement `job-watch.ts`**

```ts
import type { ExtensionToHostMessage, HostToExtensionMessage } from "@mediaforge/shared-protocol";
import type { EngineJob } from "../engine/index.ts";
import { type CoreClient, CoreLostError } from "./client.ts";

export type StartPayload = Extract<ExtensionToHostMessage, { type: "download.start" }>["payload"];

export interface WatchedJob {
  readonly id: string;
  readonly settled: Promise<EngineJob>;
  cancel(): Promise<void>;
}

const jobIdOf = (message: HostToExtensionMessage): string | undefined =>
  message.type === "download.progress" ||
  message.type === "download.completed" ||
  message.type === "download.failed"
    ? message.payload.jobId
    : undefined;

/** Fold one core frame into the job as the terminal sees it. */
export function applyFrame(job: EngineJob, message: HostToExtensionMessage): EngineJob {
  const now = Date.now();
  switch (message.type) {
    case "download.progress": {
      const { status, progress, steps, overallPercent } = message.payload;
      return {
        ...job,
        status,
        progress,
        ...(steps && { steps }),
        ...(overallPercent !== undefined && { overallPercent }),
        updatedAt: now,
      };
    }
    case "download.completed":
      return {
        ...job,
        status: "completed",
        outputPath: message.payload.outputPath,
        overallPercent: 100,
        updatedAt: now,
      };
    case "download.failed": {
      const { cancelled, error, errorKind } = message.payload;
      return {
        ...job,
        status: cancelled ? "cancelled" : "failed",
        ...(!cancelled && { error }),
        ...(errorKind !== undefined && { errorKind }),
        updatedAt: now,
      };
    }
    default:
      return job;
  }
}

const FINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * Submit a download to the core and follow it. `onUpdate` sees every change; `settled` resolves
 * with the final job, or rejects with CoreLostError if the core goes away first.
 */
export async function startJob(
  client: CoreClient,
  payload: StartPayload,
  onUpdate: (job: EngineJob) => void,
): Promise<WatchedJob> {
  let job: EngineJob | undefined;
  /** Frames that arrive between the reply and the listener taking over; never lost. */
  const early: HostToExtensionMessage[] = [];
  let resolveSettled: (job: EngineJob) => void = () => {};
  let rejectSettled: (error: Error) => void = () => {};
  const settled = new Promise<EngineJob>((res, rej) => {
    resolveSettled = res;
    rejectSettled = rej;
  });
  // A watcher that is never awaited must not raise an unhandled rejection.
  settled.catch(() => {});

  const take = (message: HostToExtensionMessage) => {
    if (!job) {
      early.push(message);
      return;
    }
    if (jobIdOf(message) !== job.id) return;
    job = applyFrame(job, message);
    onUpdate(job);
    if (FINAL.has(job.status)) {
      stopPush();
      stopClose();
      resolveSettled(job);
    }
  };
  const stopPush = client.onPush(take);
  const stopClose = client.onClose(() => {
    if (job && !FINAL.has(job.status)) rejectSettled(new CoreLostError());
  });

  const reply = await client.request("download.start", payload);
  const id = jobIdOf(reply);
  if (!id) throw new Error(`Unexpected reply to download.start: ${reply.type}`);
  const now = Date.now();
  job = {
    id,
    request: { candidate: payload.candidate, profileId: payload.profileId },
    status: "queued",
    progress: { bytesDownloaded: 0 },
    createdAt: now,
    updatedAt: now,
  };
  take(reply);
  for (const message of early.splice(0)) take(message);

  return {
    id,
    settled,
    cancel: async () => {
      try {
        await client.request("download.cancel", { jobId: id });
      } catch {
        // Already finished; `settled` reports how.
      }
    },
  };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/core/connect.test.ts apps/desktop/src/core/client.test.ts apps/desktop/src/core/job-watch.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit message for the user**

```markdown
✨ add a core client for the menu and the CLI

## Description

Terminal programs need to hand their downloads to the core and follow
them. The client says hello, matches replies, and turns a core of
another version or a dropped connection into clear errors. A
connector starts the core when it is not running, and an in-process
core lets tests drive the real service.

## Test

pnpm vitest run apps/desktop/src/core
```

---

### Task 8: `mediaforge download` through the core

**Files:**
- Modify: `apps/desktop/src/download.ts`
- Test: `apps/desktop/src/download.test.ts`

**Interfaces:**
- Consumes: `CoreConnector`, `defaultCoreConnector` (Task 7); `startJob` (Task 7); `CoreLostError`, `CoreVersionError` (Task 7); `CoreUnavailableError` (Task 7).
- Produces: `DownloadDeps` without `createEngine` and with `core: CoreConnector`. `runDownload` keeps its signature and exit codes.

- [ ] **Step 1: Update the test harness and write the failing tests**

In `apps/desktop/src/download.test.ts`, change `setup` so `deps.core` is an in-process core around the same fake engine:

```ts
import { inProcessCore } from "./core/in-process.ts";
```

```ts
  const deps: DownloadDeps = {
    env,
    isTTY,
    settings: memorySettingsStore(saved),
    onInterrupt: (h) => {
      interrupt = h;
      return () => {};
    },
    core: inProcessCore({
      createEngine: (onUpdate) =>
        new DownloadEngine({
          resolve: found,
          fs,
          onUpdate,
          run: (cmd, args, h, s) => {
            seenArgs.push(args);
            return run(cmd, args, h, s);
          },
        }),
    }).connect,
  };
```

Existing tests keep their assertions. Where a test checks the output folder passed to yt-dlp (`--paths`), compare against `resolve(...)` of the expected folder, because the CLI now sends an absolute folder.

Add:

```ts
describe("runDownload through the core", () => {
  it("fails fast with a clear message when the core cannot be reached", async () => {
    const t = setup(succeed);
    t.deps.core = async () => {
      throw new CoreUnavailableError();
    };
    await expect(runDownload(["https://example.com/v"], t.io, t.deps)).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message: expect.stringMatching(/background service/),
    });
  });

  it("exits with a failure when the core goes away mid-download", async () => {
    const hang: ProcessRunner = () => new Promise(() => {});
    const t = setup(hang);
    const connect = t.deps.core;
    t.deps.core = async () => {
      const client = await connect();
      setTimeout(() => client.close(), 20);
      return client;
    };
    await expect(runDownload(["https://example.com/v"], t.io, t.deps)).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message: expect.stringMatching(/Lost the connection/),
    });
  });

  it("sends an absolute folder and the cli origin", async () => {
    const t = setup(succeed);
    await runDownload(["-o", "relative/out", "https://example.com/v"], t.io, t.deps);
    const args = t.seenArgs[0] as string[];
    expect(args[args.indexOf("--paths") + 1]).toContain(resolve("relative/out"));
  });
});
```

Add imports: `resolve` from `node:path`, `CoreUnavailableError` from `./core/connect.ts`.

The existing Ctrl+C test (it calls `t.interrupt()` and expects `ExitCode.Cancelled`) must keep passing unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/download.test.ts`
Expected: FAIL. `core` is not in `DownloadDeps`, and `createEngine` is still required.

- [ ] **Step 3: Implement**

In `apps/desktop/src/download.ts`:

Replace the engine imports with:

```ts
import { resolve } from "node:path";
import { CoreLostError, CoreRequestError, CoreVersionError } from "./core/client.ts";
import { type CoreConnector, CoreUnavailableError, defaultCoreConnector } from "./core/connect.ts";
import { startJob } from "./core/job-watch.ts";
```

Keep `defaultOutputDir` from `./engine/paths.ts`. Remove the `DownloadEngine`, `EngineJob` and `detectJsRuntimeArgs` imports if nothing else uses them.

`DownloadDeps`: remove `createEngine` and add:

```ts
  /** Joins the background core, starting it if needed. */
  core: CoreConnector;
```

`defaultDownloadDeps`: replace `createEngine` with `core: defaultCoreConnector("cli"),`.

Replace the engine part of `runDownload`, from `const engine = ...` through the final `throw`, with:

```ts
  const baseDir = values.output ?? deps.env[OUTPUT_DIR_ENV] ?? settings.folder;
  // The type subfolder needs a concrete folder, so name the built-in default when none is set.
  const chosen = settings.sortByType
    ? withKindFolder(baseDir ?? defaultOutputDir(), kindOfProfile(profile), true)
    : baseDir;
  // The core runs elsewhere, with its own working folder: send a full path.
  const outputDir = chosen ? resolve(chosen) : undefined;

  let client: Awaited<ReturnType<CoreConnector>>;
  try {
    client = await deps.core();
  } catch (error) {
    throw new CliError(coreProblem(error), ExitCode.Failure);
  }
  try {
    let watched: Awaited<ReturnType<typeof startJob>>;
    try {
      watched = await startJob(
        client,
        {
          candidate: candidateFor(url, profile.kind),
          profileId,
          origin: "cli",
          ...(outputDir && { outputDir }),
          ...(values.filename && { filename: values.filename }),
        },
        (job) => view.update(job),
      );
    } catch (error) {
      // The core checked the request (for example the file name) and refused it.
      if (error instanceof CoreRequestError) throw new CliError(error.message, ExitCode.Usage);
      throw new CliError(coreProblem(error), ExitCode.Failure);
    }
    const stopListening = deps.onInterrupt(() => void watched.cancel());
    let job: Awaited<typeof watched.settled>;
    try {
      job = await watched.settled;
    } catch (error) {
      throw new CliError(coreProblem(error), ExitCode.Failure);
    } finally {
      stopListening();
      view.finish();
    }

    if (job.status === "completed" && job.outputPath) {
      io.stdout(`${job.outputPath}\n`);
      return ExitCode.Ok;
    }
    if (job.status === "cancelled") {
      io.stderr("Cancelled.\n");
      return ExitCode.Cancelled;
    }
    throw new CliError(
      withUpdateHint(job.error ?? "Download failed."),
      job.errorKind ?? ExitCode.Failure,
    );
  } finally {
    client.close();
  }
}

/** Plain words for the ways reaching the core can fail. */
function coreProblem(error: unknown): string {
  if (error instanceof CoreLostError) {
    return `${error.message} The download stops here; MediaForge lists it as paused next time it starts.`;
  }
  if (error instanceof CoreVersionError || error instanceof CoreUnavailableError) {
    return error.message;
  }
  return `Could not talk to the MediaForge background service: ${
    error instanceof Error ? error.message : String(error)
  }`;
}
```

Keep `const view = createProgressView(...)` above this block.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/download.test.ts apps/desktop/src/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit message for the user**

```markdown
♻️ run `mediaforge download` inside the background core

## Description

CLI downloads now run in the core, so they appear in the shared
history next to browser downloads. Output, exit codes and Ctrl+C
cancelling stay the same for scripts. A core that cannot be reached
or that drops mid-download ends the command with a clear message
instead of hanging.

## Test

pnpm vitest run apps/desktop/src/download.test.ts
```

---

### Task 9: Interactive menu through the core

**Files:**
- Modify: `apps/desktop/src/interactive/screens/DownloadScreen.tsx`
- Modify: `apps/desktop/src/interactive/screens/batch/BatchDownloadScreen.tsx`
- Modify: `apps/desktop/src/interactive/BatchFlow.tsx:204-207`
- Modify: `apps/desktop/src/interactive/screens/SettingsScreen.tsx` (`save`)
- Modify: `apps/desktop/src/interactive/deps.ts`, `apps/desktop/src/interactive/start.tsx`
- Test: `apps/desktop/src/interactive/App.test.tsx`

**Interfaces:**
- Consumes: `DownloadDeps.core` (Task 8), `startJob`, `WatchedJob` (Task 7), `defaultCoreConnector` (Task 7).
- Produces: `AppDeps.notifyCore: () => Promise<void>`. It sends `settings.reload` to a running core and never starts one or rejects. `BatchDownloadScreenProps` loses `concurrency`.

Behavior:
- Both screens start their jobs with `origin: "menu"`.
- Esc and Ctrl+C on a download screen cancel the screen's jobs, as today.
- Unmounting closes the connection but does not cancel the jobs: they keep running in the core.
- If the connection drops before a job settles, the screen reports a failed job with `CoreLostError`'s message, so the result screen shows it.
- After any settings save that changes `concurrency`, the Settings screen calls `deps.notifyCore()`.

- [ ] **Step 1: Update the test harness and write the failing tests**

In `apps/desktop/src/interactive/App.test.tsx` `setup()`, swap `createEngine` for an in-process core. The engine still records `seenArgs`, and `engineOptions` goes away:

```ts
import { inProcessCore } from "../core/in-process.ts";
```

```ts
  const notified: number[] = [];
  const core = inProcessCore({
    settings: store,
    createEngine: (onUpdate) =>
      new DownloadEngine({
        resolve: found,
        fs,
        onUpdate,
        run: (c, a, h, s) => {
          seenArgs.push(a);
          return runner(c, a, h, s);
        },
      }),
  });
  const download: DownloadDeps = {
    env: {},
    isTTY: true,
    settings: store,
    onInterrupt: () => () => {},
    core: core.connect,
  };
```

and in `deps`:

```ts
    notifyCore: async () => {
      notified.push(Date.now());
      await (await core.service).applySettings();
    },
```

Return `notified` and `core` from `setup()`. Delete assertions that read `engineOptions` (they checked per-batch `maxConcurrent`). Replace them with the concurrency test below.

Add tests:

```ts
it("tells the core when downloads-at-once changes", async () => {
  const t = setup();
  // Navigate: Home -> Settings -> "Downloads at once" -> pick 3, with the file's existing helpers.
  await openSettings(t);
  await pickConcurrency(t, 3);
  await vi.waitFor(() => expect(t.notified).toHaveLength(1));
});

it("keeps a download running in the core after the app quits", async () => {
  let release: () => void = () => {};
  const t = setup({
    runner: (_c, args, h) =>
      new Promise((resolve) => {
        release = () => {
          h.onStdoutLine(`MFFILE ${args[args.indexOf("--paths") + 1]}/Clip.mp4`);
          resolve({ exitCode: 0 });
        };
      }),
  });
  await startDownload(t, "https://example.com/v");
  t.app.unmount();
  release();
  const service = await t.core.service;
  await vi.waitFor(async () => {
    const list = await (await t.core.connect()).request("jobs.list", {});
    expect(list.type === "jobs.snapshot" && list.payload.jobs[0]?.status).toBe("completed");
  });
  void service;
});

it("shows a failure when the core goes away during a download", async () => {
  const t = setup({ runner: () => new Promise(() => {}) });
  const connect = t.download.core;
  t.download.core = async () => {
    const client = await connect();
    setTimeout(() => client.close(), 20);
    return client;
  };
  await startDownload(t, "https://example.com/v");
  await vi.waitFor(() => expect(t.lastFrame()).toMatch(/Lost the connection/));
});
```

`openSettings`, `pickConcurrency` and `startDownload` (and `t.app`, `t.lastFrame`) stand for the key sequences this file's existing tests already use to reach those screens. Reuse the existing helpers; if a sequence is inlined in another test, extract it into a helper in this file with that name.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/interactive/App.test.tsx`
Expected: FAIL. `notifyCore` is not in `AppDeps`, and the screens still call `createEngine`.

- [ ] **Step 3: Implement the screens**

`apps/desktop/src/interactive/deps.ts`, add to `AppDeps`:

```ts
  /** Ask a running core to re-read the settings. Never starts a core, never rejects. */
  notifyCore: () => Promise<void>;
```

`apps/desktop/src/interactive/start.tsx`, in `realDeps()`:

```ts
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
```

and swap `download: defaultDownloadDeps()` for:

```ts
    download: { ...defaultDownloadDeps(), core: defaultCoreConnector("menu") },
```

with `import { defaultCoreConnector } from "../core/connect.ts";`.

`DownloadScreen.tsx`: replace the download effect:

```tsx
  // biome-ignore lint/correctness/useExhaustiveDependencies: the download starts once per mount
  useEffect(() => {
    const profile = getProfile(plan.profileId);
    if (!profile) return;
    let live = true;
    let close = () => {};
    const fail = (error: unknown) => {
      if (!live) return;
      const now = Date.now();
      onDone({
        id: "",
        request: { candidate: candidateFor(plan.url, profile.kind), profileId: profile.id },
        status: "failed",
        progress: { bytesDownloaded: 0 },
        error: error instanceof Error ? error.message : String(error),
        createdAt: now,
        updatedAt: now,
      });
    };
    void (async () => {
      try {
        const client = await deps.download.core();
        close = () => client.close();
        if (!live) return close();
        const watched = await startJob(
          client,
          {
            candidate: candidateFor(plan.url, profile.kind),
            profileId: profile.id,
            outputDir: plan.outputDir,
            origin: "menu",
            ...(plan.formatSelector && { formatSelector: plan.formatSelector }),
            ...(plan.steps && { plan: plan.steps }),
          },
          (update) => {
            if (live) setJob(update);
          },
        );
        control.current = { cancel: () => void watched.cancel() };
        watched.settled.then((final) => live && onDone(final), fail);
      } catch (error) {
        fail(error);
      }
    })();
    return () => {
      // Leaving the screen does not stop the download: it keeps running in the core.
      live = false;
      close();
    };
  }, []);
```

Imports: add `import { startJob } from "../../core/job-watch.ts";`. `EngineJob` stays the screen's job type.

`BatchDownloadScreen.tsx`: drop the `concurrency` prop from the props interface and the effect's dependency list, and replace the effect body:

```tsx
  useEffect(() => {
    let live = true;
    let close = () => {};
    const watchers: { cancel: () => Promise<void> }[] = [];
    cancelAll.current = () => {
      for (const w of watchers) void w.cancel();
    };
    void (async () => {
      let client: Awaited<ReturnType<typeof deps.download.core>>;
      try {
        client = await deps.download.core();
      } catch (error) {
        if (live) done.current(plans.map((plan) => lostJob(plan, error)));
        return;
      }
      close = () => client.close();
      if (!live) return close();
      const settled: Promise<EngineJob>[] = [];
      for (const [at, plan] of plans.entries()) {
        const profile = getProfile(plan.profileId);
        if (!profile) continue;
        try {
          const watched = await startJob(
            client,
            {
              candidate: candidateFor(plan.url, profile.kind),
              profileId: profile.id,
              outputDir: plan.outputDir,
              origin: "menu",
              ...(plan.formatSelector && { formatSelector: plan.formatSelector }),
              ...(plan.steps && { plan: plan.steps }),
            },
            (update) => {
              if (live) setJobs((all) => all.map((job, i) => (i === at ? update : job)));
            },
          );
          watchers.push(watched);
          settled.push(watched.settled.catch((error) => lostJob(plan, error)));
        } catch (error) {
          settled.push(Promise.resolve(lostJob(plan, error)));
        }
      }
      const finals = await Promise.all(settled);
      if (live) done.current(finals);
    })();
    return () => {
      live = false;
      close();
    };
  }, [deps, plans]);
```

with, above the component:

```tsx
/** A job that never reached a result because the core could not be reached or went away. */
function lostJob(plan: Plan, error: unknown): EngineJob {
  const profile = getProfile(plan.profileId);
  const now = Date.now();
  return {
    id: "",
    request: {
      candidate: candidateFor(plan.url, profile?.kind ?? "video"),
      profileId: plan.profileId,
    },
    status: "failed",
    progress: { bytesDownloaded: 0 },
    error: error instanceof Error ? error.message : String(error),
    createdAt: now,
    updatedAt: now,
  };
}
```

Import `Plan` from `../../flow.ts` if the file doesn't already, and `startJob` from `../../../core/job-watch.ts`.

`BatchFlow.tsx`: remove the `concurrency={settings.concurrency}` prop at line 207.

`SettingsScreen.tsx`: in `save`, after `await deps.download.settings.save(next);`:

```tsx
      if (next.concurrency !== settings.concurrency) void deps.notifyCore();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/interactive`
Expected: PASS.

- [ ] **Step 5: Type check, lint and the full suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS. Fix any remaining compile errors from `DownloadDeps.createEngine` being removed (for example in `tools/dev`). Grep: `createEngine` must now appear only in `apps/desktop/src/core/` and engine tests.

- [ ] **Step 6: Commit message for the user**

```markdown
♻️ run interactive downloads inside the background core

## Description

Downloads started from the menu now run in the core, so they join the
shared history and keep going after the menu closes. Esc still
cancels. A changed "downloads at once" reaches a running core at once
instead of applying per batch, and a core that goes away shows as a
failed download instead of a spinner that never ends.

## Test

pnpm vitest run apps/desktop/src/interactive
```

---

### Task 10: Manual checklist

**Files:**
- Modify: `docs/desktop-cli-checklist.md`

- [ ] **Step 1: Add the phase 1 checks**

Append a section:

```markdown
## Downloads in the core (downloads manager phase 1)

- [ ] `mediaforge download <url>` with no core running starts one, downloads, prints the path, exits 0.
- [ ] Ctrl+C during `mediaforge download` prints "Cancelled." and exits with the cancelled code.
- [ ] A menu download keeps going after quitting the menu with Ctrl+C on the home screen; the file appears.
- [ ] `history.json` sits beside `config.json` and lists the CLI, menu and extension downloads with their origin.
- [ ] Kill the core in Task Manager (Windows) or with `kill -9` (Linux) during a download. Start the browser popup: the job shows as paused, and `history.json` has a notice with reason "unexpected".
- [ ] Replace `history.json` with `{broken`. Start the core: `history.json.bak` holds the broken text and a new list starts.
- [ ] Change "Downloads at once" in Settings while three downloads are queued: the new limit applies without restarting the core.
- [ ] An older extension against this exe shows the "update" state rather than errors.
```

- [ ] **Step 2: Commit message for the user**

```markdown
📝 add manual checks for downloads running in the core

## Test

Read through docs/desktop-cli-checklist.md
```
