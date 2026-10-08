import { homedir } from "node:os";
import { join } from "node:path";

/** Overrides the managed tool folder. Used by tests and by people who want the tools elsewhere. */
export const CACHE_DIR_ENV = "MEDIAFORGE_CACHE_DIR";

/** Where downloaded yt-dlp and ffmpeg live, per OS. */
export function cacheDir(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env[CACHE_DIR_ENV];
  if (override) return override;
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "MediaForge", "bin");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "MediaForge", "bin");
  }
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "mediaforge", "bin");
}
