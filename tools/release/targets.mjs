// The release targets, shared by the build, the smoke tests and the publish step.
//
// Packaging mode: docs/superpowers/spike-pkg-sea.md records which mode passed. If it chose Node 24
// in Standard mode, set PKG_NODE to "node24" and PKG_MODE_ARGS to [] here and nowhere else.
export const PKG_NODE = "node22";
export const PKG_MODE_ARGS = ["--sea"];

/**
 * key: pkg's platform-arch name, also the suffix of the release file.
 * file: the release asset name the installers download.
 * runner: the GitHub runner that smoke-tests it natively. Keep in sync with release.yml
 * (workflows.test.mjs checks this).
 */
export const TARGETS = [
  { key: "win-x64", file: "mediaforge-win-x64.exe", runner: "windows-latest" },
  { key: "linux-x64", file: "mediaforge-linux-x64", runner: "ubuntu-24.04" },
  { key: "linux-arm64", file: "mediaforge-linux-arm64", runner: "ubuntu-24.04-arm" },
  { key: "macos-x64", file: "mediaforge-macos-x64", runner: "macos-15-intel" },
  { key: "macos-arm64", file: "mediaforge-macos-arm64", runner: "macos-15" },
];

export const pkgTarget = (target) => `${PKG_NODE}-${target.key}`;

export const pkgArgs = (target, entry, outFile) => [
  entry,
  ...PKG_MODE_ARGS,
  "--targets",
  pkgTarget(target),
  "--output",
  outFile,
];
