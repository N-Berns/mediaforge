#!/usr/bin/env bash
# End-to-end test of install/install.sh against a local fake release.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d)"
port=8766

node "$here/smoke-server.mjs" "$port" &
server=$!
trap 'kill "$server" 2>/dev/null || true; rm -rf "$tmp"' EXIT

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$port/release/SHA256SUMS" -o /dev/null 2>/dev/null; then break; fi
  sleep 0.2
done

export HOME="$tmp/home"
mkdir -p "$HOME"
export SHELL=/bin/bash
export MEDIAFORGE_RELEASE_TAG=v9.9.9
export MEDIAFORGE_INSTALL_DIR="$tmp/bin dir"
export MEDIAFORGE_RELEASE_BASE_URL="http://127.0.0.1:$port/release"

profile="$HOME/.bashrc"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

sh "$root/install/install.sh" --skip-tools
[ -x "$tmp/bin dir/mediaforge" ] || fail "the binary was not installed"
grep -q "fake mediaforge binary" "$tmp/bin dir/mediaforge" || fail "wrong binary content"
grep -qF "$tmp/bin dir" "$profile" || fail "PATH was not updated"

# A second run replaces the binary and does not add the PATH line twice.
sh "$root/install/install.sh" --skip-tools
[ "$(grep -cF "$tmp/bin dir" "$profile")" = "1" ] || fail "the PATH line was added twice"

# A download that does not match SHA256SUMS is refused and the installed binary is left alone.
before="$(cat "$tmp/bin dir/mediaforge")"
if MEDIAFORGE_RELEASE_BASE_URL="http://127.0.0.1:$port/corrupt" \
  sh "$root/install/install.sh" --skip-tools 2>"$tmp/err"; then
  fail "a corrupt download was accepted"
fi
grep -q "checksum mismatch" "$tmp/err" || fail "no checksum message: $(cat "$tmp/err")"
[ "$(cat "$tmp/bin dir/mediaforge")" = "$before" ] || fail "the installed binary changed"

# An unknown option is rejected, and so is a copy that is not tied to a release.
if sh "$root/install/install.sh" --nope 2>/dev/null; then fail "an unknown option was accepted"; fi
if env -u MEDIAFORGE_RELEASE_TAG sh "$root/install/install.sh" --skip-tools 2>"$tmp/err"; then
  fail "an unstamped installer ran"
fi
grep -q "not tied to a release" "$tmp/err" || fail "no unstamped message"

echo "install.sh OK"
