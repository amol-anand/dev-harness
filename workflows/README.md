# Workflows

## feature-graph (multi-repo / large features)

Use when an approved plan spans more than one repository or several independent parts. The `dev` skill still owns
intake, planning and approval. This graph handles the fan-out:

```
            ┌─ implement+verify repo A ─┐      ┌─ code review A ─┐
plan ──►    ├─ implement+verify repo B ─┤ ──►  ├─ security A ────┤ ──► review rounds (fix → re-review, alternating models)
            └─ …                        ┘      └─ … per repo     ┘          │
                                                                            ▼
                                       cross-repo contract check ──► summary → ready-to-ship (you say "ship")
```

Nothing is committed or pushed. Reviewers are the `code-reviewer` / `security-reviewer` agents. Round 1 uses
`reviewModel`, a different model family from the author (`authorFamily`); later rounds alternate with `altModel`, each
in a fresh context. A repo is done once both reviewers have `cleanRoundsToStop` (default 2) rounds in a row with no
findings at all; the fixer addresses every finding, LOWs and nits included. `maxRounds` (default 10) caps the loop;
both must be positive integers (`maxFixRounds` is rejected). A repo that stops for any other reason has
`reviewStoppedBy` set: `maxRounds` ran out, a reviewer failed, or a fixer failed (it may have left unreviewed edits).
`openFindings` lists what is still open (after a failure, from the last real review) and `disputedFindings` what the
fixer disagreed with (severity, location, issue, reason, round). If any repo stopped, has disputes, or the contract
check failed (`contractError`) or is not clean, `next` tells the agent to list everything by severity and ask whether to run more rounds.

### Running it in the GitHub Copilot app
Dynamic workflows are session-scoped, so register the graph in the session that needs it. Ask the agent:

> Register the dev-harness feature-graph workflow from `<harness>/workflows` and run it for this plan.

The agent reads `feature-graph.meta.json` (meta) and `feature-graph.run.js` (the `run` function expression), calls
`dynamic_workflows_manage` with `operation: "author"`, then `run_dynamic_workflow` with args such as:
```json
{
  "goal": "Schedule-delete for pages and snapshots",
  "plan": "<output of dev-harness handoff show>",
  "authorFamily": "claude",
  "reviewModel": "gpt-6.1-sol",
  "altModel": "claude-opus-5.5",
  "maxRounds": 10,
  "cleanRoundsToStop": 2,
  "repos": [
    { "path": "/path/to/scheduler", "repo": "owner/scheduler", "branch": "del-route" },
    { "path": "/path/to/app", "repo": "owner/app", "branch": "deltask" }
  ]
}
```
Take the review values from the "Models" line in the session context (`~/.dev-harness/config.json`). If the author is
GPT (`authorFamily: "gpt"`), swap `reviewModel` and `altModel` so round 1 runs on Claude.
Each run spawns about `2 × repos` review subagents per round (at least `cleanRoundsToStop` rounds, default 2), plus implementers, fixers and one contract checker.
Set `limits` only if you have a budget in mind.

### Claude Code
Claude Code has no dynamic-workflow runtime. The `dev` skill runs the same graph by hand: one background subagent per
repo for implement+verify, then the review rounds with `dev-harness review --kind code|security --model <round model>`
per repo in parallel, then a contract-check subagent once every repo has converged.
