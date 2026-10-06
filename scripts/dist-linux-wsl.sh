#!/bin/bash
# Builds the Linux packages (.deb + AppImage) inside a throwaway WSL distro, for when Docker is not
# available (scripts/dist-linux.mjs is the Docker route). Run as root in a fresh Ubuntu:
#
#   wsl -d <distro> -u root --exec /bin/bash scripts/dist-linux-wsl.sh <repo-on-/mnt/c> <node-version>
#
# The committed sources (git archive of HEAD, made on Windows into .qa/src-head.tar) are built on the
# distro's own disk; only the packages are copied back to dist/linux.
set -euo pipefail
REPO="$1"
NODE_VERSION="${2:-24.20.0}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl xz-utils ca-certificates >/dev/null
if [ ! -x /opt/node/bin/node ]; then
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz
  mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
fi
export PATH="/opt/node/bin:$PATH"
rm -rf /build && mkdir -p /build && tar -xf "$REPO/.qa/src-head.tar" -C /build
cd /build
npm ci --no-audit --no-fund
node scripts/build.mjs --production
npx electron-builder --linux deb AppImage --publish never
mkdir -p "$REPO/dist/linux"
cp dist/*.deb dist/*.AppImage "$REPO/dist/linux/"
ls -la "$REPO/dist/linux"
