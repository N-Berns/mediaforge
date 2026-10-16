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
    const stop =
      process.platform === "win32"
        ? "Close it from Task Manager (or sign out and back in)"
        : "Stop the mediaforge process (or log out and back in)";
    super(`The MediaForge background service is a different version. ${stop} and try again.`);
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
  /** Send a frame the core does not answer on success (download.cancel). Never waits. */
  notify(type: ExtensionToHostMessage["type"], payload: unknown): void;
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
  let greeted = false;

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
      // Hanging up fails every later request and tells the watchers, so nothing waits forever.
      conn.close();
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
          message.payload.code === "invalid-message" && !greeted
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

  let hello: HostToExtensionMessage;
  try {
    hello = await request("hello", { client: options.client });
    if (hello.type !== "hello.ack") throw new CoreVersionError();
  } catch (error) {
    // An authenticated socket left open would keep the terminal process alive.
    conn.close();
    throw error;
  }
  greeted = true;

  return {
    ack: hello.payload,
    request,
    notify: (type, payload) => {
      if (closed) return;
      try {
        conn.send({ v: PROTOCOL_VERSION, id: newId(), type, payload });
      } catch {
        // A frame that cannot be sent is as good as a lost connection; the caller sees that.
      }
    },
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
