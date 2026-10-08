import type { OutputProfile } from "@mediaforge/shared-types";
import type { PlannedStep } from "../engine/index.ts";
import type { MediaInfo, RawFormat } from "../formats.ts";
import { isAudio, isVideo, sizeOf, usableFormats } from "./format-choices.ts";

/**
 * Guess the steps a download will go through from the format list, so every bar can be shown
 * from the start. Returns undefined when there is nothing to go on; the steps then appear as
 * they begin. A wrong guess is corrected while downloading.
 */
export function planSteps(
  profile: OutputProfile,
  info: MediaInfo | undefined,
  selector: string | undefined,
): PlannedStep[] | undefined {
  // yt-dlp lists formats worst to best, in the same order it ranks them.
  const formats = info ? usableFormats(info).reverse() : [];
  const duration = info?.duration;
  const bytes = (f: RawFormat | undefined) => (f ? sizeOf(f, duration)?.bytes : undefined);
  const step = (kind: PlannedStep["kind"], f?: RawFormat): PlannedStep => {
    const size = bytes(f);
    return size === undefined ? { kind } : { kind, bytes: size };
  };
  const byId = (id: string | undefined) => formats.find((f) => f.format_id === id);
  const audioOnly = formats.filter((f) => !isVideo(f) && isAudio(f));

  if (profile.kind === "audio") {
    // Audio is always run through ffmpeg (extracted or converted) after it downloads.
    const picked =
      byId(selector) ?? audioOnly.find((f) => f.ext === profile.container) ?? audioOnly[0];
    return [step("audio", picked), step("convert")];
  }
  if (formats.length === 0) return undefined;

  // "bv" or "bv[height<=720]": the best stream without sound, under an optional height limit.
  const silent = /^bv(?:\[height<=(\d+)\])?$/.exec(selector ?? "");
  if (silent) {
    const limit = silent[1] ? Number(silent[1]) : undefined;
    const picked = formats.find(
      (f) => isVideo(f) && !isAudio(f) && (!limit || (f.height ?? 0) <= limit),
    );
    return [step("video", picked)];
  }
  if (selector) {
    const [videoId] = selector.split(/[+/]/);
    const picked = byId(videoId);
    if (!picked) return undefined;
    if (selector.includes("+") && !isAudio(picked)) {
      return [step("video", picked), step("audio", audioOnly[0]), step("merge")];
    }
    return [step(isAudio(picked) ? "download" : "video", picked)];
  }

  // No exact format: the profile picks the best video under its height cap, adding audio if needed.
  const cap = profile.maxHeight;
  const picked = formats.find((f) => isVideo(f) && (!cap || (f.height ?? 0) <= cap));
  if (!picked) return undefined;
  if (isAudio(picked)) return [step("download", picked)];
  return [step("video", picked), step("audio", audioOnly[0]), step("merge")];
}
