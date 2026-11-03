import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, existsSync, readFileSync, rmSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { HARNESS_HOME } from './config.mjs';
import { credHelperOk, fullHelperChain } from './git.mjs';

const KEY = 'credential.https://github.com.helper';
const backupPath = () => join(HARNESS_HOME, 'backups', 'credential-helpers.json');
export const chainPath = () => join(HARNESS_HOME, 'credential-chain.json');

function gitGlobal(args) {
  execFileSync('git', ['config', '--global', ...args], { stdio: 'ignore' });
}

/** The global [credential "https://github.com"] section as key/value pairs (for exact restore on uninstall). */
function githubSection() {
  try {
    const out = execFileSync('git', ['config', '--global', '--get-regexp', '^credential\\.https://github\\.com\\.'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.replace(/\n$/, '').split('\n').filter(Boolean)
      .map((l) => (l.includes(' ') ? [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)] : [l, '']));
  } catch { return []; }
}

/** Helpers git would consult for github.com without the harness (an empty entry resets everything before it). */
export function effectiveChain(dir) {
  const all = fullHelperChain(dir);
  return all.slice(all.lastIndexOf('') + 1).filter((h) => h && !h.includes('git-credential-dev-harness'));
}

export function readChain() {
  try { return JSON.parse(readFileSync(chainPath(), 'utf8')); } catch { return []; }
}

/** Run one configured helper the way git would (`!cmd`, absolute path, or `git credential-<name>`). */
export function runHelper(spec, op, input) {
  let res;
  if (spec.startsWith('!')) res = spawnSync('sh', ['-c', `${spec.slice(1)} ${op}`], { input, encoding: 'utf8', timeout: 15000 });
  else if (isAbsolute(spec)) res = spawnSync('sh', ['-c', `${spec} ${op}`], { input, encoding: 'utf8', timeout: 15000 });
  else res = spawnSync('sh', ['-c', `git credential-${spec} ${op}`], { input, encoding: 'utf8', timeout: 15000 });
  return res.status === 0 ? res.stdout || '' : '';
}

/**
 * Make the dev-harness helper the ONLY github.com helper git calls. The previously effective chain is saved
 * and consulted by the helper itself (for `get` when it has no token), so git never sends `store`/`erase`
 * for the harness token to keychains or ~/.git-credentials.
 */
export function installCredentialHelper(helperPath, { dryRun = false } = {}) {
  const home = process.env.HOME;
  const section = githubSection();
  const chain = effectiveChain(home);
  const already = credHelperOk(home);
  if (dryRun) return { changed: !already, previous: section, chain };
  mkdirSync(join(HARNESS_HOME, 'backups'), { recursive: true });
  if (!section.some(([, v]) => v.includes('git-credential-dev-harness'))) {
    writeFileSync(backupPath(), JSON.stringify(section, null, 2));
  }
  if (chain.length || !existsSync(chainPath())) writeFileSync(chainPath(), JSON.stringify(chain, null, 2));
  if (already) return { changed: false, chain };
  // Re-create the section at the end of ~/.gitconfig so our reset also follows any global plain credential.helper.
  try { gitGlobal(['--remove-section', 'credential.https://github.com']); } catch { /* no section */ }
  for (const [k, v] of section) if (k !== KEY) gitGlobal(['--add', k, v]);
  gitGlobal(['--add', KEY, '']);
  gitGlobal(['--add', KEY, `!${helperPath}`]);
  return { changed: true, previous: section, chain };
}

export function uninstallCredentialHelper() {
  const file = backupPath();
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (previous) {
    try { gitGlobal(['--remove-section', 'credential.https://github.com']); } catch { /* no section */ }
    for (const [k, v] of previous) gitGlobal(['--add', k, v]);
  } else {
    try { gitGlobal(['--unset-all', KEY]); } catch { /* not set */ }
  }
  for (const f of [file, chainPath()]) if (existsSync(f)) rmSync(f);
  return previous;
}
