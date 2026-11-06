---
name: handoff
description: >
  Write or resume a handoff document so work can pause and continue later, in another session, or in another tool
  (Copilot ↔ Claude Code). Use when the user says "pause", "write down where we are", "resume", "continue in another
  tool", or when a long multi-repo task reaches a natural checkpoint.
---

# handoff

Handoffs live outside the repo, in the local overlay, one per repo + branch (the `dev` skill also stores the approved plan
there). Always access them through the CLI so no extra file permissions are needed: `dev-harness handoff show`,
`dev-harness handoff write <<'EOF' … EOF`, `dev-harness handoff done`. Session start lists open handoffs automatically.

## Write
Replace the handoff (`dev-harness handoff write`) with the current truth (not a log of everything that happened):
```
# <Goal> — handoff
Updated: <date>   Status: planning | implementing | verifying | ready-to-ship | shipped | paused

## Goal & definition of done
## Decisions (mark user-directed ones with "(user)")
## Repos, branches, worktrees, local clone paths
| repo | branch | path | base | PR |
## Done
## In progress / next steps (ordered, concrete)
## Open questions for the user
## How to verify
## Plan (approved)
```
For multi-repo work write one handoff in the primary repo and reference it from the others.

## Resume
1. `dev-harness handoff show`. 2. Check reality in every listed repo: `git -C <path> status --short`, `git log --oneline -5`,
   PR state via `gh-me pr view`. 3. Tell the user in ≤5 bullets where things stand and what you'll do next; flag any drift
   between the doc and reality. 4. Continue with the `dev` workflow from the right stage.

When work is shipped, run `dev-harness handoff done` so it stops appearing at session start.
