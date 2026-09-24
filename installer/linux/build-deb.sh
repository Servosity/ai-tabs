#!/bin/bash
# Build ai-tabs Linux .deb installer
# Must be run on a Debian/Ubuntu system with dpkg-deb available
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
VERSION="${CC_TABS_VERSION:-0.1.0}"

echo "Building ai-tabs ${VERSION} Linux .deb installer..."
echo ""

# ── Clean ────────────────────────────────────────────────────────────────────
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/pkg/opt/ai-tabs"
mkdir -p "$BUILD_DIR/pkg/DEBIAN"

# ── Payload: copy source files (no node_modules, no .git) ───────────────────
rsync -a \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='dist' \
    --exclude='installer' \
    --exclude='.github' \
    --exclude='chrome-profile' \
    --exclude='data' \
    --exclude='screenshot*' \
    --exclude='*.ps1' \
    --exclude='*.cmd' \
    --exclude='*.bat' \
    --exclude='*.ico' \
    --exclude='*.iss' \
    "$PROJECT_ROOT/" "$BUILD_DIR/pkg/opt/ai-tabs/"

# ── DEBIAN control files ────────────────────────────────────────────────────
sed "s/{{VERSION}}/${VERSION}/" "$SCRIPT_DIR/DEBIAN/control" > "$BUILD_DIR/pkg/DEBIAN/control"
cp "$SCRIPT_DIR/DEBIAN/postinst" "$BUILD_DIR/pkg/DEBIAN/postinst"
cp "$SCRIPT_DIR/DEBIAN/prerm" "$BUILD_DIR/pkg/DEBIAN/prerm"
chmod 755 "$BUILD_DIR/pkg/DEBIAN/postinst"
chmod 755 "$BUILD_DIR/pkg/DEBIAN/prerm"

# ── Build .deb ──────────────────────────────────────────────────────────────
echo "Building .deb package..."
dpkg-deb --build "$BUILD_DIR/pkg" "$BUILD_DIR/ai-tabs-${VERSION}-linux-amd64.deb"

echo ""
echo "Built: $BUILD_DIR/ai-tabs-${VERSION}-linux-amd64.deb"
