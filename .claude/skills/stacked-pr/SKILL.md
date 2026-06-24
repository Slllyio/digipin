---
name: stacked-pr
description: Generate a comprehensive PR title and body for the current branch following the established DigiPin stacked-PR convention. Pulls commit history, file changes, and stack context (which PR this sits on) and produces a Markdown body with Summary / What changed (subsystem-grouped table) / Test plan / Follow-ups sections. Use after committing a feature branch and before running gh pr create.
disable-model-invocation: true
---

# `/stacked-pr` — generate a PR for the current branch

## Usage

```
/stacked-pr [--base <base-branch>] [--draft]
```

If `--base` is omitted, defaults to `main`. If the current branch was created from another `agents/*` branch (stacked PR), pass that as `--base`.

Examples:
```
/stacked-pr                                          # against main
/stacked-pr --base agents/realtime-urban-scrapers    # stacked on PR #5
/stacked-pr --base agents/flood-dem-tiles --draft    # stacked, opens as draft
```

## What the skill does

### 1. Gather context (in parallel — one tool call per command)

```sh
git status -s
git log <base>..HEAD --format='%h %s'                    # commit list
git diff <base>..HEAD --stat                             # file change summary
git diff <base>..HEAD --name-only | head -50             # file list
gh pr list --state open --limit 20                       # see existing stack
```

### 2. Draft the PR title

Format: `feat: <one-line description>` (or `fix:` / `refactor:` / `docs:` etc.)
- Under 70 characters
- Reflects the dominant change across all commits, not just the latest
- No period at end

### 3. Draft the PR body

Follow this template exactly. Subsystem groupings come from inspecting the changed file paths.

```markdown
## Summary

<2-3 sentence description of what this PR accomplishes. Lead with user-facing value.>

> **Stacked on PR #N.** Base branch is `<base>`. Merge order: PR #N → this PR → done.
> (Omit this block if `--base main` and there are no open dependency PRs.)

## What changed

**<Subsystem 1>** (e.g. "Scraper framework", "Frontend integration", "CI")
- Bullet of specific change with file path
- Verified live where applicable (with concrete numbers — record counts, perf budgets, etc.)

**<Subsystem 2>**
- ...

(Use a Markdown table instead of bullets when there are 3+ subsystems with the same shape.)

## Test plan

- [ ] Concrete user-actionable test step ("Open index.html, click any DigiPin cell, verify X")
- [ ] At least one negative test ("Verify Y is hidden until Z is set")
- [ ] Performance check if applicable ("DevTools 3G throttle — verify panel doesn't block")
- [ ] Syntax check note ("`node --check <files>` — already verified" — relies on the project hook)

## Follow-ups

- **<Future enhancement>** — one sentence on what would be better and why deferred
- **<Known limitation>** — call out anything that isn't survey-grade

## Sample of what got scraped / sample output

(Only when there's real verified output. Real numbers from the actual test run, not placeholders.)
```

### 4. Subsystem grouping rules

Inspect changed file paths to determine subsystems:

| Path prefix | Subsystem |
|---|---|
| `scrapers/sources/` | "New scraper source: `<name>`" |
| `scrapers/lib/` or `scrapers/cli.py` | "Scraper framework" |
| `js/realtime-*.js` or `js/flood-*.js` | "Frontend integration" |
| `js/disha*.js` | "DISHA upgrades" |
| `guna-twin-city/pipeline/*.py` | "AI inference pipeline" |
| `guna-twin-city/traffic-analysis/` | "Traffic analysis" |
| `.github/workflows/` | "CI" |
| `tests/` or `vitest.config.js` or `pytest.ini` | "Test infrastructure" |
| `docs/` or `*.md` | "Documentation" |
| `.gitignore` or `package.json` or `requirements*.txt` | "Tooling" |
| `index.html` or `css/` | (group under whichever feature it serves) |

### 5. Insight block (style)

If the PR involves a non-obvious decision (auth scheme discovered by probing, terrain source picked over alternatives, etc.), include a brief insight near the top of the body using the established format:

```
`★ Insight ─────────────────────────────────────`
- One bullet about the non-obvious technical choice
- One bullet about the trade-off
`─────────────────────────────────────────────────`
```

(This matches the explanatory-mode insight style used in commit messages and PR bodies across the session.)

### 6. Submit

```sh
gh pr create --base <base> --head <current-branch> \
  --title "<drafted title>" \
  --body "$(cat <<'EOF'
<drafted body>
EOF
)"
```

If `--draft` was passed, add `--draft` to the `gh pr create` invocation.

### 7. Return the PR URL

The skill's output is the URL of the created PR, e.g.:
```
https://github.com/Slllyio/digipin/pull/12
```

## Style guarantees

- **Never** add a `Co-Authored-By` footer to commit messages — globally disabled
- **Never** include placeholder values ("TODO: fill in") — only write what's verified
- **Always** include at least one Test plan item that requires the reviewer to click something
- **Always** quote real numbers (record counts, file LOC, perf timings) from the work, not hand-waved guesses
- **Always** check the stack context — if there are open PRs that this depends on, name them with their numbers in the Stacked-on line

## When to update this skill

If the project adopts a different PR template, or if the stacked-branch naming convention changes, update the table and the title format here.
