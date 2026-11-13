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
    altModel: '',
    claudeCrossFamily: true,
    maxRounds: 10,
    cleanRoundsToStop: 2,
  },
  skills: {
    extra: [],
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
  cfg.review = { ...cfg.review, altModel: cfg.review.altModel || cfg.dev.model, altModelDefaulted: !cfg.review.altModel };
  return cfg;
}

export function modelFamily(model = '') {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(m)) return 'claude';
  if (/gpt|^o\d|codex/.test(m)) return 'gpt';
  if (/gemini/.test(m)) return 'gemini';
  return m.split(/[-.]/)[0] || 'unknown';
}

export function reviewConfigChecks(cfg) {
  const devFam = modelFamily(cfg.dev.model);
  const checks = [];
  for (const [k, m] of [['code', cfg.review.codeModel], ['security', cfg.review.securityModel]]) {
    checks.push({ label: `${k} reviewer ${m} is a different model family from dev model ${cfg.dev.model}`, ok: modelFamily(m) !== devFam, hint: `set review.${k}Model to a non-${devFam} model` });
  }
  for (const m of new Set([cfg.review.codeModel, cfg.review.securityModel])) {
    checks.push({ label: `review.altModel ${cfg.review.altModel} alternates with reviewer ${m}`, ok: modelFamily(cfg.review.altModel) !== modelFamily(m), hint: cfg.review.altModelDefaulted
      ? `review.altModel defaults to dev.model (${cfg.dev.model}); set review.altModel to a non-${modelFamily(m)} model or change the reviewer models`
      : `set review.altModel to a non-${modelFamily(m)} model` });
  }
  const bad = ['maxRounds', 'cleanRoundsToStop'].filter((k) => !Number.isInteger(cfg.review[k]) || cfg.review[k] < 1);
  for (const k of bad) checks.push({ label: `review.${k} ${JSON.stringify(cfg.review[k])} is a positive integer`, ok: false, hint: `set review.${k} to a positive integer` });
  if (!bad.length && cfg.review.cleanRoundsToStop > cfg.review.maxRounds) {
    checks.push({ label: `review.cleanRoundsToStop ${cfg.review.cleanRoundsToStop} is not more than review.maxRounds ${cfg.review.maxRounds}`, ok: false, hint: 'lower review.cleanRoundsToStop or raise review.maxRounds' });
  }
  if (cfg.review.maxFixRounds !== undefined) {
    checks.push({ label: 'review.maxFixRounds is no longer used', ok: false, hint: 'remove review.maxFixRounds; set review.maxRounds (total review rounds, default 10) instead' });
  }
  return checks;
}

export function preferredToken(cfg, env = process.env) {
  return cfg.github.tokenEnv ? env[cfg.github.tokenEnv] || '' : '';
}
