#!/usr/bin/env bash
# Clean-room install test: installs into a throwaway HOME for a fictional user, verifies, re-installs
# (idempotency), exercises the installed hooks, then uninstalls and checks originals are restored.
set -euo pipefail
HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HOME; HOME="$(mktemp -d)"
export GIT_CONFIG_GLOBAL="$HOME/.gitconfig" GIT_CONFIG_NOSYSTEM=1
export PATH="$HOME/.local/bin:$PATH"
unset COPILOT_HOME CLAUDE_CONFIG_DIR DEV_HARNESS_HOME DEV_HARNESS_CONFIG GH_TOKEN || true
trap 'rm -rf "$HOME"' EXIT
fail() { echo "✗ $*"; exit 1; }
ok() { echo "✓ $*"; }

# Pre-existing user files that must be backed up and restored
mkdir -p "$HOME/.copilot" "$HOME/.claude/skills/review-pr"
echo "original copilot instructions" > "$HOME/.copilot/copilot-instructions.md"
echo "original claude md" > "$HOME/.claude/CLAUDE.md"
echo '{"theme":"dark","hooks":{"PreToolUse":[{"matcher":"Edit","hooks":[{"type":"command","command":"echo mine"}]}]}}' > "$HOME/.claude/settings.json"
echo "user's own skill" > "$HOME/.claude/skills/review-pr/SKILL.md"
FAKE="$HOME/fake-helper"
printf '#!/bin/sh\necho "$1 $(grep ^password= | cut -d= -f2)" >> "$HOME/fake-helper.log"\n[ "$1" = get ] && echo "username=keychain-user" && echo "password=from-keychain"\nexit 0\n' > "$FAKE"; chmod +x "$FAKE"
git config --global credential.https://github.com.helper "!$FAKE"
git config --global credential.https://github.com.username keepme
git config --global credential.helper "!$FAKE"

node "$HARNESS/bin/dev-harness" init --account octo-dev --forbid octo --rule acme/tiny:7 >/dev/null
bash "$HARNESS/install.sh" --dry-run >/dev/null || fail "dry-run exited non-zero"
[ -L "$HOME/.copilot/skills/dev" ] && fail "dry-run made changes"
ok "dry-run makes no changes"

bash "$HARNESS/install.sh" </dev/null >/dev/null
for p in .copilot/skills/dev .copilot/skills/ship .copilot/agents/code-reviewer.agent.md .claude/skills/dev .claude/agents/security-reviewer.md .local/bin/dev-harness .local/bin/gh-me; do
  [ -L "$HOME/$p" ] || fail "missing link $p"
done
ok "skills, agents and CLI linked for both runtimes"
grep -q "^model: gpt-" "$HOME/.copilot/agents/code-reviewer.agent.md" || fail "copilot agent model not rendered"
grep -q "^model: opus" "$HOME/.claude/agents/code-reviewer.md" || fail "claude agent model not rendered"
ok "agent models rendered per runtime"
[ "$(cat "$HOME/.claude/skills/review-pr/SKILL.md")" = "user's own skill" ] || fail "overwrote user's existing skill"
ok "existing unmanaged skill left untouched"
grep -q "Working agreement" "$HOME/.copilot/copilot-instructions.md" || fail "instructions not linked"
node -e 'const s=require(process.env.HOME+"/.claude/settings.json"); if(s.theme!=="dark"||s.hooks.PreToolUse.length!==2||!s.hooks.SessionStart) process.exit(1)' || fail "claude settings merge wrong"
node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.copilot/hooks/dev-harness.json","utf8"))' || fail "copilot hooks json invalid"
ok "hooks installed; existing Claude settings preserved"
CHAIN="$(git config --global --get-all credential.https://github.com.helper)"
[ "$(echo "$CHAIN" | grep -c .)" = 1 ] && echo "$CHAIN" | grep -q git-credential-dev-harness || fail "dev-harness helper should be the only github.com helper: $CHAIN"
node -e 'import(process.argv[1]).then(m=>process.exit(m.credHelperOk(process.env.HOME)?0:1))' "$HARNESS/lib/git.mjs" || fail "credHelperOk false although plain helper precedes the section"
[ "$(git config --global credential.https://github.com.username)" = keepme ] || fail "other github.com credential keys lost"
LR="$HOME/later-repo"; git init -q "$LR"; git -C "$LR" config credential.helper "!/usr/bin/later-helper"
node -e 'import(process.argv[1]).then(m=>process.exit(m.credHelperOk(process.argv[2])?1:0))' "$HARNESS/lib/git.mjs" "$LR" || fail "credHelperOk ignored a plain helper configured after ours"
grep -q fake-helper "$HOME/.dev-harness/credential-chain.json" || fail "previous chain not saved"
ok "credential helper is the only github.com helper; previous chain saved for delegation"
OUT="$(printf 'protocol=https\nhost=github.com\n\n' | DH_TEST_TOKEN=tok123 DEV_HARNESS_CONFIG=<(echo '{"github":{"account":"octo-dev","tokenEnv":"DH_TEST_TOKEN"}}') git-credential-dev-harness get)"
echo "$OUT" | grep -q "password=tok123" && echo "$OUT" | grep -q "username=octo-dev" || fail "helper did not answer github.com: $OUT"
OUT="$(printf 'protocol=https\nhost=evil.example\n\n' | DH_TEST_TOKEN=tok123 DEV_HARNESS_CONFIG=<(echo '{"github":{"account":"octo-dev","tokenEnv":"DH_TEST_TOKEN"}}') git-credential-dev-harness get)"
[ -z "$OUT" ] || fail "helper leaked token to another host"
OUT="$(printf 'protocol=http\nhost=github.com\n\n' | DH_TEST_TOKEN=tok123 DEV_HARNESS_CONFIG=<(echo '{"github":{"account":"octo-dev","tokenEnv":"DH_TEST_TOKEN"}}') git-credential-dev-harness get)"
[ -z "$OUT" ] || fail "helper answered plain http"
OUT="$(printf 'protocol=https\nhost=github.com\n\n' | DEV_HARNESS_CONFIG=<(echo '{"github":{"account":"octo-dev","tokenEnv":"DH_TEST_TOKEN"}}') PATH=/usr/bin:/bin "$(command -v node)" "$HARNESS/bin/git-credential-dev-harness" get)"
echo "$OUT" | grep -q "password=from-keychain" || fail "helper did not delegate to the previous chain: $OUT"
: > "$HOME/fake-helper.log"
printf 'protocol=https\nhost=github.com\nusername=octo-dev\npassword=tok123\n\n' | DH_TEST_TOKEN=tok123 DEV_HARNESS_CONFIG=<(echo '{"github":{"account":"octo-dev","tokenEnv":"DH_TEST_TOKEN"}}') git-credential-dev-harness store
printf 'protocol=https\nhost=github.com\nusername=octo-dev\npassword=tok123\n\n' | DH_TEST_TOKEN=tok123 DEV_HARNESS_CONFIG=<(echo '{"github":{"account":"octo-dev","tokenEnv":"DH_TEST_TOKEN"}}') git-credential-dev-harness erase
[ -s "$HOME/fake-helper.log" ] && fail "harness token was forwarded to other helpers: $(cat "$HOME/fake-helper.log")"
printf 'protocol=https\nhost=github.com\nusername=k\npassword=from-keychain\n\n' | DEV_HARNESS_CONFIG=<(echo '{}') git-credential-dev-harness store
grep -q "store from-keychain" "$HOME/fake-helper.log" || fail "non-harness credential not forwarded on store"
ok "helper answers only https://github.com, delegates without a token, never stores its own token elsewhere"

bash "$HARNESS/install.sh" </dev/null >/dev/null
[ "$(ls "$HOME/.dev-harness/backups" | grep -cE '^[0-9]{8}-')" -le 2 ] || fail "re-install created extra backups"
node -e 'const s=require(process.env.HOME+"/.claude/settings.json"); if(s.hooks.PreToolUse.length!==2) process.exit(1)' || fail "re-install duplicated hooks"
ok "re-install is idempotent"

# Exercise the installed Copilot hook command exactly as configured
REPO="$HOME/code/web"; mkdir -p "$REPO"; git -C "$REPO" init -q -b main
git -C "$REPO" remote add origin https://github.com/acme/web.git
HOOK_CMD="$(node -p 'require(process.env.HOME+"/.copilot/hooks/dev-harness.json").hooks.preToolUse[0].bash')"
OUT="$(echo "{\"toolName\":\"bash\",\"toolArgs\":{\"command\":\"git checkout -b octo-dev-thing\"},\"cwd\":\"$REPO\"}" | bash -c "$HOOK_CMD")"
echo "$OUT" | grep -q '"permissionDecision":"deny"' || fail "installed guard did not deny bad branch: $OUT"
OUT="$(echo "{\"toolName\":\"bash\",\"toolArgs\":{\"command\":\"git status\"},\"cwd\":\"$REPO\"}" | bash -c "$HOOK_CMD")"
[ -z "$OUT" ] || fail "installed guard blocked harmless command"
ok "installed guard hook works end to end"
dev-harness branch check navfixes >/dev/null || fail "branch check"; (cd "$REPO" && dev-harness status >/dev/null) || fail "CLI on PATH failed"
ok "CLI works from PATH"

bash "$HARNESS/install.sh" --uninstall </dev/null >/dev/null
[ "$(cat "$HOME/.copilot/copilot-instructions.md")" = "original copilot instructions" ] || fail "copilot instructions not restored"
[ "$(cat "$HOME/.claude/CLAUDE.md")" = "original claude md" ] || fail "CLAUDE.md not restored"
[ -e "$HOME/.copilot/skills/dev" ] && fail "skill link not removed"
node -e 'const s=require(process.env.HOME+"/.claude/settings.json"); if(s.theme!=="dark"||s.hooks.PreToolUse.length!==1||s.hooks.SessionStart) process.exit(1)' || fail "claude settings not cleaned"
[ "$(git config --global --get-all credential.https://github.com.helper)" = "!$FAKE" ] || fail "credential helpers not restored exactly"
[ "$(git config --global credential.https://github.com.username)" = keepme ] || fail "credential section not restored"
[ -e "$HOME/.dev-harness/credential-chain.json" ] && fail "credential chain not cleared"
[ -e "$HOME/.dev-harness/backups/credential-helpers.json" ] && fail "credential backup not cleared"
ok "uninstall restores originals"
# helpers changed between installs must not be clobbered by a stale backup
git config --global --replace-all credential.https://github.com.helper "!/usr/bin/new-helper"
bash "$HARNESS/install.sh" </dev/null >/dev/null && bash "$HARNESS/install.sh" --uninstall </dev/null >/dev/null
[ "$(git config --global --get-all credential.https://github.com.helper)" = "!/usr/bin/new-helper" ] || fail "stale credential backup restored"
# Claude hooks are recognised even if the harness is cloned under another directory name
node "$HARNESS/scripts/install-helpers.mjs" claude-hooks "$HOME/s.json" add /usr/bin/node
node -e 'const f=process.env.HOME+"/s.json",s=require(f);s.hooks.PreToolUse[0].hooks[0].command="DEV_HARNESS_HOOK=1 \"/usr/bin/node\" \"/elsewhere/harness/hooks/guard.mjs\"";s.hooks.PreToolUse.push({matcher:"Bash",hooks:[{type:"command",command:"\"node\" \"/other-tool/hooks/guard.mjs\""}]});require("fs").writeFileSync(f,JSON.stringify(s))'
node "$HARNESS/scripts/install-helpers.mjs" claude-hooks "$HOME/s.json" add /usr/bin/node
node -e 'const s=require(process.env.HOME+"/s.json"); const c=s.hooks.PreToolUse.map(e=>e.hooks[0].command); if(c.length!==2||!c.some(x=>x.includes("other-tool"))) process.exit(1)' || fail "moved-clone hooks duplicated or unrelated hook removed"
ok "reinstall after helper change and moved clone behave correctly"
echo "ALL CLEAN-ROOM CHECKS PASSED"
