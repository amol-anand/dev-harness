import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';

export const CONVENTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'];
const NESTED = ['AGENTS.md', 'CLAUDE.md'];
const MAX = 20;

function trackedNested(root) {
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ...NESTED.map((n) => `*${n}`)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    }).split('\0').filter((f) => f.includes('/') && NESTED.includes(basename(f)));
  } catch { return []; }
}

function folders(file) {
  const parts = file.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** Top-level folder of the git checkout containing dir, or dir itself outside git. */
export function repoRoot(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\n$/, '') || dir;
  } catch { return dir; }
}

/**
 * Repo-relative paths of the repo's written convention files: root ones first, then nested ones by depth.
 * With `changed`, only nested files in folders above a changed file; without it, every tracked nested file.
 */
export function conventionFiles({ root, changed }) {
  const top = CONVENTION_FILES.filter((f) => existsSync(join(root, f)));
  const nested = changed
    ? [...new Set(changed.flatMap(folders))].flatMap((d) => NESTED.map((n) => `${d}/${n}`))
    : trackedNested(root);
  const depth = (f) => f.split('/').length;
  // Folder names come from the reviewed change; drop any that could add lines or break out of a code span.
  const safe = (f) => !/[\p{C}\p{Zl}\p{Zp}`]/u.test(f);
  const sorted = [...new Set(nested)]
    .filter((f) => safe(f) && existsSync(join(root, f)))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  return [...top, ...sorted].slice(0, MAX);
}
