import {
  type ExtensionToHostMessage,
  type HostToExtensionMessage,
  PROTOCOL_VERSION,
  parseHostMessage,
} from "@mediaforge/shared-protocol";

export interface NativePort {
  postMessage(message: unknown): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
  disconnect(): void;
}

export type ConnectionState =
  | { kind: "connecting" }
  | { kind: "not-installed" }
  | { kind: "unavailable"; message: string }
  | { kind: "incompatible" }
  | { kind: "setting-up"; tool?: string; percent?: number }
  | { kind: "ready" };

/** What the core said about itself in its last `hello.ack`. */
export interface HostInfo {
  hostVersion: string;
  ytDlp: { available: boolean; version?: string | undefined };
  ffmpeg: { available: boolean; version?: string | undefined };
}

export class NativeRequestError extends Error {
  override name = "NativeRequestError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface NativeClientOptions {
  /** Open the native port. Throws when the host is not registered. */
  connect: () => NativePort;
  extensionVersion: string;
  browser: "firefox" | "chrome" | "edge";
  /** Delay before reconnect attempt N, last value repeats. */
  retryDelaysMs?: number[];
  defaultTimeoutMs?: number;
}

type MessageType = ExtensionToHostMessage["type"];

export interface NativeClient {
  state(): ConnectionState;
  /** The core's last greeting; undefined before the first one. */
  host?(): HostInfo | undefined;
  onState(listener: (state: ConnectionState) => void): () => void;
  /** Every valid frame from the core, including replies. */
  onPush(listener: (message: HostToExtensionMessage) => void): () => void;
  request(
    type: MessageType,
    payload: unknown,
    options?: { timeoutMs?: number },
  ): Promise<HostToExtensionMessage>;
  start(): void;
  stop(): void;
}

const INCOMPATIBLE_RETRY_MS = 5 * 60_000;
const STABLE_MS = 30_000;
const DEFAULT_RETRY_MS = [0, 1000, 2000, 4000, 8000, 16000, 30000];

interface Pending {
  resolve: (m: HostToExtensionMessage) => void;
  reject: (e: NativeRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createNativeClient(options: NativeClientOptions): NativeClient {
  const retry = options.retryDelaysMs ?? DEFAULT_RETRY_MS;
  const defaultTimeout = options.defaultTimeoutMs ?? 15000;
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const pushListeners = new Set<(m: HostToExtensionMessage) => void>();
  const pending = new Map<string, Pending>();

  let state: ConnectionState = { kind: "connecting" };
  let hostInfo: HostInfo | undefined;
  let port: NativePort | undefined;
  let stopped = true;
  let attempt = 0;
  let heardFromCore = false;
  let helloId = "";
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let counter = 0;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;

  const setState = (next: ConnectionState) => {
    state = next;
    for (const l of stateListeners) l(next);
  };
  const newId = () => `ext-${++counter}-${Date.now()}`;
  const send = (type: MessageType, payload: unknown, id = newId()) => {
    try {
      port?.postMessage({ v: PROTOCOL_VERSION, id, type, payload });
    } catch {
      return undefined;
    }
    return id;
  };
  const clearConnTimers = () => {
    if (helloTimer) clearTimeout(helloTimer);
    if (stableTimer) clearTimeout(stableTimer);
    helloTimer = undefined;
    stableTimer = undefined;
  };

  const failAll = (code: string, message: string) => {
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new NativeRequestError(code, message));
    }
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    if (retryTimer) clearTimeout(retryTimer);
    let delay: number;
    if (state.kind === "incompatible") delay = INCOMPATIBLE_RETRY_MS;
    else {
      delay = retry[Math.min(attempt, retry.length - 1)] ?? 30000;
      attempt++;
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      open();
    }, delay);
  };

  function open() {
    if (stopped) return;
    heardFromCore = false;
    if (state.kind !== "unavailable" && state.kind !== "incompatible") {
      setState({ kind: "connecting" });
    }
    let opened: NativePort;
    try {
      opened = options.connect();
    } catch {
      port = undefined;
      setState({ kind: "not-installed" });
      scheduleReconnect();
      return;
    }
    port = opened;
    // Listeners are bound to this port; frames from an older one are dropped.
    opened.onMessage.addListener((raw) => {
      if (port === opened) onMessage(raw);
    });
    opened.onDisconnect.addListener(() => {
      if (port === opened) onDisconnect();
    });
    helloId = newId();
    send(
      "hello",
      {
        client: "extension",
        extensionVersion: options.extensionVersion,
        browser: options.browser,
      },
      helloId,
    );
    helloTimer = setTimeout(() => {
      helloTimer = undefined;
      if (port !== opened) return;
      port = undefined;
      failAll("disconnected", "The connection to MediaForge closed.");
      setState({ kind: "unavailable", message: "MediaForge did not answer." });
      opened.disconnect();
      scheduleReconnect();
    }, defaultTimeout);
  }

  function onDisconnect() {
    port = undefined;
    clearConnTimers();
    failAll("disconnected", "The connection to MediaForge closed.");
    if (state.kind === "incompatible") {
      // sticky
    } else if (!heardFromCore) setState({ kind: "not-installed" });
    else if (state.kind !== "unavailable") setState({ kind: "connecting" });
    scheduleReconnect();
  }

  function afterAck(m: Extract<HostToExtensionMessage, { type: "hello.ack" }>) {
    if (helloTimer) clearTimeout(helloTimer);
    helloTimer = undefined;
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      stableTimer = undefined;
      attempt = 0;
    }, STABLE_MS);
    const { hostVersion, ytDlp, ffmpeg } = m.payload;
    hostInfo = { hostVersion, ytDlp, ffmpeg };
    if (m.payload.setup === "ready") setState({ kind: "ready" });
    else if (m.payload.setup === "installing") setState({ kind: "setting-up" });
    else setState({ kind: "unavailable", message: "MediaForge could not finish its setup." });
    send("jobs.subscribe", {});
    send("jobs.list", {});
  }

  function isIncompatibleFrame(raw: unknown): boolean {
    if (typeof raw !== "object" || raw === null) return false;
    const f = raw as { v?: unknown; id?: unknown; type?: unknown; payload?: unknown };
    const payload = (typeof f.payload === "object" && f.payload !== null ? f.payload : {}) as {
      replyTo?: unknown;
      code?: unknown;
    };
    if (f.type === "error" && payload.replyTo === helloId) {
      return f.v !== PROTOCOL_VERSION || payload.code === "invalid-message";
    }
    return f.type === "hello.ack" && f.id === helloId && f.v !== PROTOCOL_VERSION;
  }

  function onMessage(raw: unknown) {
    if (isIncompatibleFrame(raw)) {
      const old = port;
      port = undefined;
      clearConnTimers();
      failAll("disconnected", "The connection to MediaForge closed.");
      setState({ kind: "incompatible" });
      old?.disconnect();
      scheduleReconnect();
      return;
    }
    const parsed = parseHostMessage(raw);
    if (!parsed.ok) return;
    const message = parsed.value;
    heardFromCore = true;

    if (message.type === "hello.ack" && message.id === helloId) afterAck(message);
    else if (message.type === "setup.progress") {
      const p = message.payload;
      if (p.state === "installing") {
        setState({
          kind: "setting-up",
          ...(p.tool && { tool: p.tool }),
          ...(p.percent !== undefined && { percent: p.percent }),
        });
      } else if (p.state === "ready") setState({ kind: "ready" });
      else setState({ kind: "unavailable", message: p.error ?? "MediaForge setup failed." });
    } else if (message.type === "error") {
      const { code } = message.payload;
      if (code === "core-unavailable" || code === "core-disconnected") {
        setState({ kind: "unavailable", message: message.payload.message });
      }
    }

    const key = message.type === "error" ? (message.payload.replyTo ?? "") : message.id;
    const waiting = pending.get(key);
    if (waiting) {
      pending.delete(key);
      clearTimeout(waiting.timer);
      if (message.type === "error") {
        waiting.reject(new NativeRequestError(message.payload.code, message.payload.message));
      } else waiting.resolve(message);
    }
    for (const l of pushListeners) l(message);
  }

  return {
    state: () => state,
    host: () => hostInfo,
    onState(listener) {
      stateListeners.add(listener);
      return () => void stateListeners.delete(listener);
    },
    onPush(listener) {
      pushListeners.add(listener);
      return () => void pushListeners.delete(listener);
    },
    request(type, payload, opts) {
      if (!port) {
        return Promise.reject(
          new NativeRequestError("not-connected", "MediaForge is not connected."),
        );
      }
      return new Promise((resolve, reject) => {
        const id = newId();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new NativeRequestError("timeout", "MediaForge did not answer in time."));
        }, opts?.timeoutMs ?? defaultTimeout);
        pending.set(id, { resolve, reject, timer });
        if (send(type, payload, id) === undefined) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new NativeRequestError("disconnected", "MediaForge is not reachable."));
        }
      });
    },
    start() {
      if (!stopped) {
        if (state.kind === "incompatible" && !port) {
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = undefined;
          open();
        }
        return;
      }
      stopped = false;
      attempt = 0;
      open();
    },
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      clearConnTimers();
      failAll("stopped", "The extension is shutting down.");
      const old = port;
      port = undefined;
      old?.disconnect();
    },
  };
}
