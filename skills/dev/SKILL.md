---
name: dev
description: >
  Default workflow for ANY coding task (feature, bug fix, refactor, EDS block/styling work, backend/API change) in any
  repository. Triage → branch → plan (auto plan-first for anything non-trivial; stops for approval) → surgical local implementation →
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

If an open handoff exists for this repo/branch (`dev-harness handoff show`), read it first and continue from it.

## 1. Triage
`plan-first` if ANY: 3+ files · more than one repo · API/route/response/config/storage contract change · auth,
permissions, tokens, user input handling · data migration · ambiguous definition of done · user asked for a plan.
Otherwise `execute` — only for super-minor tweaks: ≤2 files, obvious, no contract/config files (copy, a CSS value, a
one-line bug fix). When in doubt, plan. **The mode you're running in (interactive, autopilot, plan) never changes this.**
The plan gate hook enforces it: edits beyond the minor-tweak limit are blocked until a plan exists AND the user approved it.

## 2. Branch (before planning)
- Never work on the default branch. Name: short, describes only the change, no usernames
  (`dev-harness branch suggest "<what changes>"`, validate with `dev-harness branch check <name>`). Per-repo rules
  (e.g. max length) come from config and are enforced by the guard hook.
- Create branches yourself with git: `dev-harness branch check <name> && git switch -c <name>`. Never use the app's
  branch tools (`rename_branch` etc.) — the guard denies them.
- In a worktree session the app may have pre-created a branch (session start flags it when it breaks the rules):
  create the compliant branch with `git switch -c <name>` before editing; uncommitted changes carry over.
- If the user named an existing branch, check it out and pull first; never silently create a second branch.

- Create the branch BEFORE writing the plan: the plan and its approval are recorded per branch. If you must change
  branch after approval, rewrite the plan there and get the user's approval again.

## 3. Plan (plan-first only)
- Investigate the code first (use subagents for broad exploration). Find existing helpers/patterns to reuse.
- Plan contents: problem, approach, files per repo, **Impact & back-compat** (every changed surface → its consumers →
  why they keep working), test strategy, evidence so far **with the input kinds it did not cover**, risks, open
  questions. Prefer the simplest design that meets the DoD.
- Ask focused questions only where a decision genuinely changes what you build (one question at a time, with options).
- Save the plan to the handoff with `dev-harness handoff write <<'EOF' … EOF` (it doubles as the resume document; read it
  back with `dev-harness handoff show`). Always go through the CLI — the file lives outside the workspace.
- Present the plan (summary in chat + `dev-harness handoff show`), then **STOP — in every mode, including autopilot.**
  Discuss and revise with the user. Never treat "work autonomously", silence, or an unavailable user as approval.
  In Copilot use `exit_plan_mode` when in plan mode; in autopilot end the turn with the plan and the question.
- Only after the user explicitly approves (e.g. "approved", "go ahead"): run `dev-harness plan approve`, then continue.
  If scope changes materially later, update the plan, run `dev-harness plan revoke`, and ask again.

## 4. Implement — local only
- Write code with the configured dev model (session context "Models", default Claude Opus 5.5). If this session runs on
  a different model, say so in one line at intake so the user can switch.
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

**Logic and algorithm changes** (diffs, merges, parsers, matching, sorting, data transforms): also run a quick
throwaway script (outside the repo) that runs the OLD and NEW code on many generated inputs and counts the cases that
were right before and are wrong now. Generate the awkward inputs on purpose: empty, only one side empty, different
counts or lengths on each side, changes at the first/last position. Do this for every behaviour change, including small
"edge case" tweaks added late. Report the result with its input limits ("3,000 cases, same section count, no empty
sections"), never as a bare "0 failures", and put any input kinds it did not cover in the plan / review prompt.

**Repo conventions self-check** (before review): re-read the repo's `AGENTS.md`, `CLAUDE.md` and
`.github/copilot-instructions.md` (repo root and any nested ones next to changed files). For each written rule that
applies to the diff (e.g. "avoid `let`", "destructured params", "no comments that restate code"), confirm the new code
follows it or fix it. Nearby code breaking a rule is not a reason to break it too.

## 6. Independent review (always — every change)
Reviewers get fresh context and no shell: first run `dev-harness diff` (prints the path of a diff file covering
committed + uncommitted + untracked changes vs the merge-base), then give each reviewer ONLY the repo path, that diff
path, the approved plan text (paste the output of `dev-harness handoff show`), the repo profile text, the paths of the
repo convention files that apply, the merge-base SHA, and what your evidence did and did not cover. Never paste your
own reasoning or conversation. Run both in parallel:

- **Copilot**: launch two background `task` subagents with `agent_type: "code-reviewer"` and
  `agent_type: "security-reviewer"`. They are pinned to the configured review models (GPT family, e.g. gpt-6.1-sol)
  while code is written with the dev model (Claude Opus) — see "Models" in the session context. Don't override them
  unless you are yourself running on the review model's family, then pass a `model` from the other family.
- **Claude Code**: if the `copilot` CLI exists, run in parallel (background) `dev-harness review --kind code --plan "$(dev-harness handoff path)"`
  and `dev-harness review --kind security --plan "$(dev-harness handoff path)"` (GPT-family, read-only, plan inlined). Otherwise use the
  `code-reviewer` / `security-reviewer` subagents.

Prompt for each reviewer: "Review the change in <diff path> for the repository at <repo path>. Approved plan: <plan text>.
Repo profile: <profile text>. Repo conventions: <paths of the AGENTS.md / CLAUDE.md / copilot-instructions files that
apply>. Base ref: <merge-base sha>. Evidence so far and what it did NOT cover: <one line each>.
Follow your output format." Re-run `dev-harness diff` before every review round.

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
Update the handoff (`dev-harness handoff write`) with the final state. Then wait. When the user says "ship" (or explicitly asks to
commit/push/open a PR), use the `ship` skill.

## Learning
Whenever the user corrects you or restates a preference, record it right away with the `lessons` skill so it never
needs repeating.
