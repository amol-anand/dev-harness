import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = 'dev-harness-ship-ok';

function git(dir, args, raw = false) {
  try {
    const out = execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    });
    return raw ? out : out.trim();
  } catch {
    return '';
  }
}

export function repoSlug(remoteUrl) {
  const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl || '');
  return m ? `${m[1]}/${m[2]}` : '';
}

export function gitDir(dir) {
  return git(dir, ['rev-parse', '--absolute-git-dir']);
}

export function shipMarkerPath(dir) {
  const gd = gitDir(dir);
  return gd ? join(gd, MARKER) : '';
}

export function isShipUnlocked(dir, now = Date.now()) {
  const p = shipMarkerPath(dir);
  if (!p || !existsSync(p)) return false;
  const expires = Number(readFileSync(p, 'utf8').trim());
  return Number.isFinite(expires) && expires > now;
}

export function unlockShip(dir, minutes) {
  const p = shipMarkerPath(dir);
  if (!p) throw new Error(`${dir} is not inside a git repository`);
  const expires = Date.now() + minutes * 60_000;
  writeFileSync(p, String(expires));
  return { path: p, expires };
}

export function lockShip(dir) {
  const p = shipMarkerPath(dir);
  if (p && existsSync(p)) rmSync(p);
  return p;
}

export function credentialHelpers(dir) {
  const out = git(dir || '.', ['config', '--get-all', 'credential.https://github.com.helper'], true);
  return out ? out.replace(/\n$/, '').split('\n') : [];
}

/** Every helper git would use for https://github.com, in config order (generic and URL-specific keys interleaved). */
export function fullHelperChain(dir) {
  const out = git(dir || '.', ['config', '--get-regexp', String.raw`^credential\.(https://github\.com\.)?helper$`], true);
  return out ? out.replace(/\n$/, '').split('\n').map((l) => (l.includes(' ') ? l.slice(l.indexOf(' ') + 1) : '')) : [];
}

/** Git asks every helper in order (an empty value resets the list); ours must be the only one for github.com. */
export function credHelperOk(dir) {
  const helpers = fullHelperChain(dir);
  const reset = helpers.lastIndexOf('');
  const active = helpers.slice(reset + 1).filter(Boolean);
  return active.length === 1 && active[0].includes('git-credential-dev-harness');
}

export function makeGitInfo() {
  const cache = new Map();
  return (dir) => {
    if (cache.has(dir)) return cache.get(dir);
    const gd = gitDir(dir);
    const info = gd
      ? {
        isRepo: true,
        branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
        repo: repoSlug(git(dir, ['remote', 'get-url', 'origin'])),
        shipUnlocked: isShipUnlocked(dir),
        credHelperOk: credHelperOk(dir),
      }
      : { isRepo: false, branch: '', repo: '', shipUnlocked: false, credHelperOk: credHelperOk(dir) };
    cache.set(dir, info);
    return info;
  };
}
