#!/bin/sh
# MediaForge installer for Linux and macOS.
#
#   curl -fsSL https://github.com/N-Berns/mediaforge/releases/latest/download/install.sh | sh
#   curl -fsSL https://github.com/N-Berns/mediaforge/releases/latest/download/install.sh | sh -s -- --skip-tools
#
# It downloads the mediaforge binary for this computer from the GitHub release this script
# belongs to, checks its SHA-256 against the release's SHA256SUMS, puts it in ~/.local/bin (adding
# that folder to your PATH if needed) and, unless you pass --skip-tools, runs
# `mediaforge setup --yes` to download yt-dlp and ffmpeg.
# It never uses sudo and writes nothing outside your home folder. It is short; read it first if
# you like.
set -eu

REPO="N-Berns/mediaforge"
# The release workflow replaces the placeholder with the release tag when it publishes this file.
TAG="${MEDIAFORGE_RELEASE_TAG:-__RELEASE_TAG__}"
INSTALL_DIR="${MEDIAFORGE_INSTALL_DIR:-$HOME/.local/bin}"
SKIP_TOOLS=0

say() { printf '%s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# Everything runs from main, called on the last line, so a download cut short runs nothing.
main() {
  for arg in "$@"; do
    case "$arg" in
      --skip-tools) SKIP_TOOLS=1 ;;
      -h | --help)
        say "Usage: install.sh [--skip-tools]"
        exit 0
        ;;
      *) fail "unknown option: $arg" ;;
    esac
  done

  case "$TAG" in
    __RELEASE*) fail "this copy of install.sh is not tied to a release. Download it from https://github.com/$REPO/releases" ;;
  esac
  BASE_URL="${MEDIAFORGE_RELEASE_BASE_URL:-https://github.com/$REPO/releases/download/$TAG}"

  command -v curl >/dev/null 2>&1 || fail "curl is required"

  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    *) fail "unsupported operating system: $os (supported: Linux, macOS)" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "unsupported CPU: $arch (supported: x86_64, arm64)" ;;
  esac
  asset="mediaforge-$os-$arch"

  if command -v sha256sum >/dev/null 2>&1; then
    hash_of() { sha256sum "$1" | cut -d ' ' -f 1; }
  elif command -v shasum >/dev/null 2>&1; then
    hash_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
  else
    fail "sha256sum or shasum is required to verify the download"
  fi

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  say "Downloading $asset ($TAG)..."
  curl -fsSL "$BASE_URL/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "could not download $BASE_URL/SHA256SUMS"
  curl -fsSL "$BASE_URL/$asset" -o "$tmp/$asset" || fail "could not download $BASE_URL/$asset"

  expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
  actual="$(hash_of "$tmp/$asset")"
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed."

  # Copy next to the final name and rename, so an interrupted install never leaves a half-written binary.
  mkdir -p "$INSTALL_DIR"
  cp "$tmp/$asset" "$INSTALL_DIR/.mediaforge.new"
  chmod 755 "$INSTALL_DIR/.mediaforge.new"
  mv -f "$INSTALL_DIR/.mediaforge.new" "$INSTALL_DIR/mediaforge"
  say "Installed $INSTALL_DIR/mediaforge"

  profile_file() {
    case "${SHELL:-}" in
      */zsh) printf '%s' "$HOME/.zshrc" ;;
      */bash)
        if [ "$os" = "macos" ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi
        ;;
      *) printf '%s' "$HOME/.profile" ;;
    esac
  }

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      profile="$(profile_file)"
      if [ -f "$profile" ] && grep -qF "$INSTALL_DIR" "$profile"; then
        :
      else
        printf '\n# Added by the MediaForge installer\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >>"$profile"
        say "Added $INSTALL_DIR to your PATH in $profile. Open a new terminal to use it."
      fi
      ;;
  esac

  if [ "$SKIP_TOOLS" -eq 0 ]; then
    say "Setting up yt-dlp and ffmpeg..."
    "$INSTALL_DIR/mediaforge" setup --yes || say "Tool setup did not finish. Run 'mediaforge setup' when you are online."
  fi

  say "MediaForge $TAG is ready. Run: mediaforge"
}

main "$@"
