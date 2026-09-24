#!/bin/bash
set -euo pipefail

# ── Banner ───────────────────────────────────────────────────────────────────
echo ""
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║           ai-tabs installer               ║"
echo "  ║   Browser tab manager for AI coding agents ║"
echo "  ╚═══════════════════════════════════════════╝"
echo ""

# ── Helpers ──────────────────────────────────────────────────────────────────
ok()   { echo "  [OK] $1"; }
fail() { echo "  [!!] $1"; }
warn() { echo "  [--] $1"; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

confirm() {
    printf "%s [Y/n] " "$1"
    read -r answer
    [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

# ── Prerequisites ────────────────────────────────────────────────────────────
echo "Checking prerequisites..."
echo ""

# Node.js
if command_exists node; then
    node_version=$(node --version | sed 's/^v//')
    node_major=$(echo "$node_version" | cut -d. -f1)
    node_minor=$(echo "$node_version" | cut -d. -f2)
    # Electron 41 and its build tooling need Node 22.12+
    if [[ "$node_major" -gt 22 || ( "$node_major" -eq 22 && "$node_minor" -ge 12 ) ]]; then
        ok "Node.js $node_version"
    else
        fail "Node.js $node_version found (need 22.12+)"
        echo "       Install from https://nodejs.org"
        exit 1
    fi
else
    fail "Node.js not found"
    echo "       Install from https://nodejs.org or via your package manager:"
    echo "       macOS:  brew install node"
    echo "       Ubuntu: sudo apt install nodejs npm"
    echo "       Fedora: sudo dnf install nodejs"
    exit 1
fi

# Git
if command_exists git; then
    git_version=$(git --version | sed 's/git version //')
    ok "Git $git_version"
else
    fail "Git not found"
    echo "       Install via your package manager:"
    echo "       macOS:  xcode-select --install  or  brew install git"
    echo "       Ubuntu: sudo apt install git"
    echo "       Fedora: sudo dnf install git"
    exit 1
fi

# Claude Code (optional)
if command_exists claude; then
    ok "Claude Code"
else
    warn "Claude Code not found (optional)"
    echo "       Install later: npm install -g @anthropic-ai/claude-code"
fi

echo ""

# ── Install / Update ────────────────────────────────────────────────────────
INSTALL_DIR="${HOME}/.local/share/ai-tabs"
install_dir_is_fresh=false
[[ -d "$INSTALL_DIR" ]] || install_dir_is_fresh=true

# Kill running ai-tabs so file locks don't block npm install
cc_pids=$(pgrep -f "${INSTALL_DIR}/.*node" 2>/dev/null || true)
if [[ -n "$cc_pids" ]]; then
    echo "  Stopping running ai-tabs..."
    echo "$cc_pids" | xargs kill 2>/dev/null || true
    sleep 1
    ok "Stopped"
fi

if [[ -d "${INSTALL_DIR}/.git" ]]; then
    echo "Updating existing installation..."
    cd "$INSTALL_DIR"
    if ! git pull --ff-only; then
        echo "  git pull failed, trying fresh clone..."
        cd /
        rm -rf "$INSTALL_DIR"
        git clone https://github.com/Servosity/ai-tabs.git "$INSTALL_DIR"
    fi
else
    if [[ -d "$INSTALL_DIR" ]]; then
        rm -rf "$INSTALL_DIR"
    fi
    echo "Cloning ai-tabs..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone https://github.com/Servosity/ai-tabs.git "$INSTALL_DIR"
fi

# One-time migration: if this run started with no existing ai-tabs install and
# a legacy cc-tabs install exists, adopt its settings data so the user doesn't
# lose favorites, projects, or theme settings when switching to the new
# install directory. Runs after the clone/update above so the freshly checked
# out install dir isn't wiped out afterward.
if [[ "$install_dir_is_fresh" == true ]]; then
    LEGACY_INSTALL_DIR="${HOME}/.local/share/cc-tabs"
    LEGACY_DATA_DIR="${LEGACY_INSTALL_DIR}/data"
    if [[ -d "$LEGACY_DATA_DIR" ]]; then
        mkdir -p "${INSTALL_DIR}/data"
        migrated_any=false
        for f in "${LEGACY_DATA_DIR}"/*.json; do
            [[ -e "$f" ]] || continue
            dest="${INSTALL_DIR}/data/$(basename "$f")"
            if [[ ! -e "$dest" ]]; then
                cp "$f" "$dest"
                migrated_any=true
            fi
        done
        if [[ "$migrated_any" == true ]]; then
            ok "Migrated settings from legacy cc-tabs install"
        fi
    fi
fi

echo "Installing dependencies (this may take a minute)..."
cd "$INSTALL_DIR"
if ! npm install --no-fund --no-audit 2>/dev/null; then
    npm install || { fail "npm install failed. Check errors above."; exit 1; }
fi
ok "Dependencies installed"
echo ""

# ── CLI symlink ──────────────────────────────────────────────────────────────
echo "Creating symlink..."
mkdir -p "${HOME}/.local/bin"
ln -sf "${INSTALL_DIR}/ai-tabs.sh" "${HOME}/.local/bin/ai-tabs"
chmod +x "${INSTALL_DIR}/ai-tabs.sh"
ok "Symlink: ~/.local/bin/ai-tabs"

# Check if ~/.local/bin is in PATH
if [[ ":$PATH:" != *":${HOME}/.local/bin:"* ]]; then
    warn "~/.local/bin is not in your PATH"
    echo "       Add to your shell profile:"
    echo "       export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
echo ""

# ── Desktop integration ──────────────────────────────────────────────────────
if [[ "$(uname)" == "Darwin" ]]; then
    echo "Creating application bundle..."
    APP_DIR="${HOME}/Applications/ai-tabs.app"
    mkdir -p "${APP_DIR}/Contents/MacOS"
    mkdir -p "${APP_DIR}/Contents/Resources"

    # Info.plist
    cat > "${APP_DIR}/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>ai-tabs</string>
    <key>CFBundleDisplayName</key>
    <string>ai-tabs</string>
    <key>CFBundleIdentifier</key>
    <string>com.servosity.ai-tabs</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleExecutable</key>
    <string>ai-tabs</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
</dict>
</plist>
PLIST

    # Launcher script inside .app
    cat > "${APP_DIR}/Contents/MacOS/ai-tabs" << LAUNCHER
#!/bin/bash
cd "${INSTALL_DIR}"
if ! lsof -iTCP:25283 -sTCP:LISTEN -t >/dev/null 2>&1; then
    nohup node server.js > /dev/null 2>&1 &
    sleep 2
fi
open "http://localhost:25283"
LAUNCHER
    chmod +x "${APP_DIR}/Contents/MacOS/ai-tabs"

    ok "Application: ~/Applications/ai-tabs.app"
    echo "       Visible in Launchpad and Spotlight"
    echo ""

elif [[ "$(uname)" == "Linux" ]]; then
    echo "Creating desktop entry..."
    DESKTOP_DIR="${HOME}/.local/share/applications"
    mkdir -p "$DESKTOP_DIR"

    cat > "${DESKTOP_DIR}/ai-tabs.desktop" << DESKTOP
[Desktop Entry]
Name=ai-tabs
Comment=Browser-based tab manager for AI coding-agent terminals
Exec=${INSTALL_DIR}/ai-tabs.sh
Terminal=false
Type=Application
Categories=Development;
StartupNotify=false
DESKTOP

    # Update desktop database if available
    if command_exists update-desktop-database; then
        update-desktop-database "$DESKTOP_DIR" 2>/dev/null
    fi

    ok "Desktop entry: ~/.local/share/applications/ai-tabs.desktop"
    echo "       Visible in application menus"
    echo ""
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║         Installation complete!            ║"
echo "  ╚═══════════════════════════════════════════╝"
echo ""
echo "  Installed to: $INSTALL_DIR"
echo ""
echo "  Configuration:"
echo "    Set PROJECTS_ROOT if your projects aren't in ~/Projects:"
echo "    export PROJECTS_ROOT=\"/your/path\""
echo ""

# Launch now?
if confirm "Launch ai-tabs now?"; then
    bash "${INSTALL_DIR}/ai-tabs.sh"
    echo ""
    echo "  ai-tabs is starting at http://localhost:25283"
fi

echo ""
