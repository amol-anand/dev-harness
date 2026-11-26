#!/usr/bin/env node
// preToolUse guard for Copilot (camelCase payload) and Claude Code (PreToolUse payload).
// Must never crash: Copilot treats a failing command preToolUse hook as "deny".
import { homedir } from 'node:os';
import { loadConfig } from '../lib/config.mjs';
import { evaluateCommand, validateBranch } from '../lib/rules.mjs';
import { makeGitInfo, repoSlug } from '../lib/git.mjs';
import {
  EDIT_TOOLS, editTargets, canonical, repoState, isPlanApproved, planGateDecision,
} from '../lib/plangate.mjs';
import { handoffPathFor } from '../lib/context.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SHELL_TOOLS = new Set(['bash', 'Bash', 'shell', 'run_in_terminal']);
const RENAME_TOOL = 'rename_branch';
const BRANCH_HINT = 'Pick a name from the task with `dev-harness branch suggest "<what changes>"`.';

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

function originSlug(dir) {
  try {
    return repoSlug(execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim());
  } catch { return ''; }
}

function checkRename(args, cwd) {
  const name = args?.name;
  if (typeof name !== 'string' || !name) return `rename_branch needs a branch name. ${BRANCH_HINT}`;
  const cfg = loadConfig();
  if (cfg.git.protectedBranches.includes(name)) return `Refusing to rename the branch to protected branch "${name}". ${BRANCH_HINT}`;
  return validateBranch(name, cfg, originSlug(cwd));
}

function branchProblem(branch, repo, cfg, root) {
  if (!branch || branch === 'HEAD') return null;
  const fix = 'Before editing, rename it (app worktree: rename_branch; otherwise: git switch -c <name>). '
    + `${BRANCH_HINT} Plan approval does not carry over to the new branch.`;
  const label = repo || `repository ${root}`;
  if (cfg.git.protectedBranches.includes(branch)) return `Editing files on protected branch "${branch}" of ${label}. ${fix}`;
  const problem = validateBranch(branch, cfg, repo);
  if (!problem) return null;
  return repo ? `${problem} ${fix}` : `${problem} (${label}) ${fix}`;
}

function checkEdit(tool, args, cwd) {
  const cfg = loadConfig();
  const groups = new Map();
  // A symlink belongs to the repo it sits in, while edits through it land in its destination: check both
  // repos' branches, but only the destination counts toward the plan gate.
  const paths = editTargets(tool, args, cwd);
  const targets = new Set(paths.map(canonical));
  const links = paths.map((p) => join(canonical(dirname(p)), basename(p)));
  for (const t of new Set([...targets, ...links])) {
    const st = repoState(t);
    if (!st) continue;
    if (!groups.has(st.root)) groups.set(st.root, { st, targets: [] });
    if (targets.has(t)) groups.get(st.root).targets.push(t);
  }
  for (const { st, targets: gated } of groups.values()) {
    const repo = originSlug(st.root);
    const bad = branchProblem(st.branch, repo, cfg, st.root);
    if (bad) return bad;
    if (!repo || !gated.length || !cfg.planGate.enabled) continue;
    const hp = handoffPathFor(cfg, repo, st.branch);
    const planExists = existsSync(hp) && readFileSync(hp, 'utf8').trim().length > 0;
    const reason = planGateDecision(gated, {
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
  if (tool === RENAME_TOOL) {
    const reason = checkRename(args, cwd);
    if (reason) emit(claude, 'deny', `[dev-harness] ${reason}`);
    return;
  }
  const readOnly = tool === 'str_replace_editor' && args?.command === 'view';
  if (EDIT_TOOLS.has(tool) && !readOnly) {
    const reason = checkEdit(tool, args, cwd);
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
