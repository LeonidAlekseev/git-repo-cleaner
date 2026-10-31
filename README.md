# Git Repo Cleaner

**🇬🇧 English** | [🇷🇺 Русский](README.ru.md)

[![CI](https://github.com/LeonidAlekseev/git-repo-cleaner/actions/workflows/ci.yml/badge.svg)](https://github.com/LeonidAlekseev/git-repo-cleaner/actions/workflows/ci.yml)
[![JSR](https://jsr.io/badges/@leonidalekseev/git-repo-cleaner)](https://jsr.io/@leonidalekseev/git-repo-cleaner)
[![GitHub release](https://img.shields.io/github/v/release/LeonidAlekseev/git-repo-cleaner)](https://github.com/LeonidAlekseev/git-repo-cleaner/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](https://github.com/LeonidAlekseev/git-repo-cleaner/releases)
[![Deno](https://img.shields.io/badge/deno-2.x-black?logo=deno)](https://deno.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A TypeScript/Deno tool that removes traces of AI coding assistants — Claude Code, Cursor, GitHub Copilot, Codex, Gemini,
Aider, Windsurf, OpenSpec, AGENTS.md — from files, commit messages and authors across the whole git history, for any
branches, into the same branches, new branches or another repository.

> [!WARNING]
> This tool rewrites git history. Overwritten branches are backed up automatically, but before the first run on an
> important repository do a dry run (`--dry-run`) and make sure you have a copy.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [What Gets Cleaned](#what-gets-cleaned)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [How It Works](#how-it-works)
- [Safety](#safety)
- [Comparison with claude-cleaner](#comparison-with-claude-cleaner)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Development](#development)
- [Acknowledgments](#acknowledgments)
- [License](#license)

## Overview

Git Repo Cleaner clones the repository into a temporary mirror, keeps only the branches you selected, shows exactly what
will change, rewrites history with [git-filter-repo](https://github.com/newren/git-filter-repo), verifies the result and
only then delivers the cleaned branches where you asked. The source repository is not touched until the very last step.

Every question is asked interactively — checkbox lists right in the terminal — and every one of them can be answered
with a flag for scripts and CI.

## Features

- ☑️ **Terminal checkboxes**: pick branches, artifacts and actions with arrow keys and Space.
- 🌿 **Any branches**: one, several or all of them.
- 🎯 **Any destination**: the same branches, new branches (`main` → `main-clean`), another local or remote repository,
  or a mirror with `--prune`.
- 🧩 **11 artifact groups**: Claude Code, Anthropic, OpenSpec, AGENTS.md, Serena, Cursor, Copilot, Codex, Gemini, Aider,
  Windsurf — plus your own regexes.
- ✂️ **Precise trailer removal**: only attribution lines inside the trailer block are removed; the commit body,
  `Signed-off-by` and human co-authors stay.
- 👤 **Bot authors**: commits by `Claude`, `Copilot`, `Cursor Agent`, `… (aider)` are rewritten to your name.
- 🔎 **Preview**: which files will be removed, which trailers and authors will change, which branches will be
  overwritten.
- 🧪 **Dry run**: full cleanup of a temporary copy without touching the target.
- 💾 **Backup by default**: everything that will be overwritten or deleted is saved to a git bundle.
- ✅ **Verification**: after cleaning, the history is checked by the same code that built the plan; if anything is left,
  nothing is pushed.
- 🔒 **SHA preservation**: commits without artifacts stay byte-for-byte identical.
- 🎨 **Clean output**: spinners, aligned sections, colors (respects `NO_COLOR`), no git noise.
- 📦 **Single binary**: builds for Linux, macOS and Windows.

## What Gets Cleaned

### Artifacts (`--only`)

| Key         | Default | Files and folders                                                                                                                  | Trailers and authors                                                              |
| ----------- | :-----: | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `claude`    |   ✅    | `.claude/`, `CLAUDE.md`, `CLAUDE.local.md`, `claudedocs/`, `.vscode/claude.json`, `.clauderc`, `.claudeignore`, `claude*.tmp/.log` | `Co-Authored-By: Claude …`, `🤖 Generated with [Claude Code](…)`, author `Claude` |
| `anthropic` |   ✅    | —                                                                                                                                  | any trailer or author with an `@anthropic.com` email                              |
| `openspec`  |   ✅    | `openspec/`                                                                                                                        | —                                                                                 |
| `agents`    |   ✅    | `AGENTS.md`, `AGENT.md`, `AGENTS.*.md`                                                                                             | —                                                                                 |
| `serena`    |   ✅    | `.serena/`                                                                                                                         | —                                                                                 |
| `cursor`    |         | `.cursor/`, `.cursorrules`, `.cursorignore`, `.cursorindexingignore`                                                               | `Co-authored-by: Cursor Agent …`, author `Cursor Agent`                           |
| `copilot`   |         | `.github/copilot-instructions.md`, `.github/prompts/*.prompt.md`, `.github/instructions/*.instructions.md`                         | `Co-authored-by: Copilot …`, author `Copilot`                                     |
| `codex`     |         | `.codex/`                                                                                                                          | `Co-authored-by: Codex …`, author `Codex`                                         |
| `gemini`    |         | `GEMINI.md`, `.gemini/`                                                                                                            | `Co-authored-by: gemini-code-assist …`                                            |
| `aider`     |         | `.aider*` (`.aider.chat.history.md`, `.aider.conf.yml`, `.aider.tags.cache.v3/` …)                                                 | `Co-authored-by: aider …`, `(aider)` in the author name                           |
| `windsurf`  |         | `.windsurf/`, `.windsurfrules`                                                                                                     | —                                                                                 |

### Actions (`--actions`)

| Key        | Default | What it does                                                                                      |
| ---------- | :-----: | ------------------------------------------------------------------------------------------------- |
| `files`    |   ✅    | removes artifact files and folders by exact name from the whole history                           |
| `trailers` |   ✅    | removes attribution lines from the trailer block at the end of a message                          |
| `authors`  |   ✅    | replaces bot authors and committers with `--author-name`/`--author-email` (default: `git config`) |
| `extended` |         | broad path patterns: `claude-*`, `claude_*`, `claude.*`, `.claude*`, `.mcp.json`, `*openspec*`    |
| `mentions` |         | strips mentions (`claude`, `anthropic`, `openspec`, `agents.md`, your `--word`) from message text |
| `content`  |         | strips the same mentions from the contents of text files — **may break code**, use deliberately   |

### Exact path matching

Standard patterns match an exact file or folder name anywhere in the tree:

```
Pattern: .claude/
✅ .claude/settings.json, app/.claude/commands/x.md
❌ .claude2/x, my.claude/x

Pattern: CLAUDE.md
✅ CLAUDE.md, docs/CLAUDE.md, CLAUDE.local.md
❌ MY-CLAUDE.md, CLAUDE.md.backup, docs/claude-guide.md

Pattern: AGENTS.md
✅ AGENTS.md, sub/AGENT.md, AGENTS.override.md
❌ MY-AGENTS.md, agents/index.ts
```

`src/claude_client.ts` is kept by default. The `extended` action removes it too.

### Trailers

A trailer is removed only if the line matches an attribution pattern **in full** **and** sits in the trailer block at
the end of the message:

```diff
  Add Claude client

  Uses the Claude API for summaries.        ← the commit body stays
-
- 🤖 Generated with [Claude Code](https://claude.com/claude-code)
-
  Signed-off-by: Jane Doe <jane@example.com>
- Co-Authored-By: Claude <noreply@anthropic.com>
  Co-authored-by: Bob <bob@example.com>     ← a human co-author stays
```

Messages with nothing to remove are not changed at all. If nothing is left of a message, it becomes `Update files`, so
no commit ends up with an empty message.

## Installation

### Prerequisites

- **git**;
- **[git-filter-repo](https://github.com/newren/git-filter-repo)** — the history rewriting engine:
  ```sh
  pipx install git-filter-repo    # or: brew install git-filter-repo / apt install git-filter-repo
  ```
- **[Deno](https://deno.com) 2+** — only when running from source or JSR; the binary does not need Deno.

### Install Git Repo Cleaner

```sh
# Option 1: pre-built binary from the releases page
#   https://github.com/LeonidAlekseev/git-repo-cleaner/releases
#   put it on your PATH as git-repo-cleaner

# Option 2: from JSR
deno install -g -n git-repo-cleaner --allow-run=git --allow-read --allow-write --allow-env \
  jsr:@leonidalekseev/git-repo-cleaner

# Option 3: from source
git clone https://github.com/LeonidAlekseev/git-repo-cleaner
cd git-repo-cleaner
deno task compile                 # → dist/git-repo-cleaner
# or run without building:
./src/main.ts --help
```

> [!TIP]
> A `git-repo-cleaner` binary on your `PATH` also works as a git subcommand: `git repo-cleaner --help`.

> [!NOTE]
> Deno does not install versions published less than 24 hours ago by default. If a fresh release is rejected, add
> `--minimum-dependency-age=0` to the install command.

## Quick Start

```sh
cd my-project

# 1. See what would be cleaned without changing anything
git-repo-cleaner --dry-run

# 2. Run interactively and answer the questions
git-repo-cleaner
```

Example output:

```
git-repo-cleaner v0.1.1

✔ Cloned /home/jane/my-app · 1 branch 0.0s
✔ Inspected target refs 0.0s
✔ Analyzed history 0.0s

Found in history · 2 commits
  Files         3
                .claude/settings.json
                AGENTS.md
                CLAUDE.md
  Trailers      2
                🤖 Generated with [Claude Code](https://claude.com/claude-code)  ×1
                Co-Authored-By: Claude <noreply@anthropic.com>  ×1
  Authors       1
                Claude <noreply@anthropic.com>
  Commits       1 with a new message or author

Plan
  Source        /home/jane/my-app
  Target        same repository
  Branches      main → main-clean
  Tags          no
  Artifacts     claude, anthropic, openspec, agents, serena
  Actions       files, trailers, authors
  Author        Jane Doe <jane@example.com>
  Backup        not needed, nothing is overwritten
  Mode          dry run — the target stays untouched

✔ Rewrote history 0.2s
✔ Verified the result · no artifacts left 0.0s

◆ Dry run complete — the target was not changed
  Cleaned copy  /tmp/git-repo-cleaner-1a2b3c/repo.git
  Inspect       git -C /tmp/git-repo-cleaner-1a2b3c/repo.git log --all --stat
```

## Usage

### Interactive mode

```sh
git-repo-cleaner                                   # current repository
git-repo-cleaner ../other-project                  # local path
git-repo-cleaner https://github.com/me/private     # remote repository
```

Questions in order (arrows — move, Space — toggle, `a` — all/none, Enter — confirm, `q` — quit):

1. which branches to clean;
2. into a new branch (`<branch>-clean` or a custom name/suffix) or into the same branches, rewriting them;
3. into this repository, its `origin` or another repository (URL or path; a missing path is created);
4. which artifacts to clean;
5. what to do with them;
6. your own path and mention regexes;
7. preview and confirmation: `y` — run, `d` — dry run, `N` — cancel.

### Command line options

```
Usage: git-repo-cleaner [source] [options]
  source                  repository path or URL (default: current repository)

Branches:
  -b, --branch NAME       branch to clean (repeatable)
  --all                   all branches
Branch names:
  --in-place              keep branch names (rewrite history)
  --suffix=SUFFIX         new branches named <branch><suffix> (default: -clean)
  --to NAME               new branch name (single branch only)
Destination:
  --same-repo             push to the source repository
  --target URL|PATH       push to another repository (a missing path is created)
What to clean:
  --only KEYS             comma-separated artifacts (default: claude,anthropic,openspec,agents,serena)
  --actions KEYS          comma-separated actions (default: files,trailers,authors)
  --word REGEX            extra mention regex for mentions/content (repeatable)
  --path REGEX            extra file path regex (repeatable)
  --author-name NAME      name for rewritten commits (default: git config user.name)
  --author-email EMAIL    email for rewritten commits (default: git config user.email)
Other:
  --no-tags               do not transfer tags
  --prune                 delete target branches missing from the source (requires --all)
  --dry-run               preview and clean a temporary copy; leave the target untouched
  --no-backup             skip the backup of overwritten target refs (backup is on by default)
  -v, --verbose           show full lists
  -y, --yes               do not ask for confirmation
  -V, --version           print version
  -h, --help              show this help
```

Without a terminal (CI, scripts) every missing answer must come from a flag, otherwise the tool stops and tells you
which flag is needed. Pass a suffix that starts with `-` with `=`: `--suffix=-clean`.

### Basic examples

```sh
# one branch → a new branch in the same repository
git-repo-cleaner -b main --to main-public --same-repo

# all branches → suffixed branches, no questions
git-repo-cleaner --all --suffix=-clean --same-repo -y

# one branch → rewrite in place (with a backup)
git-repo-cleaner -b feature/login --in-place --same-repo
```

### Selective cleaning

```sh
# files only, keep messages and authors
git-repo-cleaner --actions files

# trailers only
git-repo-cleaner --actions trailers

# Claude and Cursor, plus mentions in message text
git-repo-cleaner --only claude,cursor --actions files,trailers,authors,mentions

# everything known, including broad path patterns
git-repo-cleaner --only claude,anthropic,openspec,agents,serena,cursor,copilot,codex,gemini,aider,windsurf \
  --actions files,extended,trailers,authors --dry-run -v
```

### Custom patterns

```sh
# remove the notes-ai/ folder and strip a project codename from messages
git-repo-cleaner --path '(^|/)notes-ai(/|$)' --word 'project-x' --actions files,trailers,mentions
```

### Publishing a private repository

```sh
# mirror: all branches and tags; branches deleted in the source are deleted in the target too
git-repo-cleaner https://github.com/me/private \
  --target https://github.com/me/public \
  --all --in-place --prune -y \
  --author-name "Jane Doe" --author-email jane@users.noreply.github.com
```

## How It Works

1. **🔍 Dependency check** — git and git-filter-repo are available.
2. **📥 Mirror copy** — the source is cloned into a temporary directory; all work happens there.
3. **🧭 Questions and checks** — branches, destination, artifacts, actions; incompatible flags, name collisions and
   `--prune` without `--all` are rejected before anything changes.
4. **📸 Target snapshot** — the target's branches and tags are copied into internal refs to know what will be
   overwritten.
5. **🔎 Plan** — from the history of the selected branches the tool builds the list of files to remove and the change
   for every commit (message, author, committer); this is the preview.
6. **✋ Confirmation** — or a dry run.
7. **💾 Backup** — the target refs that will be overwritten or deleted are saved to a git bundle.
8. **🧹 Cleanup** — git-filter-repo removes the files, replaces text for `content` and applies the commit plan by
   original SHA.
9. **✅ Verification** — the plan is rebuilt from the result; if it still contains changes or artifact files, nothing is
   pushed and the copy is kept for inspection.
10. **🚀 Delivery** — `git push --force` to a remote target or `git fetch` into a local one.

Decisions about messages and authors live in one place (`src/message.ts`, `src/history.ts`): the preview, the rewrite
and the verification share the same code, so the preview matches the result.

## Safety

### Backup by default

Before delivery everything in the target that will be overwritten or deleted — branches, tags, branches removed by
`--prune` — is saved to `~/.cache/git-repo-cleaner/<repo>-<time>.bundle`. If nothing is overwritten (a new branch, a new
repository), no backup is created. Disable with `--no-backup`.

```sh
# restore branches from a backup into backup/*
git fetch ~/.cache/git-repo-cleaner/my-app-20261031-120000.bundle 'refs/backup/heads/*:refs/heads/backup/*'
```

### Dry run

`--dry-run` (or answering `d` at the confirmation) shows the preview, runs the cleanup and the verification on a
temporary copy, but does not change the target and does not create a backup. The path to the cleaned copy is printed so
you can inspect it:

```sh
git -C /tmp/git-repo-cleaner-xxxx/repo.git log --all --stat
```

### Safety checks

- **The source is untouched until the last step**: all work happens in a temporary copy.
- **Checked-out branches**: a local branch checked out in the current worktree is updated only if the working tree is
  clean (then `git reset --hard`); a branch checked out in another worktree is never touched.
- **Tags** are transferred only when all branches are cleaned into the same names or into another repository, so
  rewritten tags never overwrite the originals next to new branches.
- **`--prune`** is allowed only with `--all`; deleted branches are listed in the plan and included in the backup.
- **Without a terminal** the tool refuses to run without `--yes` or `--dry-run`.

## Comparison with claude-cleaner

Git Repo Cleaner is inspired by [claude-cleaner](https://github.com/tylerbutler/claude-cleaner) and adopts its precise
trailer parsing, exact name matching and preview approach. The differences:

|                        | claude-cleaner                                | Git Repo Cleaner                                                                                |
| ---------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Tools                  | Claude                                        | Claude, Anthropic, OpenSpec, AGENTS.md, Serena, Cursor, Copilot, Codex, Gemini, Aider, Windsurf |
| Branch selection       | files — all refs, messages — one branch       | one, several or all branches, the same for files and messages                                   |
| Destination            | in place                                      | in place, new branches, another local or remote repository, mirror with `--prune`               |
| Interface              | flags                                         | terminal checkboxes + flags                                                                     |
| Bot authors            | —                                             | rewritten to your name                                                                          |
| Mentions in text/files | —                                             | on request (`mentions`, `content`)                                                              |
| Backup                 | bare clone of the whole repository + a branch | bundle of only the overwritten and deleted target refs                                          |
| Isolation              | rewrites the working repository               | temporary mirror; the target changes after verification                                         |
| Verification           | yes                                           | the same code that built the plan; nothing is pushed if anything is left                        |
| `CLAUDE.md`            | kept by default                               | removed by default (can be unchecked)                                                           |
| Engine                 | `git filter-branch` (only git needed)         | `git-filter-repo` (needs Python, but many times faster)                                         |

## Troubleshooting

#### `git-filter-repo is required`

```sh
pipx install git-filter-repo        # or brew install git-filter-repo / apt install git-filter-repo
git filter-repo --version
```

#### `No terminal to ask — pass …`

The tool runs without an interactive terminal (CI, a pipe). Pass the missing answer with the flag from the message, for
example `--all --in-place --same-repo -y`.

#### `Branch … is checked out in … with uncommitted changes`

The branch to overwrite is checked out and has local changes. Commit or stash them (`git stash push -m before-clean`)
and run again.

#### `Branch … is checked out in another worktree`

Switch that worktree to another branch or clean into a new branch (`--suffix=-clean`).

#### `Artifacts are still present, nothing was pushed`

Artifacts remained after cleaning — usually because a custom `--word` re-forms a match after stripping. The message
prints the path to the copy for inspection; the target is unchanged.

#### `git push failed`

The branch is protected or force-push is not allowed. Lift the protection temporarily or clean into a new branch.

## FAQ

**Will commit SHAs change?** Yes — for commits where something was removed, and for all their descendants. Commits
before the first change keep their SHAs.

**Do collaborators need to do anything?** After rewriting published branches — re-clone or run
`git fetch && git reset --hard origin/<branch>`.

**Are files removed from old commits on GitHub?** From the branches — yes. Old commits may still be reachable by SHA, in
forks and in closed pull requests. That is not enough for secrets — revoke them.

**Why is `content` off by default?** It replaces words in every text file, including code: `import anthropic` becomes
`import`. Enable it only for documentation and after a dry run.

**Are binary files and annotated tags cleaned?** No: git-filter-repo does not edit binary files, and annotated tag
messages are not processed.

**Why is CLAUDE.md removed by default?** The tool aims to remove AI traces completely. To keep these files, uncheck the
`files` action or the `claude` artifact.

**What regex syntax is supported?** Case-insensitive, applied to the full path (`--path`) or line (`--word`). Path
patterns and `--word` for `content` are executed by git-filter-repo, so they must work in both JavaScript and Python
`re` — common syntax (`\s`, `(a|b)`, `^`, `$`, `[^/]`) is fine.

## Development

```sh
deno task check     # fmt, lint, type check
deno task test      # unit tests + end-to-end tests on temporary repositories (needs git-filter-repo)
deno task start     # run from source
deno task compile   # build dist/git-repo-cleaner
```

Layout:

```
src/main.ts        CLI: questions, plan, backup, cleanup, delivery
src/artifacts.ts   artifacts, actions, rule building
src/message.ts     commit message cleaning (trailer block, mentions)
src/history.ts     history reading, per-commit plan, git-filter-repo callback
src/menu.ts        terminal checkboxes and prompts
src/ui.ts          output: colors, sections, spinners
src/git.ts         running git
tests/             unit and end-to-end tests
```

Release: bump `version` in `deno.json`, then `git tag v<version> && git push origin v<version>`. CI builds binaries for
Linux, macOS and Windows into a GitHub Release and publishes the package to JSR.

## Acknowledgments

- [claude-cleaner](https://github.com/tylerbutler/claude-cleaner) by Tyler Butler — the idea, trailer block parsing and
  the safe pattern approach.
- [git-filter-repo](https://github.com/newren/git-filter-repo) — a fast and reliable history rewriting engine.
- [Deno](https://deno.com) and [@std](https://jsr.io/@std).

## License

[MIT](LICENSE).
