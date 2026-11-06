import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateBranch } from './rules.mjs';

export function slugFile(repo) {
  return repo.replace('/', '__');
}

export function localPaths(cfg) {
  const base = cfg.localDir;
  return {
    base,
    instructions: join(base, 'instructions.md'),
    profiles: join(base, 'profiles'),
    lessons: join(base, 'lessons'),
    handoffs: join(base, 'handoffs'),
    denylist: join(base, 'denylist.txt'),
  };
}

function read(p, max) {
  if (!existsSync(p)) return '';
  const s = readFileSync(p, 'utf8').trim();
  return s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s;
}

export function profileFor(cfg, repo) {
  if (!repo) return '';
  return read(join(localPaths(cfg).profiles, `${slugFile(repo)}.md`), 6000);
}

export function lessonsFor(cfg, repo) {
  const { lessons } = localPaths(cfg);
  return {
    global: read(join(lessons, 'global.md'), 3000),
    repo: repo ? read(join(lessons, `${slugFile(repo)}.md`), 3000) : '',
  };
}

export function handoffPathFor(cfg, repo, branch) {
  return join(localPaths(cfg).handoffs, slugFile(repo), `${(branch || 'detached').replace(/\//g, '__')}.md`);
}

export function handoffsFor(cfg, repo) {
  if (!repo) return [];
  const dir = join(localPaths(cfg).handoffs, slugFile(repo));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f))
    .filter((f) => !/Status: shipped/.test(readFileSync(f, 'utf8')));
}

export function branchNotice(cfg, info) {
  if (!info.repo || !info.branch || info.branch === 'HEAD') return '';
  const problem = validateBranch(info.branch, cfg, info.repo);
  if (!problem) return '';
  return `## Branch\n${problem} It was pre-created by the app, not by you. Before editing any files, create a compliant `
    + 'branch yourself: `dev-harness branch check <name> && git switch -c <name>` (use the user\'s name if they give one). '
    + 'Never use the app\'s branch tools (rename_branch etc.); the guard denies them.';
}

export function buildSessionContext(cfg, info) {
  const parts = [];
  const head = ['# dev-harness context'];
  if (info.repo) head.push(`Repo: ${info.repo} (branch: ${info.branch || 'unknown'})`);
  if (cfg.github.account) head.push(`GitHub account for all git/gh activity: ${cfg.github.account} (use \`gh-me\` for gh commands).`);
  head.push(`Ship gate: ${cfg.shipGate.enabled ? 'ON — changes stay local until the user says "ship" or explicitly asks to commit/push/open a PR in this conversation; then use the `ship` skill (it unlocks the gate). Never unlock on your own initiative.' : 'off'}`);
  head.push('Workflow: use the `dev` skill for any coding task (plan → implement → verify → fresh-context code + security review → ready-to-ship).');
  head.push(`Models: write code with ${cfg.dev.model}; independent reviews with ${cfg.review.codeModel} (code) / ${cfg.review.securityModel} (security).`);
  if (cfg.planGate.enabled) {
    head.push(`Plan gate: ON — anything beyond a minor tweak (> ${cfg.planGate.maxUnplannedFiles} files, or contract/config files) needs a written plan that the user explicitly approved, in EVERY mode including autopilot. Write it with \`dev-harness handoff write\`, present it, STOP and discuss; after explicit approval run \`dev-harness plan approve\`. File edits past the limit are blocked until then.`);
  }
  parts.push(head.join('\n'));
  const notice = branchNotice(cfg, info);
  if (notice) parts.push(notice);
  const profile = profileFor(cfg, info.repo);
  if (profile) parts.push(`## Repo profile\n${profile}`);
  const lessons = lessonsFor(cfg, info.repo);
  if (lessons.repo) parts.push(`## Lessons for this repo\n${lessons.repo}`);
  if (lessons.global) parts.push(`## Global lessons\n${lessons.global}`);
  const handoffs = handoffsFor(cfg, info.repo);
  if (handoffs.length) parts.push(`## Open handoffs (read with \`dev-harness handoff show\` from the matching branch before resuming)\n${handoffs.map((h) => `- ${h}`).join('\n')}`);
  return parts.join('\n\n');
}
