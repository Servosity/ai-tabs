# Agent session managers vs ai-tabs (Aug 2026)

Research for [#4](https://github.com/Servosity/ai-tabs/issues/4), part of #2. All claims checked
against primary sources (vendor sites, official docs, GitHub repos) on 2026-08-21. ai-tabs facts
come from the repo at v0.31.4 (`README.md`, `lib/agents.js`, `lib/attention-hook.js`,
`lib/statusline/`, `server.js`, `public/mobile.html`).

## Summary

The category has consolidated around one pattern: **one isolated git worktree per agent run, a
diff/PR review surface next to the session, and OS-level "agent finished / needs you" signals**.
Every living leader does all three. ai-tabs does the third well (hook-driven attention, ntfy push,
mobile Approve/Reject) and is the only one with a server-outlives-client design plus a
two-machine control handoff, but it has **no worktree isolation and no diff/PR surface** -- the
two table-stakes features of the category.

Of the eight candidates in the ticket, three are no longer leading and one is a different category:

| Candidate | Status (verified) |
|---|---|
| Crystal | Deprecated Feb 2026 in favour of Nimbalyst; last push 2026-02-26 ([repo](https://github.com/stravu/crystal)) |
| Vibe Kanban | Bloop shut down 2026-04-10; repo "community maintained" but last push 2026-04-24, cloud features removed after 30 days ([announcement](https://vibekanban.com/blog/shutdown), [repo](https://github.com/BloopAI/vibe-kanban)) |
| CodeLayer | OSS repo says "pretty much all deprecated"; last push 2026-06-19. HumanLayer relaunched as a closed, paid SaaS ($100/user/mo Pro, free for 3 users) ([repo](https://github.com/humanlayer/humanlayer), [humanlayer.com](https://humanlayer.com/)) |
| Cursor cloud agents | Alive, but cloud VMs that open PRs, billed at API pricing on top of a paid plan -- not a local session manager ([docs](https://cursor.com/docs/cloud-agent)). Treated as adjacent, not matrixed in full. |

## The top 5 and why

1. **Claude Code Desktop (Anthropic)** -- first-party, free with a Claude plan, macOS + Windows +
   Linux beta. Parallel sessions with per-session worktrees, pane layout, diff review with line
   comments, PR/CI monitoring, usage ring, Dispatch from phone. Sets the baseline everyone else is
   measured against. ([docs](https://code.claude.com/docs/en/desktop))
2. **Conductor** -- free local tier, $50/mo Pro adds cloud workspaces, $60/user Teams. Mac-only.
   Claude Code, Codex, Cursor, OpenCode. Venture-backed per secondary coverage (Series A, Mar 2026;
   not verified on a primary page). ([site](https://www.conductor.build/),
   [pricing](https://www.conductor.build/pricing), [docs](https://www.conductor.build/docs/))
3. **Superset** -- 13.2k stars, shipping daily (desktop-v1.24.1 on 2026-08-21), free desktop app,
   ELv2 source-available. "100+ agents" in worktrees, diff viewer, PR split view, automations,
   CLI/SDK/MCP remote surface. macOS + Linux experimental; **no Windows**.
   ([repo](https://github.com/superset-sh/superset), [docs](https://docs.superset.sh/overview))
4. **Claude Squad** -- 8.3k stars, AGPL-3.0, v1.0.20 released 2026-08-20. The terminal-native
   (tmux + worktree) reference implementation; closest in spirit to ai-tabs' "it's the real CLI in
   a terminal" stance. ([repo](https://github.com/smtg-ai/claude-squad))
5. **Nimbalyst** -- Crystal's successor, 1.5k stars, MIT, v0.74.1 released 2026-08-21. The only
   OSS entry with **Windows + macOS + Linux + iOS/Android companions**, push notifications, voice
   reply, and mobile diff review; also kanban and visual editors. Directly overlaps ai-tabs'
   cross-platform + mobile niche. ([site](https://nimbalyst.com/),
   [repo](https://github.com/Nimbalyst/nimbalyst))

## Feature matrix

Legend: Y = documented, P = partial, N = absent, ? = not found on the primary pages fetched.

| Capability | ai-tabs 0.31.4 | CC Desktop | Conductor | Superset | Claude Squad | Nimbalyst |
|---|---|---|---|---|---|---|
| Multi-session layout | Y tabs + multi-window, drag tabs between windows | Y sidebar + split panes, drag-and-drop pane layout | Y workspace list | Y workspaces + tabbed terminals | Y TUI list + preview | Y sessions + kanban |
| Worktree / branch isolation per session | **N** (folder per tab; linked worktrees explicitly unsupported by Drive sync) | Y `.claude/worktrees/`, branch prefix, `.worktreeinclude` | Y "own workspace, branch, files, terminal" | Y worktree per workspace, setup scripts | Y worktree + tmux per instance | Y optional per session |
| Attention / notification model | Y hooks (Stop / Notification / AskUserQuestion / ExitPlanMode) -> tab flash + taskbar blink; optional ntfy push | Y OS notification on finish when not viewing; CI-finished notification | ? | Y working indicators, completion chime, dock badge | P auto-accept mode; no notifier documented | Y push notifications to mobile |
| Diff / PR review surface | **N** | Y diff pane, line comments, "Review code", PR CI bar, auto-fix/auto-merge | Y diff, open PR, merge, archive | Y diff viewer + PR split view (merge/close/reopen) | Y diff tab, checkout/push | Y red/green diffs, annotate, AI commit messages |
| Agent-output rendering (images, markdown, tool panels) | N raw xterm only; dropped image files become quoted paths | Y chat transcript with view modes, browser pane opens HTML/PDF/images, tasks pane for subagents | Y chat-style review | P terminals + built-in chat; in-app browser | N tmux pane | Y markdown / mockup / diagram editors |
| Remote / mobile control | Y LAN web UI; mobile page (session list, last line, Approve/Reject, read-only terminal); native remote mode; control handoff; remote wake | Y Remote Control to claude.ai/code + iOS/Android, Dispatch from phone, cloud + SSH sessions | P "forthcoming mobile app" on pricing page; cloud workspaces on Pro | P CLI / TypeScript SDK / MCP server; no mobile | N | Y iOS/Android: monitor, voice/text reply, diff review |
| Cost / context visibility | Y per-tab bar: model, context gradient, tokens in/out, active time, CC cost via statusLine hook; Codex transcript parser | Y usage ring: context per session + plan usage | N ("plan to introduce usage-based pricing" only) | ? | N | ? |
| Cross-platform | Y Win / macOS / Linux | Y macOS, Windows (x64 + ARM64), Linux beta | Mac only | macOS; Linux experimental; no Windows | macOS / Linux (tmux) | Y Win 10+, macOS, Linux + mobile |
| Agents supported | Claude, Codex, Gemini, plain shell, custom via `agents.json` | Claude only | Claude, Codex, Cursor, OpenCode | Claude, Cursor, Copilot, OpenCode, Gemini, custom | Claude, Codex, Gemini, Aider, custom profiles | Claude, Codex, OpenCode, Copilot |
| Pricing / licence | Free, MIT | Free with Claude plan; closed | Free local; $50 Pro; $60/user Teams; closed | Free desktop; ELv2 source-available | Free, AGPL-3.0 | Free, MIT |
| Permission-mode control at launch | Y per-agent profiles (Claude manual/acceptEdits/auto/plan/bypass; Codex sandbox modes; Gemini approval modes) | Y mode picker incl. plan / bypass | ? | ? | P yolo flag | ? |

## Holes in ai-tabs

| # | Hole | Tag | Evidence |
|---|---|---|---|
| 1 | **No worktree/branch isolation per tab.** Two tabs on one project share a working tree. All five leaders create a worktree per session; CC Desktop does it by default. | table-stakes | [CC Desktop](https://code.claude.com/docs/en/desktop), [Superset](https://docs.superset.sh/overview), [Claude Squad](https://github.com/smtg-ai/claude-squad), [Nimbalyst](https://nimbalyst.com/) |
| 2 | **No diff / PR review surface.** No way to see what the agent changed without leaving the app. All five have a diff view; three have PR create/merge/CI. | table-stakes | same as above plus [Conductor docs](https://www.conductor.build/docs/) |
| 3 | **No OS-native notification on attention.** Tab flash + taskbar blink + optional ntfy only; CC Desktop, Superset (chime + dock badge) and Nimbalyst (push) all do native notifications. Small change: Electron `Notification` fed by the existing hook. | table-stakes | [Superset README](https://github.com/superset-sh/superset), [CC Desktop](https://code.claude.com/docs/en/desktop) |
| 4 | **No rendered agent output.** xterm only; images, markdown and tool-call panels are CC Desktop / Nimbalyst strengths. Mobile already extracts `lastLine` per session, which is the seed of a summary view. | differentiator (full); nice-to-have (minimal: open image/HTML paths from the terminal) | [CC Desktop](https://code.claude.com/docs/en/desktop) "Browser pane can also open static HTML files, PDFs, images" |
| 5 | **Mobile is display-only.** `mobile.html` shows sessions and Approve/Reject; xterm is read-only "to avoid virtual keyboard conflicts". CC Remote Control and Nimbalyst allow full steering, image attach and voice reply from a phone. | differentiator | [Remote Control](https://code.claude.com/docs/en/remote-control), [Nimbalyst repo](https://github.com/Nimbalyst/nimbalyst) |
| 6 | **Remote transport is plain HTTP with a plaintext stored password** (README Security). Competitors tunnel through the vendor (CC, Cursor) or do not offer remote. Becomes table-stakes the moment remote is marketed beyond LAN/Tailscale. | table-stakes (conditional) | `README.md` Security section |
| 7 | **No live-session filter/grouping.** CC Desktop filters by status/project/environment; Nimbalyst groups by phase. ai-tabs categories apply to projects, not running sessions. | nice-to-have | [CC Desktop](https://code.claude.com/docs/en/desktop) |
| 8 | **No per-workspace setup/run scripts or dev-server preview.** Superset `.superset/config.json`, CC Desktop `.claude/launch.json` + Browser pane. | nice-to-have | [Superset](https://docs.superset.sh/overview), [CC Desktop](https://code.claude.com/docs/en/desktop) |
| 9 | **No scheduled/automated sessions.** Superset Automations, CC Desktop scheduled tasks. | nice-to-have | [Superset README](https://github.com/superset-sh/superset) |
| 10 | **Cost visibility is Claude-only and needs the injected statusLine hook**; Gemini/custom agents get folder/branch/elapsed. CC Desktop also shows *plan* usage, which ai-tabs cannot see. | nice-to-have | `lib/statusline/index.js`, [CC Desktop](https://code.claude.com/docs/en/desktop) "Check usage" |

## What ai-tabs already does better

- **Cross-platform, including Windows, as OSS.** Conductor is Mac-only, Superset has no Windows
  build, Claude Squad needs tmux. Only CC Desktop (closed) and Nimbalyst match.
- **Agent-agnostic with launch-time permission profiles.** Allowlisted flags and profiles in
  `lib/agents.js` for Claude, Codex *and* Gemini, plus custom agents via `data/agents.json`.
  CC Desktop is Claude-only; no competitor documents a Codex-sandbox / Gemini-approval picker.
- **Precise, hook-based attention.** `lib/attention-hook.js` subscribes to exactly
  Stop / Notification / AskUserQuestion / ExitPlanMode and suppresses `stop_hook_active` re-fires
  and SubagentStop noise -- more accurate than output-quiescence heuristics. Codex also gets a
  transcript parser for the status bar.
- **Server outlives the client, with control handoff.** Sessions run in a detached server; the
  desktop app can attach to a remote server, the server GUI locks behind "Remote client in
  control", and a waker service (port 25284) can start a sleeping server. Nothing in the top 5
  documents a local-first equivalent (CC offers cloud sessions instead).
- **Google Drive project sync** carrying unpushed commits, stashes and agent memory between two
  machines with leases and conflict recovery. Unique in the set.
- **Mobile Approve/Reject and ntfy push without a vendor account.** Works for any agent; CC Remote
  Control requires a Pro/Max/Team subscription and excludes API-key users.
- **It is the real CLI.** No wrapper around the agent's UI, so skills, hooks, `/resume`, MCP all
  work unmodified -- the same argument Claude Squad makes, but with a GUI.

## Suggested order of attack (not a commitment)

1. Worktree-per-tab option (hole 1) -- unblocks the rest and removes the Drive-sync caveat.
2. OS notification on attention (hole 3) -- small, high-visibility.
3. Minimal diff surface: "changes since tab opened" panel from `git diff` (hole 2), then PR
   creation via `gh`.
4. Mobile input + image attach (hole 5), building on the existing Approve/Reject path.

## Sources

- Claude Code Desktop docs -- https://code.claude.com/docs/en/desktop
- Claude Code Remote Control -- https://code.claude.com/docs/en/remote-control
- Conductor -- https://www.conductor.build/ ; https://www.conductor.build/pricing ; https://www.conductor.build/docs/
- Superset -- https://github.com/superset-sh/superset ; https://docs.superset.sh/overview ; https://github.com/superset-sh/superset/releases
- Claude Squad -- https://github.com/smtg-ai/claude-squad ; https://github.com/smtg-ai/claude-squad/releases
- Nimbalyst -- https://nimbalyst.com/ ; https://github.com/Nimbalyst/nimbalyst
- Crystal (deprecated) -- https://github.com/stravu/crystal
- Vibe Kanban (sunset) -- https://github.com/BloopAI/vibe-kanban ; https://vibekanban.com/blog/shutdown
- CodeLayer / HumanLayer -- https://github.com/humanlayer/humanlayer ; https://humanlayer.com/
- Cursor cloud agents -- https://cursor.com/docs/cloud-agent
- Repo metadata (stars, `pushed_at`, latest release) pulled with `gh api repos/<owner>/<repo>` on 2026-08-21.
