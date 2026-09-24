# ai-tabs

An Electron-based tab manager for AI coding-agent terminals — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), and [Gemini CLI](https://github.com/google-gemini/gemini-cli). Each project gets its own tab with a full xterm.js terminal that auto-launches your agent of choice — so you can run multiple agent sessions side by side.

## Features

- **Project launcher** — Landing page shows all project folders as a card grid. Click to open a terminal running your default agent in a new tab.
- **Multi-agent** — Pick Claude Code, Codex CLI, or Gemini CLI per project, or launch a plain terminal. Switch a project's default agent from the launcher.
- **Favorites bar** — Star projects to pin them to a quick-launch bar at the top. Favorited projects auto-open in background tabs on launch.
- **Categories** — Organize projects into named groups. Create, assign, and delete categories from an inline picker.
- **Full terminal** — xterm.js with WebGL rendering, Unicode 11, clickable links, auto-copy on select, right-click paste.
- **Tab drag & drop** — Reorder tabs by dragging within the tab bar. Drag a tab off the bar to spawn a new window (Chrome-style), and drop it onto another window to merge it back.
- **Multi-window** — Each window has its own tab bar and tabs. Drag tabs between windows freely.
- **Idle detection** — Tab flashes amber and the taskbar icon blinks when an agent finishes a task in a background tab.
- **Status line** — Per-tab bar (DNA from [claude-code-statusline](https://github.com/servosity/claude-code-statusline)) showing model, project folder, git branch, a window-scaled context-usage gradient bar, session token in/out counts, and active time. Full stats for Claude Code and Codex CLI (parsed from their session transcripts); other agents get folder/branch/elapsed. Toggle it in Settings → Behavior. Custom agents in `data/agents.json` can set `"statusline": "claude"` or `"codex"` to reuse a parser (e.g. for a wrapper around one of those CLIs).

  **Session cost and exact context window (Claude Code):** cost is computed by Claude Code itself and only exposed through its `statusLine` hook. ai-tabs wires this automatically: Claude launches get `--settings <generated file>` pointing CC's statusLine at the bundled forwarder (`scripts/statusline-forward.js`), which POSTs the hook's JSON to the local server. This is per-tab only — your global `~/.claude/settings.json` is never touched, and claude outside ai-tabs keeps whatever statusline you configured. Besides cost, the hook feeds the bar the exact context-window size, the model display name, and the exact transcript path (making stats accurate when two tabs run Claude in the same folder). Disable via the "Cost hook" toggle in Settings → Behavior. Note that inside ai-tabs tabs the injected hook replaces Claude Code's own in-terminal statusline — the tab bar is the status display.

  To get cost for Claude sessions running *outside* ai-tabs tabs too (matched to a tab by folder), you can instead set the forwarder globally in `~/.claude/settings.json`:

  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "node \"C:\\path\\to\\ai-tabs\\scripts\\statusline-forward.js\""
    }
  }
  ```
- **Keyboard shortcuts** — `Ctrl+T` new tab, `Ctrl+W` close tab, `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle tabs, `Ctrl+V` paste, `Shift+Enter` newline. Every other binding (agent launch, permission modes, custom commands) is editable in the hotkeys panel on the landing page.

## Requirements

| | Windows | macOS | Linux |
|---|---|---|---|
| **OS** | Windows 10+ | macOS 12+ | Any modern distro |
| **Node.js** | 22.12+ ([nodejs.org](https://nodejs.org)) | 22.12+ ([nodejs.org](https://nodejs.org)) | 22.12+ ([nodejs.org](https://nodejs.org)) |
| **C++ build tools** (node-pty is compiled on install) | Visual Studio Build Tools with the "Desktop development with C++" workload | `xcode-select --install` | `build-essential` and `python3` (or your distro's equivalent) |
| **Git** | [Git for Windows](https://git-scm.com/download/win) | Xcode CLI tools or `brew install git` | `apt install git` / `dnf install git` |
| **An agent CLI** | `npm i -g @anthropic-ai/claude-code` (or Codex CLI / Gemini CLI) | same | same |

## Installation

> **Packaged installers are behind the source.** The most recent packaged
> release on the [Releases](https://github.com/Servosity/ai-tabs/releases)
> page predates the ai-tabs rename (`cc-tabs v0.16.0`), so the GUI installers
> and one-liners below install that older version. For the current version,
> use the [manual install](#manual-all-platforms) until the next packaged
> release is cut.

### Windows

**GUI installer** — download the latest `ai-tabs-setup-<version>.exe` from [Releases](https://github.com/Servosity/ai-tabs/releases/latest) and run it. Checks prerequisites, installs dependencies, creates shortcuts.

**One-liner** (PowerShell):
```powershell
irm https://github.com/Servosity/ai-tabs/releases/latest/download/install.ps1 | iex
```

### macOS

**GUI installer** — download the latest `ai-tabs-<version>-macos.pkg` from [Releases](https://github.com/Servosity/ai-tabs/releases/latest) and open it. Installs to `~/.local/share/ai-tabs`, creates an app in ~/Applications, and a CLI command.

**One-liner** (Terminal):
```bash
curl -fsSL https://github.com/Servosity/ai-tabs/releases/latest/download/install.sh | bash
```

### Linux

**One-liner** (Terminal):
```bash
curl -fsSL https://github.com/Servosity/ai-tabs/releases/latest/download/install.sh | bash
```

Installs to `~/.local/share/ai-tabs`, creates a `.desktop` entry for application menus, and an `ai-tabs` symlink in `~/.local/bin/`.

### Manual (all platforms)

```bash
git clone https://github.com/servosity/ai-tabs.git
cd ai-tabs
npm install
```

## Configuration

Set these environment variables before starting, or accept the defaults:

| Variable | Default | Description |
|---|---|---|
| `PROJECTS_ROOT` | `~/Documents/Projects` | Folder containing your project directories. Each subfolder becomes a launchable project. |
| `AI_TABS_SHELL` | *(auto-detected)* | Override the shell binary used for terminals. Auto-detection finds Git Bash on Windows, or uses `$SHELL` on macOS/Linux. (`CC_TABS_SHELL` still works as a legacy alias.) |
| `AI_TABS_DEBUG` | *(off)* | Set to `1` to enable verbose debug logging to `data/debug.log` — useful when reporting a bug. (`CC_TABS_DEBUG` still works as a legacy alias; `"debug": true` in `data/settings.json` does the same without an env var.) |

## Usage

### Start ai-tabs

```bash
npm start          # the Electron app (branded ai-tabs.exe on Windows)
./ai-tabs.sh       # macOS / Linux alternative: server + browser UI, no Electron
```

`npm start` launches the Electron app window on every OS. On Windows it runs
the renamed `ai-tabs.exe` so the taskbar shows ai-tabs; elsewhere it runs the
stock Electron binary. The app starts its local server automatically (port 25283) as a
detached process, so the server survives app restarts. Click any project card to open a terminal running its default agent
in a new tab.

Open **Settings → Default session permissions** to choose the starting
permission profile for new Claude Code, Codex CLI, and Gemini CLI tabs. Changes
apply only to tabs opened afterward. Defaults remain Claude Manual, Codex Ask
for approval (`workspace-write` with on-request approvals), and Gemini Default.
The configured modifier-click launch gesture takes precedence: it starts the
selected agent in its explicit bypass mode instead of using this setting.

Dangerous permission profiles display a warning. Switching permissions during a
session remains the responsibility of each agent CLI.

> You can also open **http://localhost:25283** in a browser to reach the same
> UI — this is the path phones and tablets on your LAN use.

### Quick launch

- **Windows:** Double-click the desktop shortcut, or run `ai-tabs.cmd`
- **macOS:** Open ai-tabs from Launchpad/Spotlight, or run `ai-tabs` in Terminal
- **Linux:** Launch from application menu, or run `ai-tabs` in a terminal

### Remote access (phones / tablets)

To reach ai-tabs from another device, open **Settings** in the app and set a
password under **Remote access**. Until a password is set, remote browsers are
blocked. You can optionally set a **Remote hostname** (e.g. a Tailscale or DDNS
name) that the landing page will show as a bookmarkable URL.

⚠️ Remote access is not yet hardened — see [Security](#security). Keep it behind
Tailscale or a VPN; don't expose it to the public internet.

### Native desktop remote mode

The desktop app itself can connect to an ai-tabs server running on another
machine — no browser, no local server. Sessions run on the server and keep
running when the client app closes.

**Connect:** launching ai-tabs opens a **server picker** listing the local
server plus every remote server you've added. Choose **Add server**, enter the
server's address (e.g. `192.168.1.20:25283`) and its remote-access password,
and the app validates the connection, saves it, and opens a window bound to
that server. Inside a running window, **Settings → Remote access** shows which
server you're connected to with a **Switch server…** button that reopens the
picker. Saved servers live in `servers.json` in the client's Electron user-data
directory (`%APPDATA%\ai-tabs` on Windows, `~/Library/Application Support/ai-tabs`
on macOS, `~/.config/ai-tabs` on Linux), so they survive reinstalls.

### Control handoff

The server's own GUI no longer has to be closed. When a remote client connects,
the GUI on the server machine locks behind a "Remote client in control" screen —
sessions keep running and the remote client picks them up live. Whoever clicked
last has control: a **Take control** button on the lock screen swaps sides at
any time, from either machine. When the remote client quits or drops off the
network, control returns to the server's GUI automatically after a few seconds.

Quitting a GUI while another client is connected hands control over instead of
shutting anything down. Quitting the server machine's GUI when nothing else is
connected still shuts down the server and its sessions, as before.

**Use the server's IP address.** The server only accepts hostnames it owns
(its own IPs plus loopback), so connecting by a DNS or Tailscale name is
rejected with 403 unless that name is listed in the **server's**
`data/settings.json`:

```json
{ "extraAllowedHosts": ["my-desktop.tail1234.ts.net"] }
```

Restart the server after editing (the allowlist is read at startup).

If the server is unreachable or the password is wrong, the server picker shows the error in red, letting you try another server or fix the connection. Transient failures never silently switch to local mode — you control when to disconnect.

⚠️ Security: traffic is plain HTTP and the password is stored in plaintext in
the client's `data/settings.json` — use remote mode only over a trusted LAN,
Tailscale, or VPN (see [Security](#security)).

## Port

ai-tabs runs on port **25283** ("CLAUD" on a phone keypad). Change it in `server.js` if needed.

## How it works

- **Electron** provides the native window shell with a custom tab bar (`BaseWindow` + `WebContentsView`)
- **Express** serves the project launcher and API endpoints (projects, favorites, categories)
- **WebSocket** connects each tab to a **node-pty** pseudoterminal
- An agent registry (`lib/agents.js`) maps each project to a launch command — Claude Code, Codex CLI, Gemini CLI, or a plain shell
- Shell auto-detection picks the right backend per platform (Git Bash on Windows via winpty, default `$SHELL` on macOS/Linux)
- **xterm.js** with WebGL, Unicode 11, and web-links addons renders terminals
- Tab drag-off uses `showInactive()` to spawn windows without stealing pointer capture, with `setBounds` caching to prevent resize drift on Windows
- Favorites and categories persist to `data/favorites.json` and `data/categories.json`

## Security

ai-tabs runs a local server (port 25283) that exposes a control API and a
WebSocket. A few things worth knowing:

- **Cross-site protection.** As of this version, the server validates the
  `Origin` header on WebSocket connections and the `Host` header on all HTTP
  requests. This blocks malicious websites from reaching the local server
  through your browser (cross-site WebSocket hijacking and DNS-rebinding
  attacks). Connections from other websites are rejected.
- **LAN / phone access still works.** The server binds to all interfaces, and
  the allowlist includes your machine's own IPv4 LAN/Tailscale addresses, so
  accessing ai-tabs from another device on your network is unaffected.
- **Restart after an IP change.** The allowlist is computed once at startup. If
  your machine's IP address changes (DHCP renewal, joining Tailscale after
  launch), restart ai-tabs so it picks up the new address.
- **Launch links only work from ai-tabs itself.** The app page acts on its
  query string (`?cwd=`, `?agent=`), so the server refuses such loads when the
  browser reports another website started the navigation, and refuses to be
  framed. The open-tab API's `command` is kept server-side, keyed by a random
  request id, never carried in a URL.
- **The local control API trusts local processes.** Requests from `localhost`
  skip the password, and `POST /api/sessions/:id/input` types into any live
  terminal. Anything that can reach localhost — another local user, or a
  reverse proxy / tunnel you point at port 25283 — can drive your shells.
- **Remote access is not yet hardened.** The optional remote-access password
  (12+ characters) is sent over plain HTTP, and rate limiting is basic. Do not expose ai-tabs directly to untrusted
  networks or the public internet. If you need remote access, put it behind
  Tailscale or a VPN.
- **Auto-update is off by default.** Set `"autoUpdate": true` in
  `data/settings.json` to fast-forward a source checkout onto `origin/master`
  (and `npm install`) at every launch.
- **Keep `data/` private.** The `data/` directory holds local state including
  the remote-access password hash and debug logs.

## License

MIT
