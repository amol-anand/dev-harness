import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_PATTERNS = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Generic secret assignment', /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{16,}['"]/i],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

const PERSONAL_PATHS = /\/(?:Users|home)\/(?!<|\$|you\b|me\b|example\b)[A-Za-z0-9._-]+\//;

export function loadDenylist(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function listFiles(dir, staged) {
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACM'] : ['ls-files', '--cached', '--others', '--exclude-standard'];
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

/** Scan repository files for secrets, personal paths and denylisted identifiers. */
export function audit(dir, { denylist = [], staged = false } = {}) {
  const findings = [];
  const lowerDeny = denylist.map((d) => d.toLowerCase());
  for (const f of listFiles(dir, staged)) {
    const p = join(dir, f);
    if (!existsSync(p) || statSync(p).size > 2_000_000) continue;
    const text = readFileSync(p, 'utf8');
    if (text.includes('\u0000')) continue;
    text.split('\n').forEach((line, i) => {
      if (/dev-harness-audit-ignore/.test(line)) return;
      for (const [name, re] of SECRET_PATTERNS) {
        if (re.test(line)) findings.push({ file: f, line: i + 1, kind: name });
      }
      if (PERSONAL_PATHS.test(line)) findings.push({ file: f, line: i + 1, kind: 'Personal absolute path' });
      const l = line.toLowerCase();
      lowerDeny.forEach((d, idx) => {
        if (l.includes(d)) findings.push({ file: f, line: i + 1, kind: `Denylisted identifier "${denylist[idx]}"` });
      });
    });
  }
  return findings;
}
