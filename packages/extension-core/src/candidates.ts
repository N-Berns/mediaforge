import type { DetectionSource, MediaCandidate, MediaVariant } from "@mediaforge/shared-types";
import type { Classification } from "./classify.ts";

/** Query params that vary between requests for the same media and must not split duplicates. */
const VOLATILE_PARAMS = ["range", "bytestart", "byteend", "rn", "rbuf", "_", "cb"];

/** Stable identity for a media URL: drops the hash, volatile params, and sorts the rest. */
export function candidateKey(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  url.hash = "";
  for (const param of VOLATILE_PARAMS) url.searchParams.delete(param);
  url.searchParams.sort();
  return url.toString();
}

export interface CreateCandidateInput {
  url: string;
  pageUrl: string;
  pageTitle?: string;
  source: DetectionSource;
  classification: Classification;
  mime?: string;
  durationSec?: number;
  thumbnail?: string;
  variants?: MediaVariant[];
  /** Defaults to Date.now(); injectable for tests. */
  detectedAt?: number;
}

export function createCandidate(input: CreateCandidateInput): MediaCandidate {
  const { classification, variants, detectedAt, ...rest } = input;
  const isAudio = classification.kind === "audio";
  return {
    ...rest,
    id: candidateKey(input.url),
    kind: classification.kind,
    streamType: classification.streamType,
    // Progressive files are a single variant; manifests get variants once parsed.
    variants:
      variants ??
      (classification.streamType === "progressive"
        ? [
            {
              id: "default",
              label: classification.container?.toUpperCase() ?? "Original",
              ...(classification.container && { container: classification.container }),
              hasVideo: !isAudio,
              hasAudio: true,
            },
          ]
        : []),
    detectedAt: detectedAt ?? Date.now(),
  };
}

const SOURCE_RANK: Record<DetectionSource, number> = { manifest: 3, network: 2, dom: 1 };

/**
 * Collapse candidates that refer to the same media, keeping the earliest
 * detection but upgrading to the richer source and merging known metadata.
 */
export function dedupeCandidates(candidates: readonly MediaCandidate[]): MediaCandidate[] {
  const byKey = new Map<string, MediaCandidate>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate.url);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }
    const preferred =
      SOURCE_RANK[candidate.source] > SOURCE_RANK[existing.source] ? candidate : existing;
    const other = preferred === candidate ? existing : candidate;
    byKey.set(key, {
      ...other,
      ...preferred,
      variants: preferred.variants.length > 0 ? preferred.variants : other.variants,
      detectedAt: Math.min(existing.detectedAt, candidate.detectedAt),
    });
  }
  return [...byKey.values()];
}
