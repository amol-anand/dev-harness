#!/usr/bin/env node
// preToolUse guard for Copilot (camelCase payload) and Claude Code (PreToolUse payload).
// Must never crash: Copilot treats a failing command preToolUse hook as "deny".
import { homedir } from 'node:os';
import { loadConfig } from '../lib/config.mjs';
import { evaluateCommand } from '../lib/rules.mjs';
import { makeGitInfo, repoSlug } from '../lib/git.mjs';
import {
  EDIT_TOOLS, editTargets, canonical, repoState, isPlanApproved, planGateDecision,
} from '../lib/plangate.mjs';
import { handoffPathFor } from '../lib/context.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SHELL_TOOLS = new Set(['bash', 'Bash', 'shell', 'run_in_terminal']);
const APP_BRANCH_TOOLS = new Set(['rename_branch']);
const APP_BRANCH_REASON = 'Do not use the app\'s branch tools. Create the branch yourself: '
  + 'dev-harness branch check <name> && git switch -c <name>.';

function readStdin() {
  return new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', () => res(data));
  });
}

function extract(payload) {
  const claude = 'hook_event_name' in payload || 'tool_input' in payload;
  const tool = payload.toolName ?? payload.tool_name;
  let args = payload.toolArgs ?? payload.tool_input;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = { command: args }; }
  }
  return {
    claude, tool, args, command: args?.command, cwd: payload.cwd || process.cwd(),
  };
}

function emit(claude, decision, reason) {
  if (decision !== 'deny') return;
  const out = claude
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
    : { permissionDecision: 'deny', permissionDecisionReason: reason };
  process.stdout.write(JSON.stringify(out));
}

function checkPlanGate(tool, args, cwd) {
  const cfg = loadConfig();
  if (!cfg.planGate.enabled) return null;
  const groups = new Map();
  for (const t of editTargets(tool, args, cwd).map(canonical)) {
    const st = repoState(t);
    if (!st) continue;
    if (!groups.has(st.root)) groups.set(st.root, { st, targets: [] });
    groups.get(st.root).targets.push(t);
  }
  for (const { st, targets } of groups.values()) {
    let remote = '';
    try { remote = execFileSync('git', ['-C', st.root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }); } catch { /* none */ }
    const repo = repoSlug(remote.trim());
    if (!repo) continue;
    const hp = handoffPathFor(cfg, repo, st.branch);
    const planExists = existsSync(hp) && readFileSync(hp, 'utf8').trim().length > 0;
    const reason = planGateDecision(targets, {
      ...st, repo, planExists, approved: isPlanApproved(st.root, st.branch),
    }, cfg);
    if (reason) return reason;
  }
  return null;
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;
  const {
    claude, tool, args, command, cwd,
  } = extract(JSON.parse(raw));
  if (APP_BRANCH_TOOLS.has(tool)) {
    emit(claude, 'deny', `[dev-harness] ${APP_BRANCH_REASON}`);
    return;
  }
  if (EDIT_TOOLS.has(tool)) {
    const reason = checkPlanGate(tool, args, cwd);
    if (reason) emit(claude, 'deny', `[dev-harness] ${reason}`);
    return;
  }
  if (!SHELL_TOOLS.has(tool) || typeof command !== 'string') return;
  if (!/\bgit\b|\bgh\b|gh-me/.test(command)) return;
  const res = evaluateCommand(command, {
    cfg: loadConfig(),
    env: process.env,
    cwd,
    home: process.env.HOME || homedir(),
    gitInfo: makeGitInfo(),
  });
  emit(claude, res.decision, `[dev-harness] ${res.reason || ''}`);
}

main().catch((err) => {
  if (process.env.DEV_HARNESS_DEBUG) process.stderr.write(`dev-harness guard error: ${err.stack}\n`);
}).finally(() => process.exit(0));
