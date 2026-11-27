# Core and Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `MediaForge.exe` a long-lived core that owns the download engine, plus a short-lived `--native-host` relay that bridges the browser's native messaging to it.

**Architecture:** One exe, three modes (TUI, `--native-host`, `--core`). The core listens on a per-user named pipe, authenticates clients with a token file, and wraps the existing `DownloadEngine`. The relay forwards framed protocol messages between stdio and the pipe, and spawns the core detached when it is not running. Protocol goes to v2 with job list, subscription, settings, and setup progress messages.

**Tech Stack:** TypeScript (ESM, `.ts` import specifiers), Node 22 `net` named pipes, Zod 4, Vitest 5, Biome, pnpm workspace.

**Spec:** [docs/superpowers/specs/2026-10-13-extension-core-architecture-design.md](../specs/2026-10-13-extension-core-architecture-design.md)

## Global Constraints

- Windows is the verified platform. Non-Windows code paths (Unix socket path, no autostart) exist behind the same interfaces but get stale-socket cleanup and tests in the later Linux pass.
- No localhost HTTP server. IPC is a named pipe plus a token handshake.
- The relay writes only protocol frames to stdout. Everything else goes to stderr.
- Host to extension messages stay at or under 1 MiB (`MAX_HOST_MESSAGE_BYTES`). Extension to host stays under `MAX_EXTENSION_MESSAGE_BYTES`.
- `keepRunning` default `false`; `extensionUi` default `"overlay"`.
- Idle exit grace period default 60 seconds; yt-dlp refresh at most once per 24 hours.
- Never run `git commit`, `git push`, or `gh pr create`. Each task ends by printing a commit message for the user, in the format from CLAUDE.md (gitmoji, scope, `## Description`, `## Test`). No `Co-Authored-By` lines.
- Run `pnpm exec biome check --write <paths>` on any file created through Bash. Run `pnpm lint` and `pnpm typecheck` and `pnpm test` before declaring the plan done.
- Do not suppress Biome rules with ignore comments.

## Review Focus

- Second core started while one is live must exit quietly and must not overwrite the live core's token (test in Task 4).
- Wrong or missing token must be rejected and the socket closed (Task 3).
- A relay that cannot reach or start a core must answer with an `error` frame (`core-unavailable`) and exit non-zero, never hang (Task 6).
- A relay started before the token file exists must retry, not fail (Task 6).
- Engine progress can fire many times per second; non-terminal updates must be throttled so the browser is not flooded (Task 5).
- Chrome on Windows passes the extension origin as the first argument, and cannot pass `--native-host`; relay mode must trigger on that origin (Task 7).
- A client that disconnects mid-download must not cancel the job, and a later `jobs.list` must still show it (Task 5).
- Turning `keepRunning` off while the core is resident must let it exit once idle, without a restart (Task 4).

## File Structure

| Path | Responsibility |
| --- | --- |
| `packages/shared-protocol/src/schemas.ts` | Add job, context, setup-state and settings schemas. |
| `packages/shared-protocol/src/messages.ts` | Add v2 messages, extend `hello.ack` and `download.start`. |
| `packages/shared-protocol/src/version.ts` | `PROTOCOL_VERSION = 2`. |
| `apps/desktop/src/settings.ts` | Add `keepRunning`, `extensionUi`. |
| `apps/desktop/src/core/ipc.ts` | Pipe path, token file, framed connection wrapper, server, client. One responsibility: transport and auth. |
| `apps/desktop/src/core/provisioner.ts` | Silent tool install plus daily yt-dlp refresh, with status events. |
| `apps/desktop/src/core/idle.ts` | Idle-exit decision and timer. |
| `apps/desktop/src/core/service.ts` | Protocol handling, subscriptions, job mapping. No I/O of its own. |
| `apps/desktop/src/core/run-core.ts` | Wires ipc, provisioner, service, idle monitor into the `--core` process. |
| `apps/desktop/src/core/relay.ts` | stdio to pipe relay, core spawning. |
| `apps/desktop/src/core/autostart.ts` | Windows login autostart through the HKCU Run key. |
| `apps/desktop/src/cli.ts`, `apps/desktop/src/main.ts` | Hidden `--core` and `--native-host` dispatch. |
| `apps/desktop/src/interactive/screens/SettingsScreen.tsx` | Two new rows. |

---

### Task 1: Protocol v2

**Files:**
- Modify: `packages/shared-protocol/src/version.ts`
- Modify: `packages/shared-protocol/src/schemas.ts`
- Modify: `packages/shared-protocol/src/messages.ts`
- Test: `packages/shared-protocol/src/parse.test.ts`

**Interfaces:**
- Produces (schemas): `DownloadStatusSchema`, `DownloadJobSchema`, `RequestContextSchema`, `SetupStateSchema`, `ExtensionSettingsSchema`.
- Produces (messages): `JobsListMessage`, `JobsSubscribeMessage`, `JobsUnsubscribeMessage`, `SettingsGetMessage`, `SettingsSetMessage`, `JobsSnapshotMessage`, `SettingsValueMessage`, `SetupProgressMessage`. `HelloAckMessage` payload gains `setup` and `keepRunning`. `DownloadStartMessage` payload gains optional `context`.
- Produces (types): `ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>`, `SetupState = z.infer<typeof SetupStateSchema>`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared-protocol/src/parse.test.ts` (keep existing imports; add `ExtensionSettings` is not needed):

```ts
describe("protocol v2", () => {
  const v = PROTOCOL_VERSION;

  it("is version 2", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("accepts the new extension messages", () => {
    for (const type of ["jobs.list", "jobs.subscribe", "jobs.unsubscribe", "settings.get"]) {
      expect(parseExtensionMessage({ v, id: "1", type, payload: {} }).ok).toBe(true);
    }
  });

  it("accepts a partial settings.set and rejects a bad extensionUi", () => {
    const ok = parseExtensionMessage({
      v,
      id: "1",
      type: "settings.set",
      payload: { keepRunning: true },
    });
    expect(ok.ok).toBe(true);
    const bad = parseExtensionMessage({
      v,
      id: "1",
      type: "settings.set",
      payload: { extensionUi: "huge" },
    });
    expect(bad.ok).toBe(false);
  });

  it("accepts download.start with a request context", () => {
    const result = parseExtensionMessage({
      v,
      id: "1",
      type: "download.start",
      payload: {
        candidate,
        profileId: "best",
        context: { referer: "https://example.com/", headers: { Origin: "https://example.com" } },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("requires setup and keepRunning on hello.ack", () => {
    const base = {
      v,
      id: "1",
      type: "hello.ack",
      payload: {
        hostVersion: "0.3.0",
        ytDlp: { available: true },
        ffmpeg: { available: true },
      },
    };
    expect(parseHostMessage(base).ok).toBe(false);
    const full = { ...base, payload: { ...base.payload, setup: "ready", keepRunning: false } };
    expect(parseHostMessage(full).ok).toBe(true);
  });

  it("accepts jobs.snapshot, settings.value and setup.progress", () => {
    const job = {
      id: "j1",
      request: { candidate, profileId: "best" },
      status: "downloading",
      progress: { bytesDownloaded: 10 },
      createdAt: 1,
      updatedAt: 2,
    };
    expect(
      parseHostMessage({ v, id: "1", type: "jobs.snapshot", payload: { jobs: [job] } }).ok,
    ).toBe(true);
    expect(
      parseHostMessage({
        v,
        id: "1",
        type: "settings.value",
        payload: { extensionUi: "overlay", keepRunning: false },
      }).ok,
    ).toBe(true);
    expect(
      parseHostMessage({
        v,
        id: "1",
        type: "setup.progress",
        payload: { state: "installing", tool: "yt-dlp", phase: "downloading", percent: 40 },
      }).ok,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/shared-protocol/src/parse.test.ts`
Expected: FAIL (`PROTOCOL_VERSION` is 1; new types unknown).

- [ ] **Step 3: Implement**

`packages/shared-protocol/src/version.ts`:

```ts
/** Bump when a message shape changes incompatibly. */
export const PROTOCOL_VERSION = 2;
```

`packages/shared-protocol/src/schemas.ts`: add `DownloadJob` to the type import, then insert before the `// Compile-time guarantee` comment:

```ts
export const DownloadStatusSchema = z.enum([
  "queued",
  "downloading",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export const DownloadJobSchema = z.object({
  id: z.string(),
  request: DownloadRequestSchema,
  status: DownloadStatusSchema,
  progress: DownloadProgressSchema,
  outputPath: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** What a sniffed stream needs to be fetched the way the browser fetched it. */
export const RequestContextSchema = z.object({
  referer: z.string().optional(),
  userAgent: z.string().optional(),
  cookies: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const SetupStateSchema = z.enum(["ready", "installing", "failed"]);

/** The settings the extension may read and write. */
export const ExtensionSettingsSchema = z.object({
  extensionUi: z.enum(["popup", "overlay"]),
  keepRunning: z.boolean(),
  folder: z.string().optional(),
  quality: z.string().optional(),
});

export type SetupState = z.infer<typeof SetupStateSchema>;
export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;
```

and extend the `_SchemaChecks` tuple with `Assert<Equals<z.infer<typeof DownloadJobSchema>, DownloadJob>>,`.

`packages/shared-protocol/src/messages.ts`: change the import to

```ts
import {
  DownloadJobSchema,
  DownloadProgressSchema,
  DownloadRequestSchema,
  ExtensionSettingsSchema,
  RequestContextSchema,
  SetupStateSchema,
} from "./schemas.ts";
```

replace `DownloadStartMessage` and `HelloAckMessage`, add the new messages, and extend both unions:

```ts
export const DownloadStartMessage = message(
  "download.start",
  DownloadRequestSchema.extend({ context: RequestContextSchema.optional() }),
);
export const JobsListMessage = message("jobs.list", z.object({}));
export const JobsSubscribeMessage = message("jobs.subscribe", z.object({}));
export const JobsUnsubscribeMessage = message("jobs.unsubscribe", z.object({}));
export const SettingsGetMessage = message("settings.get", z.object({}));
export const SettingsSetMessage = message("settings.set", ExtensionSettingsSchema.partial());

export const HelloAckMessage = message(
  "hello.ack",
  z.object({
    hostVersion: z.string(),
    ytDlp: z.object({ available: z.boolean(), version: z.string().optional() }),
    ffmpeg: z.object({ available: z.boolean(), version: z.string().optional() }),
    setup: SetupStateSchema,
    keepRunning: z.boolean(),
  }),
);
export const JobsSnapshotMessage = message(
  "jobs.snapshot",
  z.object({ jobs: z.array(DownloadJobSchema) }),
);
export const SettingsValueMessage = message("settings.value", ExtensionSettingsSchema);
export const SetupProgressMessage = message(
  "setup.progress",
  z.object({
    state: SetupStateSchema,
    tool: z.enum(["yt-dlp", "ffmpeg", "deno"]).optional(),
    phase: z.string().optional(),
    percent: z.number().min(0).max(100).optional(),
    error: z.string().optional(),
  }),
);
```

Union additions: `ExtensionToHostMessage` gets `JobsListMessage, JobsSubscribeMessage, JobsUnsubscribeMessage, SettingsGetMessage, SettingsSetMessage`; `HostToExtensionMessage` gets `JobsSnapshotMessage, SettingsValueMessage, SetupProgressMessage`. Remove the old `HelloAckMessage` and `DownloadStartMessage` definitions.

- [ ] **Step 4: Run to verify pass, and fix fixtures**

Run: `pnpm exec vitest run packages/shared-protocol && pnpm typecheck`
Expected: PASS. If existing `hello.ack` fixtures in `parse.test.ts` fail, add `setup: "ready", keepRunning: false` to them.

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write packages/shared-protocol/src`
Print for the user (do not commit): title `✨ shared-protocol: add v2 messages for jobs, settings and setup`.

---

### Task 2: Settings fields and the Settings screen rows

**Files:**
- Modify: `apps/desktop/src/settings.ts`
- Modify: `apps/desktop/src/interactive/screens/SettingsScreen.tsx`
- Modify: `apps/desktop/src/interactive/App.test.tsx` (the reset test at the `toEqual({ askFolder: true, ... })` block)
- Create: `apps/desktop/src/settings-core.test.ts`

**Interfaces:**
- Produces: `Settings.keepRunning: boolean`, `Settings.extensionUi: "popup" | "overlay"`; both in `DEFAULT_SETTINGS` and `sanitizeSettings`.

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/settings-core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.ts";

describe("core settings", () => {
  it("defaults to on-demand core and the overlay", () => {
    expect(DEFAULT_SETTINGS.keepRunning).toBe(false);
    expect(DEFAULT_SETTINGS.extensionUi).toBe("overlay");
  });

  it("keeps valid values", () => {
    const s = sanitizeSettings({ keepRunning: true, extensionUi: "popup" });
    expect(s.keepRunning).toBe(true);
    expect(s.extensionUi).toBe("popup");
  });

  it("falls back to defaults for invalid values", () => {
    const s = sanitizeSettings({ keepRunning: "yes", extensionUi: "huge" });
    expect(s.keepRunning).toBe(false);
    expect(s.extensionUi).toBe("overlay");
  });
});
```

In `App.test.tsx`, replace the expected object in the reset test with:

```ts
    expect(await t.store.load()).toEqual({
      askFolder: true,
      askQuality: true,
      sortByType: true,
      concurrency: 2,
      keepRunning: false,
      extensionUi: "overlay",
    });
```

and add inside `describe("settings", ...)` before the "resets only after confirmation" test:

```ts
  it("turns background running on and off", async () => {
    const t = await openSettings();
    await moveTo(t.app, "Keep running in the background");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Saved");
    expect((await t.store.load()).keepRunning).toBe(true);
    t.app.unmount();
  });

  it("switches the browser button between popup and overlay", async () => {
    const t = await openSettings();
    await moveTo(t.app, "Download button on videos");
    await press(t.app, KEY.enter);
    await waitFor(t.app, "Saved");
    expect((await t.store.load()).extensionUi).toBe("popup");
    t.app.unmount();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/desktop/src/settings-core.test.ts apps/desktop/src/interactive/App.test.tsx -t "core settings|settings"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`settings.ts`: add to `Settings`:

```ts
  /** Keep the background core running with no idle exit, and start it at login. */
  keepRunning: boolean;
  /** Browser extension surface: toolbar popup only, or popup plus a button on videos. */
  extensionUi: "popup" | "overlay";
```

`DEFAULT_SETTINGS` gains `keepRunning: false, extensionUi: "overlay",`. In `sanitizeSettings` add to the `settings` literal:

```ts
    keepRunning:
      typeof o.keepRunning === "boolean" ? o.keepRunning : DEFAULT_SETTINGS.keepRunning,
    extensionUi:
      o.extensionUi === "popup" || o.extensionUi === "overlay"
        ? o.extensionUi
        : DEFAULT_SETTINGS.extensionUi,
```

`SettingsScreen.tsx`: add `"keepRunning" | "extensionUi"` to `Choice`; in `onSelect` add before the final `else setMode(choice)`:

```ts
          } else if (choice === "keepRunning") {
            void save({ ...settings, keepRunning: !settings.keepRunning });
          } else if (choice === "extensionUi") {
            void save({
              ...settings,
              extensionUi: settings.extensionUi === "overlay" ? "popup" : "overlay",
            });
```

(turn the preceding `else if (choice === "sortByType") {...}` closing brace so the chain stays valid) and insert in `items` after the `concurrency` entry:

```ts
          {
            value: "keepRunning",
            icon: ICONS.settings,
            label: "Keep running in the background",
            hint: `${settings.keepRunning ? ICONS.on : ICONS.off} ${settings.keepRunning ? "Yes, start at login" : "No, start when the browser needs it"}`,
          },
          {
            value: "extensionUi",
            icon: ICONS.video,
            label: "Download button on videos",
            hint: `${settings.extensionUi === "overlay" ? ICONS.on : ICONS.off} ${settings.extensionUi === "overlay" ? "Yes (browser extension)" : "No, toolbar popup only"}`,
          },
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/desktop && pnpm typecheck`
Expected: PASS. Fix any other test or fixture that builds a full `Settings` literal (typecheck lists them).

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write apps/desktop/src`
Print for the user: title `✨ desktop: add keepRunning and extensionUi settings`.

---

### Task 3: IPC transport and token auth

**Files:**
- Modify: `apps/desktop/package.json` (add `"@mediaforge/shared-protocol": "workspace:*"` to `dependencies`)
- Modify: `apps/desktop/tsconfig.json` (add `{ "path": "../../packages/shared-protocol" }` to `references`)
- Create: `apps/desktop/src/core/ipc.ts`
- Test: `apps/desktop/src/core/ipc.test.ts`

**Interfaces:**
- Produces:
  - `interface Connection { send(message: unknown): void; onMessage(h: (m: unknown) => void): void; onClose(h: () => void): void; close(): void }`
  - `pipePath(platform: NodeJS.Platform, env: Record<string, string | undefined>, username?: string): string`
  - `tokenPath(env: Record<string, string | undefined>, platform?: NodeJS.Platform, home?: string): string`
  - `writeToken(path: string, token: string): Promise<void>`, `readToken(path: string): Promise<string | undefined>`, `newToken(): string`
  - `listenCore(options: { path: string; token: string; onConnection: (conn: Connection) => void }): Promise<net.Server>`
  - `connectCore(options: { path: string; token: string }): Promise<Connection>`
- Behavior: the core never sends before it has received a request from the client.

- [ ] **Step 1: Install the workspace dependency**

Edit `package.json` and `tsconfig.json` as listed, then run `pnpm install`.
Expected: lockfile updated, no errors.

- [ ] **Step 2: Write the failing tests**

`apps/desktop/src/core/ipc.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Connection,
  connectCore,
  listenCore,
  newToken,
  pipePath,
  readToken,
  tokenPath,
  writeToken,
} from "./ipc.ts";

const servers: Server[] = [];
const dirs: string[] = [];

const testPath = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\mediaforge-test-${randomUUID()}`
    : join(tmpdir(), `mediaforge-test-${randomUUID()}.sock`);

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const nextMessage = (conn: Connection) =>
  new Promise<unknown>((resolve) => conn.onMessage(resolve));

describe("pipePath", () => {
  it("is a named pipe on Windows", () => {
    expect(pipePath("win32", {}, "neil")).toBe("\\\\.\\pipe\\mediaforge-neil");
  });

  it("is a socket file elsewhere, and sanitizes the user name", () => {
    expect(pipePath("linux", { XDG_RUNTIME_DIR: "/run/user/1" }, "a b")).toBe(
      join("/run/user/1", "mediaforge-a_b.sock"),
    );
  });
});

describe("token file", () => {
  it("round-trips a token and reports a missing file as undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mf-token-"));
    dirs.push(dir);
    const path = join(dir, "sub", "core.token");
    expect(await readToken(path)).toBeUndefined();
    const token = newToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await writeToken(path, token);
    expect(await readToken(path)).toBe(token);
  });

  it("lives next to the settings file", () => {
    expect(tokenPath({ APPDATA: "C:\\Users\\n\\AppData\\Roaming" }, "win32")).toBe(
      join("C:\\Users\\n\\AppData\\Roaming", "MediaForge", "core.token"),
    );
  });
});

describe("listenCore and connectCore", () => {
  it("exchanges framed messages after the handshake", async () => {
    const path = testPath();
    const token = newToken();
    servers.push(
      await listenCore({
        path,
        token,
        onConnection: (conn) => conn.onMessage((m) => conn.send({ echo: m })),
      }),
    );
    const client = await connectCore({ path, token });
    const reply = nextMessage(client);
    client.send({ hello: "core" });
    expect(await reply).toEqual({ echo: { hello: "core" } });
    client.close();
  });

  it("rejects a wrong token", async () => {
    const path = testPath();
    servers.push(await listenCore({ path, token: newToken(), onConnection: () => {} }));
    await expect(connectCore({ path, token: "nope" })).rejects.toThrow();
  });

  it("refuses a second listener on the same path", async () => {
    const path = testPath();
    servers.push(await listenCore({ path, token: newToken(), onConnection: () => {} }));
    await expect(
      listenCore({ path, token: newToken(), onConnection: () => {} }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("rejects when nothing is listening", async () => {
    await expect(connectCore({ path: testPath(), token: "x" })).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm exec vitest run apps/desktop/src/core/ipc.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `apps/desktop/src/core/ipc.ts`**

```ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  createDecoder,
  encodeMessage,
  MAX_EXTENSION_MESSAGE_BYTES,
  MAX_HOST_MESSAGE_BYTES,
} from "@mediaforge/shared-protocol";
import { settingsPath } from "../settings.ts";

/** A framed, already-authenticated link between a client and the core. */
export interface Connection {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

const HANDSHAKE_TIMEOUT_MS = 5000;

const safeName = (name: string) => name.replace(/[^A-Za-z0-9_.-]/g, "_");

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "user";
  }
}

/** Where the core listens. One per user, so two Windows accounts never share a core. */
export function pipePath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  username: string = currentUser(),
): string {
  const name = `mediaforge-${safeName(username)}`;
  if (platform === "win32") return `\\\\.\\pipe\\${name}`;
  return join(env.XDG_RUNTIME_DIR ?? tmpdir(), `${name}.sock`);
}

/** The per-user token file, in the same folder as the settings file. */
export function tokenPath(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return join(dirname(settingsPath(env, platform, home)), "core.token");
}

export const newToken = (): string => randomBytes(32).toString("hex");

export async function writeToken(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, token, { encoding: "utf8", mode: 0o600 });
}

export async function readToken(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

interface WrapOptions {
  /** Largest frame this side may send. */
  maxSendBytes?: number;
}

export function wrapSocket(socket: net.Socket, options: WrapOptions = {}): Connection {
  const maxSendBytes = options.maxSendBytes ?? MAX_HOST_MESSAGE_BYTES;
  const decoder = createDecoder();
  let messageHandler: (message: unknown) => void = () => {};
  let closeHandler: () => void = () => {};

  socket.on("data", (chunk) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    // A handshake handler may swap `messageHandler` while this loop runs, so read it each time.
    for (const message of messages) messageHandler(message);
  });
  socket.on("close", () => closeHandler());
  socket.on("error", () => socket.destroy());

  return {
    send(message) {
      if (!socket.destroyed) socket.write(encodeMessage(message, maxSendBytes));
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    close() {
      socket.end();
    },
  };
}

function tokenMatches(value: unknown, expected: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const given = (value as { token?: unknown }).token;
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ListenOptions {
  path: string;
  token: string;
  /** Called once per authenticated client. Register handlers synchronously. */
  onConnection: (conn: Connection) => void;
}

/**
 * Start the core's server. Rejects with `EADDRINUSE` when another core already holds the pipe,
 * which is how a second instance learns it is not needed.
 */
export function listenCore({ path, token, onConnection }: ListenOptions): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const conn = wrapSocket(socket);
      const timer = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);
      socket.on("close", () => clearTimeout(timer));
      conn.onMessage((first) => {
        clearTimeout(timer);
        if (!tokenMatches(first, token)) {
          socket.destroy();
          return;
        }
        conn.send({ ok: true });
        onConnection(conn);
      });
    });
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export interface ConnectOptions {
  path: string;
  token: string;
}

/** Connect and authenticate. Rejects when nothing listens or the token is refused. */
export function connectCore({ path, token }: ConnectOptions): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    const conn = wrapSocket(socket, { maxSendBytes: MAX_EXTENSION_MESSAGE_BYTES });
    const rejectOnClose = () => reject(new Error("Core closed the connection."));
    socket.once("error", reject);
    socket.once("close", rejectOnClose);
    socket.once("connect", () => {
      conn.onMessage((reply) => {
        const ok = typeof reply === "object" && reply !== null && (reply as { ok?: unknown }).ok;
        if (ok === true) {
          socket.off("error", reject);
          socket.off("close", rejectOnClose);
          resolve(conn);
        } else {
          socket.destroy();
          reject(new Error("Core refused the handshake."));
        }
      });
      conn.send({ token });
    });
  });
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm exec vitest run apps/desktop/src/core/ipc.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Lint and print commit message**

Run: `pnpm exec biome check --write apps/desktop/src/core apps/desktop/package.json apps/desktop/tsconfig.json`
Print: title `✨ desktop: add named-pipe IPC with token handshake for the core`.

---

### Task 4: Provisioner and idle monitor

**Files:**
- Create: `apps/desktop/src/core/provisioner.ts`
- Create: `apps/desktop/src/core/idle.ts`
- Test: `apps/desktop/src/core/provisioner.test.ts`, `apps/desktop/src/core/idle.test.ts`

**Interfaces:**
- Consumes: `ToolRuntime`, `acquireTool`, `tryResolve`, `toCliError` from `../tool-runtime.ts`; `isRequired` from `../doctor.ts`; `makeRuntime` from `../test-runtime.ts` (tests).
- Produces:
  - `interface SetupStatus { state: SetupState; tool?: Tool; phase?: string; percent?: number; error?: string }`
  - `interface Provisioner { status(): SetupStatus; onChange(l: (s: SetupStatus) => void): () => void; ready(): Promise<SetupStatus> }`
  - `startProvisioning(rt: ToolRuntime, options?: { tools?: Tool[]; refresh?: { stale: () => Promise<boolean>; stamp: () => Promise<void> } }): Provisioner`
  - `class IdleMonitor { constructor(o: { graceMs: number; isIdle: () => boolean; keepRunning: () => Promise<boolean>; onIdle: () => void }); check(): Promise<void>; stop(): void }`

- [ ] **Step 1: Write the failing tests**

`provisioner.test.ts`:

```ts
import { ToolInstallError } from "@mediaforge/binary-resolver";
import { describe, expect, it } from "vitest";
import { makeRuntime } from "../test-runtime.ts";
import { startProvisioning } from "./provisioner.ts";

describe("startProvisioning", () => {
  it("is ready at once when every tool is present", async () => {
    const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
    const result = await startProvisioning(rt).ready();
    expect(result.state).toBe("ready");
    expect(log.installed).toEqual([]);
  });

  it("downloads missing tools without asking, and reports progress", async () => {
    const { rt, log } = makeRuntime({ present: ["deno"], interactive: false });
    const provisioner = startProvisioning(rt);
    const seen: string[] = [];
    provisioner.onChange((s) => seen.push(`${s.state}:${s.tool ?? ""}`));
    const result = await provisioner.ready();
    expect(result.state).toBe("ready");
    expect(log.installed.sort()).toEqual(["ffmpeg", "yt-dlp"]);
    expect(log.asked).toEqual([]);
    expect(seen).toContain("installing:yt-dlp");
  });

  it("fails when a required tool cannot be installed", async () => {
    const { rt } = makeRuntime({
      present: ["deno"],
      installError: new ToolInstallError("offline", "Could not reach github.com.", "Check it."),
    });
    const result = await startProvisioning(rt).ready();
    expect(result.state).toBe("failed");
    expect(result.error).toContain("Could not reach github.com.");
  });

  it("ignores a failed optional tool", async () => {
    const { rt, present } = makeRuntime({
      present: ["yt-dlp", "ffmpeg"],
      installError: new ToolInstallError("offline", "no", "no"),
    });
    expect(present.has("deno")).toBe(false);
    const result = await startProvisioning(rt).ready();
    expect(result.state).toBe("ready");
  });

  it("refreshes yt-dlp when the stamp is stale, and stamps it", async () => {
    const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
    let stamped = false;
    await startProvisioning(rt, {
      refresh: { stale: async () => true, stamp: async () => void (stamped = true) },
    }).ready();
    expect(log.installed).toEqual(["yt-dlp"]);
    expect(stamped).toBe(true);
  });

  it("does not refresh when the stamp is fresh, and survives a failed refresh", async () => {
    const fresh = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
    await startProvisioning(fresh.rt, {
      refresh: { stale: async () => false, stamp: async () => {} },
    }).ready();
    expect(fresh.log.installed).toEqual([]);

    const broken = makeRuntime({
      present: ["yt-dlp", "ffmpeg", "deno"],
      installError: new ToolInstallError("offline", "no", "no"),
    });
    const result = await startProvisioning(broken.rt, {
      refresh: { stale: async () => true, stamp: async () => {} },
    }).ready();
    expect(result.state).toBe("ready");
  });
});
```

`idle.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleMonitor } from "./idle.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(state: { idle: boolean; keep: boolean }) {
  const onIdle = vi.fn();
  const monitor = new IdleMonitor({
    graceMs: 60_000,
    isIdle: () => state.idle,
    keepRunning: async () => state.keep,
    onIdle,
  });
  return { monitor, onIdle };
}

describe("IdleMonitor", () => {
  it("exits after the grace period when idle and not kept running", async () => {
    const { monitor, onIdle } = setup({ idle: true, keep: false });
    await monitor.check();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does not exit while jobs or clients are active", async () => {
    const state = { idle: false, keep: false };
    const { monitor, onIdle } = setup(state);
    await monitor.check();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("cancels the countdown when work arrives", async () => {
    const state = { idle: true, keep: false };
    const { monitor, onIdle } = setup(state);
    await monitor.check();
    state.idle = false;
    await monitor.check();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("never exits while keepRunning is on, and exits once it is turned off", async () => {
    const state = { idle: true, keep: true };
    const { monitor, onIdle } = setup(state);
    await monitor.check();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onIdle).not.toHaveBeenCalled();
    state.keep = false;
    await monitor.check();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("re-checks when the timer fires, so late work wins", async () => {
    const state = { idle: true, keep: false };
    const { monitor, onIdle } = setup(state);
    await monitor.check();
    state.idle = false;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/desktop/src/core/provisioner.test.ts apps/desktop/src/core/idle.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`apps/desktop/src/core/idle.ts`:

```ts
export interface IdleMonitorOptions {
  graceMs: number;
  /** True when no jobs are queued or running and no client is connected. */
  isIdle: () => boolean;
  /** Read fresh each time, so turning the setting off lets a resident core exit. */
  keepRunning: () => Promise<boolean>;
  onIdle: () => void;
}

export class IdleMonitor {
  readonly #options: IdleMonitorOptions;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: IdleMonitorOptions) {
    this.#options = options;
  }

  /** Call whenever a client or job changes, and now and then so a settings change is noticed. */
  async check(): Promise<void> {
    if (!this.#options.isIdle() || (await this.#options.keepRunning())) {
      this.stop();
      return;
    }
    if (this.#timer) return;
    this.#timer = setTimeout(() => void this.#fire(), this.#options.graceMs);
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #fire(): Promise<void> {
    this.#timer = undefined;
    if (this.#options.isIdle() && !(await this.#options.keepRunning())) this.#options.onIdle();
  }
}
```

`apps/desktop/src/core/provisioner.ts`:

```ts
import type { InstallProgress, Tool } from "@mediaforge/binary-resolver";
import type { SetupState } from "@mediaforge/shared-protocol";
import { isRequired } from "../doctor.ts";
import { acquireTool, type ToolRuntime, tryResolve } from "../tool-runtime.ts";

export interface SetupStatus {
  state: SetupState;
  tool?: Tool;
  phase?: string;
  percent?: number;
  error?: string;
}

export interface Provisioner {
  status(): SetupStatus;
  onChange(listener: (status: SetupStatus) => void): () => void;
  /** Resolves once the required tools are ready or provisioning has failed. Never rejects. */
  ready(): Promise<SetupStatus>;
}

export interface ProvisionOptions {
  tools?: Tool[];
  /** Keeps yt-dlp fresh: `stale` says whether a refresh is due, `stamp` records that one ran. */
  refresh?: { stale: () => Promise<boolean>; stamp: () => Promise<void> };
}

const DEFAULT_TOOLS: Tool[] = ["yt-dlp", "ffmpeg", "deno"];

const percentOf = (progress: InstallProgress): number | undefined =>
  progress.phase === "downloading" && progress.total && progress.received
    ? Math.min(100, (progress.received / progress.total) * 100)
    : undefined;

/** Make the tools available with no prompt. Runs in the background; check `ready()`. */
export function startProvisioning(rt: ToolRuntime, options: ProvisionOptions = {}): Provisioner {
  const tools = options.tools ?? DEFAULT_TOOLS;
  const listeners = new Set<(status: SetupStatus) => void>();
  let current: SetupStatus = { state: "installing" };

  const publish = (next: SetupStatus) => {
    current = next;
    for (const listener of listeners) listener(next);
  };

  const run = async (): Promise<SetupStatus> => {
    // Nothing here touches the terminal: the core never prompts.
    const silent: ToolRuntime = { ...rt, interactive: false };
    for (const tool of tools) {
      if (await tryResolve(tool, rt.resolve)) continue;
      publish({ state: "installing", tool });
      try {
        await acquireTool(tool, silent, {
          onProgress: (progress) => {
            const percent = percentOf(progress);
            publish({
              state: "installing",
              tool,
              phase: progress.phase,
              ...(percent !== undefined && { percent }),
            });
          },
        });
      } catch (error) {
        if (isRequired(tool)) {
          const failed: SetupStatus = {
            state: "failed",
            tool,
            error: error instanceof Error ? error.message : String(error),
          };
          publish(failed);
          return failed;
        }
      }
    }
    await refreshYtDlp();
    const ready: SetupStatus = { state: "ready" };
    publish(ready);
    return ready;
  };

  const refreshYtDlp = async (): Promise<void> => {
    const refresh = options.refresh;
    if (!refresh) return;
    try {
      if (!(await refresh.stale())) return;
      publish({ state: "installing", tool: "yt-dlp", phase: "refreshing" });
      await rt.install("yt-dlp", () => {});
      await refresh.stamp();
    } catch {
      // A failed refresh keeps the copy that already works.
    }
  };

  const done = run();

  return {
    status: () => current,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    ready: () => done,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/desktop/src/core && pnpm typecheck`
Expected: PASS. If `InstallProgress` is not exported from `@mediaforge/binary-resolver`, import it from the path `tool-runtime.ts` already uses for it.

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write apps/desktop/src/core`
Print: title `✨ desktop: add silent tool provisioning and idle monitor for the core`.

---

### Task 5: Core service

**Files:**
- Create: `apps/desktop/src/core/service.ts`
- Test: `apps/desktop/src/core/service.test.ts`

**Interfaces:**
- Consumes: `DownloadEngine`, `EngineJob` (`../engine/index.ts`); `SettingsStore`, `Settings`, `sanitizeSettings` (`../settings.ts`); `Provisioner`, `SetupStatus` (`./provisioner.ts`); `parseExtensionMessage`, `PROTOCOL_VERSION`, `HostToExtensionMessage`, `ExtensionToHostMessage` (`@mediaforge/shared-protocol`); `getProfile` (`@mediaforge/media-profiles`); `kindOfProfile`, `withKindFolder` (`../kind-folder.ts`); `defaultOutputDir` (`../engine/paths.ts`).
- Produces:
  - `interface ServiceClient { send(message: HostToExtensionMessage): void }`
  - `interface ClientHandle { handle(raw: unknown): Promise<void>; detach(): void }`
  - `interface CoreServiceDeps { createEngine(onUpdate: (job: EngineJob) => void): DownloadEngine; settings: SettingsStore; provisioner: Provisioner; version: string; probeTool(tool: "yt-dlp" | "ffmpeg"): Promise<{ available: boolean; version?: string }>; applyAutostart(enabled: boolean): Promise<void>; onActivity(): void; now(): number; newId(): string }`
  - `class CoreService { constructor(deps); attach(client: ServiceClient): ClientHandle; get isIdle(): boolean }` — `isIdle` is true when no clients are attached and the engine has no queued or running job.

- [ ] **Step 1: Write the failing tests**

`service.test.ts` uses a fake engine so it never spawns yt-dlp:

```ts
import type { MediaCandidate } from "@mediaforge/shared-types";
import { describe, expect, it, vi } from "vitest";
import type { EngineJob } from "../engine/index.ts";
import { memorySettingsStore } from "../settings.ts";
import { PROTOCOL_VERSION, type HostToExtensionMessage } from "@mediaforge/shared-protocol";
import type { Provisioner, SetupStatus } from "./provisioner.ts";
import { CoreService } from "./service.ts";

const candidate: MediaCandidate = {
  id: "c",
  pageUrl: "https://example.com/watch",
  url: "https://example.com/watch",
  kind: "video",
  streamType: "progressive",
  source: "dom",
  variants: [],
  detectedAt: 0,
};

function fakeEngine() {
  const jobs = new Map<string, EngineJob>();
  let n = 0;
  const submitted: unknown[] = [];
  const engine = {
    submit: (request: EngineJob["request"]) => {
      const job: EngineJob = {
        id: `job-${++n}`,
        request,
        status: "queued",
        progress: { bytesDownloaded: 0 },
        createdAt: 1,
        updatedAt: 1,
      };
      jobs.set(job.id, job);
      submitted.push(request);
      return { ...job };
    },
    cancel: (id: string) => jobs.has(id),
    list: () => [...jobs.values()],
    get: (id: string) => jobs.get(id),
  };
  return { engine, jobs, submitted };
}

function setup(options: { setup?: SetupStatus } = {}) {
  const fake = fakeEngine();
  let push: (job: EngineJob) => void = () => {};
  const status = options.setup ?? { state: "ready" as const };
  const provisioner: Provisioner = {
    status: () => status,
    onChange: () => () => {},
    ready: async () => status,
  };
  const autostart = vi.fn(async () => {});
  let clock = 0;
  const service = new CoreService({
    createEngine: (onUpdate) => {
      push = onUpdate;
      return fake.engine as never;
    },
    settings: memorySettingsStore(),
    provisioner,
    version: "9.9.9",
    probeTool: async () => ({ available: true, version: "1" }),
    applyAutostart: autostart,
    onActivity: () => {},
    now: () => clock,
    newId: () => `id-${++clock}`,
  });
  const sent: HostToExtensionMessage[] = [];
  const handle = service.attach({ send: (m) => sent.push(m) });
  const send = (type: string, payload: unknown = {}, id = "req") =>
    handle.handle({ v: PROTOCOL_VERSION, id, type, payload });
  const advance = (ms: number) => void (clock += ms);
  return { service, handle, sent, send, fake, push: (j: EngineJob) => push(j), autostart, advance };
}

describe("hello", () => {
  it("answers with versions, tool availability, setup state and keepRunning", async () => {
    const t = setup();
    await t.send("hello", { extensionVersion: "1", browser: "chrome" });
    expect(t.sent[0]).toMatchObject({
      id: "req",
      type: "hello.ack",
      payload: {
        hostVersion: "9.9.9",
        ytDlp: { available: true },
        setup: "ready",
        keepRunning: false,
      },
    });
  });
});

describe("validation", () => {
  it("answers invalid messages with an error that names the request", async () => {
    const t = setup();
    await t.handle.handle({ v: PROTOCOL_VERSION, id: "x", type: "nope", payload: {} });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "invalid-message", replyTo: "x" } });
  });
});

describe("download.start", () => {
  it("queues the job, applies the type folder, and replies queued", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "best" }, "r1");
    expect(t.sent[0]).toMatchObject({
      id: "r1",
      type: "download.progress",
      payload: { jobId: "job-1", status: "queued" },
    });
    const request = t.fake.submitted[0] as { outputDir?: string };
    expect(request.outputDir).toMatch(/Video/);
  });

  it("rejects an unknown profile", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "nope" });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "unknown-profile" } });
  });
});

describe("job updates", () => {
  it("sends terminal states to the owner and throttles progress", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.sent.length = 0;
    const base = t.fake.jobs.get("job-1") as EngineJob;
    const progress = (bytes: number): EngineJob => ({
      ...base,
      status: "downloading",
      progress: { bytesDownloaded: bytes },
    });
    t.push(progress(1));
    t.push(progress(2));
    t.push(progress(3));
    expect(t.sent.filter((m) => m.type === "download.progress")).toHaveLength(1);
    t.advance(300);
    t.push(progress(4));
    expect(t.sent.filter((m) => m.type === "download.progress")).toHaveLength(2);
    t.push({ ...base, status: "completed", outputPath: "C:\\v.mp4" });
    expect(t.sent.at(-1)).toMatchObject({
      type: "download.completed",
      payload: { jobId: "job-1", outputPath: "C:\\v.mp4" },
    });
  });

  it("reports a cancelled job as failed with cancelled true", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.push({ ...(t.fake.jobs.get("job-1") as EngineJob), status: "cancelled" });
    expect(t.sent.at(-1)).toMatchObject({
      type: "download.failed",
      payload: { jobId: "job-1", cancelled: true },
    });
  });

  it("keeps the job after the client detaches", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.handle.detach();
    expect(t.service.isIdle).toBe(false);
    const b = setup();
    expect(b.service.isIdle).toBe(false);
  });
});

describe("jobs and settings", () => {
  it("lists jobs as a snapshot without engine-only fields", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.sent.length = 0;
    await t.send("jobs.list");
    const snapshot = t.sent[0] as Extract<HostToExtensionMessage, { type: "jobs.snapshot" }>;
    expect(snapshot.payload.jobs).toHaveLength(1);
    expect(Object.keys(snapshot.payload.jobs[0] as object)).not.toContain("steps");
  });

  it("subscribers see jobs they did not start", async () => {
    const t = setup();
    const other: HostToExtensionMessage[] = [];
    const otherHandle = t.service.attach({ send: (m) => other.push(m) });
    await otherHandle.handle({ v: PROTOCOL_VERSION, id: "s", type: "jobs.subscribe", payload: {} });
    await t.send("download.start", { candidate, profileId: "best" });
    t.push({ ...(t.fake.jobs.get("job-1") as EngineJob), status: "downloading" });
    expect(other.some((m) => m.type === "download.progress")).toBe(true);
  });

  it("persists settings.set, returns the merged value, and syncs autostart", async () => {
    const t = setup();
    await t.send("settings.set", { keepRunning: true, extensionUi: "popup" });
    expect(t.sent[0]).toMatchObject({
      type: "settings.value",
      payload: { keepRunning: true, extensionUi: "popup" },
    });
    expect(t.autostart).toHaveBeenCalledWith(true);
    t.sent.length = 0;
    await t.send("settings.get");
    expect(t.sent[0]).toMatchObject({ payload: { keepRunning: true } });
  });

  it("cancel reports an unknown job", async () => {
    const t = setup();
    await t.send("download.cancel", { jobId: "ghost" });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "unknown-job" } });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/desktop/src/core/service.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `apps/desktop/src/core/service.ts`**

```ts
import { getProfile } from "@mediaforge/media-profiles";
import {
  type ExtensionToHostMessage,
  type HostToExtensionMessage,
  PROTOCOL_VERSION,
  parseExtensionMessage,
} from "@mediaforge/shared-protocol";
import type { DownloadJob } from "@mediaforge/shared-types";
import type { DownloadEngine, EngineJob } from "../engine/index.ts";
import { defaultOutputDir } from "../engine/paths.ts";
import { kindOfProfile, withKindFolder } from "../kind-folder.ts";
import { sanitizeSettings, type SettingsStore } from "../settings.ts";
import type { Provisioner, SetupStatus } from "./provisioner.ts";

export interface ServiceClient {
  send(message: HostToExtensionMessage): void;
}

export interface ClientHandle {
  handle(raw: unknown): Promise<void>;
  detach(): void;
}

export interface CoreServiceDeps {
  createEngine(onUpdate: (job: EngineJob) => void): DownloadEngine;
  settings: SettingsStore;
  provisioner: Provisioner;
  version: string;
  probeTool(tool: "yt-dlp" | "ffmpeg"): Promise<{ available: boolean; version?: string }>;
  applyAutostart(enabled: boolean): Promise<void>;
  /** Called after every client or job change, so the idle monitor can re-check. */
  onActivity(): void;
  now(): number;
  newId(): string;
}

interface ClientState {
  client: ServiceClient;
  subscribedAll: boolean;
  jobs: Set<string>;
}

/** Progress for one job is sent at most this often; terminal states always go through. */
const PROGRESS_INTERVAL_MS = 250;
/** `jobs.snapshot` carries the newest jobs only, to stay under the 1 MiB host message cap. */
const SNAPSHOT_LIMIT = 200;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

const toProtocolJob = (job: EngineJob): DownloadJob => ({
  id: job.id,
  request: job.request,
  status: job.status,
  progress: job.progress,
  ...(job.outputPath !== undefined && { outputPath: job.outputPath }),
  ...(job.error !== undefined && { error: job.error }),
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
});

export class CoreService {
  readonly #deps: CoreServiceDeps;
  readonly #engine: DownloadEngine;
  readonly #clients = new Set<ClientState>();
  readonly #lastProgress = new Map<string, number>();

  constructor(deps: CoreServiceDeps) {
    this.#deps = deps;
    this.#engine = deps.createEngine((job) => this.#onJob(job));
    deps.provisioner.onChange((status) => this.#broadcastSetup(status));
  }

  /** True when no client is attached and no job is queued or running. */
  get isIdle(): boolean {
    return (
      this.#clients.size === 0 && this.#engine.list().every((job) => TERMINAL.has(job.status))
    );
  }

  attach(client: ServiceClient): ClientHandle {
    const state: ClientState = { client, subscribedAll: false, jobs: new Set() };
    this.#clients.add(state);
    this.#deps.onActivity();
    return {
      handle: (raw) => this.#handle(state, raw),
      detach: () => {
        this.#clients.delete(state);
        this.#deps.onActivity();
      },
    };
  }

  #reply<T extends HostToExtensionMessage["type"]>(
    state: ClientState,
    id: string,
    type: T,
    payload: Extract<HostToExtensionMessage, { type: T }>["payload"],
  ): void {
    state.client.send({ v: PROTOCOL_VERSION, id, type, payload } as HostToExtensionMessage);
  }

  #error(state: ClientState, replyTo: string, code: string, message: string): void {
    this.#reply(state, this.#deps.newId(), "error", { code, message, replyTo });
  }

  async #handle(state: ClientState, raw: unknown): Promise<void> {
    const parsed = parseExtensionMessage(raw);
    if (!parsed.ok) {
      const id = (raw as { id?: unknown } | null)?.id;
      this.#error(state, typeof id === "string" ? id : "", "invalid-message", parsed.error);
      return;
    }
    try {
      await this.#dispatch(state, parsed.value);
    } catch (error) {
      this.#error(
        state,
        parsed.value.id,
        "internal",
        error instanceof Error ? error.message : String(error),
      );
    }
    this.#deps.onActivity();
  }

  async #dispatch(state: ClientState, message: ExtensionToHostMessage): Promise<void> {
    switch (message.type) {
      case "hello":
      case "host.info":
        return this.#hello(state, message.id);
      case "download.start":
        return this.#start(state, message);
      case "download.cancel": {
        if (!this.#engine.cancel(message.payload.jobId)) {
          this.#error(state, message.id, "unknown-job", "No such job, or it already finished.");
        }
        return;
      }
      case "jobs.list": {
        const jobs = this.#engine
          .list()
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(-SNAPSHOT_LIMIT)
          .map(toProtocolJob);
        return this.#reply(state, message.id, "jobs.snapshot", { jobs });
      }
      case "jobs.subscribe":
        state.subscribedAll = true;
        return;
      case "jobs.unsubscribe":
        state.subscribedAll = false;
        return;
      case "settings.get":
        return this.#sendSettings(state, message.id);
      case "settings.set":
        return this.#setSettings(state, message);
    }
  }

  async #hello(state: ClientState, id: string): Promise<void> {
    const [ytDlp, ffmpeg, settings] = await Promise.all([
      this.#deps.probeTool("yt-dlp"),
      this.#deps.probeTool("ffmpeg"),
      this.#deps.settings.load(),
    ]);
    this.#reply(state, id, "hello.ack", {
      hostVersion: this.#deps.version,
      ytDlp,
      ffmpeg,
      setup: this.#deps.provisioner.status().state,
      keepRunning: settings.keepRunning,
    });
  }

  async #start(
    state: ClientState,
    message: Extract<ExtensionToHostMessage, { type: "download.start" }>,
  ): Promise<void> {
    const { context: _context, ...request } = message.payload;
    const profile = getProfile(request.profileId);
    if (!profile) {
      this.#error(state, message.id, "unknown-profile", `Unknown profile: ${request.profileId}`);
      return;
    }
    const settings = await this.#deps.settings.load();
    const base = request.outputDir ?? settings.folder;
    const outputDir = settings.sortByType
      ? withKindFolder(base ?? defaultOutputDir(), kindOfProfile(profile), true)
      : base;
    const job = this.#engine.submit({
      ...request,
      ...(outputDir && { outputDir }),
    });
    state.jobs.add(job.id);
    this.#reply(state, message.id, "download.progress", {
      jobId: job.id,
      status: "queued",
      progress: job.progress,
    });
  }

  async #sendSettings(state: ClientState, id: string): Promise<void> {
    const s = await this.#deps.settings.load();
    this.#reply(state, id, "settings.value", {
      extensionUi: s.extensionUi,
      keepRunning: s.keepRunning,
      ...(s.folder && { folder: s.folder }),
      ...(s.quality && { quality: s.quality }),
    });
  }

  async #setSettings(
    state: ClientState,
    message: Extract<ExtensionToHostMessage, { type: "settings.set" }>,
  ): Promise<void> {
    const current = await this.#deps.settings.load();
    const next = sanitizeSettings({ ...current, ...message.payload });
    await this.#deps.settings.save(next);
    if (next.keepRunning !== current.keepRunning) {
      await this.#deps.applyAutostart(next.keepRunning);
    }
    await this.#sendSettings(state, message.id);
  }

  #onJob(job: EngineJob): void {
    const terminal = TERMINAL.has(job.status);
    if (!terminal) {
      const last = this.#lastProgress.get(job.id);
      const now = this.#deps.now();
      if (last !== undefined && now - last < PROGRESS_INTERVAL_MS) return;
      this.#lastProgress.set(job.id, now);
    } else {
      this.#lastProgress.delete(job.id);
    }
    for (const state of this.#clients) {
      if (!state.subscribedAll && !state.jobs.has(job.id)) continue;
      this.#sendJob(state, job);
    }
    this.#deps.onActivity();
  }

  #sendJob(state: ClientState, job: EngineJob): void {
    const id = this.#deps.newId();
    if (job.status === "completed") {
      this.#reply(state, id, "download.completed", {
        jobId: job.id,
        outputPath: job.outputPath ?? "",
      });
    } else if (job.status === "failed") {
      this.#reply(state, id, "download.failed", {
        jobId: job.id,
        error: job.error ?? "Download failed.",
      });
    } else if (job.status === "cancelled") {
      this.#reply(state, id, "download.failed", {
        jobId: job.id,
        error: "Cancelled.",
        cancelled: true,
      });
    } else {
      this.#reply(state, id, "download.progress", {
        jobId: job.id,
        status: job.status,
        progress: job.progress,
      });
    }
  }

  #broadcastSetup(status: SetupStatus): void {
    for (const state of this.#clients) {
      this.#reply(state, this.#deps.newId(), "setup.progress", {
        state: status.state,
        ...(status.tool && { tool: status.tool }),
        ...(status.phase && { phase: status.phase }),
        ...(status.percent !== undefined && { percent: status.percent }),
        ...(status.error && { error: status.error }),
      });
    }
  }
}
```

The test case "keeps the job after the client detaches" asserts `isIdle` is `false` because a queued job remains; the second assertion (`setup().service.isIdle` is false because the new service still has its attached client) documents that an attached client also blocks idle. Remove the second `setup()` lines if you prefer one assertion per test; the first is the one that matters.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/desktop/src/core/service.test.ts && pnpm typecheck`
Expected: PASS. If `DownloadEngine` or `EngineJob` is not re-exported from `../engine/index.ts`, import from `../engine/engine.ts`.

- [ ] **Step 5: Lint and print commit message**

Run: `pnpm exec biome check --write apps/desktop/src/core`
Print: title `✨ desktop: add the core service that serves the extension protocol`.

---

### Task 6: Autostart, core runner, relay

**Files:**
- Create: `apps/desktop/src/core/autostart.ts`
- Create: `apps/desktop/src/core/run-core.ts`
- Create: `apps/desktop/src/core/relay.ts`
- Test: `apps/desktop/src/core/autostart.test.ts`, `apps/desktop/src/core/relay.test.ts`, `apps/desktop/src/core/run-core.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3 to 5.
- Produces:
  - `coreSpawnCommand(execPath: string, argv1: string | undefined): { command: string; args: string[] }`
  - `applyAutostart(enabled: boolean, deps?: AutostartDeps): Promise<void>`
  - `runCore(deps: RunCoreDeps): Promise<number>` and `runDefaultCore(): Promise<number>`
  - `runRelay(deps: RelayDeps): Promise<number>` and `runDefaultRelay(): Promise<number>`

- [ ] **Step 1: Write the failing tests**

`autostart.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { applyAutostart, coreSpawnCommand } from "./autostart.ts";

describe("coreSpawnCommand", () => {
  it("runs the packaged exe with --core", () => {
    expect(coreSpawnCommand("C:\\MediaForge\\MediaForge.exe", "snapshot.js")).toEqual({
      command: "C:\\MediaForge\\MediaForge.exe",
      args: ["--core"],
    });
  });

  it("passes the script when running through node", () => {
    expect(coreSpawnCommand("C:\\node\\node.exe", "C:\\repo\\dist\\main.js")).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\repo\\dist\\main.js", "--core"],
    });
  });
});

describe("applyAutostart", () => {
  it("adds the Run key on Windows", async () => {
    const run = vi.fn(async () => {});
    await applyAutostart(true, {
      platform: "win32",
      execPath: "C:\\MediaForge\\MediaForge.exe",
      argv1: undefined,
      run,
    });
    expect(run).toHaveBeenCalledWith("reg.exe", [
      "add",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      "MediaForge",
      "/t",
      "REG_SZ",
      "/d",
      '"C:\\MediaForge\\MediaForge.exe" --core',
      "/f",
    ]);
  });

  it("removes the key, and ignores a key that is already gone", async () => {
    const run = vi.fn(async () => {
      throw new Error("not found");
    });
    await expect(
      applyAutostart(false, { platform: "win32", execPath: "x.exe", argv1: undefined, run }),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(
      "reg.exe",
      expect.arrayContaining(["delete", "/v", "MediaForge", "/f"]),
    );
  });

  it("does nothing off Windows or when running through node", async () => {
    const run = vi.fn(async () => {});
    await applyAutostart(true, { platform: "linux", execPath: "/x", argv1: undefined, run });
    await applyAutostart(true, {
      platform: "win32",
      execPath: "C:\\node\\node.exe",
      argv1: "main.js",
      run,
    });
    expect(run).not.toHaveBeenCalled();
  });
});
```

`relay.test.ts` uses real `ipc` with a test pipe and in-memory streams:

```ts
import { randomUUID } from "node:crypto";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createDecoder,
  encodeMessage,
  MAX_EXTENSION_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from "@mediaforge/shared-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { connectCore, listenCore, newToken } from "./ipc.ts";
import { runRelay } from "./relay.ts";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
});

const testPath = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\mediaforge-relay-${randomUUID()}`
    : join(tmpdir(), `mediaforge-relay-${randomUUID()}.sock`);

const frame = (message: unknown) => encodeMessage(message, MAX_EXTENSION_MESSAGE_BYTES);

function collect(stream: PassThrough) {
  const decoder = createDecoder();
  const messages: unknown[] = [];
  stream.on("data", (chunk: Buffer) => messages.push(...decoder.push(chunk)));
  return messages;
}

const until = async (check: () => boolean, tries = 200) => {
  for (let i = 0; i < tries && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error("timed out");
};

describe("runRelay", () => {
  it("forwards frames both ways", async () => {
    const path = testPath();
    const token = newToken();
    servers.push(
      await listenCore({
        path,
        token,
        onConnection: (conn) => conn.onMessage((m) => conn.send({ echo: m })),
      }),
    );
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = collect(stdout);
    const done = runRelay({
      stdin,
      stdout,
      connect: () => connectCore({ path, token }),
      spawnCore: () => {},
      timeoutMs: 1000,
      retryMs: 10,
    });
    stdin.write(frame({ v: PROTOCOL_VERSION, id: "1", type: "jobs.list", payload: {} }));
    await until(() => out.length === 1);
    expect(out[0]).toEqual({
      echo: { v: PROTOCOL_VERSION, id: "1", type: "jobs.list", payload: {} },
    });
    stdin.end();
    expect(await done).toBe(0);
  });

  it("spawns the core once and retries until it is reachable", async () => {
    const path = testPath();
    const token = newToken();
    let spawned = 0;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = collect(stdout);
    const done = runRelay({
      stdin,
      stdout,
      connect: () => connectCore({ path, token }),
      spawnCore: () => {
        spawned++;
        void listenCore({
          path,
          token,
          onConnection: (conn) => conn.onMessage((m) => conn.send({ echo: m })),
        }).then((s) => servers.push(s));
      },
      timeoutMs: 2000,
      retryMs: 10,
    });
    stdin.write(frame({ v: PROTOCOL_VERSION, id: "1", type: "jobs.list", payload: {} }));
    await until(() => out.length === 1);
    expect(spawned).toBe(1);
    stdin.end();
    await done;
  });

  it("answers core-unavailable and exits non-zero when the core never appears", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = collect(stdout);
    const done = runRelay({
      stdin,
      stdout,
      connect: async () => {
        throw new Error("nothing listening");
      },
      spawnCore: () => {},
      timeoutMs: 100,
      retryMs: 10,
    });
    stdin.write(frame({ v: PROTOCOL_VERSION, id: "7", type: "hello", payload: {} }));
    expect(await done).toBe(1);
    expect(out[0]).toMatchObject({
      type: "error",
      payload: { code: "core-unavailable", replyTo: "7" },
    });
  });
});
```

`run-core.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@mediaforge/shared-protocol";
import { describe, expect, it } from "vitest";
import { memorySettingsStore } from "../settings.ts";
import { makeRuntime } from "../test-runtime.ts";
import { connectCore, listenCore, newToken, readToken } from "./ipc.ts";
import { runCore } from "./run-core.ts";

const testPath = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\mediaforge-core-${randomUUID()}`
    : join(tmpdir(), `mediaforge-core-${randomUUID()}.sock`);

const nextMessage = (conn: Awaited<ReturnType<typeof connectCore>>) =>
  new Promise<unknown>((resolve) => conn.onMessage(resolve));

async function deps(overrides: Partial<Parameters<typeof runCore>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mf-core-"));
  const { rt } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
  return {
    pipe: testPath(),
    tokenFile: join(dir, "core.token"),
    stampFile: join(dir, "refresh.stamp"),
    settings: memorySettingsStore(),
    toolRuntime: rt,
    createEngine: () =>
      ({ list: () => [], submit: () => ({}), cancel: () => false, get: () => undefined }) as never,
    version: "9.9.9",
    idleGraceMs: 50,
    pollMs: 20,
    applyAutostart: async () => {},
    handleSignals: false,
    ...overrides,
  };
}

describe("runCore", () => {
  it("serves a client, then exits after the idle grace period", async () => {
    const d = await deps();
    const exit = runCore(d);
    const token = await new Promise<string>((resolve, reject) => {
      const started = Date.now();
      const tick = async () => {
        const t = await readToken(d.tokenFile);
        if (t) return resolve(t);
        if (Date.now() - started > 2000) return reject(new Error("no token"));
        setTimeout(tick, 10);
      };
      void tick();
    });
    const client = await connectCore({ path: d.pipe, token });
    const reply = nextMessage(client);
    client.send({ v: PROTOCOL_VERSION, id: "h", type: "hello", payload: { extensionVersion: "1", browser: "chrome" } });
    expect(await reply).toMatchObject({ type: "hello.ack", payload: { hostVersion: "9.9.9" } });
    client.close();
    expect(await exit).toBe(0);
  });

  it("exits quietly and leaves the live token alone when a core already runs", async () => {
    const d = await deps();
    const liveToken = newToken();
    const server = await listenCore({ path: d.pipe, token: liveToken, onConnection: () => {} });
    const code = await runCore(d);
    expect(code).toBe(0);
    await expect(readFile(d.tokenFile, "utf8")).rejects.toThrow();
    await new Promise((r) => server.close(() => r(undefined)));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/desktop/src/core`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `autostart.ts`**

```ts
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "MediaForge";

const runningThroughNode = (execPath: string): boolean =>
  basename(execPath.replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "") === "node";

/** The command that starts the core: the packaged exe, or node plus the script in development. */
export function coreSpawnCommand(
  execPath: string,
  argv1: string | undefined,
): { command: string; args: string[] } {
  if (runningThroughNode(execPath) && argv1) {
    return { command: execPath, args: [argv1, "--core"] };
  }
  return { command: execPath, args: ["--core"] };
}

export interface AutostartDeps {
  platform: NodeJS.Platform;
  execPath: string;
  argv1: string | undefined;
  run: (file: string, args: string[]) => Promise<unknown>;
}

const defaults = (): AutostartDeps => ({
  platform: process.platform,
  execPath: process.execPath,
  argv1: process.argv[1],
  run: (file, args) => execFileAsync(file, args, { windowsHide: true }),
});

/**
 * Start the core at login (Windows, packaged exe only). Anything else is a no-op, and a failure
 * never reaches the caller: autostart is a convenience, not something a download depends on.
 */
export async function applyAutostart(
  enabled: boolean,
  deps: AutostartDeps = defaults(),
): Promise<void> {
  if (deps.platform !== "win32" || runningThroughNode(deps.execPath)) return;
  try {
    if (enabled) {
      const { command, args } = coreSpawnCommand(deps.execPath, deps.argv1);
      await deps.run("reg.exe", [
        "add",
        RUN_KEY,
        "/v",
        VALUE_NAME,
        "/t",
        "REG_SZ",
        "/d",
        `"${command}" ${args.join(" ")}`,
        "/f",
      ]);
    } else {
      await deps.run("reg.exe", ["delete", RUN_KEY, "/v", VALUE_NAME, "/f"]);
    }
  } catch {
    // The key may already be absent, or the registry may be locked down.
  }
}
```

- [ ] **Step 4: Implement `run-core.ts`**

```ts
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DownloadEngine, type EngineJob } from "../engine/index.ts";
import { ExitCode } from "../exit-codes.ts";
import { detectJsRuntimeArgs } from "../js-runtime.ts";
import { resolveTool } from "../binaries.ts";
import { defaultSettingsStore, type SettingsStore } from "../settings.ts";
import { defaultToolRuntime, type ToolRuntime, tryResolve } from "../tool-runtime.ts";
import { VERSION } from "../version.ts";
import { applyAutostart } from "./autostart.ts";
import { IdleMonitor } from "./idle.ts";
import { listenCore, newToken, pipePath, tokenPath, writeToken } from "./ipc.ts";
import { type Provisioner, startProvisioning } from "./provisioner.ts";
import { CoreService } from "./service.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RunCoreDeps {
  pipe: string;
  tokenFile: string;
  stampFile: string;
  settings: SettingsStore;
  toolRuntime: ToolRuntime;
  createEngine: (onUpdate: (job: EngineJob) => void, provisioner: Provisioner) => DownloadEngine;
  version: string;
  idleGraceMs: number;
  /** How often to re-check idleness, so turning `keepRunning` off is noticed. */
  pollMs: number;
  applyAutostart: (enabled: boolean) => Promise<void>;
  /** Exit on SIGINT and SIGTERM. Off in tests. */
  handleSignals: boolean;
}

/**
 * Run the core until it goes idle. Resolves with the process exit code. Another live core is not
 * an error: this instance exits with 0 and leaves that core's token file alone.
 */
export async function runCore(deps: RunCoreDeps): Promise<number> {
  const token = newToken();
  const provisioner = startProvisioning(deps.toolRuntime, {
    refresh: {
      stale: async () => {
        try {
          return Date.now() - (await stat(deps.stampFile)).mtimeMs > DAY_MS;
        } catch {
          return true;
        }
      },
      stamp: async () => {
        await mkdir(dirname(deps.stampFile), { recursive: true });
        await writeFile(deps.stampFile, String(Date.now()), "utf8");
      },
    },
  });

  let service: CoreService | undefined;
  let monitor: IdleMonitor | undefined;
  const check = () => void monitor?.check();

  let server: Awaited<ReturnType<typeof listenCore>>;
  try {
    server = await listenCore({
      path: deps.pipe,
      token,
      onConnection: (conn) => {
        if (!service) return conn.close();
        const handle = service.attach({ send: (m) => conn.send(m) });
        conn.onMessage((m) => void handle.handle(m));
        conn.onClose(() => handle.detach());
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "EADDRINUSE") return ExitCode.Ok;
    throw error;
  }
  // Written only after the pipe is ours, so a second instance can never overwrite a live token.
  await writeToken(deps.tokenFile, token);

  service = new CoreService({
    createEngine: (onUpdate) => deps.createEngine(onUpdate, provisioner),
    settings: deps.settings,
    provisioner,
    version: deps.version,
    probeTool: async (tool) => {
      const found = await tryResolve(tool, deps.toolRuntime.resolve);
      return found
        ? { available: true, ...(found.version && { version: found.version }) }
        : { available: false };
    },
    applyAutostart: deps.applyAutostart,
    onActivity: check,
    now: () => Date.now(),
    newId: () => randomUUID(),
  });

  // Keep the Run key in step with the setting, even when it was changed from the menu.
  void deps.settings.load().then((s) => deps.applyAutostart(s.keepRunning));

  return await new Promise<number>((resolve) => {
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      monitor?.stop();
      clearInterval(poll);
      server.close(() => resolve(code));
      // Open client sockets would keep the server alive; end them.
      server.unref();
    };
    monitor = new IdleMonitor({
      graceMs: deps.idleGraceMs,
      isIdle: () => service?.isIdle ?? true,
      keepRunning: async () => (await deps.settings.load()).keepRunning,
      onIdle: () => finish(ExitCode.Ok),
    });
    const poll = setInterval(check, deps.pollMs);
    if (deps.handleSignals) {
      process.once("SIGINT", () => finish(ExitCode.Cancelled));
      process.once("SIGTERM", () => finish(ExitCode.Ok));
    }
    check();
  });
}

/** The real machine: real pipe, real settings, real engine with a resolver that waits for setup. */
export function runDefaultCore(): Promise<number> {
  const env = process.env;
  const base = {
    ...defaultToolRuntime(env),
  };
  return runCore({
    pipe: pipePath(process.platform, env),
    tokenFile: tokenPath(env),
    stampFile: `${tokenPath(env)}.refresh`,
    settings: defaultSettingsStore(),
    toolRuntime: base,
    createEngine: (onUpdate, provisioner) =>
      new DownloadEngine({
        onUpdate,
        jsRuntimeArgs: detectJsRuntimeArgs,
        // Jobs that arrive during first-run setup wait here instead of failing.
        resolve: async (tool) => {
          await provisioner.ready();
          return resolveTool(tool);
        },
      }),
    version: VERSION,
    idleGraceMs: 60_000,
    pollMs: 30_000,
    applyAutostart: (enabled) => applyAutostart(enabled),
    handleSignals: true,
  });
}
```

The test's `createEngine: () => ({...}) as never` type-checks against this signature.

- [ ] **Step 5: Implement `relay.ts`**

```ts
import { spawn } from "node:child_process";
import {
  createDecoder,
  encodeMessage,
  MAX_EXTENSION_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from "@mediaforge/shared-protocol";
import { ExitCode } from "../exit-codes.ts";
import { coreSpawnCommand } from "./autostart.ts";
import { type Connection, connectCore, pipePath, readToken, tokenPath } from "./ipc.ts";

export interface RelayDeps {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  /** One attempt to reach and authenticate with the core. Rejects when it cannot. */
  connect: () => Promise<Connection>;
  /** Start a detached core. Called at most once. */
  spawnCore: () => void;
  /** How long to keep trying before answering `core-unavailable`. */
  timeoutMs: number;
  retryMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorFrame(replyTo: string, code: string, message: string): Uint8Array {
  return encodeMessage({
    v: PROTOCOL_VERSION,
    id: `relay-${Date.now()}`,
    type: "error",
    payload: { code, message, replyTo },
  });
}

/**
 * Bridge the browser's stdio to the core. Resolves with the exit code when stdin closes, the core
 * goes away, or the core cannot be reached. Only protocol frames are written to stdout.
 */
export async function runRelay(deps: RelayDeps): Promise<number> {
  const decoder = createDecoder(MAX_EXTENSION_MESSAGE_BYTES);
  const pending: unknown[] = [];
  let conn: Connection | undefined;
  let stdinEnded = false;
  let lastId = "";
  let settle: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => {
    settle = resolve;
  });

  deps.stdin.on("data", (chunk) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk as Uint8Array);
    } catch {
      settle(ExitCode.Failure);
      return;
    }
    for (const message of messages) {
      const id = (message as { id?: unknown } | null)?.id;
      if (typeof id === "string") lastId = id;
      if (conn) conn.send(message);
      else pending.push(message);
    }
  });
  deps.stdin.on("end", () => {
    stdinEnded = true;
    conn?.close();
    settle(ExitCode.Ok);
  });

  const connecting = (async (): Promise<Connection | undefined> => {
    const deadline = Date.now() + deps.timeoutMs;
    let spawned = false;
    while (!stdinEnded) {
      try {
        return await deps.connect();
      } catch {
        if (!spawned) {
          spawned = true;
          deps.spawnCore();
        }
        if (Date.now() >= deadline) return undefined;
        await sleep(deps.retryMs);
      }
    }
    return undefined;
  })();

  void connecting.then((connected) => {
    if (stdinEnded) return;
    if (!connected) {
      deps.stdout.write(
        errorFrame(lastId, "core-unavailable", "MediaForge could not be started."),
      );
      settle(ExitCode.Failure);
      return;
    }
    conn = connected;
    connected.onMessage((message) => deps.stdout.write(encodeMessage(message)));
    connected.onClose(() => settle(stdinEnded ? ExitCode.Ok : ExitCode.Failure));
    for (const message of pending.splice(0)) connected.send(message);
  });

  return finished;
}

/** The real machine: stdio, the per-user pipe and token file, and a detached core. */
export function runDefaultRelay(): Promise<number> {
  const env = process.env;
  const path = pipePath(process.platform, env);
  return runRelay({
    stdin: process.stdin,
    stdout: process.stdout,
    connect: async () => {
      const token = await readToken(tokenPath(env));
      if (!token) throw new Error("No core token yet.");
      return connectCore({ path, token });
    },
    spawnCore: () => {
      const { command, args } = coreSpawnCommand(process.execPath, process.argv[1]);
      spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    },
    timeoutMs: 10_000,
    retryMs: 100,
  });
}
```

Note on the "core never appears" test: the first failed `connect()` triggers `spawnCore()`, the loop retries until the deadline, then the error frame uses `lastId` ("7"). The test writes the frame before the deadline, so `lastId` is set in time.

- [ ] **Step 6: Run to verify pass**

Run: `pnpm exec vitest run apps/desktop/src/core && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Lint and print commit message**

Run: `pnpm exec biome check --write apps/desktop/src/core`
Print: title `✨ desktop: add the --core runner, the native-host relay and login autostart`.

---

### Task 7: Dispatch `--core` and `--native-host`

**Files:**
- Modify: `apps/desktop/src/cli.ts`
- Modify: `apps/desktop/src/main.ts`
- Test: `apps/desktop/src/cli.test.ts`

**Interfaces:**
- Consumes: `runDefaultCore`, `runDefaultRelay`.
- Produces: `RunOptions.core?: () => Promise<number>` and `RunOptions.relay?: () => Promise<number>`; `isRelayInvocation(first: string | undefined): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/cli.test.ts`:

```ts
describe("background modes", () => {
  const io = { stdout: () => {}, stderr: () => {} };

  it("runs the core for --core", async () => {
    let called = 0;
    const code = await run(["--core"], io, {
      core: async () => {
        called++;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(called).toBe(1);
  });

  it("runs the relay for --native-host and for a Chrome origin argument", async () => {
    let called = 0;
    const relay = async () => {
      called++;
      return 0;
    };
    await run(["--native-host"], io, { relay });
    await run(["chrome-extension://abcdefghijklmnop/", "--parent-window=0"], io, { relay });
    expect(called).toBe(2);
  });

  it("keeps both modes out of the help text", async () => {
    const { out } = await exec("--help");
    expect(out).not.toContain("--core");
    expect(out).not.toContain("--native-host");
  });

  it("fails with a usage error when a mode is requested but not available", async () => {
    expect((await exec("--core")).code).toBe(ExitCode.Usage);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/desktop/src/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`cli.ts`: extend `RunOptions`:

```ts
export interface RunOptions {
  /** Opens the interactive menu. Provided only when running in a real terminal. */
  interactive?: () => Promise<number>;
  /** The long-lived background core (`--core`). */
  core?: () => Promise<number>;
  /** The browser native-messaging relay (`--native-host`). */
  relay?: () => Promise<number>;
}

/**
 * Chrome cannot pass flags to a native host on Windows; it passes the extension origin as the
 * first argument instead.
 */
export const isRelayInvocation = (first: string | undefined): boolean =>
  first === "--native-host" || /^(chrome|moz)-extension:\/\//.test(first ?? "");
```

In `run`, before the `-h` check:

```ts
  if (first === "--core" || isRelayInvocation(first)) {
    const mode = first === "--core" ? options.core : options.relay;
    if (!mode) {
      io.stderr(`${first} is not available here.\n`);
      return ExitCode.Usage;
    }
    try {
      return await mode();
    } catch (error) {
      io.stderr(`Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
      return ExitCode.Failure;
    }
  }
```

`main.ts`: add to the options object passed to `run`:

```ts
    core: async () => (await import("./core/run-core.ts")).runDefaultCore(),
    relay: async () => (await import("./core/relay.ts")).runDefaultRelay(),
```

and after `process.exitCode = await run(...)`, add:

```ts
// The background modes hold pipes and timers open; leave explicitly once they are done.
if (process.argv[2] === "--core" || isRelayInvocation(process.argv[2])) {
  process.exit(process.exitCode);
}
```

with `import { isRelayInvocation, run } from "./cli.ts";`. Also guard `cleanupAfterUpdate()` so it is skipped in these modes: wrap it in `if (!(process.argv[2] === "--core" || isRelayInvocation(process.argv[2])))`, because the relay is started by the browser on every launch and must stay fast and silent.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run && pnpm typecheck && pnpm lint`
Expected: PASS everywhere. The existing "does not list browser host commands" test still passes because neither mode is in `COMMANDS`.

- [ ] **Step 5: Manual Windows smoke test (requires the user)**

Run: `pnpm --filter @mediaforge/desktop build`, then `node apps/desktop/dist/main.js --core` in one terminal. In a second, send one `hello` frame through the relay:

```powershell
node -e "const f=(m)=>{const b=Buffer.from(JSON.stringify(m));const h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b])};process.stdout.write(f({v:2,id:'1',type:'hello',payload:{extensionVersion:'0',browser:'chrome'}}))" | node apps/desktop/dist/main.js --native-host | node -e "process.stdin.once('data',d=>console.log(d.subarray(4).toString()))"
```

Expected: a `hello.ack` JSON line with `"setup":"installing"` or `"ready"`. After 60 seconds with no client the core terminal exits. Report the real result to the user; do not claim it passed without running it.

- [ ] **Step 6: Print commit message**

Print: title `✨ desktop: dispatch --core and the native-host relay`.

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
| --- | --- |
| Protocol additions: jobs.list, subscribe, settings get/set, setup.progress, hello.ack fields, download.start context | 1 |
| `keepRunning`, `extensionUi` settings, TUI rows | 2 |
| Pipe, token handshake, single-instance lock via `EADDRINUSE`, token written only after listen | 3, 6 |
| Silent provisioning, no prompts, `setup.progress`, daily yt-dlp refresh | 4 |
| Idle exit, `keepRunning` re-read so turning it off works | 4, 6 |
| Core service: engine wrap, job mapping, throttling, subscriptions, settings, jobs survive detach | 5 |
| Jobs wait for provisioning | 6 (`resolve` wrapper) |
| Relay: stdio, spawn detached, `core-unavailable`, only frames on stdout | 6 |
| One exe, three modes, hidden from help, Chrome origin trigger | 7 |
| Autostart at login | 6 |

**Known deviations from the spec**

- A download that arrives during first-run setup shows as `downloading` with 0 bytes, not `queued`, because it waits inside the engine's tool resolver. The popup uses `setup.progress` to explain it.
- `download.start` accepts and validates `context` but the engine does not yet forward it to yt-dlp. That belongs to sub-project 3.
- The TUI is not yet a client of the core. Spec marked that "a later step"; it is not in this plan.
- Unix stale-socket cleanup is deferred to the Linux pass (Global Constraints).

**Placeholder scan:** none.

**Type consistency:** `Connection`, `SetupStatus`, `Provisioner`, `CoreServiceDeps`, `RunCoreDeps`, `RelayDeps`, `coreSpawnCommand` names match across tasks. `ready()` returns `SetupStatus` in provisioner and is awaited the same way in `run-core.ts`.
