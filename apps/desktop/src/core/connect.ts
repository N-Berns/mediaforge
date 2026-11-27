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
