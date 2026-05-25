#!/usr/bin/env node
/**
 * PreToolUse hook — blocks direct edits to data/realtime/<source>/latest.json.
 *
 * These files are auto-managed by .github/workflows/realtime-scrape.yml
 * which runs every 15 minutes. Editing them manually creates merge
 * conflicts and ships stale data. The hook redirects the user to the
 * correct workflow: `python -m scrapers.cli <source>`.
 *
 * Exit codes:
 *   0  allow
 *   2  block (the tool call is cancelled and the message shown to the user)
 */

const fs = require('fs');

let payload;
try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
    process.exit(0);
}

const filePath = payload?.tool_input?.file_path || '';
const normalized = filePath.replace(/\\/g, '/');

if (/data\/realtime\/[^/]+\/latest\.json$/.test(normalized)) {
    const m = normalized.match(/data\/realtime\/([^/]+)\/latest\.json$/);
    const source = m ? m[1] : '<source>';
    console.error(
        `[hook block-latest-json] BLOCKED edit to ${normalized}.\n` +
        `This snapshot is auto-managed by the CI cron at ` +
        `.github/workflows/realtime-scrape.yml (refreshes every 15 min).\n` +
        `To regenerate locally: python -m scrapers.cli ${source}`
    );
    process.exit(2);
}

process.exit(0);
