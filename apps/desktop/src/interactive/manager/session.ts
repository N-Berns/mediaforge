import type { ExtensionSettings, HostToExtensionMessage } from "@mediaforge/shared-protocol";
import type { DownloadJob, Notice } from "@mediaforge/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { type CoreClient, CoreLostError } from "../../core/client.ts";
import type { CoreConnector } from "../../core/connect.ts";
import { applyFrame, jobIdOf } from "../../core/job-watch.ts";
import type { EngineJob } from "../../engine/index.ts";

/** Pushes update the state at once; the screen is drawn at most this often. */
export const RENDER_INTERVAL_MS = 250;
/** How long to wait between attempts to reach a core that went away. */
export const RECONNECT_MS = 1000;

export type Jobs = ReadonlyMap<string, DownloadJob>;

/** Fold one push into the job map; returns the same map when nothing changed. */
export function foldPush(jobs: Jobs, message: HostToExtensionMessage): Jobs {
  if (message.type === "jobs.snapshot") {
    return new Map(message.payload.jobs.map((job) => [job.id, job]));
  }
  const id = jobIdOf(message);
  const job = id === undefined ? undefined : jobs.get(id);
  if (!id || !job) return jobs;
  const next = new Map(jobs);
  next.set(id, applyFrame(job as EngineJob, message));
  return next;
}

export interface CoreSession {
  state: "connecting" | "ready" | "reconnecting";
  jobs: Jobs;
  notice: Notice | undefined;
  settings: ExtensionSettings | undefined;
  /** Rejects with CoreLostError when not connected. */
  request: CoreClient["request"];
  /** Send a frame the core answers only on failure (download.cancel). Throws CoreLostError when not connected. */
  notify: CoreClient["notify"];
}

type Snapshot = Omit<CoreSession, "request" | "notify">;

/**
 * One live connection to the core for the manager: subscribes, loads the jobs, the settings and
 * the session notice, and folds every push in. When the core goes away the last rows stay and it
 * retries until it is back.
 */
export function useCoreSession(
  connect: CoreConnector,
  options: { onAttention?: () => void; renderMs?: number; retryMs?: number } = {},
): CoreSession {
  const renderMs = options.renderMs ?? RENDER_INTERVAL_MS;
  const retryMs = options.retryMs ?? RECONNECT_MS;
  const live = useRef<Snapshot>({
    state: "connecting",
    jobs: new Map(),
    notice: undefined,
    settings: undefined,
  });
  const [view, setView] = useState<Snapshot>(live.current);
  const client = useRef<CoreClient | undefined>(undefined);
  /** The running effect's state setter, so request replies can update the state too. */
  const apply = useRef<(patch: Partial<Snapshot>) => void>(() => {});
  const onAttention = useRef(options.onAttention);
  onAttention.current = options.onAttention;

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    let lastFlush = 0;

    // Draw now if the last frame is old enough, else once the interval has passed.
    const schedule = () => {
      if (flush || stopped) return;
      const wait = Math.max(0, lastFlush + renderMs - Date.now());
      flush = setTimeout(() => {
        flush = undefined;
        lastFlush = Date.now();
        if (!stopped) setView(live.current);
      }, wait);
    };
    const set = (patch: Partial<Snapshot>) => {
      live.current = { ...live.current, ...patch };
      schedule();
    };
    apply.current = set;
    const again = () => {
      if (stopped) return;
      set({ state: "reconnecting" });
      retry = setTimeout(() => void run(), retryMs);
    };

    let refreshing = false;
    /** Asked again while a list was on its way: that list may predate the new job. */
    let stale = false;
    const refresh = (c: CoreClient) => {
      if (refreshing) {
        stale = true;
        return;
      }
      refreshing = true;
      stale = false;
      c.request("jobs.list", {})
        .then((list) => {
          if (!stopped && list.type === "jobs.snapshot")
            set({ jobs: foldPush(live.current.jobs, list) });
        })
        .catch(() => {})
        .finally(() => {
          refreshing = false;
          if (stale && !stopped) refresh(c);
        });
    };

    const run = async () => {
      let c: CoreClient;
      try {
        c = await connect();
      } catch {
        again();
        return;
      }
      if (stopped) {
        c.close();
        return;
      }
      c.onPush((message) => {
        if (message.type === "app.attention") onAttention.current?.();
        else if (message.type === "notice") set({ notice: message.payload.notice });
        else if (message.type === "settings.value") set({ settings: message.payload });
        else {
          const id = jobIdOf(message);
          // A job someone else just started: only a fresh list has its request and origin.
          if (id !== undefined && !live.current.jobs.has(id)) refresh(c);
          const jobs = foldPush(live.current.jobs, message);
          if (jobs !== live.current.jobs) set({ jobs });
        }
      });
      c.onClose(() => {
        if (client.current === c) client.current = undefined;
        again();
      });
      try {
        // The core does not answer a subscribe.
        c.notify("jobs.subscribe", {});
        // Applied on arrival: frames come in order, so a later push or refresh is never undone.
        const list = await c.request("jobs.list", {});
        if (stopped) {
          c.close();
          return;
        }
        if (list.type === "jobs.snapshot") set({ jobs: foldPush(live.current.jobs, list) });
        const settings = await c.request("settings.get", {});
        if (stopped) {
          c.close();
          return;
        }
        client.current = c;
        set({
          state: "ready",
          ...(settings.type === "settings.value" && { settings: settings.payload }),
          notice: c.ack.notice,
        });
      } catch {
        // The connection broke while loading: its close handler retries.
        c.close();
      }
    };
    void run();

    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(flush);
      client.current?.close();
      client.current = undefined;
    };
  }, [connect, renderMs, retryMs]);

  const request = useCallback<CoreClient["request"]>(async (type, payload) => {
    if (!client.current) throw new CoreLostError();
    const reply = await client.current.request(type, payload);
    // Some requests answer with new state: show it as if it had been pushed. (The core pushes
    // a dismissed notice to everyone but the client that dismissed it.)
    if (reply.type === "settings.value") apply.current({ settings: reply.payload });
    if (reply.type === "notice") apply.current({ notice: reply.payload.notice });
    return reply;
  }, []);

  const notify = useCallback<CoreClient["notify"]>((type, payload) => {
    if (!client.current) throw new CoreLostError();
    client.current.notify(type, payload);
  }, []);

  return { ...view, request, notify };
}
