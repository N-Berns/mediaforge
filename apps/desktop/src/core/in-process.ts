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
