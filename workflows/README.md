# Workflows

## feature-graph (multi-repo / large features)

Use when an approved plan spans more than one repository or several independent parts. The `dev` skill still owns
intake, planning and approval. This graph handles the fan-out:

```
            ┌─ implement+verify repo A ─┐      ┌─ code review A ─┐
plan ──►    ├─ implement+verify repo B ─┤ ──►  ├─ security A ────┤ ──► fix loop (≤ maxFixRounds, failing repos only)
            └─ …                        ┘      └─ … per repo     ┘          │
                                                                            ▼
                                       cross-repo contract check ──► summary → ready-to-ship (you say "ship")
```

Nothing is committed or pushed. Reviewers are the `code-reviewer` / `security-reviewer` agents, pinned to a
different model family than the author (`authorFamily`).

### Running it in the GitHub Copilot app
Dynamic workflows are session-scoped, so register the graph in the session that needs it. Ask the agent:

> Register the dev-harness feature-graph workflow from `<harness>/workflows` and run it for this plan.

The agent reads `feature-graph.meta.json` (meta) and `feature-graph.run.js` (the `run` function expression), calls
`dynamic_workflows_manage` with `operation: "author"`, then `run_dynamic_workflow` with args such as:
```json
{
  "goal": "Schedule-delete for pages and snapshots",
  "planPath": "/path/to/handoff.md",
  "authorFamily": "claude",
  "repos": [
    { "path": "/path/to/scheduler", "repo": "owner/scheduler", "branch": "del-route" },
    { "path": "/path/to/app", "repo": "owner/app", "branch": "deltask" }
  ]
}
```
Each run spawns about `2 × repos` implementation/review subagents per round, plus fixers and one contract checker.
Set `limits` only if you have a budget in mind.

### Claude Code
Claude Code has no dynamic-workflow runtime. The `dev` skill runs the same graph by hand: one background subagent per
repo for implement+verify, then `dev-harness review --kind code|security` per repo in parallel, then the fix loop and a
contract-check subagent.
