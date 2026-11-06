---
name: ship
description: >
  Commit, push and open the pull request(s) once the user says "ship" or explicitly asks to commit/push/open a PR.
  Uses the configured GitHub account, validates the branch name, writes the commit message, PR description and
  reviewer testing plan, handles stacked/multi-repo PRs and follow-up pushes, and returns copy-paste-ready PR links
  plus a Slack-ready summary.
---

# ship — commit, push, PR

Only run when the user said "ship" or explicitly asked to commit / push / open or update a PR in this conversation.
The guard hook blocks `git commit`, `git push` and `gh pr create` until you unlock, and blocks wrong-account `gh`
writes, pushes to the default branch and badly named branches. If the guard denies something, fix the cause (don't work around it).

## Steps (per repo; for stacked/multi-repo work, go in dependency order)
1. **Preflight** — `dev-harness status`. If the review stage of the `dev` skill hasn't run on the current diff, run it
   first unless the user said to skip. If the branch name is invalid, `git branch -m $(dev-harness branch suggest "<change>")`.
2. **Unlock** — `dev-harness unlock` (time-boxed).
3. **Stage deliberately** — `git status --short`; stage only files that belong to the change. Never stage `.env*`,
   credentials, downloaded assets/screenshots, local scratch files, or lockfile churn the change didn't need.
4. **Commit** — imperative subject ≤ 72 chars (conventional prefix if the repo uses them: `fix:`, `feat:` …), blank line,
   2–5 bullets of what/why. Add any trailer your runtime requires.
5. **Push** — `git push -u origin <branch>`. The credential helper authenticates as the configured account. If the remote
   branch exists with unrelated history, stop and ask.
6. **PR** — `gh-me pr create --base <base> --head <branch> --title "<subject>" --body-file <tmpfile>`
   - `<base>`: default branch, or the parent branch for stacked PRs. Ready (not draft) unless the user asks for draft.
   - If a PR already exists for the branch, update it instead: `gh-me pr edit <n> --body-file <tmpfile>`.
   - Body template:
     ```
     ## Summary
     <1–2 sentences: what and why>
     ## Changes
     - <bullet per meaningful change>
     ## Testing plan for reviewers
     1. <exact steps / URLs / commands to verify, incl. branch preview URLs where the platform provides them>
     2. <expected result>
     ## Backward compatibility & risk
     <consumers checked; what stays unchanged>
     ## Review
     Independent code + security review: <verdicts>; open items: <none | list>
     <Related PRs: stacked/companion PR links>
     ```
7. **Lock** — `dev-harness lock`.
8. **Report** — output exactly:
   ```
   PRs:
   - <url>
   - <url>
   ```
   then a **Slack-ready summary** (3–6 plain bullets a teammate can read without context), then run `dev-harness handoff done`.

## Follow-up changes on a shipped branch
Same flow: unlock → commit → push → lock. If the change alters scope, also refresh the PR body with `gh-me pr edit`.

## Commit/PR text only
If the user only asks for a commit message or PR description ("give me a commit msg / PR description in MD"),
produce it in a fenced block for copy-paste and do not commit or push.
