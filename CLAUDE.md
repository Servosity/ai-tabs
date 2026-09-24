# ai-tabs

Electron + xterm.js + node-pty tab manager for AI coding-agent terminals (Claude Code, Codex CLI, Gemini CLI). JavaScript, not Python: the Python rules in the parent `Projects/CLAUDE.md` (uv, ruff, type hints) do not apply here; the architecture/style principles (deterministic first, config in one place, named constants, split files approaching 400 lines) do.

## Working rules

- Bump `package.json` version with every change: patch for fixes, minor for behavior changes.
- The server (`server.js`) runs detached on port 25283 and outlives the Electron app; changes to `server.js` or `lib/` need a server restart, which ends live sessions.
- Never run `npm start` from inside an agent session running in ai-tabs: it restarts the server that session lives in.
- Personal, machine-specific rules live in the gitignored `CLAUDE.local.md`.

## Agent skills

### Issue tracker

GitHub Issues on `Servosity/ai-tabs` via the `gh` CLI; wayfinder maps use sub-issues + native issue dependencies. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root (created lazily). See `docs/agents/domain.md`.
