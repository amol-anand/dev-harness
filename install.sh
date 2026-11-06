#!/usr/bin/env bash
# dev-harness installer — idempotent. Links skills, agents, hooks, instructions and CLI tools into
# GitHub Copilot (~/.copilot) and Claude Code (~/.claude). Anything replaced is backed up first.
#
#   ./install.sh                 install / update
#   ./install.sh --dry-run       show what would change
#   ./install.sh --uninstall     remove everything and restore backups
#   ./install.sh --no-claude | --no-copilot | --no-instructions | --no-credential-helper
set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DH_HOME="${DEV_HARNESS_HOME:-$HOME/.dev-harness}"
COPILOT_DIR="${COPILOT_HOME:-$HOME/.copilot}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
BIN_DIR="${DEV_HARNESS_BIN:-$HOME/.local/bin}"
MANIFEST="$DH_HOME/install-manifest.txt"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$DH_HOME/backups/$STAMP"

DRY=0; UNINSTALL=0; DO_CLAUDE=1; DO_COPILOT=1; DO_INSTR=1; DO_CRED=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --no-claude) DO_CLAUDE=0 ;;
    --no-copilot) DO_COPILOT=0 ;;
    --no-instructions) DO_INSTR=0 ;;
    --no-credential-helper) DO_CRED=0 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  [dry-run] $*"; else "$@"; fi; }

# ---------- prerequisites ----------
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { say "✗ node not found (need Node.js >= 20)"; exit 1; }
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { say "✗ Node.js >= 20 required (found $("$NODE" -v))"; exit 1; }
command -v git >/dev/null || { say "✗ git not found"; exit 1; }
command -v gh >/dev/null || say "! gh CLI not found — gh-me and PR creation need it (https://cli.github.com)"

HELP="$NODE $HARNESS/scripts/install-helpers.mjs"

backup() { # backup <path> if it exists and is not already a symlink into the harness
  local p="$1"
  if [ -e "$p" ] || [ -L "$p" ]; then
    local target; target="$(readlink "$p" 2>/dev/null || true)"
    case "$target" in "$HARNESS"*|"$DH_HOME"*) return 0 ;; esac
    run mkdir -p "$BACKUP_DIR$(dirname "$p")"
    run mv "$p" "$BACKUP_DIR$p"
    say "  backed up $p → $BACKUP_DIR$p"
  fi
}

record() { [ "$DRY" = 1 ] || echo "$1" >> "$MANIFEST.new"; }

link() { # link <target> <linkpath> [--if-free]
  local target="$1" lp="$2" mode="${3:-}"
  local cur; cur="$(readlink "$lp" 2>/dev/null || true)"
  if [ "$cur" = "$target" ]; then record "$lp"; return 0; fi
  if [ "$mode" = "--if-free" ] && { [ -e "$lp" ] || [ -L "$lp" ]; } && [[ "$cur" != "$HARNESS"* && "$cur" != "$DH_HOME"* ]]; then
    say "  ! skipped $lp (already exists and is not managed by dev-harness)"
    return 0
  fi
  [ "$mode" = "--if-free" ] && [[ "$cur" == "$HARNESS"* || "$cur" == "$DH_HOME"* ]] && run rm "$lp"
  [ "$mode" = "--if-free" ] || backup "$lp"
  run mkdir -p "$(dirname "$lp")"
  run ln -sfn "$target" "$lp"
  say "  linked $lp → $target"
  record "$lp"
}

# ---------- uninstall ----------
if [ "$UNINSTALL" = 1 ]; then
  say "Uninstalling dev-harness"
  if [ -f "$MANIFEST" ]; then
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      t="$(readlink "$p" 2>/dev/null || true)"
      if [[ "$t" == "$HARNESS"* || "$t" == "$DH_HOME"* ]] || [[ "$p" == *"/hooks/dev-harness.json" ]]; then run rm -f "$p"; say "  removed $p"; fi
    done < "$MANIFEST"
  fi
  [ -f "$CLAUDE_DIR/settings.json" ] && run $HELP claude-hooks "$CLAUDE_DIR/settings.json" remove "$NODE" && say "  removed Claude Code hooks"
  for s in "$COPILOT_DIR/settings.json" "$CLAUDE_DIR/settings.json"; do run $HELP restore-model "$s"; done
  if [ "$DO_CRED" = 1 ] && git config --global --get-all credential.https://github.com.helper 2>/dev/null | grep -q git-credential-dev-harness; then
    run "$NODE" -e "import('$HARNESS/lib/credential.mjs').then(m=>m.uninstallCredentialHelper())"
    say "  restored previous git credential helpers"
  fi
  # restore the oldest backup of each file (the pre-harness original); older dirs first, never overwrite
  if [ -d "$DH_HOME/backups" ]; then
    for d in $(ls -1 "$DH_HOME/backups" | grep -E "^[0-9]{8}-" | sort); do
      (cd "$DH_HOME/backups/$d" && find . -mindepth 1 \( -type f -o -type l \) -print) | while IFS= read -r rel; do
        orig="/${rel#./}"
        if [ ! -e "$orig" ] && [ ! -L "$orig" ]; then run mkdir -p "$(dirname "$orig")"; run cp -RP "$DH_HOME/backups/$d/$rel" "$orig"; say "  restored $orig"; fi
      done
    done
  fi
  run rm -f "$MANIFEST"
  say "Done. Config and local overlay kept in $DH_HOME (delete manually if you want)."
  exit 0
fi

say "Installing dev-harness from $HARNESS"
[ "$DRY" = 1 ] || { mkdir -p "$DH_HOME"; : > "$MANIFEST.new"; }

# ---------- config ----------
if [ ! -f "$DH_HOME/config.json" ]; then
  if [ "$DRY" = 1 ]; then say "  [dry-run] would create $DH_HOME/config.json via dev-harness init"
  elif [ -t 0 ]; then "$NODE" "$HARNESS/bin/dev-harness" init
  else
    "$NODE" "$HARNESS/bin/dev-harness" init --account "" >/dev/null
    say "  created default config at $DH_HOME/config.json (edit it or run: dev-harness init)"
  fi
fi

# ---------- CLI tools ----------
say "• CLI tools → $BIN_DIR"
for b in dev-harness gh-me git-credential-dev-harness; do link "$HARNESS/bin/$b" "$BIN_DIR/$b"; done
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "  ! $BIN_DIR is not on PATH — add: export PATH=\"$BIN_DIR:\$PATH\"" ;; esac

# ---------- generated files ----------
GEN="$DH_HOME/generated"
if [ "$DRY" = 0 ]; then
  rm -rf "$GEN/copilot-agents" "$GEN/claude-agents"
  $HELP render-agents "$GEN/copilot-agents" copilot >/dev/null
  $HELP render-agents "$GEN/claude-agents" claude >/dev/null
  $HELP compose-instructions "$GEN/instructions.md"
fi

# ---------- GitHub Copilot ----------
if [ "$DO_COPILOT" = 1 ]; then
  say "• GitHub Copilot → $COPILOT_DIR"
  for s in "$HARNESS"/skills/*/; do link "${s%/}" "$COPILOT_DIR/skills/$(basename "$s")" --if-free; done
  for a in "$HARNESS"/agents/*.agent.md; do n="$(basename "$a")"; link "$GEN/copilot-agents/$n" "$COPILOT_DIR/agents/$n" --if-free; done
  if [ "$DRY" = 0 ]; then mkdir -p "$COPILOT_DIR/hooks"; $HELP copilot-hooks "$COPILOT_DIR/hooks/dev-harness.json" "$NODE"; record "$COPILOT_DIR/hooks/dev-harness.json"; fi
  say "  hooks → $COPILOT_DIR/hooks/dev-harness.json"
  [ "$DO_INSTR" = 1 ] && link "$GEN/instructions.md" "$COPILOT_DIR/copilot-instructions.md"
  M="$($HELP dev-model copilot)"
  if [ -n "$M" ]; then run $HELP set-model "$COPILOT_DIR/settings.json" "$M"; say "  default model → $M"; fi
fi

# ---------- Claude Code ----------
if [ "$DO_CLAUDE" = 1 ] && { [ -d "$CLAUDE_DIR" ] || command -v claude >/dev/null; }; then
  say "• Claude Code → $CLAUDE_DIR"
  for s in "$HARNESS"/skills/*/; do link "${s%/}" "$CLAUDE_DIR/skills/$(basename "$s")" --if-free; done
  for a in "$HARNESS"/agents/*.agent.md; do n="$(basename "$a" .agent.md).md"; link "$GEN/claude-agents/$n" "$CLAUDE_DIR/agents/$n" --if-free; done
  if [ "$DRY" = 0 ]; then
    [ -f "$CLAUDE_DIR/settings.json" ] && [ ! -f "$DH_HOME/backups/claude-settings.original.json" ] && mkdir -p "$DH_HOME/backups" && cp "$CLAUDE_DIR/settings.json" "$DH_HOME/backups/claude-settings.original.json"
    $HELP claude-hooks "$CLAUDE_DIR/settings.json" add "$NODE"
  fi
  say "  hooks merged into $CLAUDE_DIR/settings.json"
  [ "$DO_INSTR" = 1 ] && link "$GEN/instructions.md" "$CLAUDE_DIR/CLAUDE.md"
  M="$($HELP dev-model claude)"
  if [ -n "$M" ]; then run $HELP set-model "$CLAUDE_DIR/settings.json" "$M"; say "  default model → $M"; fi
elif [ "$DO_CLAUDE" = 1 ]; then
  say "• Claude Code not detected — skipped"
fi

# ---------- identity ----------
if [ "$DO_CRED" = 1 ] && [ "$DRY" = 0 ] && [ -n "$("$NODE" -p "require('$DH_HOME/config.json').github?.account || ''" 2>/dev/null)" ]; then
  say "• git credential helper"
  "$NODE" "$HARNESS/bin/dev-harness" doctor --fix >/dev/null 2>&1 || true
fi

if [ "$DRY" = 0 ]; then mv "$MANIFEST.new" "$MANIFEST"; fi
say ""
say "Done. Run \`dev-harness doctor\` to verify, then restart Copilot / Claude Code so hooks load."
