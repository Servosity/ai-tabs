# Where agent screenshots/images live, and how ai-tabs can capture them

Resolves wayfinder research ticket #6 (part of #2). Researched 2026-08-21 against
Claude Code 2.1.238 on this machine, primary docs, and the Codex / Gemini CLI sources.

## Summary

1. **Image bytes are persisted, not stripped.** Claude Code writes every tool result
   verbatim to `~/.claude/projects/<slug>/<session>.jsonl`, including `image` content
   blocks with inline base64 payloads. 1,962 local transcripts contain 957 image blocks
   (~92 MB of base64): Claude-in-Chrome screenshots (`mcp__claude-in-chrome__computer`
   and `browser_batch`), Read-tool image results, and user-pasted images. The `[Image]`
   placeholder is purely a terminal render; it never appears in the JSONL.
2. **A PostToolUse hook receives the full image**, not a reference. Verified empirically:
   `tool_response` for `Read` on a PNG is `{type:"image", file:{base64, type, originalSize,
   dimensions}}` with the whole payload inline. For MCP tools the same field carries the
   raw MCP content array (`[{text},{text},{image,source:{base64}}]`), which is exactly the
   `toolUseResult` field the transcript stores.
3. **Caveats:** transcripts are plaintext, swept after `cleanupPeriodDays` (default 30),
   single JSONL lines reach 1.3 MB and files reach 40 MB locally; the transcript is
   written asynchronously and can lag a hook. Codex persists image tool outputs as
   `data:` URLs in its rollout JSONL; Gemini CLI appends full `Part` lists (including
   `inlineData`) to `~/.gemini/tmp/<hash>/chats/session-*.jsonl`.
4. **Recommendation:** capture via a **PostToolUse hook** injected through the
   `--settings` file ai-tabs already generates, POSTing to a new `/api/media-hook`
   endpoint that decodes the base64 and writes a file under `data/media/<tabSessionId>/`.
   Use transcript tailing (the existing `TailReader`) only as a backfill for Codex and
   for sessions that pre-date the hook. Rationale in the last section.

## Evidence: local Claude Code transcripts

Scan script: every `*.jsonl` under `C:\Users\alice\.claude\projects\` (1,962 files,
391,912 lines). Base64 payloads redacted to their length.

| Image-bearing block                     | Count | Source type | Media types          |
| --------------------------------------- | ----- | ----------- | -------------------- |
| `mcp__claude-in-chrome__computer`       | 280   | base64      | image/jpeg           |
| `mcp__claude-in-chrome__browser_batch`  | 16    | base64      | image/jpeg           |
| `Read` on an image file                 | 189   | base64      | image/png            |
| User-pasted image (role user, no tool)  | 7     | base64      | image/jpeg           |
| `source.type == "url"` or `"file"`      | 0     |             |                      |
| Literal `[Image]` text in any transcript| 0     | (only in this ticket's own prompt text) |

Observed shapes (one transcript line each; `type:"user"` lines carry tool results):

```jsonc
// Claude-in-Chrome screenshot. tool_use input was {"action":"screenshot","tabId":1559019016}
{"type":"user","uuid":"df00f083-...","parentUuid":"99e4d5c4-...","isSidechain":false,
 "timestamp":"2026-08-04T20:58:38.682Z",
 "message":{"role":"user","content":[
   {"type":"tool_result","tool_use_id":"toolu_01RtYA...","content":[
     {"type":"text","text":"Successfully captured screenshot (1568x779, jpeg) - ID: ss_8538g1xfe"},
     {"type":"text","text":"\n\nTab Context:\n- Executed on tabId: 1559019016 ..."},
     {"type":"image","source":{"type":"base64","media_type":"image/jpeg",
       "data":"<190,984 chars ~140 KB>"}}]}]},
 // top-level copy of the raw tool output, same three blocks, same base64
 "toolUseResult":[{"type":"text",...},{"type":"text",...},
   {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"<190,984 chars>"}}]}
```

```jsonc
// Read tool on icon-192.png. tool_use input was {"file_path":"C:\\...\\icon-192.png"}
{"type":"user","timestamp":"2026-08-20T23:44:19.941Z",
 "message":{"role":"user","content":[
   {"type":"tool_result","tool_use_id":"toolu_...","content":[
     {"type":"image","source":{"type":"base64","data":"<7,556 chars>","media_type":"image/png"}}]}]},
 "toolUseResult":{"type":"image","file":{"base64":"<7,556 chars>","type":"image/png",
   "originalSize":5665,
   "dimensions":{"originalWidth":192,"originalHeight":192,"displayWidth":192,"displayHeight":192}}}}
```

```jsonc
// User-pasted image: a plain user turn, no tool_result wrapper
{"type":"user","message":{"role":"user","content":[
   {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"<329,500 chars ~241 KB>"}}]}}
```

Notes:

- The `message.content` block is the API-shaped `image` block (what the model saw).
  `toolUseResult` is Claude Code's internal raw result: for MCP tools it is the MCP
  content array; for `Read` it is the `{type:"image", file:{...}}` envelope with
  `originalSize` and `dimensions`. Both carry the full base64.
- Screenshot tool_use inputs carry **no file path**; Claude-in-Chrome returns bytes
  inline (the `ID: ss_...` is an extension-side handle, not a file). Nothing is written
  to scratchpad/temp dirs for screenshots. Only `Read` carries a path (`tool_input.file_path`).
- Subagent transcripts sit next to the parent (`agent-<id>.jsonl`, and
  `<session>/subagents/`); image results inside them have the same shapes.
- Local extremes: largest single line 1,366,097 chars; largest transcript 40 MB
  (`C--Users-alice-Documents-Projects-myproject/0e45899c-....jsonl`). Any tailer must
  stream by byte offset, as `lib/statusline/tail-reader.js` already does.

## Evidence: PostToolUse hook payload (empirical)

Ran `claude -p ... --settings <file> --allowedTools Read` with a PostToolUse hook
(`matcher: "Read"`) that dumps stdin to disk, asking it to Read `public/icon-192.png`:

```jsonc
{"session_id":"7edd1b17-...","transcript_path":"C:\\Users\\alice\\.claude\\projects\\...\\7edd1b17-....jsonl",
 "cwd":"...","prompt_id":"65e251cd-...","permission_mode":"default","effort":{"level":"medium"},
 "hook_event_name":"PostToolUse","tool_name":"Read",
 "tool_input":{"file_path":"C:\\Users\\alice\\Documents\\Projects\\ai-tabs\\public\\icon-192.png"},
 "tool_response":{"type":"image","file":{"base64":"<2,928 chars>","type":"image/png",
   "originalSize":2195,"dimensions":{"originalWidth":192,"originalHeight":192,"displayWidth":192,"displayHeight":192}}},
 "tool_use_id":"toolu_01W6Wnos...","duration_ms":71}
```

`tool_response` is byte-for-byte the transcript's `toolUseResult`. For Claude-in-Chrome
the transcript's `toolUseResult` is the MCP content array with the inline `image` block,
so a PostToolUse hook matched on `mcp__claude-in-chrome__.*` receives the screenshot
bytes too (inferred from the identical field; not re-run here because it needs a live
Chrome session). The docs confirm the field semantics but do not spell out image handling:

- Hooks reference (https://code.claude.com/docs/en/hooks): PostToolUse input has
  `session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name,
  tool_input, tool_response, tool_use_id`; `tool_response` is "the result from the tool".
  It also warns: "The transcript file is written asynchronously and may lag the in-memory
  conversation, so it may not yet include the current turn's most recent messages when a
  hook fires." Hook *output* is capped at 10,000 chars; hook *input* has no stated cap.
- Agent SDK hooks (https://code.claude.com/docs/en/agent-sdk/hooks) expose the same
  payload as `PostToolUseHookInput`; the SDK TypeScript reference
  (https://code.claude.com/docs/en/agent-sdk/typescript) reads transcripts back with
  `getSessionMessages()` returning `SessionMessage.message: unknown` (raw payload), and
  `persistSession:false` disables the JSONL entirely.

## Hook vs transcript comparison

| Concern                      | PostToolUse hook                                   | Transcript JSONL tail                                  |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| Has the bytes                | Yes, inline base64 in `tool_response`              | Yes, inline base64 in `message.content` + `toolUseResult` |
| Latency                      | Immediate, synchronous with the tool               | Async write; docs say it can lag the hook              |
| Tab attribution              | ai-tabs already injects `tabSessionId` into hook settings via `--settings` | Needs `transcript_path` from the statusline hook (`pinFile`) or mtime heuristics |
| Cost per event               | One process spawn per matched tool (matcher limits it) | Re-parse of every appended line; 1 MB+ lines for each screenshot |
| User-pasted images           | Not a tool; hook never fires                       | Captured (`role:user` image block)                     |
| Subagent screenshots         | Hooks fire for subagent tool calls too             | Separate `agent-*.jsonl` / `subagents/` files to discover |
| Codex / Gemini               | Codex has hooks (`~/.codex/hooks.json` already used by ai-tabs for `UserPromptSubmit`); Gemini has hooks too, untested | Codex rollouts and Gemini `chats/*.jsonl` both persist image bytes |
| Works when persistence is off| Yes                                                | No (`persistSession:false`, or a future opt-out)       |

## Size and retention caveats

- Transcripts are plaintext and swept at startup once older than `cleanupPeriodDays`
  (default 30, minimum 1): https://code.claude.com/docs/en/settings and
  https://code.claude.com/docs/en/claude-directory ("Full conversation transcript: every
  message, tool call, and tool result"; `paste-cache/`, `image-cache/` hold "contents of
  large pastes and attached images"). A media panel that only indexes the JSONL loses its
  history on that schedule; copying bytes out to `data/media/` decouples retention.
- Claude-in-Chrome screenshots are ~100-250 KB JPEG each; 296 of them account for most
  of the 92 MB observed. Budget roughly 150 KB per screenshot on disk, and put a
  per-session cap / LRU on the media store.
- Large text tool results are spilled to `projects/<project>/<session>/tool-results/`,
  but images are **not** spilled; they stay inline, which is why single lines hit 1.3 MB.
- Hook payloads arrive on stdin with no documented cap; the forwarder must stream stdin
  to the POST body rather than building a string (a 250 KB JPEG is ~340 KB of JSON).
- `/feedback`, session-quality survey uploads, and Remote Control sync all ship the raw
  transcript (images included) to Anthropic: https://code.claude.com/docs/en/data-usage.

## Codex CLI and Gemini CLI equivalents

**Codex CLI** (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, already tailed by
`lib/statusline/codex-parser.js`). Lines are `{timestamp, type, payload}`. The
persistence policy (`codex-rs/rollout/src/policy.rs`,
https://github.com/openai/codex/blob/main/codex-rs/rollout/src/policy.rs) returns `true`
for `ResponseItem::Message`, `FunctionCallOutput`, `CustomToolCallOutput`, so images are
persisted. Image shapes (`codex-rs/protocol/src/models.rs`): `ContentItem::InputImage
{ image_url }` for user/model messages and `FunctionCallOutputContentItem::InputImage {
image_url, detail }` in tool outputs, where `image_url` is a `data:{mime};base64,{data}`
URL. `config.toml` `history.persistence = save-all|none` and `history.max_bytes` govern
`history.jsonl` (the prompt history), not the rollouts
(https://learn.chatgpt.com/docs/config-file/config-reference). None of the 190 local
rollouts contains an image item yet, so the shape is from source, not observation.

**Gemini CLI** (not installed here; no `~/.gemini`). Sessions live at
`~/.gemini/tmp/<project_hash>/chats/session-<timestamp>-<id8>.jsonl`
(https://geminicli.com/docs/cli/session-management/ and
`packages/core/src/services/chatRecordingService.ts`). Each line is a `MessageRecord`
with `content: PartListUnion` appended as-is via `JSON.stringify(record)`; tool calls are
`ToolCallRecord{ id, name, result: Part[] }` where `functionResponse` parts, including
`inlineData` images, are preserved untruncated. Retention is `sessionRetention`
(`maxAge` default 30d, `maxCount` 50). Gemini also has a hook system
(`packages/core/src/hooks/hookEventHandler.ts`) that could mirror the Claude approach.

## Recommended capture mechanism for the ai-tabs media panel

**Primary: PostToolUse hook -> `/api/media-hook` -> `data/media/`.**

1. Extend `lib/attention-hook.js` / `ensureHookSettingsFile` to add a `PostToolUse`
   entry with `matcher: "Read|mcp__claude-in-chrome__computer|mcp__claude-in-chrome__browser_batch"`
   pointing at a new `scripts/media-forward.js`. It rides the `--settings` file ai-tabs
   already passes, so it needs no change to `~/.claude/settings.json` and already knows
   its `tabSessionId`.
2. The forwarder walks `tool_response` for `{type:"image"}` blocks (`source.data` for MCP
   results, `file.base64` for Read), decodes them, and POSTs each image as binary with
   headers for `tabSessionId`, `session_id`, `tool_use_id`, `tool_name`, media type, and
   `tool_input.file_path` when present. Skip results with no image block so text-only
   Reads cost one spawn and nothing else.
3. The server writes `data/media/<tabSessionId>/<timestamp>-<tool_use_id>.<ext>` plus a
   small JSON sidecar (or one `index.jsonl` per tab), broadcasts `{type:"media", ...}`
   over the existing session WebSocket, and enforces a size cap with LRU eviction.

**Secondary: transcript backfill.** Reuse `TailReader` + the statusline `transcript_path`
pin to (a) import images from Codex rollouts (`data:` URLs in `custom_tool_call_output`
/ `function_call_output` and `input_image` items), (b) recover user-pasted images and
anything from before the hook was installed. Parse only lines containing `"image"` to
avoid JSON-parsing 1 MB lines needlessly.

**Why the hook, not the transcript, is primary:**

- It is the only source that is synchronous with the event (the transcript is documented
  to lag), so the panel updates the moment a screenshot lands.
- Attribution is free: the hook settings file is per-launch and already carries
  `tabSessionId`; the transcript route needs the statusline pin and still guesses when two
  tabs share a cwd before the first statusline tick.
- It is immune to retention and to `persistSession:false`, and it avoids re-reading
  multi-MB lines every poll.
- It covers subagent tool calls without discovering `agent-*.jsonl` files.
- The user-paste gap (7 of 957 local images) is small and is covered by the backfill.

Not recommended: scraping `[Image]` from the PTY (no bytes), or reading `~/.claude/image-cache/`
(undocumented layout, pastes only, and not present on this machine).
