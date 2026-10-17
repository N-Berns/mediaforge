import type { InstallProgress, InstallResult, Tool } from "@mediaforge/binary-resolver";
import type { Report, SendResult } from "@mediaforge/shared-types";
import { createContext, useContext } from "react";
import type { CoreConnector } from "../core/connect.ts";
import type { ToolReport } from "../doctor.ts";
import type { DownloadDeps } from "../download.ts";
import type { MediaInfo } from "../formats.ts";
import type { UpdateInfo, UpdateProgress } from "../self-update.ts";
import type { FolderFs } from "./folder-browser.ts";

/** Everything the interactive app needs from the outside world. Tests replace all of it. */
export interface AppDeps {
  download: DownloadDeps;
  fetchInfo: (url: string) => Promise<MediaInfo>;
  inspectTools: () => Promise<ToolReport[]>;
  /** Download one tool into MediaForge's tool folder, reporting progress as it goes. */
  installTool: (
    tool: Tool,
    onProgress: (progress: InstallProgress) => void,
  ) => Promise<InstallResult>;
  /** Ask GitHub for the newest MediaForge release. Rejects when it cannot be reached. */
  checkUpdate: () => Promise<UpdateInfo>;
  /** Replace the running program with the release in `info`. */
  installUpdate: (
    info: UpdateInfo,
    onProgress: (progress: UpdateProgress) => void,
  ) => Promise<void>;
  readClipboard: () => Promise<string | undefined>;
  /** Puts text on the clipboard; false when no clipboard tool works. Never rejects. */
  writeClipboard: (text: string) => Promise<boolean>;
  openFolder: (path: string) => Promise<void>;
  /** Size of a finished file in bytes, if it can be read. */
  fileSize: (path: string) => Promise<number | undefined>;
  /** The file system the folder browser reads. */
  folders: FolderFs;
  /** Where the settings file lives, shown on the About page. */
  configPath: string;
  /** The platform and CPU this build runs on, e.g. "win32-x64". */
  target: string;
  /** Where downloads go unless settings or the user say otherwise. */
  defaultOutputDir: string;
  /** Start the background core at login, or stop doing so. Never rejects. */
  applyAutostart: (enabled: boolean) => Promise<void>;
  /** Ask a running core to re-read the settings. Never starts a core, never rejects. */
  notifyCore: () => Promise<void>;
  /** Where bundled tools are looked up, for "how to fix" messages. */
  binDir: string;
  version: string;
  /** Joins the core as the downloads manager (starting it if needed). */
  managerCore: CoreConnector;
  /** Draws the user's eye to this terminal window. Never throws. */
  flash: () => void;
  /** Posts a problem report. Never rejects: a failure comes back as `{ ok: false }`. */
  sendReport: (report: Report) => Promise<SendResult>;
  /** The text of `history.json`, for the last failure in a report; undefined when unreadable. */
  readHistory: () => Promise<string | undefined>;
  /** The system, as reports name it: "Windows 11", "Linux 6.8.0". */
  osName: string;
}

export const DepsContext = createContext<AppDeps | undefined>(undefined);

export function useDeps(): AppDeps {
  const deps = useContext(DepsContext);
  if (!deps) throw new Error("useDeps must be used inside <DepsContext.Provider>");
  return deps;
}
