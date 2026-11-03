---
name: lessons
description: >
  Capture a correction or restated preference from the user as a durable rule so it never needs repeating. Use
  immediately whenever the user corrects you ("don't…", "I told you…", "always…", "remove that comment", "use my X
  account") or asks to "save this as a rule".
---

# lessons

1. **Distil** the correction into one imperative, testable rule (≤ 25 words), e.g.
   "Reuse the existing audit-log helpers in the shared support library instead of re-implementing them."
2. **Scope it**:
   - Repo-specific (code patterns, test conventions, related repos, consumers) → `dev-harness lesson add "<rule>"` from the repo.
   - Applies everywhere (communication style, workflow, simplicity) → `dev-harness lesson add "<rule>" --global`.
   - Enforceable mechanically (branch naming, account, protected branches, ship gate) → propose a change to
     `~/.dev-harness/config.json` instead; the guard hook enforces config, prose doesn't.
   - Repo facts (commands, local clone paths, consumers to keep compatible) → add to the repo profile's Notes section
     (`~/.dev-harness/local/profiles/<owner>__<repo>.md`).
3. Apply the rule to the current work right away, and confirm in one line what you recorded and where.

Lessons are injected at every session start. Keep them short; if a file grows past ~40 rules, consolidate duplicates.
