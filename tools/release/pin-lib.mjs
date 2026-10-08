// Pure helpers for pin-ffmpeg.mjs, kept apart so they can be tested without the network.

/** The static LGPL ffmpeg builds in BtbN/FFmpeg-Builds, and how to unpack each. */
export const BTBN_TARGETS = {
  "win32-x64": { suffix: "win64", archive: "zip", member: "bin/ffmpeg.exe" },
  "linux-x64": { suffix: "linux64", archive: "tar.xz", member: "bin/ffmpeg" },
  "linux-arm64": { suffix: "linuxarm64", archive: "tar.xz", member: "bin/ffmpeg" },
};

/** Martin Riedl's macOS release builds (GPL: libx264 and libx265 are enabled). */
export const RIEDL_HOST = "https://ffmpeg.martin-riedl.de";
export const RIEDL_TARGETS = {
  "darwin-x64": { arch: "amd64" },
  "darwin-arm64": { arch: "arm64" },
};

export const riedlRedirectUrl = (arch) =>
  `${RIEDL_HOST}/redirect/latest/macos/${arch}/release/ffmpeg.zip`;

const compareVersions = (a, b) => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * Pick the versioned, static, LGPL build for a target from a release's asset names. Shared builds,
 * GPL builds, the unversioned `master` builds and the floating `n9.0-latest` aliases are skipped: a
 * pinned build is named `n<version>-<commits>-g<hash>`. With several versions, the highest wins.
 */
export function selectBtbnAsset(names, target) {
  const { suffix, archive } = BTBN_TARGETS[target];
  const ext = archive === "zip" ? "zip" : "tar\\.xz";
  const pattern = new RegExp(
    `^ffmpeg-n(\\d+\\.\\d+(?:\\.\\d+)?)-\\d+-g[0-9a-f]+-${suffix}-lgpl-\\d+\\.\\d+\\.${ext}$`,
  );
  const matches = names
    .map((name) => ({ name, version: pattern.exec(name)?.[1] }))
    .filter((m) => m.version !== undefined);
  if (matches.length === 0) {
    const near = names.filter((n) => n.includes(suffix)).join(", ") || "(none)";
    throw new Error(`No static LGPL ${suffix} build found. Assets containing "${suffix}": ${near}`);
  }
  matches.sort((a, b) => compareVersions(b.version, a.version) || a.name.localeCompare(b.name));
  return matches[0];
}

const AUTOBUILD_TAG = /^autobuild-(\d{4}-\d{2})-\d{2}-\d{2}-\d{2}$/;

/**
 * BtbN keeps only the last 14 daily builds, but keeps the last build of each month for two years.
 * Pick the newest finished month's last build that passes `hasAllBuilds`, so a pin outlives the
 * daily builds. The current month is skipped: its last build is not known until the month ends.
 * Tags look like `autobuild-YYYY-MM-DD-HH-MM` (UTC), so they sort by time as plain strings.
 */
export function selectMonthEndRelease(releases, hasAllBuilds, now = new Date()) {
  const thisMonth = now.toISOString().slice(0, 7);
  const lastOfMonth = new Map();
  for (const release of releases) {
    const month = AUTOBUILD_TAG.exec(release.tag_name)?.[1];
    if (!month || month >= thisMonth) continue;
    const current = lastOfMonth.get(month);
    if (!current || release.tag_name > current.tag_name) lastOfMonth.set(month, release);
  }
  const found = [...lastOfMonth.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([, release]) => release)
    .find(hasAllBuilds);
  if (!found) {
    throw new Error(
      "No month-end FFmpeg-Builds release has all three static LGPL builds. Pass --tag to choose one.",
    );
  }
  return found;
}

/** Turn the redirect from the "latest" URL into the pinned download URL and its build id. */
export function parseRiedlLocation(location, base) {
  const url = new URL(location, base);
  const segments = url.pathname.split("/").filter(Boolean);
  const version = segments.at(-2);
  if (segments.length < 2 || !version) {
    throw new Error(`Unexpected redirect location: ${location}`);
  }
  return { url: url.toString(), version };
}

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
};

/** The lock file text: keys sorted so diffs show only what changed. */
export const renderLock = (lock) => `${JSON.stringify(sortKeys(lock), null, 2)}\n`;
