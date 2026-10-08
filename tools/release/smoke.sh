#!/usr/bin/env bash
# Smoke-test a built mediaforge binary on the machine it was built for.
#
#   tools/release/smoke.sh <path-to-binary> [expected-version]
#
# Checks --version, --help and `doctor --json`, then runs `setup --yes --tools yt-dlp` against a
# local fake yt-dlp repository (never the real upstream) and checks the cache and its manifest.
set -euo pipefail

bin="$1"
expected="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
port=8765

# Node and the binary are native programs; on Windows Git Bash they need Windows-style paths.
native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

cache="$(mktemp -d)"
node "$(native "$here/smoke-server.mjs")" "$port" &
server=$!
trap 'kill "$server" 2>/dev/null || true; rm -rf "$cache"' EXIT

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$port/repo/releases/latest" -o /dev/null 2>/dev/null; then break; fi
  sleep 0.2
done

version="$("$bin" --version)"
echo "version: $version"
if [ -n "$expected" ] && [ "$version" != "$expected" ]; then
  echo "expected version $expected" >&2
  exit 1
fi

"$bin" --help >/dev/null

# doctor exits 0 when both tools are found and 3 when one is missing; both are fine here.
set +e
"$bin" doctor --json >"$cache/doctor.json"
code=$?
set -e
if [ "$code" -ne 0 ] && [ "$code" -ne 3 ]; then
  echo "doctor exited with $code" >&2
  exit 1
fi
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$(native "$cache/doctor.json")"

# Regression guard for "tools look not runnable inside the packaged binary" (pkg patches execFile,
# see Task 5): offer the binary itself as a fake yt-dlp. It answers --version, so doctor must find
# it in the bundled folder. (ffmpeg is probed with -version and must print "ffmpeg version X", which
# the binary cannot fake, so only yt-dlp is checked; ffmpeg is expected to be missing here.)
ext=""
case "$bin" in *.exe) ext=".exe" ;; esac
mkdir -p "$cache/fakebin" "$cache/empty"
cp "$bin" "$cache/fakebin/yt-dlp$ext"
set +e
MEDIAFORGE_BIN_DIR="$(native "$cache/fakebin")" PATH="$(native "$cache/empty")" \
  "$bin" doctor --json >"$cache/doctor-fake.json"
code=$?
set -e
if [ "$code" -ne 0 ] && [ "$code" -ne 3 ]; then
  echo "doctor exited with $code" >&2
  exit 1
fi
node -e '
const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const ytDlp = report.tools.find((t) => t.tool === "yt-dlp");
if (!ytDlp?.found || ytDlp.source !== "bundled") {
  console.error("doctor did not find the runnable fake yt-dlp:", JSON.stringify(report.tools));
  process.exit(1);
}
' "$(native "$cache/doctor-fake.json")"

# Setup against the fake repository, with an empty PATH and an empty bundled folder so a yt-dlp on
# this machine (or next to the binary) cannot hide it.
mkdir -p "$cache/empty" "$cache/tools"
MEDIAFORGE_BIN_DIR="$(native "$cache/empty")" \
  MEDIAFORGE_CACHE_DIR="$(native "$cache/tools")" \
  MEDIAFORGE_YTDLP_REPO_URL="http://127.0.0.1:$port/repo" \
  PATH="$(native "$cache/empty")" \
  "$bin" setup --yes --tools yt-dlp

node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1] + "/manifest.json", "utf8"));
if (manifest["yt-dlp"]?.version !== "2099.01.01.000000") {
  console.error("manifest does not record yt-dlp:", manifest);
  process.exit(1);
}
const names = fs.readdirSync(process.argv[1]).sort();
console.log("cache holds:", names.join(", "));
if (names.some((name) => name.startsWith("."))) {
  console.error("temp files were left behind");
  process.exit(1);
}
' "$(native "$cache/tools")"

echo "smoke OK"
