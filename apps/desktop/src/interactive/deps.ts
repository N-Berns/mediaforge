import { createContext, useContext } from "react";
import type { ToolReport } from "../doctor.ts";
import type { DownloadDeps } from "../download.ts";
import type { MediaInfo } from "../formats.ts";
import type { FolderFs } from "./folder-browser.ts";

/** Everything the interactive app needs from the outside world. Tests replace all of it. */
export interface AppDeps {
  download: DownloadDeps;
  fetchInfo: (url: string) => Promise<MediaInfo>;
  inspectTools: () => Promise<ToolReport[]>;
  readClipboard: () => Promise<string | undefined>;
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
  /** Where bundled tools are looked up, for "how to fix" messages. */
  binDir: string;
  version: string;
}

export const DepsContext = createContext<AppDeps | undefined>(undefined);

export function useDeps(): AppDeps {
  const deps = useContext(DepsContext);
  if (!deps) throw new Error("useDeps must be used inside <DepsContext.Provider>");
  return deps;
}
