# DEC mode 2026 (synchronized output) under ai-tabs

Researched 2026-08-21 against xterm.js 5.5.0 / addon-webgl 0.19.0 / node-pty 1.1.0
(as pinned in `package.json`) and Claude Code 2.1.238.

## Verdict

**xterm.js 5.5.0 does not implement mode 2026.** Claude Code detects this
correctly and falls back to unsynchronized redraws. Setting
`CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` would not help — the `CSI ? 2026 h/l`
pairs would reach a terminal that ignores them — so it is **not** added to the
Claude agent's `env`. The fix is an xterm.js upgrade, not an env var.

## Evidence

### xterm.js

- Synchronized output landed in xterm.js via PR #5453, merged 2025-12-20,
  milestone **6.0.0**: DECSET/DECRST 2026, a DECRQM reply for 2026, and a 1 s
  safety flush. https://github.com/xtermjs/xterm.js/pull/5453
- The 6.0.0 release notes list "Add synchronized output support (DEC mode
  2026)". 5.5.0 predates it (April 2024).
  https://github.com/xtermjs/xterm.js/releases
- Local confirmation: `grep -c 2026 node_modules/@xterm/xterm/lib/xterm.js`
  returns **0** in the bundled 5.5.0; the webgl addon bundle also has 0 hits.
- 5.5.0 *does* implement DECRQM (the `$y` DECRPM reply is in the bundle) and
  per the VT feature docs "for modes not understood xterm.js always returns
  `notRecognized`", i.e. a probe of 2026 gets `CSI ? 2026 ; 0 $ y` — the
  spec's defined "not supported" answer.
  https://xtermjs.org/docs/api/vtfeatures/ ·
  https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036
- 5.5.0 does not answer XTVERSION with an `xterm.js` string either (no
  `P>|xterm.js` in the bundle), so Claude cannot identify the emulator that way.

### Claude Code's decision (2.1.238 binary, `strings` of the decision function)

Order of checks, reconstructed from the minified source:

1. `CLAUDE_CODE_FORCE_SYNC_OUTPUT` set → true.
2. `TERM_PROGRAM` in a hard-coded allowlist (iTerm.app, WezTerm, WarpTerminal,
   ghostty, contour, **vscode**, alacritty, mintty, rio, Tabby), JetBrains,
   Konsole ≥ 21.12, kitty, foot, Zed, **`WT_SESSION` set**, VTE ≥ 0.68 → true.
3. Otherwise the runtime probe result (`synchronizedOutputSupported`, filled
   from the DECRQM reply) decides; under tmux only the probe counts.

Under ai-tabs: `TERM=xterm-256color`, no `TERM_PROGRAM`, so the probe decides,
and xterm.js 5.5.0's `;0$y` reply correctly yields "unsupported". The docs
describe the same behaviour: "Claude Code probes the terminal for
synchronized-output support at startup and uses it when the terminal reports
it" and the override is for terminals that "support synchronized output but
[aren't] auto-detected, such as Emacs eat".
https://code.claude.com/docs/en/fullscreen ·
https://code.claude.com/docs/en/terminal-config

Related: users whose terminal *does* support 2026 but is not on the allowlist
reported Claude stopping sending 2026 in 2.1.110+ (issue #55613); the probe
path above is the answer to that.
https://github.com/anthropics/claude-code/issues/55613

### ConPTY (Windows)

- ai-tabs spawns with node-pty `useConpty: true` and no `useConptyDll`, so the
  OS in-box ConPTY is used (this machine: Windows 11 build 26200).
- Windows Terminal 1.22's ConPTY rewrite (PR #17510, "Goodbye VtEngine")
  promises "any VT output that an application generates will now be given to
  the terminal unmodified", and PR #17741 fixed the *input* side so terminal
  replies to passed-through queries are no longer swallowed. That is the
  version where `CSI ? 2026 h/l` and a DECRQM round-trip can be expected to
  survive ConPTY. https://github.com/microsoft/terminal/pull/17510 ·
  https://github.com/microsoft/terminal/pull/17741
- Whether the in-box conhost on a given Windows build carries that rewrite is
  **not verified** here. node-pty 1.1.0 exposes `useConptyDll: true` to use its
  bundled (terminal-repo) conpty.dll instead, which removes that uncertainty.
- Known ConPTY wrinkle even when it passes through: it coalesces output, so a
  frame's begin/end pair often arrives in one chunk (Rio changelog). xterm.js
  6.0's implementation handles an inline end and has a 1 s safety flush.

## Recommendation

1. **Do not set `CLAUDE_CODE_FORCE_SYNC_OUTPUT`** while on xterm.js 5.5.0. The
   emulator ignores 2026, so the variable only lies to Claude Code; benefit is
   nil and the failure mode (Claude trusting a sync that never happens) is
   unknown.
2. **Upgrade `@xterm/xterm` to 6.0.x** (with matching addon majors). Then the
   DECRQM probe returns "set/reset" and Claude Code enables synchronized output
   on its own — no env var needed. Re-verify the probe through ConPTY after the
   upgrade; if it fails there, try node-pty `useConptyDll: true` before reaching
   for `CLAUDE_CODE_FORCE_SYNC_OUTPUT`.
3. **Stop `WT_SESSION` leaking into PTYs.** `lib/pty-manager.js` does not strip
   it, so a server launched from a Windows Terminal shell hands every tab an
   env that makes Claude Code skip the probe and assume sync support it does
   not have. Add it to the stripped-env list (out of scope for this note).
