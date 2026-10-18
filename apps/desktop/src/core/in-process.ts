import { randomUUID } from "node:crypto";
import type { JobOrigin } from "@mediaforge/shared-types";
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
): {
  connect: CoreConnector;
  /** Connect as this kind of client (the manager, the menu…). */
  connectAs: (client: JobOrigin) => CoreConnector;
  /** Close every open connection, as if the core went away. */
  dropAll: () => void;
  service: Promise<CoreService>;
} {
  const service = (async () =>
    new CoreService({
      settings: memorySettingsStore(),
      provisioner: readyProvisioner,
      version: "0.0.0-test",
      probeTool: async () => ({ available: true }),
      probe: async () => {
        throw new Error("probe is not available in-process");
      },
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
      trash: async () => ({ failed: [] }),
      ...deps,
    }))();

  const open = new Set<() => void>();
  const connectAs = (client: JobOrigin) => async (): Promise<CoreClient> => {
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
      open.delete(close);
      handle.detach();
      for (const h of closeHandlers) queueMicrotask(h);
    };
    open.add(close);
    const conn: Connection = {
      send: (m) => void handle.handle(structuredClone(m)),
      onMessage: (h) => {
        toClient = h;
      },
      onClose: (h) => void closeHandlers.push(h),
      close,
    };
    return openCoreClient(conn, { client });
  };
  const dropAll = () => {
    for (const close of [...open]) close();
  };
  return { connect: connectAs("cli"), connectAs, dropAll, service };
}
