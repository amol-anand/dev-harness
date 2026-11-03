import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

export function handoffsFor(cfg, repo) {
  if (!repo) return [];
  const dir = join(localPaths(cfg).handoffs, slugFile(repo));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f))
    .filter((f) => !/Status: shipped/.test(readFileSync(f, 'utf8')));
}

export function buildSessionContext(cfg, info) {
  const parts = [];
  const head = ['# dev-harness context'];
  if (info.repo) head.push(`Repo: ${info.repo} (branch: ${info.branch || 'unknown'})`);
  if (cfg.github.account) head.push(`GitHub account for all git/gh activity: ${cfg.github.account} (use \`gh-me\` for gh commands).`);
  head.push(`Ship gate: ${cfg.shipGate.enabled ? 'ON — changes stay local until the user says "ship" or explicitly asks to commit/push/open a PR in this conversation; then use the `ship` skill (it unlocks the gate). Never unlock on your own initiative.' : 'off'}`);
  head.push('Workflow: use the `dev` skill for any coding task (plan → implement → verify → fresh-context code + security review → ready-to-ship).');
  parts.push(head.join('\n'));
  const profile = profileFor(cfg, info.repo);
  if (profile) parts.push(`## Repo profile\n${profile}`);
  const lessons = lessonsFor(cfg, info.repo);
  if (lessons.repo) parts.push(`## Lessons for this repo\n${lessons.repo}`);
  if (lessons.global) parts.push(`## Global lessons\n${lessons.global}`);
  const handoffs = handoffsFor(cfg, info.repo);
  if (handoffs.length) parts.push(`## Open handoffs (read with \`dev-harness handoff show\` from the matching branch before resuming)\n${handoffs.map((h) => `- ${h}`).join('\n')}`);
  return parts.join('\n\n');
}
