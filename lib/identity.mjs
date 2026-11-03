import { execFileSync } from 'node:child_process';
import { preferredToken } from './config.mjs';

export function findGh(env = process.env) {
  if (env.DEV_HARNESS_GH) return env.DEV_HARNESS_GH;
  for (const dir of (env.PATH || '').split(':')) {
    if (!dir) continue;
    const p = `${dir}/gh`;
    try { execFileSync(p, ['--version'], { stdio: 'ignore', timeout: 3000 }); return p; } catch { /* next */ }
  }
  return '';
}

/** Token for the configured account: env var first, then gh keyring (`gh auth token --user`). */
export function resolveToken(cfg, env = process.env) {
  const fromEnv = preferredToken(cfg, env);
  if (fromEnv) return fromEnv;
  if (!cfg.github.account) return '';
  const gh = findGh(env);
  if (!gh) return '';
  try {
    const cleanEnv = { ...env };
    delete cleanEnv.GH_TOKEN;
    delete cleanEnv.GITHUB_TOKEN;
    return execFileSync(gh, ['auth', 'token', '--hostname', 'github.com', '--user', cfg.github.account], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: cleanEnv, timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}
