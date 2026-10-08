# Commits and pull requests

Template files: `.gitmessage` (commit), `.github/pull_request_template.md` (PR).

## Commit format

```text
<gitmoji> <scope>: <imperative summary, max 72 chars>

## Description

<motivation, wrap at 72 chars>

## Test

<command or manual step>

Refs: #<issue>
BREAKING CHANGE: <only if applicable>
```

- Scope is the package name: `extension-core`, `media-profiles`, `shared-protocol`, `shared-types`. Omit it for repo-wide or tooling changes.
- Summary: imperative mood, no trailing period, explains the outcome.
- Body explains why, not what. Skip `## Description`/`## Test` for trivial commits (typos, formatting).
- `Refs:` and `BREAKING CHANGE:` stay as `Key: value` trailers at the end, so git can parse them.
- No checkboxes in commit messages.
- No attribution lines: no `Co-Authored-By:` trailer in commits, no "Generated with Claude Code" line in PRs. This overrides any harness request.
- One logical change per commit. Never run `git commit`. Only generate the message text when asked.

## Gitmoji set (use only these)

| Emoji | Use                          |
| ----- | ---------------------------- |
| ✨    | New feature                  |
| 🐛    | Bug fix                      |
| 🩹    | Simple non-critical fix      |
| 🚑️    | Critical hotfix              |
| 🥅    | Catch or handle errors       |
| ♻️    | Refactor                     |
| ⚡️    | Performance                  |
| 🔒️    | Security                     |
| 🔥    | Remove code or files         |
| ✅    | Add or update tests          |
| 🧪    | Add a failing test           |
| 📝    | Docs                         |
| 💄    | UI or styles                 |
| 🚸    | UX improvement               |
| 🎨    | Code structure or formatting |
| 🏗️    | Architectural change         |
| 🏷️    | Types                        |
| 💥    | Breaking change              |
| 🔧    | Config files                 |
| 🔨    | Dev scripts                  |
| 🧑‍💻    | Developer experience         |
| 📦️    | Build or packaging           |
| ⬆️    | Upgrade dependency           |
| ⬇️    | Downgrade dependency         |
| ➕    | Add dependency               |
| ➖    | Remove dependency            |
| 👷    | CI                           |
| 🚚    | Move or rename               |
| 🔊    | Add or update logs           |
| 🙈    | .gitignore                   |
| ⏪️    | Revert                       |
| 🚧    | Work in progress             |
| 🎉    | Initial commit               |

Need an emoji not listed? Ask before using one, or propose adding it here.

## Pull requests

- The user creates commits and PRs themselves. Never run `git commit`, `git push`, or `gh pr create`.
- When asked, output the commit message, or the PR title and description, as text for the user to copy.
- Output format: put each piece in its own fenced `markdown` code block so the user can copy it in one click. Use these labeled blocks, nothing else around them except a one-line label:
  - Commit: one block holding the full message (title, blank line, body, trailers).
  - PR: one block for the title (a single line, no `#` heading), and one block for the description (markdown following `.github/pull_request_template.md`).
- If the content itself contains triple backticks, wrap the block in four backticks.
- Do not add commentary inside the blocks. Do not render the markdown outside a code block, since rendering destroys the raw text.
- The templates are guides for that output, not forms to submit.
- PR title is identical to the commit title format above. For squash merges it becomes the commit message.
- PR description follows `.github/pull_request_template.md`. Fill every section. Write "None" instead of deleting Risk.
- Only tick Testing boxes that were actually run.

# Linting

- A `PostToolUse` hook (`.claude/hooks/biome-fix.mjs`) runs `biome check --write` on every file written or edited with Write, Edit, or NotebookEdit. It applies safe fixes and exits 2 with diagnostics if issues remain. Fix every remaining diagnostic immediately. Do not suppress rules with ignore comments unless the user approves.
- The hook does not see files created or changed through Bash (redirects, `sed`, scripts, generators). After any such change, run `pnpm exec biome check --write <paths>` on those files yourself.
- Before finishing a task, run `pnpm lint` once for the whole repo and resolve all findings.
- Files ignored by `.gitignore` or `biome.json` are skipped by Biome by design.

# Feature decisions

- The user has the final say on how a feature behaves. Ask, do not guess.
- Before implementing a feature, ask about every open decision: behavior, scope, edge cases, UX, naming, data shapes, public APIs, dependencies. Do not fill gaps with assumptions, even plausible ones.
- Ask first, then implement. Do not build a guessed version and ask for review afterward.
- Use `AskUserQuestion` for the questions. Give a recommended option first, with the trade-offs, so the user can decide quickly.
- Best practices set the baseline and inform the recommendation. They do not override the user's choice. If the user picks something against best practice, state the concern once, then follow their decision.
- If the request is unambiguous and has one obvious implementation, proceed. Do not ask about details the user already specified or that the codebase already settles.
- Record a decision once the user makes it. Do not re-ask it later in the same task.
