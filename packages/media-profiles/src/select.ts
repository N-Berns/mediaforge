import type { MediaCandidate, MediaVariant, OutputProfile } from "@mediaforge/shared-types";

export interface VariantSelection {
  /** Variant providing the picture (absent for audio profiles). */
  video?: MediaVariant;
  /** Separate audio variant, set when `video` has no audio track or the profile is audio-only. */
  audio?: MediaVariant;
  /** True when video and audio come from different variants and FFmpeg must merge them. */
  needsMerge: boolean;
}

const byBitrateDesc = (a: MediaVariant, b: MediaVariant) => (b.bitrate ?? 0) - (a.bitrate ?? 0);

const byQualityDesc = (a: MediaVariant, b: MediaVariant) =>
  (b.height ?? 0) - (a.height ?? 0) ||
  // Prefer muxed variants at equal height: they avoid a merge step.
  Number(b.hasAudio) - Number(a.hasAudio) ||
  byBitrateDesc(a, b);

/**
 * Pick the variant(s) that best satisfy a profile. Returns undefined when the
 * candidate has nothing usable (e.g. an audio profile on video-only variants).
 */
export function selectVariant(
  candidate: MediaCandidate,
  profile: OutputProfile,
): VariantSelection | undefined {
  const { variants } = candidate;
  const bestAudio = variants.filter((v) => v.hasAudio && !v.hasVideo).sort(byBitrateDesc)[0];

  if (profile.kind === "audio") {
    if (bestAudio) return { audio: bestAudio, needsMerge: false };
    // Fall back to extracting audio from the lowest-resolution muxed variant.
    const muxed = variants
      .filter((v) => v.hasVideo && v.hasAudio)
      .sort(byQualityDesc)
      .at(-1);
    return muxed ? { audio: muxed, needsMerge: false } : undefined;
  }

  const videos = variants.filter((v) => v.hasVideo).sort(byQualityDesc);
  const { maxHeight } = profile;
  const video =
    (maxHeight === undefined
      ? videos[0]
      : videos.find((v) => v.height === undefined || v.height <= maxHeight)) ??
    // Nothing fits under the cap: take the smallest available rather than failing.
    videos.at(-1);
  if (!video) return undefined;

  if (video.hasAudio || !bestAudio) return { video, needsMerge: false };
  return { video, audio: bestAudio, needsMerge: true };
}
