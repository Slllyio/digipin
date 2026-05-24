# `.claude/` — DigiPin team automation

This directory configures Claude Code automation that travels with the
repo: skills, subagents, hooks, and the MCP server list. Everything
here is intentionally checked in so a new contributor running Claude
Code in the project gets the same productivity boosts as everyone else.

## Layout

```
.claude/
├── settings.json                 # project hooks (loaded for everyone)
├── settings.local.json           # personal overrides (gitignored if needed)
├── hooks/
│   ├── check-js.cjs              # PostToolUse: node --check on .js edits
│   └── block-latest-json.cjs     # PreToolUse: blocks edits to scraper snapshots
├── skills/
│   ├── new-realtime-source/      # /new-realtime-source — scaffold a scraper
│   └── stacked-pr/               # /stacked-pr — generate PR title + body
└── agents/
    ├── maplibre-layer-reviewer.md
    └── scraper-source-reviewer.md

.mcp.json                         # shared MCP server list (one level up)
```

## Skills

### `/new-realtime-source <id> <feed-url> [--auth=none|env|api-key]`

Scaffolds a new scraper source in `scrapers/sources/<id>.py` following
the 8-source convention established in PRs #5 / #6 / #7. Also appends
to the CI workflow matrix and the README. **User-invocable only** —
this skill writes files.

### `/stacked-pr [--base <branch>] [--draft]`

Generates a PR title and body from the current branch's commits +
diff. Matches the established DigiPin convention: subsystem-grouped
"What changed" table, concrete Test plan checklist, Follow-ups
section, and the stacked-on indicator when the base isn't `main`.
**User-invocable only.**

## Hooks

| Event | Trigger | Action |
|---|---|---|
| `PostToolUse` | Edit / Write / MultiEdit on `*.js` | Run `node --check` on the file; exit 2 with the error if syntax is broken |
| `PreToolUse` | Edit / Write / MultiEdit on `data/realtime/*/latest.json` | Block with a message redirecting to `python -m scrapers.cli <source>` |

Both hook scripts are in `.claude/hooks/` and can be smoke-tested
independently:

```sh
# Pass: valid JS
echo '{"tool_input":{"file_path":"js/data-fetcher.js"}}' | node .claude/hooks/check-js.cjs

# Fail: broken JS
echo "function broken( {}" > /tmp/bad.js
echo '{"tool_input":{"file_path":"/tmp/bad.js"}}' | node .claude/hooks/check-js.cjs

# Block: latest.json
echo '{"tool_input":{"file_path":"data/realtime/ndma_sachet/latest.json"}}' | node .claude/hooks/block-latest-json.cjs
```

## Subagents

### `maplibre-layer-reviewer`

Reviews any JS file that adds, modifies, or animates a MapLibre
source / layer. Enforces the cleanup-on-cell-change rule, naming
conventions, and the canvas-source-for-animated-rasters pattern that
emerged across PRs #9 / #10 / #11.

Invoke via the Task tool with `subagent_type: "maplibre-layer-reviewer"`,
or let Claude proactively invoke it on `js/realtime-*.js` /
`js/flood-*.js` / `js/map.js` changes.

### `scraper-source-reviewer`

Reviews `scrapers/sources/<name>.py` files for conformance with the
framework convention: `SOURCE_ID` matches filename, dataclass has
`csv_fields()`, `fetch(client)` + `key_for(record)` signatures match,
auth uses env-var graceful skip, polite delays between iterations.

## MCP servers (`.mcp.json` at repo root)

| Server | Purpose |
|---|---|
| `context7` | Live docs for MapLibre / georaster / Open-Meteo / IMD — preferred over WebFetch for library lookups |
| `playwright` | Browser automation for testing the cell panel, flood animation, inundation overlay. Same Playwright binary the project already uses in `record-video.mjs` |

To activate a server, run `claude mcp list` to see what's loaded, or
restart Claude Code. The `.mcp.json` file is read on every session
start.

## When this is loaded

- Skills appear as `/new-realtime-source` and `/stacked-pr` in Claude
  Code's slash-command palette
- Hooks fire automatically on the matching tool events — no manual
  invocation needed
- Subagents are listed in the Task tool's available `subagent_type`
  values
- MCP servers are loaded at session start (visible via `claude mcp list`)

## Local-only overrides

Personal preferences that shouldn't be shared with the team go in
`.claude/settings.local.json` (already gitignored if added to `.gitignore`).
For example, a personal API key or a hook you only want on your machine.
