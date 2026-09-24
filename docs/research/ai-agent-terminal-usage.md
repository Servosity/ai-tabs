# How developers actually use terminals with AI coding agents

Research for wayfinder ticket #5 (part of #2). Date: 2026-08-21.
Scope: Claude Code, Codex CLI, Gemini CLI — official docs/changelogs, the
most-upvoted terminal/UX issues on their trackers (via GitHub search sorted
by reactions), and attributed practitioner write-ups. Every claim links a source.

## Summary

- The dominant workflow is **several agents at once**: 2–4 sessions in tabs,
  tmux windows or git worktrees, one being "steered" while the others "grind"
  ([aq.dev](https://aq.dev/guides/run-multiple-claude-code-sessions-in-parallel/),
  [Claude Code best practices](https://code.claude.com/docs/en/best-practices)).
  All three vendors now ship first-party worktree isolation
  ([CC `--worktree`](https://code.claude.com/docs/en/common-workflows#run-parallel-sessions-with-worktrees),
  [Gemini experimental worktrees](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/git-worktrees.md),
  [CC agent view auto-worktrees](https://code.claude.com/docs/en/agent-view)).
- The #1 terminal complaint by vote count is **rendering**: flicker and
  runaway scrolling in the classic renderer (CC #3648: 694 👍, #826: 691 👍,
  #769: 300 👍) and, after the fix moved to an alt-screen TUI, **lost native
  scrollback / search / copy** (CC #42670, #41965, #42002; Codex #2558: 114 👍).
- The #2 complaint is **attention**: not knowing when a background session
  needs you. Every vendor has had to add notification hooks/sounds
  (CC Notification hook; Codex #3962: 190 👍, #2109 hooks: 525 👍; Gemini #4310: 74 👍),
  and both CC and Codex now auto-resolve unanswered questions after 60 s, which
  users hate (CC #73125: 388 👍, Codex #28969: 198 👍).
- **AFK / phone check-in** is now a first-party feature (CC Remote Control, Feb
  2026; Codex #9224 closed as shipped, 409 👍), but it requires the vendor cloud
  login and the local process staying alive, and reconnection is flaky (CC #34255).
- **Cost/context blindness** is addressed by CC's statusLine JSON
  (`total_cost_usd`, `context_window.used_percentage`, 5h/7d rate limits) and
  Codex `/status`; Codex users are asking for a CC-style status line
  (#17827: 159 👍). Rate-limit exhaustion is the top cost-shaped complaint
  (CC #16157: 693 👍; Codex #28879: 363 👍).
- **Images, clipboard and paste** remain platform-fragile: image paste broken on
  Windows Terminal / WSL / Linux at various times (CC #32791, #13738, #8324),
  Codex pastes executing on Ctrl+V on Windows (#13729), long pastes silently
  becoming attachments (#25144: 87 👍).

ai-tabs already covers the attention, multi-session, status/cost and
phone-check-in workflows well. The biggest uncovered areas are **scrollback
and search across an agent's alt-screen TUI**, **diff review outside the
transcript**, and **image/clipboard robustness on Windows**.

## Workflows catalogue

| Workflow | What people do | Primary evidence |
|---|---|---|
| Parallel sessions | 2–4 concurrent agents; one steering, others grinding; tabs or tmux windows; Writer/Reviewer pattern with separate contexts | [aq.dev guide](https://aq.dev/guides/run-multiple-claude-code-sessions-in-parallel/), [CC best practices: Run multiple Claude sessions](https://code.claude.com/docs/en/best-practices#run-multiple-claude-sessions), [MindStudio](https://www.mindstudio.ai/blog/claude-code-parallel-sessions) |
| Worktree isolation | One checkout per agent so edits don't collide; `claude --worktree name`; Gemini `experimental.worktrees`; CC background sessions auto-move into `.claude/worktrees/` | [CC common workflows](https://code.claude.com/docs/en/common-workflows#run-parallel-sessions-with-worktrees), [Gemini worktrees](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/git-worktrees.md), [CC agent view](https://code.claude.com/docs/en/agent-view) |
| Dashboard of agents | `claude agents` groups sessions into Needs input / Working / Ready for review / Completed, peek without attaching, tab title shows "2 awaiting input" | [CC agent view](https://code.claude.com/docs/en/agent-view) |
| Plan → approve → implement | Shift+Tab into plan mode, edit plan in `$EDITOR` (Ctrl+G), approve, implement; Codex Plan Mode (#2101, 406 👍, shipped); Gemini plan mode + approval-mode cycle | [CC best practices: Explore, plan, code](https://code.claude.com/docs/en/best-practices#explore-first-then-plan-then-code), [Codex #2101](https://github.com/openai/codex/issues/2101), [Gemini keyboard shortcuts](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/keyboard-shortcuts.md) |
| Approval fatigue mitigations | Allowlists, sandbox, auto mode (classifier reviews actions), YOLO toggle | [CC best practices: Configure permissions](https://code.claude.com/docs/en/best-practices#configure-permissions), [Medium: auto mode](https://medium.com/@AdithyaGiridharan/claude-codes-auto-mode-solves-the-permission-fatigue-problem-1bb7417bb858) |
| Long AFK runs | `/goal`, Stop hooks, `/loop`, `claude -p` fan-out, scheduled routines; "give Claude a check it can run" so you can walk away | [CC best practices: verify its work](https://code.claude.com/docs/en/best-practices#give-claude-a-way-to-verify-its-work), [CC common workflows: schedule](https://code.claude.com/docs/en/common-workflows#run-claude-on-a-schedule) |
| Phone check-in | `/remote-control` + QR; approve permissions, read progress, send photos from phone; push when task finishes or needs decision; Codex equivalent in ChatGPT app | [CC Remote Control](https://code.claude.com/docs/en/remote-control), [builder.io](https://www.builder.io/blog/claude-code-mobile-phone), [Codex #9224](https://github.com/openai/codex/issues/9224) |
| Pre-official AFK | Tailscale + SSH + tmux + Termius; Telegram/ntfy bots | [Codex #9224 body](https://github.com/openai/codex/issues/9224), [explainx.ai](https://www.explainx.ai/blog/claude-code-mobile-remote-control-phone-guide-2026) |
| Context hygiene | `/clear` between tasks, `/compact <instructions>`, subagents for research, `/btw` side questions; status line to watch context % | [CC best practices: Manage context](https://code.claude.com/docs/en/best-practices#manage-context-aggressively), [Gemini `/compress`, `/stats`](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md) |
| Checkpoint / rewind | Esc Esc or `/rewind`; Gemini shadow-repo checkpoints + `/restore`; Codex users demand `/undo` back (#9203, 397 👍) | [CC checkpointing](https://code.claude.com/docs/en/best-practices#rewind-with-checkpoints), [Gemini checkpointing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md), [Codex #9203](https://github.com/openai/codex/issues/9203) |
| Visual verification | Paste screenshots/mockups, ask agent to screenshot result and compare | [CC common workflows: images](https://code.claude.com/docs/en/common-workflows#work-with-images), [Codex `--image`](https://learn.chatgpt.com/docs/codex/cli) |
| Resume across sittings | `claude --continue/--resume`, `/rename` sessions like branches, `codex resume`, Gemini `/chat save|resume` | [CC sessions](https://code.claude.com/docs/en/common-workflows#resume-previous-conversations), [Codex CLI features](https://learn.chatgpt.com/docs/codex/cli) |

## Ranked pain points

Ranking weighs upvotes, breadth across the three CLIs, and how directly the
pain lives in the terminal layer (where a host like ai-tabs can act).

| # | Pain point | Evidence | ai-tabs status |
|---|---|---|---|
| 1 | **Rendering flicker / runaway scrolling** in the inline renderer, worst in VS Code/Cursor terminals, tmux, Windows Terminal | CC [#3648](https://github.com/anthropics/claude-code/issues/3648) (694 👍), [#826](https://github.com/anthropics/claude-code/issues/826) (691 👍), [#769](https://github.com/anthropics/claude-code/issues/769) (300 👍, accessibility), [#16939](https://github.com/anthropics/claude-code/issues/16939) (Win11); Codex [#11901](https://github.com/openai/codex/issues/11901); Gemini [#14708](https://github.com/google-gemini/gemini-cli/issues/14708), [#2859](https://github.com/google-gemini/gemini-cli/issues/2859); [Namiru write-up](https://namiru.ai/blog/claude-code-s-terminal-flickering-700-upvotes-9-months-still-broken); [HN: Claude Chill](https://news.ycombinator.com/item?id=46699072) | **partial** — xterm.js + WebGL is fast enough that users rarely hit IDE-terminal throughput limits, and CC now defaults new users to fullscreen ([fullscreen docs](https://code.claude.com/docs/en/fullscreen)). Not verified whether ai-tabs advertises DEC 2026 synchronized output, which CC probes for at startup. |
| 2 | **Alt-screen TUI kills native scrollback, Cmd+F search, tmux copy mode, and free text selection** | CC [#42670](https://github.com/anthropics/claude-code/issues/42670), [#41965](https://github.com/anthropics/claude-code/issues/41965), [#42002](https://github.com/anthropics/claude-code/issues/42002), [#4851](https://github.com/anthropics/claude-code/issues/4851) (97 👍); Codex [#2558](https://github.com/openai/codex/issues/2558) (114 👍), [#2836](https://github.com/openai/codex/issues/2836), [#17169](https://github.com/openai/codex/issues/17169); Gemini [#13059](https://github.com/google-gemini/gemini-cli/issues/13059), [#20814](https://github.com/google-gemini/gemini-cli/issues/20814); CC's own docs list what changes ([fullscreen: What changes](https://code.claude.com/docs/en/fullscreen#what-changes)) | **none** — ai-tabs provides the host scrollback only; once CC/Codex run in the alternate buffer the tab has nothing to scroll or search. No transcript viewer/search, and mouse capture means xterm's auto-copy-on-select no longer applies inside the TUI. |
| 3 | **Lost attention: not knowing which session finished or is blocked on a prompt** | CC Notification hook and `preferredNotifChannel` exist because desktop notifications only fire in Ghostty/Kitty/iTerm2 ([terminal-config](https://code.claude.com/docs/en/terminal-config#get-a-terminal-bell-or-notification)); Codex [#3962](https://github.com/openai/codex/issues/3962) (190 👍, "bell is too short/quiet"), [#2109](https://github.com/openai/codex/issues/2109) (525 👍), [#3247](https://github.com/openai/codex/issues/3247); Gemini [#4310](https://github.com/google-gemini/gemini-cli/issues/4310) (74 👍), [#2681](https://github.com/google-gemini/gemini-cli/issues/2681), [notifications.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/notifications.md) (OSC 9 / BEL); [CodeGrid](https://www.codegrid.app/blog/claude-code-approval-prompts-never-miss-one-again) | **addresses** — tab flash + taskbar blink from CC hooks (Stop/Notification/AskUserQuestion/ExitPlanMode via `lib/attention-hook.js`), OSC 9 + quiescence fallback (`lib/prompt-detector.js`), ntfy push (`lib/push-notifier.js`). Gap: Codex/Gemini attention relies on OSC 9/quiescence, not their hook systems. |
| 4 | **Questions auto-resolve after 60 s while you are away** (AFK runs silently take the default) | CC [#73125](https://github.com/anthropics/claude-code/issues/73125) (388 👍); Codex [#28969](https://github.com/openai/codex/issues/28969) (198 👍); CC [#13922](https://github.com/anthropics/claude-code/issues/13922) (configurable idle_prompt timeout) | **partial** — ai-tabs flashes immediately on AskUserQuestion, and ntfy push can reach a phone, but 60 s is often shorter than the walk back; nothing records what was auto-answered. |
| 5 | **Cost / context / rate-limit blindness** | [CC statusline JSON](https://code.claude.com/docs/en/statusline) exposes `cost.total_cost_usd`, `context_window.used_percentage`, `rate_limits.five_hour/seven_day`; CC [#18456](https://github.com/anthropics/claude-code/issues/18456) (145 👍, show context % in UI), [#16157](https://github.com/anthropics/claude-code/issues/16157) (693 👍 limits), [#46829](https://github.com/anthropics/claude-code/issues/46829) (245 👍 cache TTL cost); Codex [#17827](https://github.com/openai/codex/issues/17827) (159 👍 status line), [#14593](https://github.com/openai/codex/issues/14593), [#28879](https://github.com/openai/codex/issues/28879); [Eftimie: status lines](https://ovidiueftimie.substack.com/p/claude-code-status-lines-that-actually) | **addresses** (Claude, Codex) — per-tab bar with context gradient, tokens, cost via injected statusLine forwarder; Codex parsed from transcripts. Gaps: 5h/7d **rate-limit %** from the same hook JSON is not shown; Gemini gets folder/branch/elapsed only. |
| 6 | **AFK phone check-in is fragile or vendor-gated** | [CC Remote Control](https://code.claude.com/docs/en/remote-control) needs claude.ai login, local process alive, not Bedrock/gateway; reconnection bug [#34255](https://github.com/anthropics/claude-code/issues/34255); push requests [#29438](https://github.com/anthropics/claude-code/issues/29438), [#28765](https://github.com/anthropics/claude-code/issues/28765); Codex [#9224](https://github.com/openai/codex/issues/9224) (409 👍), [#32908](https://github.com/openai/codex/issues/32908), [#20930](https://github.com/openai/codex/issues/20930); [inventivehq](https://inventivehq.com/blog/claude-code-from-your-phone-remote) | **addresses** — LAN/Tailscale mobile PWA (`public/mobile.html`), native remote mode, control handoff, wake-on-demand, ntfy push; works for all three agents and without vendor cloud. Gap: plain HTTP + plaintext password (README Security), so it is trusted-network only. |
| 7 | **Image / screenshot paste is platform-fragile** | CC [#1361](https://github.com/anthropics/claude-code/issues/1361), [#13738](https://github.com/anthropics/claude-code/issues/13738) (WSL), [#8324](https://github.com/anthropics/claude-code/issues/8324) (Linux, open), [#26679](https://github.com/anthropics/claude-code/issues/26679), [#32791](https://github.com/anthropics/claude-code/issues/32791) (Windows Terminal, open), [#5277](https://github.com/anthropics/claude-code/issues/5277) (SSH); Gemini [#1452](https://github.com/google-gemini/gemini-cli/issues/1452); Codex [#37412](https://github.com/openai/codex/issues/37412); Remote Control lets phones attach photos ([docs](https://code.claude.com/docs/en/remote-control)) | **none** — clipboard bridge is text-only (`main.js` `clipboard-read/write`); image paste depends entirely on what the CLI can read from the OS clipboard inside an Electron-hosted PTY. No drag-drop-to-path, no phone-photo upload. |
| 8 | **Paste/clipboard quirks**: multi-line paste executes immediately, long pastes collapsed or turned into attachments, copying output loses formatting | Codex [#13729](https://github.com/openai/codex/issues/13729), [#25144](https://github.com/openai/codex/issues/25144) (87 👍), [#33307](https://github.com/openai/codex/issues/33307); CC [#5512](https://github.com/anthropics/claude-code/issues/5512) (101 👍 `/copy`), [#41954](https://github.com/anthropics/claude-code/issues/41954) (selection spams clipboard); CC paste-cache behaviour ([terminal-config](https://code.claude.com/docs/en/terminal-config#paste-large-content)); Gemini [#3005](https://github.com/google-gemini/gemini-cli/issues/3005), [#2810](https://github.com/google-gemini/gemini-cli/issues/2810) | **partial** — bracketed paste via xterm.js and right-click paste exist (0.31.4 fixed double-paste); no large-paste-to-file helper, no "copy last response" shortcut. |
| 9 | **Can't review diffs outside the transcript / batch-approve changes** | CC [#33932](https://github.com/anthropics/claude-code/issues/33932) (175 👍), [#31888](https://github.com/anthropics/claude-code/issues/31888), [#23626](https://github.com/anthropics/claude-code/issues/23626) (129 👍), [#37951](https://github.com/anthropics/claude-code/issues/37951); Codex [#2998](https://github.com/openai/codex/issues/2998) (227 👍); Codex `/diff` in CLI features | **none** — no diff panel, git status, or "open in editor" affordance per tab. |
| 10 | **Multi-session operational friction**: port collisions, worktree cleanup debt, sessions die with the laptop, teammates can't see progress | [aq.dev](https://aq.dev/guides/run-multiple-claude-code-sessions-in-parallel/); CC [agent view limits](https://code.claude.com/docs/en/agent-view) (rate limits scale with sessions, local only); Codex [#12564](https://github.com/openai/codex/issues/12564) (rename threads) | **partial** — detached server survives app restarts, Drive sync carries worktree state between two machines, tabs renameable; no worktree creation/cleanup UI, no per-session port hints. |
| 11 | **Terminal key/IME quirks** (Shift+Enter, Option-as-Meta, Backspace-as-Ctrl-Backspace on Windows, Japanese IME) | [CC terminal-config](https://code.claude.com/docs/en/terminal-config); CC [#3368](https://github.com/anthropics/claude-code/issues/3368), [#8208](https://github.com/anthropics/claude-code/issues/8208); Gemini [#1796](https://github.com/google-gemini/gemini-cli/issues/1796) (167 👍); Codex [#11026](https://github.com/openai/codex/issues/11026) | **partial** — xterm.js sends standard sequences; Shift+Enter newline and CSI-u/kitty keyboard support not verified. |
| 12 | **Notification fatigue / over-notification** once everything alerts | CC [#12046](https://github.com/anthropics/claude-code/issues/12046) (option to disable), push skipped while typing in the terminal and `CLAUDE_CLIENT_PRESENCE_FILE` ([remote-control docs](https://code.claude.com/docs/en/remote-control#mobile-push-notifications)); [zenn: approval fatigue](https://zenn.dev/kbwok/articles/d9d1b14a0dc55a?locale=en) | **partial** — per-tab mute exists and active tab does not flash; ntfy push has no presence suppression (fires even when you are at the desk). |

## Implications for ai-tabs

1. **Scrollback and search for alt-screen TUIs (pain #2)** is the largest
   uncovered gap and is squarely a host-terminal job. Options: a per-tab
   "transcript" pane that tails the agent's JSONL transcript (ai-tabs already
   locates it for the status line), or a search/export button that runs the
   CLI's own escape hatches (CC transcript mode `[` writes to native scrollback,
   `v` opens `$EDITOR`). Cheapest win: document `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`
   as a per-agent launch option so users can choose native scrollback.
2. **Verify synchronized output (pain #1)**: CC probes for DEC 2026 at startup
   and falls back to flicker-prone redraws. Confirm xterm.js advertises it and
   that ConPTY on Windows passes it through; if not, set
   `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` in Claude launches (only if safe).
3. **Rate-limit % in the status bar (pain #5)**: the hook JSON ai-tabs already
   receives carries `rate_limits.five_hour.used_percentage` and `seven_day`.
   Surfacing them is a small parser change and directly targets the highest-
   voted cost-shaped complaints.
4. **Image paste bridge (pain #7)**: on Windows the CLIs read the OS clipboard
   themselves and break per terminal. ai-tabs could intercept an image paste in
   the renderer, save it under the project (or `data/`), and type the path —
   the exact workaround users already do by hand. The mobile PWA could accept a
   photo upload the same way, matching Remote Control's phone-photo feature.
5. **60 s auto-resolve (pain #4)**: ntfy push already fires on
   AskUserQuestion; consider a distinct "question pending, auto-answers in 60 s"
   priority, and log auto-answered prompts in the tab so AFK users can audit.
6. **Codex/Gemini attention parity (pain #3)**: Codex has a `notify` hook and
   Gemini has hooks + OSC 9; wiring them like the CC attention forwarder would
   remove reliance on quiescence heuristics.
7. **Diff review (pain #9)**: a lightweight "changes since tab opened" panel
   (`git diff --stat` + open file in editor) would cover the most-requested
   non-IDE review flow without building an editor.
8. **Presence-aware push (pain #12)**: suppress ntfy when the tab's window is
   focused or the machine is unlocked, mirroring CC's
   `CLAUDE_CLIENT_PRESENCE_FILE` behaviour.

## Sources

Official docs and changelogs
- Claude Code: [Best practices](https://code.claude.com/docs/en/best-practices), [Common workflows](https://code.claude.com/docs/en/common-workflows), [Terminal config](https://code.claude.com/docs/en/terminal-config), [Fullscreen rendering](https://code.claude.com/docs/en/fullscreen), [Agent view](https://code.claude.com/docs/en/agent-view), [Remote Control](https://code.claude.com/docs/en/remote-control), [Status line](https://code.claude.com/docs/en/statusline), [Hooks](https://code.claude.com/docs/en/hooks), [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Codex CLI: [CLI features](https://learn.chatgpt.com/docs/codex/cli), [docs/config.md](https://github.com/openai/codex/blob/main/docs/config.md)
- Gemini CLI: [Notifications](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/notifications.md), [Git worktrees](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/git-worktrees.md), [Checkpointing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md), [Commands](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md), [Keyboard shortcuts](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/keyboard-shortcuts.md)

Issue trackers (GitHub search, `sort=reactions`, August 2026) — linked inline above.

Practitioner write-ups
- [aq.dev: Run multiple Claude Code sessions in parallel](https://aq.dev/guides/run-multiple-claude-code-sessions-in-parallel/)
- [Namiru: Claude Code's terminal flickering](https://namiru.ai/blog/claude-code-s-terminal-flickering-700-upvotes-9-months-still-broken)
- [HN: Claude Chill — fix Claude Code's flickering](https://news.ycombinator.com/item?id=46699072)
- [Ovidiu Eftimie: Claude Code status lines that actually matter](https://ovidiueftimie.substack.com/p/claude-code-status-lines-that-actually)
- [builder.io: Claude Code on your phone](https://www.builder.io/blog/claude-code-mobile-phone)
- [InventiveHQ: Claude Code from your phone](https://inventivehq.com/blog/claude-code-from-your-phone-remote)
- [CodeGrid: never miss an approval prompt](https://www.codegrid.app/blog/claude-code-approval-prompts-never-miss-one-again)
- [Medium: auto mode and permission fatigue](https://medium.com/@AdithyaGiridharan/claude-codes-auto-mode-solves-the-permission-fatigue-problem-1bb7417bb858)

Method note: GitHub reaction counts are 👍 at time of query; some issues (e.g. CC
#3648) show higher counts in the tracker than in older write-ups.
