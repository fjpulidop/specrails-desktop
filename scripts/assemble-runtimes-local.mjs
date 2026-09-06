#!/usr/bin/env node
// Local dev port of the runtime-assembly steps in
// .github/workflows/desktop-release.yml (build-macos job).
//
// CI is the ONLY place that normally populates src-tauri/runtimes/ — `npm run
// build:desktop` has no assembly step, so a local build ships an empty
// runtimes/ (only .gitkeep) and the resulting .app runs as a normal server
// using the system PATH. On a clean Mac that means Add Project dead-ends with
// "dependencies not installed".
//
// This script reproduces the macOS arm64 Node + Git assembly locally so you can
// build a self-contained .app for testing. It does NOT codesign or notarize —
// that stays CI-only (signing after notarization would invalidate the updater).
// For a shippable build, use the desktop-release workflow.
//
// Usage: node scripts/assemble-runtimes-local.mjs   (or: npm run build:desktop:local)

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_BUNDLE_VERSION = '22.x';
const GIT_BUNDLE_VERSION = '2.49.0';
const GIT_SHA256 = '618190cf590b7e9f6c11f91f23b1d267cd98c3ab33b850416d8758f8b5a85628';
const UV_BUNDLE_VERSION = '0.11.28';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimes = path.join(repoRoot, 'src-tauri', 'runtimes');

if (process.platform !== 'darwin' || os.arch() !== 'arm64') {
  console.error(
    `This local assembler only targets macOS arm64 (got ${process.platform}/${os.arch()}).\n` +
      'For other platforms, use the desktop-release CI workflow.',
  );
  process.exit(1);
}

// Each step is a self-contained bash snippet mirroring the CI job verbatim.
function bash(label, script) {
  console.log(`\n=== ${label} ===`);
  execSync(`set -euo pipefail\n${script}`, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: '/bin/bash',
    env: { ...process.env, NODE_BUNDLE_VERSION, GIT_BUNDLE_VERSION, GIT_SHA256, UV_BUNDLE_VERSION },
  });
}

// --- Node (macOS arm64): download, SHA-verify, replace npm/npx symlinks with wrappers ---
bash('Download and verify Node.js (macOS arm64)', `
  NODE_VERSION=$(curl -fsSL "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" \\
    | grep 'node-v.*-darwin-arm64\\.tar\\.gz$' | awk '{print $2}' \\
    | grep -oE 'v[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1)
  TARBALL="node-\${NODE_VERSION}-darwin-arm64.tar.gz"
  URL="https://nodejs.org/dist/\${NODE_VERSION}/\${TARBALL}"
  echo "Downloading Node.js \${NODE_VERSION} (macOS arm64)..."
  curl -fsSL "\${URL}" -o "\${TARBALL}"
  EXPECTED_SHA=$(curl -fsSL "https://nodejs.org/dist/\${NODE_VERSION}/SHASUMS256.txt" \\
    | grep "\${TARBALL}" | awk '{print $1}')
  ACTUAL_SHA=$(shasum -a 256 "\${TARBALL}" | awk '{print $1}')
  if [[ "\${EXPECTED_SHA}" != "\${ACTUAL_SHA}" ]]; then
    echo "CHECKSUM MISMATCH: expected=\${EXPECTED_SHA} actual=\${ACTUAL_SHA}"; exit 1
  fi
  echo "Checksum OK: \${ACTUAL_SHA}"
  rm -rf src-tauri/runtimes/node
  mkdir -p src-tauri/runtimes/node
  tar -xzf "\${TARBALL}" --strip-components=1 -C src-tauri/runtimes/node
  rm "\${TARBALL}"
  NB="src-tauri/runtimes/node/bin"
  rm -f "\${NB}/npm" "\${NB}/npx"
  printf '%s\\n' \\
    '#!/bin/sh' \\
    'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"' \\
    'exec "$DIR/node" "$DIR/../lib/node_modules/npm/bin/npm-cli.js" "$@"' \\
    > "\${NB}/npm"
  printf '%s\\n' \\
    '#!/bin/sh' \\
    'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"' \\
    'exec "$DIR/node" "$DIR/../lib/node_modules/npm/bin/npx-cli.js" "$@"' \\
    > "\${NB}/npx"
  chmod 755 "\${NB}/node" "\${NB}/npm" "\${NB}/npx"
  echo "Extracted Node.js \${NODE_VERSION}; npm/npx replaced with bundled-node wrappers."
`);

// --- Git (macOS arm64): build relocatable from source, assert self-containment ---
bash('Build relocatable Git from source (macOS arm64)', `
  GIT_VERSION="\${GIT_BUNDLE_VERSION}"
  TARBALL="git-\${GIT_VERSION}.tar.xz"
  curl -fsSL "https://mirrors.edge.kernel.org/pub/software/scm/git/\${TARBALL}" -o "\${TARBALL}"
  ACTUAL_SHA=$(shasum -a 256 "\${TARBALL}" | awk '{print $1}')
  if [[ "\${GIT_SHA256}" != "\${ACTUAL_SHA}" ]]; then
    echo "CHECKSUM MISMATCH for \${TARBALL}: expected=\${GIT_SHA256} actual=\${ACTUAL_SHA}"; exit 1
  fi
  echo "Checksum OK: \${ACTUAL_SHA}"
  tar xf "\${TARBALL}"
  DEST="\$PWD/src-tauri/runtimes/git"
  rm -rf "\${DEST}"; mkdir -p "\${DEST}"
  pushd "git-\${GIT_VERSION}" >/dev/null
  MAKE_FLAGS=(
    prefix=/
    RUNTIME_PREFIX=YesPlease
    NO_GETTEXT=1 NO_OPENSSL=1 APPLE_COMMON_CRYPTO=1
    NO_TCLTK=1 NO_GITWEB=1
    gitexecdir=libexec/git-core
    template_dir=share/git-core/templates
  )
  USE_CURL=0
  if command -v curl-config >/dev/null 2>&1 && [[ "$(curl-config --prefix 2>/dev/null)" == "/usr" ]]; then
    USE_CURL=1
  fi
  if [[ "\${USE_CURL}" -eq 0 ]]; then
    echo "No self-contained system curl-config — building git without libcurl/expat (local ops only)."
    MAKE_FLAGS+=(NO_CURL=1 NO_EXPAT=1)
  fi
  make -j"$(sysctl -n hw.ncpu)" "\${MAKE_FLAGS[@]}"
  make "\${MAKE_FLAGS[@]}" DESTDIR="\${DEST}" install
  popd >/dev/null
  rm -rf "git-\${GIT_VERSION}" "\${TARBALL}"
  GITBIN="\${DEST}/bin/git"
  if [[ -d "\${DEST}/libexec/git-core" ]]; then
    find "\${DEST}/libexec/git-core" -type f | while read -r f; do
      if [[ "\${f}" -ef "\${GITBIN}" ]]; then rm -f "\${f}"; fi
    done
  fi
  test -x "\${DEST}/bin/git"
  test -d "\${DEST}/libexec/git-core"
  test -d "\${DEST}/share/git-core/templates"
  echo "=== otool -L git (must be system libs only) ==="
  otool -L "\${DEST}/bin/git"
  if otool -L "\${DEST}/bin/git" | awk 'NR>1{print $1}' | grep -E '(/opt/|/usr/local/|@rpath|@loader_path)'; then
    echo "ERROR: bundled git links a non-system dylib — not self-contained"; exit 1
  fi
  echo "Built relocatable Git \${GIT_VERSION} → \${DEST}"
`);

// --- uv (macOS arm64): download official standalone binary, SHA-verify ---
bash('Download and verify uv (macOS arm64)', `
  UV_VERSION="\${UV_BUNDLE_VERSION}"
  TARBALL="uv-aarch64-apple-darwin.tar.gz"
  BASE="https://releases.astral.sh/github/uv/releases/download/\${UV_VERSION}"
  echo "Downloading uv \${UV_VERSION} (macOS arm64)..."
  curl -fsSL "\${BASE}/\${TARBALL}" -o "\${TARBALL}"
  curl -fsSL "\${BASE}/\${TARBALL}.sha256" -o "\${TARBALL}.sha256"
  EXPECTED_SHA=$(awk '{print $1}' "\${TARBALL}.sha256")
  ACTUAL_SHA=$(shasum -a 256 "\${TARBALL}" | awk '{print $1}')
  if [[ "\${EXPECTED_SHA}" != "\${ACTUAL_SHA}" ]]; then
    echo "CHECKSUM MISMATCH for \${TARBALL}: expected=\${EXPECTED_SHA} actual=\${ACTUAL_SHA}"; exit 1
  fi
  echo "Checksum OK: \${ACTUAL_SHA}"
  rm -rf src-tauri/runtimes/uv tmp_uv
  mkdir -p src-tauri/runtimes/uv/bin tmp_uv
  tar -xzf "\${TARBALL}" -C tmp_uv
  UV_BIN=$(find tmp_uv -type f -name uv | head -1)
  test -n "\${UV_BIN}"
  mv "\${UV_BIN}" src-tauri/runtimes/uv/bin/uv
  chmod 755 src-tauri/runtimes/uv/bin/uv
  rm -rf tmp_uv "\${TARBALL}" "\${TARBALL}.sha256"
  src-tauri/runtimes/uv/bin/uv --version
  echo "Extracted uv \${UV_VERSION} → src-tauri/runtimes/uv/bin/uv"
`);

// --- Chromium (macOS arm64): bundle for the browser-capture feature, opt-in ---
// Default skipped (keeps the local build lean + avoids the download). Set
// BUNDLE_CHROMIUM=true to include it; the desktop app then launches the bundled
// Chromium instead of downloading a Playwright-managed one on first use.
if (process.env.BUNDLE_CHROMIUM === 'true') {
  bash('Bundle Chromium (macOS arm64)', `
    npx playwright install chromium
    node scripts/assemble-chromium.mjs
    test -s src-tauri/runtimes/chromium/chromium.tar.gz
  `);
}

// Sanity: assert the Rust has_runtimes gate (src-tauri/src/lib.rs:134) will pass.
const nodeBin = path.join(runtimes, 'node', 'bin', 'node');
const gitBin = path.join(runtimes, 'git', 'bin', 'git');
const uvBin = path.join(runtimes, 'uv', 'bin', 'uv');
if (!existsSync(nodeBin) || !existsSync(gitBin) || !existsSync(uvBin)) {
  console.error('\nAssembly incomplete — node, git, or uv binary missing.');
  process.exit(1);
}
console.log('\nRuntimes assembled. has_runtimes gate will pass → desktop mode active.');
console.log('NOTE: unsigned build — Gatekeeper will warn. For a signed/notarized');
console.log('build use the desktop-release CI workflow.');
