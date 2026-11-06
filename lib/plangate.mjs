import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, rmSync, realpathSync,
} from 'node:fs';
import {
  dirname, isAbsolute, join, relative, resolve,
} from 'node:path';
import { gitDir } from './git.mjs';

export const EDIT_TOOLS = new Set([
  'edit', 'create', 'write', 'str_replace_editor', 'apply_patch', 'multi_edit',
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
]);

/** File paths an edit tool call would touch. */
export function editTargets(tool, args, cwd) {
  const out = [];
  const add = (p) => { if (typeof p === 'string' && p) out.push(isAbsolute(p) ? p : resolve(cwd, p)); };
  add(args?.path);
  add(args?.file_path);
  add(args?.notebook_path);
  const patch = typeof args?.input === 'string' ? args.input : typeof args?.patch === 'string' ? args.patch : '';
  for (const m of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) add(m[1].trim());
  return [...new Set(out)];
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
  } catch { return null; }
}

function existingDir(p) {
  let d = dirname(p);
  while (d !== dirname(d) && !existsSync(d)) d = dirname(d);
  return d;
}

/** Resolve symlinks (e.g. macOS /tmp → /private/tmp) on the existing part of a path that may not exist yet. */
export function canonical(p) {
  if (existsSync(p)) {
    try { return realpathSync(p); } catch { return p; }
  }
  const d = existingDir(p);
  try { return join(realpathSync(d), relative(d, p)); } catch { return p; }
}

/** Repo root, branch and the set of files already changed vs HEAD (incl. untracked), relative to root. */
export function repoState(file) {
  const dir = existingDir(file);
  const root = (git(dir, ['rev-parse', '--show-toplevel']) || '').trim();
  if (!root) return null;
  const branch = (git(root, ['symbolic-ref', '--short', 'HEAD']) || git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
  const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']) || '';
  const changed = new Set();
  const entries = status.split('\0');
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e) continue;
    changed.add(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i += 1;
  }
  return { root, branch, changed };
}

const approvalPath = (root) => {
  const gd = gitDir(root);
  return gd ? join(gd, 'dev-harness-plan-approved') : '';
};

export function isPlanApproved(root, branch) {
  const p = approvalPath(root);
  return Boolean(p && existsSync(p) && readFileSync(p, 'utf8').trim() === branch);
}

export function approvePlan(root, branch) {
  const p = approvalPath(root);
  if (!p) throw new Error(`${root} is not inside a git repository`);
  writeFileSync(p, branch);
  return p;
}

export function revokePlan(root) {
  const p = approvalPath(root);
  if (p && existsSync(p)) rmSync(p);
}

function isContract(rel, patterns) {
  return patterns.some((pat) => (pat.endsWith('/') ? rel.startsWith(pat) : rel === pat || rel.endsWith(`/${pat}`)));
}

/**
 * Pure decision. state: { root, branch, changed:Set, repo, planExists, approved }.
 * Returns null (allow) or a deny reason.
 */
export function planGateDecision(targets, state, cfg) {
  const gate = cfg.planGate;
  if (!gate.enabled || !state) return null;
  if (state.approved && state.planExists) return null;
  if ((gate.excludeRepos || []).map((r) => r.toLowerCase()).includes((state.repo || '').toLowerCase())) return null;
  const rels = targets.map((t) => relative(state.root, t)).filter((r) => r && !r.startsWith('..'));
  if (!rels.length) return null;
  const newFiles = rels.filter((r) => !state.changed.has(r));
  if (!newFiles.length) return null;
  const total = new Set([...state.changed, ...rels]).size;
  const contract = newFiles.find((r) => isContract(r, gate.contractFiles || []));
  if (total <= gate.maxUnplannedFiles && !contract) return null;
  const why = contract
    ? `"${contract}" is a contract/config file`
    : `this would make ${total} changed files (limit without an approved plan: ${gate.maxUnplannedFiles})`;
  const next = state.planExists
    ? 'A plan exists for this branch but is NOT approved. Present it (`dev-harness handoff show`) to the user, discuss, and STOP until they explicitly approve; only then run `dev-harness plan approve` and continue.'
    : 'Write the plan first with `dev-harness handoff write` (problem, approach, files, impact & back-compat, tests), present it to the user and STOP — even in autopilot. Only after the user explicitly approves, run `dev-harness plan approve` and continue.';
  return `Plan gate: ${why} on ${state.repo || state.root}@${state.branch}. ${next}`;
}
