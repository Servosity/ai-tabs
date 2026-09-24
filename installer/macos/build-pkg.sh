#!/bin/bash
# Build ai-tabs macOS .pkg installer
# Must be run on macOS with pkgbuild and productbuild available
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
VERSION="${CC_TABS_VERSION:-0.1.0}"

echo "Building ai-tabs ${VERSION} macOS installer..."
echo ""

# ── Clean ────────────────────────────────────────────────────────────────────
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/payload"
mkdir -p "$BUILD_DIR/resources"
mkdir -p "$BUILD_DIR/scripts"

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
    "$PROJECT_ROOT/" "$BUILD_DIR/payload/"

# ── Scripts ──────────────────────────────────────────────────────────────────
cp "$SCRIPT_DIR/scripts/preinstall" "$BUILD_DIR/scripts/preinstall"
cp "$SCRIPT_DIR/scripts/postinstall" "$BUILD_DIR/scripts/postinstall"
chmod +x "$BUILD_DIR/scripts/preinstall"
chmod +x "$BUILD_DIR/scripts/postinstall"

# ── Welcome / Conclusion HTML ────────────────────────────────────────────────
cat > "$BUILD_DIR/resources/welcome.html" << 'HTML'
<html><body>
<h1>ai-tabs</h1>
<p>Browser-based tab manager for AI coding-agent terminals.</p>
<p>This installer will:</p>
<ul>
  <li>Install ai-tabs to <code>~/.local/share/ai-tabs</code></li>
  <li>Run <code>npm install</code> to set up dependencies</li>
  <li>Create a <strong>ai-tabs.app</strong> in ~/Applications</li>
  <li>Create a CLI command at <code>~/.local/bin/ai-tabs</code></li>
</ul>
<p><strong>Requirements:</strong> Node.js 18+</p>
</body></html>
HTML

cat > "$BUILD_DIR/resources/conclusion.html" << 'HTML'
<html><body>
<h1>Installation Complete!</h1>
<p>ai-tabs has been installed. You can launch it by:</p>
<ul>
  <li>Opening <strong>ai-tabs</strong> from Launchpad or Spotlight</li>
  <li>Running <code>ai-tabs</code> in Terminal (if ~/.local/bin is in PATH)</li>
</ul>
<p><strong>Configuration:</strong> Set the <code>PROJECTS_ROOT</code> environment
variable if your projects aren't in ~/Projects.</p>
</body></html>
HTML

# ── Build component .pkg ─────────────────────────────────────────────────────
echo "Building component package..."
pkgbuild \
    --root "$BUILD_DIR/payload" \
    --install-location "$HOME/.local/share/ai-tabs" \
    --scripts "$BUILD_DIR/scripts" \
    --identifier "com.servosity.ai-tabs" \
    --version "$VERSION" \
    "$BUILD_DIR/ai-tabs-core.pkg"

# ── Update version in distribution.xml ───────────────────────────────────────
sed "s/version=\"0.0.0\"/version=\"${VERSION}\"/" "$SCRIPT_DIR/distribution.xml" > "$BUILD_DIR/distribution.xml"

# ── Build product .pkg ───────────────────────────────────────────────────────
echo "Building product package..."
productbuild \
    --distribution "$BUILD_DIR/distribution.xml" \
    --resources "$BUILD_DIR/resources" \
    --package-path "$BUILD_DIR" \
    "$BUILD_DIR/ai-tabs-${VERSION}-macos.pkg"

echo ""
echo "Built: $BUILD_DIR/ai-tabs-${VERSION}-macos.pkg"
