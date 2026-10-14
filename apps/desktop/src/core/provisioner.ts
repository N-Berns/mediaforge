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
  /**
   * Download yt-dlp again when the refresh stamp is stale, for a core that stays up for days.
   * A no-op without the `refresh` option, while the stamp is fresh, or while setup is still
   * installing; one refresh runs at a time. Never rejects: a failed refresh keeps the copy that
   * works. While it runs the status is installing yt-dlp, phase "refreshing"; afterwards it goes
   * back to what it was.
   */
  refreshIfStale(): Promise<void>;
}

export interface ProvisionOptions {
  tools?: Tool[];
  /** Keeps yt-dlp fresh: `stale` says whether a refresh is due, `stamp` records that one ran. */
  refresh?: { stale: () => Promise<boolean>; stamp: () => Promise<void> };
  /** The clock, in ms. Defaults to `Date.now`; tests inject their own. */
  now?: () => number;
}

const DEFAULT_TOOLS: Tool[] = ["yt-dlp", "ffmpeg", "deno"];

/** After a failed refresh, how long before the next attempt (each one downloads ~18 MB). */
export const REFRESH_RETRY_MS = 60 * 60 * 1000;

const percentOf = (progress: InstallProgress): number | undefined =>
  progress.phase === "downloading" && progress.total && progress.received
    ? Math.min(100, (progress.received / progress.total) * 100)
    : undefined;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Make the tools available with no prompt. Runs in the background; check `ready()`. */
export function startProvisioning(rt: ToolRuntime, options: ProvisionOptions = {}): Provisioner {
  const tools = options.tools ?? DEFAULT_TOOLS;
  const listeners = new Set<(status: SetupStatus) => void>();
  let current: SetupStatus = { state: "installing" };

  const publish = (next: SetupStatus) => {
    current = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // A listener's bug must not fail provisioning or hide the status from the others.
      }
    }
  };

  const run = async (): Promise<SetupStatus> => {
    // Nothing here touches the terminal: the core never prompts.
    const silent: ToolRuntime = { ...rt, interactive: false };
    const installed = new Set<Tool>();
    for (const tool of tools) {
      if (await tryResolve(tool, rt.resolve)) continue;
      publish({ state: "installing", tool });
      try {
        const outcome = await acquireTool(tool, silent, {
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
        if (outcome.status === "installed") installed.add(tool);
      } catch (error) {
        if (isRequired(tool)) {
          const failed: SetupStatus = {
            state: "failed",
            tool,
            error: messageOf(error),
          };
          publish(failed);
          return failed;
        }
      }
    }
    await refreshYtDlp(installed.has("yt-dlp"));
    const ready: SetupStatus = { state: "ready" };
    publish(ready);
    return ready;
  };

  const refreshYtDlp = async (installedThisRun: boolean): Promise<void> => {
    const refresh = options.refresh;
    if (!refresh) return;
    try {
      if (installedThisRun) {
        // Just downloaded, so already the latest: record it instead of downloading again.
        await refresh.stamp();
        return;
      }
      if (!(await refresh.stale())) return;
      publish({ state: "installing", tool: "yt-dlp", phase: "refreshing" });
      await rt.install("yt-dlp", () => {});
      await refresh.stamp();
    } catch {
      // A failed refresh keeps the copy that already works.
    }
  };

  // `ready()` is documented to never reject, so an unexpected error becomes a failed status
  // instead of an unhandled rejection inside the core.
  const done = run().catch((error: unknown): SetupStatus => {
    const failed: SetupStatus = { state: "failed", error: messageOf(error) };
    publish(failed);
    return failed;
  });

  let refreshing: Promise<void> | undefined;
  /** When the last refresh attempt failed; kept in memory only. */
  let lastFailedAt: number | undefined;
  const now = options.now ?? Date.now;
  const refreshIfStale = (): Promise<void> => {
    if (refreshing) return refreshing;
    const refresh = options.refresh;
    if (!refresh || current.state === "installing") return Promise.resolve();
    const run = async () => {
      try {
        // A failed attempt is not repeated for a while, or every poll would download again.
        if (lastFailedAt !== undefined && now() - lastFailedAt < REFRESH_RETRY_MS) return;
        if (!(await refresh.stale())) return;
        // Setup may have started meanwhile; it owns the tool folder until it is done.
        if (current.state === "installing") return;
        const before = current;
        publish({ state: "installing", tool: "yt-dlp", phase: "refreshing" });
        try {
          await rt.install("yt-dlp", () => {});
          await refresh.stamp();
          lastFailedAt = undefined;
        } catch (error) {
          // An unstamped success stays stale too, so it waits like a failure.
          lastFailedAt = now();
          throw error;
        } finally {
          // A failed setup stays visible; anything else is simply ready again.
          publish(before.state === "failed" ? before : { state: "ready" });
        }
      } catch {
        // A failed refresh keeps the copy that already works.
      }
    };
    const pending = run().finally(() => {
      refreshing = undefined;
    });
    refreshing = pending;
    return pending;
  };

  return {
    status: () => current,
    refreshIfStale,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    ready: () => done,
  };
}
