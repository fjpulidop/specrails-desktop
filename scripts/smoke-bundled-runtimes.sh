#!/usr/bin/env bash
#
# smoke-bundled-runtimes.sh <runtimes-dir>
#
# Validates a bundled runtimes tree (Node + Git) the way the desktop app uses it:
#   - node/npm/npx respond to --version (npm/npx must resolve the BUNDLED node)
#   - git is FUNCTIONAL, not just `git --version`: init + commit + log + status
#     exercise libexec/git-core helpers and templates and would surface a missing
#     helper, a broken dylib, a dereferenced symlink, or a dropped exec bit.
#
# Used by .github/workflows/desktop-release.yml against BOTH the staging copy
# (src-tauri/runtimes) and the copy inside the assembled .app, on macOS and
# (via Git Bash) Windows.
set -euo pipefail

RT="${1:?usage: smoke-bundled-runtimes.sh <runtimes-dir>}"
if [[ ! -d "${RT}" ]]; then
  echo "ERROR: runtimes dir not found: ${RT}"
  exit 1
fi

# Resolve platform-specific tool paths (POSIX layout vs Windows layout).
if [[ -e "${RT}/node/bin/node" ]]; then
  NODE="${RT}/node/bin/node"; NPM="${RT}/node/bin/npm"; NPX="${RT}/node/bin/npx"
else
  NODE="${RT}/node/node.exe"; NPM="${RT}/node/npm.cmd"; NPX="${RT}/node/npx.cmd"
fi
if [[ -e "${RT}/git/bin/git" ]]; then
  GIT="${RT}/git/bin/git"
elif [[ -e "${RT}/git/cmd/git.exe" ]]; then
  GIT="${RT}/git/cmd/git.exe"
else
  GIT="${RT}/git/bin/git.exe"
fi
if [[ -e "${RT}/uv/bin/uv" ]]; then
  UV="${RT}/uv/bin/uv"
elif [[ -e "${RT}/uv/uv.exe" ]]; then
  UV="${RT}/uv/uv.exe"
elif [[ -e "${RT}/uv/bin/uv.exe" ]]; then
  UV="${RT}/uv/bin/uv.exe"
else
  echo "ERROR: bundled uv not found under ${RT}/uv"
  exit 1
fi

echo "=== bundled runtimes smoke test: ${RT} ==="
echo "node: $("${NODE}" --version)"
echo "npm:  $("${NPM}" --version)"
echo "npx:  $("${NPX}" --version)"
echo "git:  $("${GIT}" --version)"
echo "uv:   $("${UV}" --version)"

# Optional: bundled GitHub CLI (system-first fallback — see path-resolver.ts).
# Only validated when present; a runtimes tree without gh is still valid.
if [[ -e "${RT}/gh/bin/gh" ]]; then
  echo "gh:   $("${RT}/gh/bin/gh" --version | head -1)"
elif [[ -e "${RT}/gh/bin/gh.exe" ]]; then
  echo "gh:   $("${RT}/gh/bin/gh.exe" --version | head -1)"
fi

# Functional git check in an isolated temp repo with no global/system config.
T="$(mktemp -d 2>/dev/null || mktemp -d -t smokegit)"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
"${GIT}" -C "${T}" init -q
"${GIT}" -C "${T}" -c user.email=ci@specrails.dev -c user.name=ci commit -q --allow-empty -m "smoke"
"${GIT}" -C "${T}" log --oneline
"${GIT}" -C "${T}" status --porcelain >/dev/null
"${GIT}" -C "${T}" help -a >/dev/null   # proves libexec/git-core resolves
rm -rf "${T}"

# Optional: bundled Chromium for the browser-capture feature. Only validated when
# present (it is bundled solely when BUNDLE_CHROMIUM=true in the release workflow);
# otherwise the feature falls back to a Playwright-managed Chromium at runtime.
#
# IMPORTANT (BUG-CI-04): Chromium ships as a SINGLE OPAQUE, OBFUSCATED blob
# (chromium/chromium.pak — a XOR-transformed chromium.tar.gz; see the env comment
# in desktop-release.yml + scripts/obfuscate-chromium.mjs), NOT an unpacked tree.
# The previous probe `find`-ed for an unpacked *.app/chrome/chrome.exe tree that
# NEVER matches the shipped .pak, so it silently skipped validation — a
# broken/truncated/mis-keyed .pak shipped in signed releases with no CI signal.
# We now de-obfuscate the SHIPPED .pak (reversing the exact XOR the runtime uses),
# extract it, locate the executable, and run a headless --dump-dom against the
# extracted Chromium — proving the bundled blob round-trips to a runnable browser.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
OBFUSCATE="${SCRIPT_DIR}/obfuscate-chromium.mjs"
PAK="${RT}/chromium/chromium.pak"

if [[ -f "${PAK}" ]]; then
  echo "=== validating shipped chromium.pak: ${PAK} ==="
  if [[ ! -f "${OBFUSCATE}" ]]; then
    echo "ERROR: cannot find obfuscate-chromium.mjs at ${OBFUSCATE} to decode the .pak"
    exit 1
  fi
  CHROMIUM_TMP="$(mktemp -d 2>/dev/null || mktemp -d -t smokechromium)"
  # 1. Reverse the XOR (the transform is symmetric) → chromium.tar.gz.
  "${NODE}" "${OBFUSCATE}" "${PAK}" "${CHROMIUM_TMP}/chromium.tar.gz" >/dev/null \
    || { echo "ERROR: failed to de-obfuscate ${PAK}"; rm -rf "${CHROMIUM_TMP}"; exit 1; }
  # 2. Extract the recovered archive (Windows 10+ ships bsdtar as `tar`).
  mkdir -p "${CHROMIUM_TMP}/extracted"
  tar -xzf "${CHROMIUM_TMP}/chromium.tar.gz" -C "${CHROMIUM_TMP}/extracted" \
    || { echo "ERROR: chromium.pak did not decode to a valid tar.gz (corrupt/truncated/mis-keyed)"; rm -rf "${CHROMIUM_TMP}"; exit 1; }
  # 3. Locate the executable (Playwright's layout varies: a macOS *.app binary, or
  #    chrome.exe / chrome / chromium on Windows / Linux).
  CHROMIUM=$(find "${CHROMIUM_TMP}/extracted" -path "*.app/Contents/MacOS/*" -type f 2>/dev/null | head -1)
  if [[ -z "${CHROMIUM}" ]]; then
    CHROMIUM=$(find "${CHROMIUM_TMP}/extracted" -type f \( -name "chrome.exe" -o -name "chrome" -o -name "chromium" \) 2>/dev/null | head -1)
  fi
  if [[ -z "${CHROMIUM}" ]]; then
    echo "ERROR: extracted chromium.pak contains no chrome executable"
    rm -rf "${CHROMIUM_TMP}"; exit 1
  fi
  chmod +x "${CHROMIUM}" 2>/dev/null || true
  # 4. Functional headless probe against the extracted Chromium.
  echo "chromium: $("${CHROMIUM}" --version 2>&1 | head -n1)"
  "${CHROMIUM}" --headless=new --no-sandbox --dump-dom about:blank >/dev/null 2>&1 \
    || "${CHROMIUM}" --headless --no-sandbox --dump-dom about:blank >/dev/null 2>&1 \
    || { echo "ERROR: bundled chromium (from .pak) failed to render about:blank"; rm -rf "${CHROMIUM_TMP}"; exit 1; }
  rm -rf "${CHROMIUM_TMP}"
  echo "chromium.pak round-trip + headless probe OK"
elif [[ -d "${RT}/chromium" ]]; then
  # Defensive: a chromium/ dir with NO .pak means the obfuscated bundle is missing
  # — fail loudly rather than silently skipping (the old behaviour).
  echo "ERROR: ${RT}/chromium exists but ${PAK} is missing — chromium bundle is broken"
  exit 1
fi

echo "Smoke test PASSED for ${RT}"
