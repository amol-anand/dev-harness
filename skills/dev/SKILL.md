---
name: dev
description: >
  Default workflow for ANY coding task (feature, bug fix, refactor, EDS block/styling work, backend/API change) in any
  repository. Triage → plan (auto plan-first for anything non-trivial) → branch → surgical local implementation →
  verify → independent fresh-context code review + security review on a different model family → bounded fix loop →
  ready-to-ship summary, then STOP until the user says "ship". Use this instead of ad-hoc coding.
---

# dev — plan → build → verify → independent review → ready to ship

You are running the user's standard development workflow. Follow the stages in order. Keep the user informed with
one-line updates at each stage transition so they never need to ask "still working?".

Helper CLI: `dev-harness` (run `dev-harness help`). Session start already injected the repo profile, lessons and
open handoffs — re-read them with `dev-harness context` if they are not in your context.

## 0. Intake (always)
Write a 4-line brief before touching code:
- **Goal + definition of done** (observable conditions, e.g. "existing customers unaffected", "tests pass", "no visual change on desktop")
- **Repos / files** expected to change (explore first if unknown)
- **Constraints** (what must not change, patterns to match, out of scope)
- **Mode**: `plan-first` or `execute` (see triage)

If an open handoff exists for this repo/branch, read it first and continue from it.

## 1. Triage
`plan-first` if ANY: 3+ files · more than one repo · API/route/response/config/storage contract change · auth,
permissions, tokens, user input handling · data migration · ambiguous definition of done · user asked for a plan.
Otherwise `execute` (small, obvious, ≤2 files). When in doubt, plan.

## 2. Plan (plan-first only)
- Investigate the code first (use subagents for broad exploration). Find existing helpers/patterns to reuse.
- Plan contents: problem, approach, files per repo, **Impact & back-compat** (every changed surface → its consumers →
  why they keep working), test strategy, risks, open questions. Prefer the simplest design that meets the DoD.
- Ask focused questions only where a decision genuinely changes what you build (one question at a time, with options).
- Save the plan to the handoff file: `dev-harness handoff path` (it doubles as the resume document).
- Get approval (plan mode / exit_plan_mode in Copilot; plan mode in Claude Code). Do not write code before approval.

## 3. Branch
- Never work on the default branch. Name: short, describes only the change, no usernames
  (`dev-harness branch suggest "<what changes>"`, validate with `dev-harness branch check <name>`). Per-repo rules
  (e.g. max length) come from config and are enforced by the guard hook.
- In a worktree session the tool may have pre-created a random branch: rename it now with `git branch -m <name>`.
- If the user named an existing branch, check it out and pull first; never silently create a second branch.

## 4. Implement — local only
- Surgical: touch only what the plan needs; no drive-by refactors; reuse existing helpers; no new dependencies
  unless the plan says so. Match the repo's style and test patterns (don't introduce new mocking libs or timeouts).
- No comments that restate code. Comment only a non-obvious *why*.
- Do NOT commit, push or open PRs — the ship gate blocks it anyway. Changes stay in the working tree for the user to see.
- For EDS work, also follow `content-driven-development` / `building-blocks` skills if available.
- Multi-repo / large features: consider the `feature-graph` workflow (see `workflows/README.md` in the harness repo).

## 5. Verify
Run the profile's verify recipe. At minimum: lint, existing tests + tests for new behaviour, and an actual run of the
changed path (local server, curl the route, load the page). For EDS: start the dev server, load the changed pages,
check console errors and mobile/desktop layout; compare with the reference page when replicating a design.
Record exact commands and results. If something can't be verified locally, say exactly what and why.
If you need the user to approve a permission or start something, say precisely what and why in one line.

## 6. Independent review (always — every change)
Reviewers get fresh context and no shell: first run `dev-harness diff` (prints the path of a diff file covering
committed + uncommitted + untracked changes vs the merge-base), then give each reviewer ONLY the repo path, that diff
path, the handoff/plan path and the profile path. Never paste your reasoning or conversation. Run both in parallel:

- **Copilot**: launch two background `task` subagents with `agent_type: "code-reviewer"` and
  `agent_type: "security-reviewer"`. Their pinned models are from a different family than the default author model.
  If you yourself are running on that same family, pass a `model` override from the other family
  (Claude author → GPT reviewer; GPT/other author → Claude reviewer).
- **Claude Code**: if the `copilot` CLI exists, run in parallel (background) `dev-harness review --kind code --plan <handoff>`
  and `dev-harness review --kind security --plan <handoff>` (GPT-family, read-only). Otherwise use the
  `code-reviewer` / `security-reviewer` subagents.

Prompt for each reviewer: "Review the change in <diff path> for the repository at <repo path>. Intent/plan: <handoff path>.
Repo profile: <profile path>. Follow your output format." Re-run `dev-harness diff` before every review round.

## 7. Fix loop (max `review.maxFixRounds`, default 2)
- Fix CRITICAL/HIGH, and MEDIUM where you agree. Re-verify. Re-run only the reviewer(s) that had findings.
- If you disagree with a finding, don't fix it — note it with a one-line rationale for the user.
- Stop after the round limit; unresolved items go into the summary.

## 8. Ready-to-ship summary — then STOP
```
## Ready to ship — <owner/repo> @ <branch>
**What & why:** 3–6 bullets
**Verified:** commands run → results; manual checks; anything not verified
**Review:** code <verdict> · security <verdict> · fixed: … · open/disputed: …
**Back-compat:** consumers checked and why they keep working
Say **ship** to commit, push as <account> and open the PR (or tell me what to change).
```
Update the handoff file with the final state. Then wait. When the user says "ship" (or explicitly asks to
commit/push/open a PR), use the `ship` skill.

## Learning
Whenever the user corrects you or restates a preference, record it right away with the `lessons` skill so it never
needs repeating.
