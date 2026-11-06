# dev-harness

A **development workflow harness** for [GitHub Copilot](https://github.com/features/copilot) (app & CLI) and
[Claude Code](https://www.anthropic.com/claude-code). It gives coding agents one consistent process: plan before
non-trivial changes, keep diffs small, verify, get an independent code and security review, and ship only when you
say so. Where possible the rules are enforced by hooks rather than left to instructions.

```
intake ─► triage ─► branch ─► plan* ─► STOP: you approve ─► implement (local only) ─► verify
                                                                                  │
          ┌──────────── fresh-context, different-model-family review ◄────────────┘
          │   code-reviewer  ║  security-reviewer      (parallel, read-only)
          └─► fix loop (≤2) ─► READY-TO-SHIP summary ─► STOP
                                                         │  you: "ship"
                              commit + push + PR (+ testing plan, Slack summary) ─► lessons captured
* plan-first is automatic for anything non-trivial: 3+ files, multiple repos, contract/auth changes, unclear "done"
```

## What you get

| Piece | What it does |
|-------|--------------|
| **`dev` skill** | The orchestrator above. Every coding task goes through it. |
| **`ship` skill** | Commit, push and PR (stacked/multi-repo aware) with description, reviewer testing plan and a Slack-ready summary. |
| **`review-pr` skill** | Review someone else's PR, re-review after fixes, or triage comments on your own PR. Posts inline comments only after you approve. |
| **`handoff` / `lessons` skills** | Pause and resume across sessions and tools; turn every correction into a durable rule. |
| **`code-reviewer` / `security-reviewer` agents** | Independent reviewers that never see the author's conversation, pinned to a different model family. |
| **Guard hook** (`preToolUse`) | Blocks commit/push/PR before you say "ship", pushes to `main`, plain force-pushes, badly named branches, the app's own branch tools, and `gh` writes made with the wrong account. |
| **Plan gate** (same hook) | In every mode — including autopilot — file edits beyond a minor tweak (> 2 files, or contract files like `package.json`) are blocked until a plan is written and you've explicitly approved it (`dev-harness plan approve`). |
| **Session-start hook** | Injects the repo profile, lessons and open handoffs into every new session. Also self-heals the git credential helper. |
| **`gh-me` + credential helper** | Always act as *your* GitHub account, even when the host injects a different `GH_TOKEN`. |
| **`feature-graph` workflow** | Copilot dynamic workflow that fans a multi-repo plan out to parallel implement/review agents. |
| **`dev-harness` CLI** | `init`, `doctor`, `status`, `unlock`/`lock`, `branch check|suggest`, `profile init`, `diff`, `review`, `lesson add`, `handoff path`, `audit`. |

## Prerequisites

- **Node.js ≥ 20** and **git**
- **GitHub CLI** (`gh`) signed in to the account you want to use (`gh auth login`)
- At least one of: **GitHub Copilot** app/CLI, **Claude Code**
- Optional: the **Copilot CLI** (`npm i -g @github/copilot`). Claude Code users get cross-family reviews through it.
- Optional: **gitleaks** for an extra secret scan in `dev-harness audit`

## Install

```bash
git clone https://github.com/amol-anand/dev-harness.git ~/dev-harness
cd ~/dev-harness
./install.sh            # asks a few questions on first run (account, branch rules), then links everything
dev-harness doctor      # verify
```
Then **restart** the Copilot app/CLI and Claude Code so hooks and skills load.

`install.sh` is idempotent. Re-run it after `git pull` or after editing your personal instructions. Options:
`--dry-run`, `--uninstall`, `--no-claude`, `--no-copilot`, `--no-instructions`, `--no-credential-helper`.
Anything it replaces is backed up to `~/.dev-harness/backups/`, and `--uninstall` restores it.

### What gets installed where

| Location | Contents |
|----------|----------|
| `~/.local/bin/` | `dev-harness`, `gh-me`, `git-credential-dev-harness` (symlinks; make sure it's on `PATH`) |
| `~/.copilot/skills/`, `~/.claude/skills/` | `dev`, `ship`, `review-pr`, `handoff`, `lessons` (symlinks; existing skills with the same name are left alone) |
| `~/.copilot/agents/`, `~/.claude/agents/` | `code-reviewer`, `security-reviewer` (rendered with your configured models) |
| `~/.copilot/hooks/dev-harness.json` | guard + session-start hooks for Copilot |
| `~/.claude/settings.json` | the same hooks, merged in (your other settings are preserved) |
| `~/.copilot/copilot-instructions.md`, `~/.claude/CLAUDE.md` | symlink to generated instructions: `instructions/global.md` + your private `~/.dev-harness/local/instructions.md` |
| `~/.gitconfig` | `credential.https://github.com.helper` → the dev-harness helper as the only github.com helper (only if you configured an account). Your previous helpers are saved to `~/.dev-harness/credential-chain.json` and still used when the harness has no token. |

## Configure

Your settings live in `~/.dev-harness/config.json` (see [`config.example.json`](config.example.json)), created by
`dev-harness init`:

| Key | Meaning |
|-----|---------|
| `github.account` | The GitHub user that all commits, pushes and `gh` writes should use. Blank = no identity enforcement. |
| `github.tokenEnv` | Optional env var that already holds that account's token, e.g. one the Copilot app injects per account (`COPILOT_GH_ACCOUNT_…`). Blank = use `gh auth token --user <account>` from the gh keyring. |
| `github.enforce` | `writes` (default): block wrong-account `gh` writes. `all`: block every `gh` call. `off`. |
| `git.protectedBranches` | Never commit or push directly to these. |
| `git.branch.maxLength` / `forbidSubstrings` / `rules[]` | Branch naming policy. `rules` sets per-repo limits, e.g. `{ "repos": ["org/repo"], "maxLength": 7 }`. |
| `shipGate.enabled` / `ttlMinutes` / `excludeRepos` | Ship gate on/off, how long an unlock lasts, and repos where it doesn't apply. |
| `dev.model` / `dev.claudeModel` / `dev.setDefaults` | Model that writes code (default `claude-opus-5.5`; `opus` in Claude Code). `install.sh` sets it as the default model in both runtimes (original restored on uninstall); `setDefaults: false` leaves your settings alone. |
| `review.codeModel` / `securityModel` | Reviewer models (default `gpt-6.1-sol`). Must be a different family from `dev.model`; `doctor` checks this. |
| `planGate.enabled` / `maxUnplannedFiles` / `contractFiles` / `excludeRepos` | Plan gate: how many changed files count as a minor tweak (default 2), which files always need a plan, and repos to skip. |
| `review.maxFixRounds` | Review → fix iterations before handing back to you. |
| `localDir` | Private overlay for profiles, lessons, handoffs, personal instructions and the audit denylist. |

### Multiple GitHub accounts
If you use several accounts (e.g. work and personal), set `github.account` to the one the harness should use.
- **Copilot app**: it exposes each signed-in account's token as `COPILOT_GH_ACCOUNT_<host>_<user>`. Put the right
  variable name in `github.tokenEnv` (encoding: `.`→`_2E_`, `-`→`_2D_`, `_`→`_5F_`). Run `env | grep COPILOT_GH_ACCOUNT` in a session to see the names.
- **Elsewhere**: `gh auth login` with that account; the harness reads it via `gh auth token --user <account>`.
- To use a different account for one command, tell the agent. It will prefix `GH_TOKEN=…` explicitly, which the guard allows.

Single account? Leave `github.account` blank and identity enforcement is skipped entirely.

### Repo profiles (recommended)
Profiles teach the agent each repo's lint/test/server commands, related repos and back-compat consumers, so you stop
re-explaining them:
```bash
dev-harness profile init ~/code/my-repo     # writes ~/.dev-harness/local/profiles/<owner>__<repo>.md
```
Edit the **Notes** section, e.g. local clone paths of companion repos, consumers to keep compatible, and gotchas.
Profiles stay private and are never committed to this repo.

## Day-to-day use

Just ask for work as usual. The `dev` skill picks it up. Useful phrases:

| You say | What happens |
|---------|--------------|
| "Fix X in repo Y" | Triage. If non-trivial: plan → **stops for your approval (any mode)** → build → verify → review → ready-to-ship summary |
| **"approved"** | Records approval (`dev-harness plan approve`) and continues building |
| **"ship"** | Commit + push as your account + PR with testing plan + Slack summary |
| "review PR <url>" | Explanation + risks + independent findings; posts inline comments if you say so |
| "address the review comments on my PR" | Classify each comment (valid / not valid / needs discussion), fix valid ones via `dev`, reply on threads |
| "pause" | Handoff written; listed automatically at the next session start |
| A correction ("don't do X") | Recorded as a lesson for this repo (or globally) |

Manual controls: `dev-harness status`, `dev-harness plan status|approve|revoke`, `dev-harness unlock` / `lock`, `dev-harness branch suggest "fix the nav overflow"`,
`dev-harness review --kind security` (cross-family review from any terminal).

### Multi-repo features (Copilot)
For approved plans spanning several repos, ask the agent to run the **feature-graph** workflow. See
[`workflows/README.md`](workflows/README.md).

## Copilot vs Claude Code differences

| | GitHub Copilot | Claude Code |
|---|---|---|
| Hooks | `~/.copilot/hooks/dev-harness.json` (`preToolUse`, `sessionStart`) | merged into `~/.claude/settings.json` (`PreToolUse` on `Bash`, `SessionStart`) |
| Cross-family review | reviewer agents pinned to `review.*Model` (e.g. GPT reviewing Claude) | `dev-harness review` shells out to the Copilot CLI with a GPT model; falls back to Claude subagents |
| Multi-repo graph | `feature-graph` dynamic workflow | same graph run by the `dev` skill with parallel subagents |
| Plan approval | plan mode / `exit_plan_mode` | plan mode |

**Tool approvals**: when the guard blocks something, the agent gets the reason and the fix (for example "use `gh-me …`" or
"rename the branch"). You won't get a permission prompt. You may want to pre-approve `dev-harness` and `gh-me` shell
commands in your tool's permission settings to avoid repeated prompts.

## Customizing

- **Instructions**: put personal preferences in `~/.dev-harness/local/instructions.md`, then re-run `./install.sh`.
- **Add a skill**: create `skills/<name>/SKILL.md` (front-matter `name` + `description`) and re-run `./install.sh`.
- **Change reviewer behaviour**: edit `agents/*.agent.md` (templates; `{{CODE_MODEL}}`/`{{SECURITY_MODEL}}` are filled from config).
- **Policy**: rules live in `lib/rules.mjs` and are unit-tested in `tests/rules.test.mjs`.
- Fork it. Nothing in the repo is specific to one person; personal data stays in `~/.dev-harness/`.

## Uninstall
```bash
./install.sh --uninstall
```
This removes the links and hooks, restores the backed-up originals (instructions, Claude settings, git credential
helper) and keeps `~/.dev-harness/` for you to delete.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Hooks don't fire | Restart the app/CLI (hooks load at startup). Check `~/.copilot/hooks/dev-harness.json` exists and that the `node` path inside it is still valid (nvm upgrades change it), then re-run `./install.sh`. |
| "would authenticate with the wrong GitHub account" | `dev-harness doctor --fix`. Some hosts rewrite `~/.gitconfig` on launch; the session-start hook re-applies the helper automatically. |
| `gh-me: no token for <account>` | `gh auth login` with that account, or set `github.tokenEnv`. |
| Need to commit without the gate (e.g. a quick personal repo) | `dev-harness unlock`, or add the repo to `shipGate.excludeRepos`. |
| Debug a hook | `echo '{"toolName":"bash","toolArgs":{"command":"git push"},"cwd":"'$PWD'"}' \| DEV_HARNESS_DEBUG=1 node hooks/guard.mjs` |
| `aem up` crashes in a git worktree (fsmonitor watch error) | `git fsmonitor--daemon stop && git config core.fsmonitor false` in that worktree. |

## Security notes

- The guard is a **guardrail**, not a sandbox. It stops mistakes, not a determined agent. The plan gate watches the
  file-edit tools; edits made through shell commands (e.g. `sed -i`) are not counted.
- Command `preToolUse` hooks in Copilot are fail-closed, so the guard catches every internal error and exits cleanly.
  A broken config can't lock you out of your tools.
- Tokens are never stored by the harness. The credential helper reads them at call time from the env var you name or
  from the gh keyring, answers only `https://github.com`, and never forwards its own token to other helpers
  (so it doesn't end up in your keychain or `~/.git-credentials`).
- Reviewers treat code under review as untrusted. They get a precomputed diff (`dev-harness diff`) and read-only
  tools only, with no shell, writes or network, so a prompt injection in a PR can't make them run anything.
- Claude Code hook entries are tagged with a `DEV_HARNESS_HOOK=1` prefix, so install/uninstall only ever touch their own entries.
- `dev-harness audit` (also the `.githooks/pre-commit` hook and CI) scans for secrets, personal absolute paths and the
  identifiers in your private `~/.dev-harness/local/denylist.txt`. Run it before publishing a fork.

## Development
```bash
npm test               # unit + hook integration + workflow tests
npm run test:install   # clean-room install/uninstall into a throwaway HOME
git config core.hooksPath .githooks   # enable the audit pre-commit hook
```

MIT licensed.
