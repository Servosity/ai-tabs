# Terminal emulators vs ai-tabs (v0.31.4)

Research for wayfinder ticket #3 (part of #2). Date: 2026-08-21. Primary sources only (official docs, vendor repos); every matrix cell is backed by a URL in the Sources section. ai-tabs facts come from reading the repo (`README.md`, `package.json`, `public/index.html`, `lib/theme-presets.js`, `lib/pty-manager.js`, `lib/prompt-detector.js`, `lib/auto-update.js`).

## Summary

The five comparison targets (Warp, Ghostty, WezTerm, iTerm2, Windows Terminal) are all still top-tier as of Aug 2026 and none needed replacing: Warp shipped Windows (Feb 2025) and a new GPU engine (Mar 2026); Ghostty is at 1.2 with a command palette and SSH integration; iTerm2 3.6.11 shipped June 2026; Windows Terminal 1.22+ has Sixel, regex search and buffer-restoring sessions. The one caveat is WezTerm, whose last *stable* tag is 20240203 with development continuing on nightlies; it stays on the list because it is the only cross-platform entry with a built-in multiplexer, and kitty (the obvious substitute) has no Windows build.

ai-tabs is not a general terminal emulator; it is an agent-session manager built on xterm.js. Against that bar it is strong on the things the five do not do at all (per-tab agent launch, agent status line with cost/context, idle detection, Drive sync, remote control handoff, browser/phone access) and weak on baseline emulator plumbing. Every emulator hole listed below is fixable with an existing `@xterm/*` addon except splits, session restore, and shell-integration (OSC 133) marks, which need app work.

Tagging: **table-stakes** = all five have it and users expect it; **differentiator** = only some have it, and it would matter for an agent-first tool; **nice-to-have** = cosmetic or niche.

## Feature matrix

Legend: Y = documented; P = partial / opt-in / preview; N = not documented or explicitly absent; "?" = could not confirm from a primary source.

| Feature | Warp | Ghostty | WezTerm | iTerm2 | Windows Terminal | ai-tabs 0.31.4 |
|---|---|---|---|---|---|---|
| **Rendering** | | | | | | |
| GPU renderer | Y (Metal on macOS, wgpu elsewhere; new engine Mar 2026) [W6][W7] | Y (Metal macOS / OpenGL Linux) [G3] | Y (OpenGL default; WebGpu opt-in: Metal/Vulkan/DX12) [Z5] | Y (Metal renderer) [I5] | Y ("GPU accelerated text rendering engine") [M1] | Y (xterm.js WebGL addon; DOM fallback; atlas-corruption workaround) [A] |
| Ligatures | ? (not in docs) | Y [G3] | Y [Z1] | ? (not on features page) | Y (`font.features`, `liga`) [M8] | P (`fontLigatures` option toggle, but `@xterm/addon-ligatures` is NOT loaded, so the WebGL path does not shape ligatures) [A][X3] |
| Sixel | N (open issue) [W8] | N (Kitty only) [G3] | Y (experimental) [Z1] | Y [I3] | Y (1.22) [M5] | N (no `@xterm/addon-image`) [X2] |
| iTerm2 inline images (OSC 1337) | P (renders post-init; bug during shell init) [W9] | N [G3] | Y + `imgcat` [Z1] | Y (origin of protocol) [I4] | N | N |
| Kitty graphics | P [W9] | Y [G1] | Y [Z1] | N (not in feature reporting spec) [I3] | N | N |
| **Layout & sessions** | | | | | | |
| Split panes | Y [W5] | Y [G3] | Y [Z1] | Y [I1] | Y (directional, swap, move, zoom, read-only) [M6] | N (tabs + multi-window only) [A] |
| Tabs / tab drag-out / tab groups | Y tabs [W1] | Y native tabs [G1] | Y tabs + workspaces [Z1] | Y tabs [I1] | Y tabs + tear-out [M1] | Y tabs + Chrome-style tear-off/merge; no groups (categories are launcher-side) [A] |
| Session restore | Y (windows/tabs/panes + recent blocks, SQLite) [W3] | P (window/tab/split layout, macOS only) [G4] | P (mux server keeps panes alive; no layout save) [Z3] | Y (jobs survive upgrade/crash, since 3.0) [I5] | Y (layout; 1.22 re-displays buffer contents) [M2][M5] | P (server outlives GUI; ring-buffer replay / SIGWINCH repaint on reattach; favorites auto-open; no tab-set persistence) [A] |
| **Search & palette** | | | | | | |
| Scrollback search | Y (block find) [W4] | Y (search colours in config ref) [G5] | Y (Ctrl-Shift-F) [Z1] | Y (regex, global across tabs) [I1] | Y (regex since 1.22; per-pane) [M4][M5] | N (no `@xterm/addon-search`) [X1] |
| Command palette | Y [W1] | Y (1.2) [G2] | Y (Ctrl-Shift-P, since 2023-03) [Z4] | N (Toolbelt, not a palette) [I1] | Y (Ctrl-Shift-P; `wt` command-line mode) [M7] | N |
| **Shell integration** | | | | | | |
| OSC 133 prompt marks | Y (Blocks are the UI for this) [W4] | Y (auto-injected bash/elvish/fish/nu/zsh) [G6] | Y (OSC 133 + OSC 7 + OSC 1337) [Z2] | Y (own escape codes, marks) [I2] | Y (FTCS A/B/C/D; auto-mark on by default since 1.22) [M3][M5] | N (only OSC 9 notifications are sniffed, for idle detection) [A] |
| Jump to prompt | Y (Cmd/Ctrl-Up/Down blocks) [W4] | Y (`jump_to_prompt`) [G6] | Y (`ScrollToPrompt`) [Z2] | Y (Cmd-Shift-Up/Down) [I2] | Y (`scrollToMark`) [M3] | N |
| Select command output / block | Y (click block, multi-select) [W4] | Y (ctrl/cmd triple-click) [G6] | Y (`SelectTextAtMouseCursor` SemanticZone) [Z2] | Y (Edit menu) [I2] | Y (`selectOutput`, right-click menu) [M3] | N |
| Exit-code colouring | Y (red block) [W4] | ? | ? | ? | Y (mark colour from `133;D;<code>`) [M3] | N |
| **AI** | | | | | | |
| Built-in AI / agent | Y (Agent Mode, cloud agents "Oz", `/model`, code diffs) [W2] | N | N | Y (AI Chat: run commands, send keys, read terminal, permission model; separate plugin) [I6][I7] | P (Terminal Chat, Canary only; Copilot/Azure OpenAI/OpenAI; suggest-only) [M9] | Y by design: launches Claude Code / Codex / Gemini per tab; per-agent permission profiles; status line with model, context bar, cost via CC statusLine hook [A] |
| Agent-aware UI (idle/attention, cost) | Y (block status) [W4] | N | N | P (completion alerts) [I2] | N | Y (tab flash + taskbar blink on idle; cost/context/token counts) [A] |
| **Remote** | | | | | | |
| SSH integration | Y (Warpify companion server; Linux/macOS hosts only) [W10] | Y (`ssh-env`/`ssh-terminfo`, `ghostty +ssh`) [G2] | Y (SSH client, SSH/TLS/unix mux domains) [Z3] | Y (tmux -CC integration; uploads/downloads) [I8][I2] | P (SSH dynamic profiles) [M2] | N (no SSH client; run `ssh` in a plain tab) |
| Own remote protocol / mobile | N (cloud agents via web) [W2] | N | Y (mux server) [Z3] | N | N | Y (LAN web UI + PWA `mobile.html`, desktop remote mode, control handoff, waker service, push notifications) [A] |
| **Theming** | | | | | | |
| Themes | 22 built-in + image-based creator + OS light/dark sync [W11] | "hundreds", light/dark pair syntax [G3][G5] | 1001 schemes [Z6] | 24-bit colour, profiles [I1] | schemes + light/dark pair per profile, Mica/acrylic, shaders [M8] | 8 presets (Default Purple, Dracula, Solarized Dark, One Dark, Nord, Monokai, Tokyo Night, Gruvbox Dark); no light/dark pair [A] |
| **Packaging & updates** | | | | | | |
| Platforms | macOS, Windows (x64/ARM64), Linux [W12][W13] | macOS 13+, Linux; Windows not planned for 1.3 [G7][G2] | Linux, macOS, Windows, FreeBSD, NetBSD [Z1] | macOS 12.4+ only [I9] | Windows only [M2] | Windows 10+, macOS 12+, Linux (Electron) [A] |
| Install channels | direct, Homebrew, WinGet, apt/dnf/pacman/zypper, AppImage [W12] | DMG, package managers, source [G7] | installers/packages, nightly [Z7] | DMG [I9] | Microsoft Store, winget/choco/scoop, GitHub [M10] | GUI installer (Win/mac), one-liner scripts, git clone [A] |
| Auto-update | Y (all channels) [W12] | Y (listed feature) [G3] | N (notify only, `check_for_updates`) [Z8] | ? (not on downloads page) [I9] | Y via Store; N via GitHub builds [M10] | P (git fast-forward of a source checkout on startup + `npm install` when deps change; no binary updater) [A] |

## Holes in ai-tabs

### Table-stakes (all five have it; users will notice)
1. **Scrollback search** -- none. `@xterm/addon-search` (official) provides it [X1].
2. **Split panes** -- none; tabs and multi-window only. Warp/Ghostty/WezTerm/iTerm2/WT all split. Requires layout work in `public/index.html` and per-pane PTY sessions.
3. **Shell-integration marks (OSC 133)** -- not parsed. Enables jump-to-prompt, select-output, exit-code colouring, and a more reliable idle signal than OSC 9 + quiescence. WT auto-marks by default since 1.22 [M5]; Ghostty auto-injects [G6].
4. **Session restore on app restart** -- the tab set is not persisted. The detached server already keeps PTYs alive, so restoring the tab layout is the missing half.
5. **Working ligatures** -- the Settings toggle sets `fontLigatures` but `@xterm/addon-ligatures` is not loaded; with a canvas/WebGL renderer ligatures need the addon (Electron-only, needs font-file access) [X3].

### Differentiator (matters for an agent-first terminal)
6. **Image protocols** -- agents increasingly emit screenshots/plots; `@xterm/addon-image` gives Sixel + iTerm2 IIP (beta) and Kitty (alpha) in one addon [X2]. Only WezTerm supports all three today.
7. **Command palette** -- Warp, Ghostty, WezTerm, WT have one. For ai-tabs this is the natural home for "open project X with agent Y", permission-profile switches, and sync actions.
8. **Block/turn selection for agents** -- Warp's Blocks are the agent-era equivalent of OSC 133 zones. Once OSC 133 (or agent-specific markers) are parsed, "copy last agent turn" is a cheap differentiator.
9. **Transport security for remote** -- every competitor's remote story is SSH/TLS; ai-tabs is plain HTTP with a plaintext password [A]. Not an emulator feature per se, but it is the biggest gap in the part ai-tabs is best at.

### Nice-to-have
10. **Light/dark theme pairs** and more presets (WT, Ghostty, Warp all switch with the OS) [M8][G5][W11].
11. **Regex / case / whole-word search options** once search exists (WT added regex in 1.22) [M5].
12. **Broadcast input to several tabs** (Warp synchronized input, WT multi-pane) [W5][M6] -- useful for sending the same prompt to several agents.
13. **Per-pane read-only mode** (WT) [M6] -- would protect a running agent tab from stray keystrokes.
14. **Binary auto-update channel** (Warp, iTerm2, WT Store) instead of git fast-forward [W12][M10].

## Things ai-tabs does better than all five

- **Agent launch as the unit of work**: project card -> PTY running Claude Code / Codex / Gemini with a per-agent permission profile and a modifier-click bypass gesture. No emulator models third-party agents; Warp's Agent Mode is its own agent, not a host for other CLIs [W2].
- **Agent status line**: model, git branch, context-usage bar, token in/out, elapsed time, and exact session cost fed by Claude Code's `statusLine` hook without touching the user's global settings [A]. iTerm2's status bar (3.3) is generic [I5].
- **Idle/attention detection** across background tabs with taskbar blink, driven by OSC 9 + output quiescence [A]. Closest analogue is iTerm2's "alert when a long-running command finishes" [I2].
- **Remote control handoff**: server outlives the GUI, a phone/tablet PWA and a native remote mode attach to live sessions, "Take control" swaps sides, and a waker service can start a sleeping machine's server [A]. WezTerm's mux server is the only comparable architecture and has no handoff or mobile UI [Z3].
- **Google Drive project sync**: leases, checkpoints, Git bundle handoff, conflict recovery through the agent [A]. No emulator has a workspace-sync story.
- **Cross-platform from one codebase** including Windows, which Ghostty and iTerm2 lack and where Warp arrived only in 2025 [G2][I9][W13].

## Sources

**ai-tabs** [A]: `README.md`; `package.json` (deps: `@xterm/xterm` 5.5, addons fit/unicode11/web-links/webgl only); `public/index.html` lines 472-476 (addons loaded) and 677-678 (`fontLigatures`); `lib/theme-presets.js` (8 presets, `DEFAULT_SETTINGS`); `lib/prompt-detector.js` (OSC 9 + quiescence); `lib/pty-manager.js` (ring buffer, alt-screen tracking, repaint nudge); `lib/auto-update.js` (git fast-forward).

**xterm.js**: [X1] https://github.com/xtermjs/xterm.js/blob/master/README.md (official addon list) . [X2] https://github.com/xtermjs/xterm.js/blob/master/addons/addon-image/README.md . [X3] https://github.com/xtermjs/xterm.js/blob/master/addons/addon-ligatures/README.md

**Warp**: [W1] https://docs.warp.dev/ . [W2] https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes . [W3] https://docs.warp.dev/terminal/sessions/session-restoration . [W4] https://docs.warp.dev/terminal/blocks/block-basics . [W5] https://docs.warp.dev/terminal/windows/split-panes . [W6] https://www.warp.dev/blog/how-warp-works . [W7] https://www.warp.dev/newsroom/2026/3/8/new-gpu-accelerated-rendering-engine-launches . [W8] https://github.com/warpdotdev/Warp/issues/4282 . [W9] https://github.com/warpdotdev/warp/issues/10020 . [W10] https://docs.warp.dev/terminal/warpify/ssh . [W11] https://docs.warp.dev/terminal/appearance/themes . [W12] https://docs.warp.dev/getting-started/getting-started-with-warp . [W13] https://www.warp.dev/blog/launching-warp-on-windows

**Ghostty**: [G1] https://ghostty.org/docs/about . [G2] https://ghostty.org/docs/install/release-notes/1-2-0 . [G3] https://ghostty.org/docs/features . [G4] https://ghostty.org/docs/config/reference (`window-save-state`, `font-feature`) . [G5] https://ghostty.org/docs/config/reference (`theme`, `search-*`) . [G6] https://ghostty.org/docs/features/shell-integration . [G7] https://ghostty.org/download

**WezTerm**: [Z1] https://wezterm.org/features.html . [Z2] https://wezterm.org/shell-integration.html . [Z3] https://wezterm.org/multiplexing.html . [Z4] https://wezterm.org/config/lua/keyassignment/ActivateCommandPalette.html . [Z5] https://wezterm.org/config/lua/config/front_end.html . [Z6] https://wezterm.org/colorschemes/index.html . [Z7] https://wezterm.org/installation.html and https://wezterm.org/changelog.html (last stable 20240203-110809-5046fc22) . [Z8] https://wezterm.org/config/lua/config/check_for_updates.html

**iTerm2**: [I1] https://iterm2.com/features.html . [I2] https://iterm2.com/documentation-shell-integration.html . [I3] https://iterm2.com/feature-reporting/ (Sixel + OSC 1337 File booleans) . [I4] https://iterm2.com/documentation-images.html . [I5] https://iterm2.com/version3.html . [I6] https://iterm2.com/ai-plugin.html . [I7] https://iterm2.com/documentation-ai-chat.html . [I8] https://iterm2.com/documentation-tmux-integration.html . [I9] https://iterm2.com/downloads.html (3.6.11, macOS 12.4+)

**Windows Terminal**: [M1] https://learn.microsoft.com/en-us/windows/terminal/ . [M2] https://learn.microsoft.com/en-us/windows/terminal/customize-settings/startup . [M3] https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration . [M4] https://learn.microsoft.com/en-us/windows/terminal/search . [M5] https://github.com/microsoft/terminal/releases/tag/v1.22.2362.0 . [M6] https://learn.microsoft.com/en-us/windows/terminal/panes . [M7] https://learn.microsoft.com/en-us/windows/terminal/command-palette . [M8] https://learn.microsoft.com/en-us/windows/terminal/customize-settings/profile-appearance . [M9] https://learn.microsoft.com/en-us/windows/terminal/terminal-chat . [M10] https://learn.microsoft.com/en-us/windows/terminal/install

**Replacement check**: kitty https://sw.kovidgoyal.net/kitty/ (no Windows build) was the only candidate considered for swapping in; not chosen because the ai-tabs audience is Windows-heavy and WezTerm already covers the "cross-platform with multiplexer" slot.
