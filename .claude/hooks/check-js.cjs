#!/usr/bin/env node
/**
 * PostToolUse hook — runs `node --check` against any .js file just edited.
 *
 * Reads Claude Code's hook payload from stdin (JSON):
 *   { tool_input: { file_path: "..." }, ... }
 *
 * Exit codes:
 *   0  pass (file isn't .js, OR node --check succeeded, OR file deleted)
 *   2  fail (node --check reported a syntax error)
 *
 * The hook output goes to the conversation transcript, so a syntax error
 * shows up immediately after the offending Edit/Write and the next
 * iteration of the loop can fix it without a Run-and-fail cycle.
 */

const fs = require('fs');
const { execSync } = require('child_process');

let payload;
try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
    process.exit(0);   // malformed hook input — don't block the user
}

const filePath = payload?.tool_input?.file_path;
if (!filePath || !filePath.endsWith('.js')) {
    process.exit(0);
}

if (!fs.existsSync(filePath)) {
    process.exit(0);   // file was deleted by the tool call
}

// Skip ESM test files — `node --check` can't parse `import` against the
// project's CJS-typed package.json. Vitest runs them as ESM directly.
const normalised = filePath.replace(/\\/g, '/');
if (/\/tests\//.test(normalised) || /\.test\.js$/.test(normalised) || /\.spec\.js$/.test(normalised)) {
    process.exit(0);
}

try {
    execSync(`node --check "${filePath}"`, { stdio: 'pipe' });
    console.log(`[hook check-js] OK ${filePath}`);
    process.exit(0);
} catch (e) {
    const stderr = (e.stderr && e.stderr.toString()) || e.message;
    console.error(`[hook check-js] SYNTAX ERROR in ${filePath}\n${stderr}`);
    process.exit(2);
}
