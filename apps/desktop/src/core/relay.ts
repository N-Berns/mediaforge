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
  /** Start a detached core. Called at most once, and never after the relay has finished. */
  spawnCore: () => void;
  /** How long to keep trying before answering `core-unavailable`. */
  timeoutMs: number;
  retryMs: number;
}

/**
 * Longest to wait for the last frame to leave before exiting anyway: the error frame on stdout, or
 * the frames on their way to the core once stdin has ended.
 */
const FLUSH_TIMEOUT_MS = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run a step whose failure must never reach the caller. */
function quietly(step: () => void): void {
  try {
    step();
  } catch {
    // Nothing useful can be done about it here.
  }
}

function errorFrame(replyTo: string, code: string, message: string): Uint8Array {
  return encodeMessage({
    v: PROTOCOL_VERSION,
    id: `relay-${Date.now()}`,
    type: "error",
    // `replyTo` is optional in the protocol: leave it out rather than send an empty id.
    payload: { code, message, ...(replyTo && { replyTo }) },
  });
}

/**
 * Bridge the browser's stdio to the core. Resolves with the exit code when stdin closes, the core
 * goes away, or the core cannot be reached. Only protocol frames are written to stdout. When the
 * core cannot be reached or goes away, the extension is sent an `error` frame first
 * (`core-unavailable`, `core-disconnected`) carrying the last request id seen.
 *
 * Frames are forwarded as they are: the core owns validation. Nothing here throws; a stream or
 * connection that fails ends the relay with a failure code.
 *
 * stdin ending does not drop what the browser already sent (an MV3 service worker may post a
 * request and close its port at once). With nothing received, the relay ends at once. Otherwise it
 * keeps connecting (within `timeoutMs`), sends every frame on, closes its end of the connection,
 * and resolves only once the core has closed too (or after FLUSH_TIMEOUT_MS), so a `process.exit`
 * after it cannot cut a frame short. Frames from the core after stdin ended are dropped.
 */
export async function runRelay(deps: RelayDeps): Promise<number> {
  const decoder = createDecoder(MAX_EXTENSION_MESSAGE_BYTES);
  /** Frames that arrived before the core connection was ready. */
  const pending: unknown[] = [];
  let conn: Connection | undefined;
  let settled = false;
  /** stdin has ended: the browser sends nothing more and reads nothing more. */
  let inputEnded = false;
  /** At least one whole frame arrived from the browser. */
  let received = false;
  /** Bounds the wait for the core to close its end after stdin ended. */
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastId = "";
  let resolveExit: (code: number) => void = () => {};
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const settle = (code: number) => {
    if (settled) return;
    settled = true;
    clearTimeout(closeTimer);
    pending.length = 0;
    quietly(() => conn?.close());
    // Stop reading, so an idle stdin no longer keeps the process alive.
    quietly(() => deps.stdin.pause());
    resolveExit(code);
  };

  const sendToCore = (message: unknown) => {
    try {
      conn?.send(message);
    } catch {
      settle(ExitCode.Failure);
    }
  };

  deps.stdin.on("data", (chunk: Uint8Array | string) => {
    if (settled) return;
    let messages: unknown[];
    try {
      messages = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    } catch {
      settle(ExitCode.Failure);
      return;
    }
    for (const message of messages) {
      received = true;
      const id = (message as { id?: unknown } | null)?.id;
      if (typeof id === "string") lastId = id;
      if (conn) sendToCore(message);
      else pending.push(message);
      if (settled) return;
    }
  });
  /**
   * Close our end of the core connection after what was sent to it, and settle once the core has
   * closed its end too: by then it has read everything.
   */
  const closeGracefully = (connection: Connection) => {
    closeTimer = setTimeout(() => settle(ExitCode.Ok), FLUSH_TIMEOUT_MS);
    try {
      connection.close();
    } catch {
      settle(ExitCode.Ok);
    }
  };

  // The browser closing its end is the normal way a relay ends.
  const onInputEnd = () => {
    if (settled || inputEnded) return;
    inputEnded = true;
    if (conn) closeGracefully(conn);
    // Nothing to deliver: no reason to wait for a core.
    else if (!received) settle(ExitCode.Ok);
    // Otherwise `attach` delivers the pending frames once it connects, then closes.
  };
  deps.stdin.on("end", onInputEnd);
  deps.stdin.on("close", onInputEnd);
  // A broken pipe on either side arrives as an event; without a listener it would crash the relay.
  deps.stdin.on("error", () => settle(ExitCode.Failure));
  // Once stdin has ended nobody reads stdout: a late write error there must not cut short the
  // frames still on their way to the core.
  deps.stdout.on("error", () => {
    if (!inputEnded) settle(ExitCode.Failure);
  });

  /** The last thing the relay says: wait for it to leave stdout, then exit. */
  const answerAndFail = (frame: Uint8Array) => {
    const timer = setTimeout(() => settle(ExitCode.Failure), FLUSH_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      settle(ExitCode.Failure);
    };
    try {
      deps.stdout.write(frame, done);
    } catch {
      done();
    }
  };

  const attach = async (): Promise<void> => {
    const deadline = Date.now() + deps.timeoutMs;
    let spawned = false;
    let connected: Connection | undefined;
    while (!settled) {
      try {
        connected = await deps.connect();
        break;
      } catch {
        if (settled) break;
        if (!spawned) {
          spawned = true;
          quietly(() => deps.spawnCore());
        }
        if (Date.now() >= deadline) break;
        await sleep(deps.retryMs);
      }
    }
    if (settled) {
      // Connected too late: nobody is left to relay for, so do not leave the socket open.
      const late = connected;
      if (late) quietly(() => late.close());
      return;
    }
    if (!connected) {
      answerAndFail(errorFrame(lastId, "core-unavailable", "MediaForge could not be started."));
      return;
    }
    conn = connected;
    // Both handlers are set up here, synchronously, `onMessage` first: the transport reports a
    // close ahead of a frame that is still waiting for its handler.
    connected.onMessage((message) => {
      // After stdin ended nobody reads stdout any more.
      if (settled || inputEnded) return;
      try {
        deps.stdout.write(encodeMessage(message));
      } catch {
        settle(ExitCode.Failure);
      }
    });
    // After stdin ended, the core closing is the end of the graceful close the relay started.
    // Any other close is the core going away (idle exit, a crash), which the extension must be
    // told.
    connected.onClose(() => {
      if (settled) return;
      if (inputEnded) settle(ExitCode.Ok);
      else answerAndFail(errorFrame(lastId, "core-disconnected", "MediaForge stopped."));
    });
    for (const message of pending.splice(0)) {
      if (settled) break;
      sendToCore(message);
    }
    if (inputEnded && !settled) closeGracefully(connected);
  };
  attach().catch(() => settle(ExitCode.Failure));

  return exit;
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
      // One attempt must stay short: the retry loop owns the overall deadline.
      return connectCore({ path, token, timeoutMs: 1000, role: "relay" });
    },
    spawnCore: () => {
      const { command, args } = coreSpawnCommand(process.execPath, process.argv[1]);
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
      // A missing executable arrives as an event; the retry loop already answers for it.
      child.on("error", () => {});
      child.unref();
    },
    timeoutMs: 10_000,
    retryMs: 100,
  });
}
