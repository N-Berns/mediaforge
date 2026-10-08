import { codec, type MediaInfo, type RawFormat } from "../formats.ts";
import type { MediaKind } from "../kind-folder.ts";
import { formatBytes } from "../progress-view.ts";
import type { MenuItem } from "./components/Menu.tsx";

type Choice<T> = Pick<MenuItem<T>, "value" | "label" | "hint">;

export type { MediaKind };

export interface FormatPick {
  /** Passed to yt-dlp `-f`. Left out when the profile alone decides what to fetch. */
  selector?: string;
  /** Profile that decides the output container for this pick. */
  profileId: "best" | "audio-m4a" | "audio-mp3-320";
}

const hasCodec = (value: string | undefined) => Boolean(value) && value !== "none";
export const isVideo = (f: RawFormat) => hasCodec(f.vcodec);
export const isAudio = (f: RawFormat) => hasCodec(f.acodec);

/** Storyboards, DRC duplicates, and manifests with no known codecs are not real choices. */
const usable = (f: RawFormat) =>
  Boolean(f.format_id) &&
  f.ext !== "mhtml" &&
  !f.format_id?.includes("-drc") &&
  (isVideo(f) || isAudio(f));

export const usableFormats = (info: MediaInfo) => (info.formats ?? []).filter(usable);

/** Which kinds this link can offer. "Video only" needs a stream that carries no audio. */
export function availableKinds(info: MediaInfo): Record<MediaKind, boolean> {
  const formats = usableFormats(info);
  return {
    "video-audio": formats.some(isVideo),
    video: formats.some((f) => isVideo(f) && !isAudio(f)),
    audio: formats.some((f) => !isVideo(f) && isAudio(f)),
  };
}

interface Size {
  bytes: number;
  /** True when yt-dlp reported the size rather than us guessing it from the bitrate. */
  exact: boolean;
}

/** Size from yt-dlp's own numbers, else bitrate times duration. */
export function sizeOf(f: RawFormat, duration: number | undefined): Size | undefined {
  if (f.filesize) return { bytes: f.filesize, exact: true };
  if (f.filesize_approx) return { bytes: f.filesize_approx, exact: false };
  if (f.tbr && duration) return { bytes: (f.tbr * 1000 * duration) / 8, exact: false };
  return undefined;
}

const sizeText = (size: Size | undefined, estimate = false) =>
  size ? `${size.exact && !estimate ? "" : "~"}${formatBytes(size.bytes)}` : "-";

/** One menu row before its columns are lined up. */
interface Entry {
  value: FormatPick;
  /** "Auto" on the row yt-dlp would pick; blank otherwise. */
  tag?: string;
  /** "1080p60", "MP3", ... */
  quality: string;
  ext: string;
  codec: string;
  /** Bitrate, right-aligned in its own column ("130 kbps"). */
  rate?: string;
  note: string;
  size: string;
}

/**
 * Line every row up in the same columns: tag, quality, format | codec, note, size.
 * Columns that are empty on every row are dropped so they leave no gap.
 */
function toChoices(all: Entry[]): Choice<FormatPick>[] {
  // Dubbed audio tracks and mirrors show up as rows that look identical; one is enough.
  const seen = new Set<string>();
  const entries = all.filter((e) => {
    const key = [e.quality, e.ext, e.codec, e.rate, e.note, e.size].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const width = (pick: (e: Entry) => string) => Math.max(0, ...entries.map((e) => pick(e).length));
  const [tagW, qualityW, extW, codecW, rateW, noteW, sizeW] = [
    width((e) => e.tag ?? ""),
    width((e) => e.quality),
    width((e) => e.ext),
    width((e) => e.codec),
    width((e) => e.rate ?? ""),
    width((e) => e.note),
    width((e) => e.size),
  ] as [number, number, number, number, number, number, number];
  // Text columns line up on the left, numbers (bitrate) on the right.
  const columns = (parts: [string, number, ("left" | "right")?][]) =>
    parts
      .filter(([, w]) => w > 0)
      .map(([text, w, align]) => (align === "right" ? text.padStart(w) : text.padEnd(w)))
      .join("  ");

  return entries.map((e) => ({
    value: e.value,
    label: columns([
      [e.tag ?? "", tagW],
      [e.quality, qualityW],
      [e.ext, extW],
    ]),
    hint: [
      columns([
        [e.codec, codecW],
        [e.rate ?? "", rateW, "right"],
        [e.note, noteW],
      ]),
      e.size.padStart(sizeW),
    ]
      .filter((part) => part.trim() !== "")
      .join("  ")
      .trimEnd(),
  }));
}

/**
 * HLS streams often carry a higher bitrate than the direct file next to them, yet yt-dlp ranks them
 * lower because they download in many small pieces. Saying so explains why "Auto" is not the biggest.
 */
const streamNote = (f: RawFormat) => (f.protocol?.startsWith("m3u8") ? "HLS stream" : "");

function resolutionName(f: RawFormat): string {
  const fps = f.fps && f.fps > 30 ? String(f.fps) : "";
  return f.height ? `${f.height}p${fps}` : "Video";
}

/** The formats for one kind. The first row is the one yt-dlp would pick, marked "Auto". */
export function formatChoices(info: MediaInfo, kind: MediaKind): Choice<FormatPick>[] {
  // yt-dlp lists formats worst to best, so the first after reversing is what it would pick.
  const formats = usableFormats(info).reverse();
  const duration = info.duration;
  const audioOnly = formats.filter((f) => !isVideo(f) && isAudio(f));
  const entries: Entry[] = [];

  if (kind === "video-audio" || kind === "video") {
    // yt-dlp's `ba` picks the best audio stream, so that is what gets added to silent video.
    const addedAudio = audioOnly[0] && sizeOf(audioOnly[0], duration);
    const pool =
      kind === "video" ? formats.filter((f) => isVideo(f) && !isAudio(f)) : formats.filter(isVideo);
    for (const f of pool) {
      const withSound = isAudio(f);
      const own = sizeOf(f, duration);
      const joined =
        kind === "video-audio" && !withSound && own && addedAudio
          ? { ...own, bytes: own.bytes + addedAudio.bytes }
          : own;
      entries.push({
        value: {
          selector:
            withSound || kind === "video" ? f.format_id : `${f.format_id}+ba/${f.format_id}`,
          profileId: "best",
        },
        quality: resolutionName(f),
        ext: f.ext ?? "",
        codec: codec(f.vcodec) === "-" ? "" : codec(f.vcodec),
        note: [kind === "video" ? "no sound" : withSound ? "" : "audio added", streamNote(f)]
          .filter(Boolean)
          .join(" · "),
        size: sizeText(joined, kind === "video-audio" && !withSound),
      });
    }
    const first = entries[0];
    if (first) {
      // The profile (or `bv`) makes the same choice itself, so the top row stands for it.
      first.tag = "Auto";
      first.value =
        kind === "video" ? { selector: "bv", profileId: "best" } : { profileId: "best" };
    }
  } else {
    // The "best audio" pick keeps m4a when there is one, like the m4a profile does.
    const bestM4a = audioOnly.find((f) => f.ext === "m4a") ?? audioOnly[0];
    const bitrate = (f: RawFormat) => (f.abr ? `${Math.round(f.abr)} kbps` : "");
    for (const f of audioOnly) {
      entries.push({
        value: { selector: f.format_id, profileId: "audio-m4a" },
        quality: "Audio",
        ext: f.ext ?? "",
        codec: codec(f.acodec) === "-" ? "" : codec(f.acodec),
        rate: bitrate(f),
        note: [f.ext === "m4a" ? "" : "saved as m4a", streamNote(f)].filter(Boolean).join(" · "),
        size: sizeText(sizeOf(f, duration)),
      });
    }
    const best = entries[audioOnly.indexOf(bestM4a as RawFormat)];
    if (best) {
      best.tag = "Auto";
      best.value = { profileId: "audio-m4a" };
      best.ext = "m4a";
      // A non-m4a best stream is converted, so say so rather than showing its own container.
      if (bestM4a?.ext !== "m4a") best.note = "saved as m4a";
      entries.splice(entries.indexOf(best), 1);
      entries.unshift(best);
    }
    // MP3 is always a conversion at 320 kbps; the length gives a rough size.
    entries.splice(best ? 1 : 0, 0, {
      value: { profileId: "audio-mp3-320" },
      quality: "MP3",
      ext: "mp3",
      codec: "mp3",
      rate: "320 kbps",
      note: "converted",
      size: duration ? `~${formatBytes((320 * 1000 * duration) / 8)}` : "-",
    });
  }
  return toChoices(entries);
}
