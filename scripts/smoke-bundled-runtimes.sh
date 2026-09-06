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

# Validate the actual shipped Chromium payload in an isolated temporary tree.
# macOS release callers require Developer ID signing and notarization through
# the corresponding SPECRAILS_REQUIRE_CHROMIUM_* environment variables. The
# functional probe uses Playwright with the sandbox enabled on macOS/Windows.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
if [[ -d "${RT}/chromium" || "${SPECRAILS_REQUIRE_CHROMIUM_SIGNATURE:-0}" == "1" || "${SPECRAILS_REQUIRE_CHROMIUM_NOTARIZATION:-0}" == "1" ]]; then
  "${NODE}" "${SCRIPT_DIR}/verify-chromium-bundle.mjs" "${RT}"
fi

echo "Smoke test PASSED for ${RT}"
