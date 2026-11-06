import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const HARNESS_HOME = process.env.DEV_HARNESS_HOME
  || join(process.env.HOME || homedir(), '.dev-harness');

export const DEFAULTS = Object.freeze({
  github: {
    account: '',
    tokenEnv: '',
    enforce: 'writes',
  },
  git: {
    protectedBranches: ['main', 'master'],
    branch: {
      maxLength: 40,
      forbidSubstrings: [],
      rules: [],
    },
  },
  shipGate: {
    enabled: true,
    ttlMinutes: 30,
    excludeRepos: [],
  },
  planGate: {
    enabled: true,
    maxUnplannedFiles: 2,
    contractFiles: ['package.json', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'fstab.yaml', '.github/workflows/'],
    excludeRepos: [],
  },
  dev: {
    model: 'claude-opus-5.5',
    claudeModel: 'opus',
    setDefaults: true,
  },
  review: {
    codeModel: 'gpt-6.1-sol',
    securityModel: 'gpt-6.1-sol',
    claudeCrossFamily: true,
    maxFixRounds: 2,
  },
  localDir: '~/.dev-harness/local',
});

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function merge(base, over) {
  if (!isObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function expandHome(p) {
  if (!p) return p;
  const home = process.env.HOME || homedir();
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : resolve(p);
}

export function configPath() {
  return process.env.DEV_HARNESS_CONFIG || join(HARNESS_HOME, 'config.json');
}

export function loadConfig(path = configPath()) {
  let user = {};
  if (existsSync(path)) {
    user = JSON.parse(readFileSync(path, 'utf8'));
  }
  const cfg = merge(DEFAULTS, user);
  cfg.localDir = expandHome(cfg.localDir);
  return cfg;
}

export function modelFamily(model = '') {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(m)) return 'claude';
  if (/gpt|^o\d|codex/.test(m)) return 'gpt';
  if (/gemini/.test(m)) return 'gemini';
  return m.split(/[-.]/)[0] || 'unknown';
}

export function preferredToken(cfg, env = process.env) {
  return cfg.github.tokenEnv ? env[cfg.github.tokenEnv] || '' : '';
}
