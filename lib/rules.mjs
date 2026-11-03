import { isAbsolute, join, normalize } from 'node:path';
import { preferredToken } from './config.mjs';

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n']);

/** Remove heredoc bodies: they are data, not commands. */
function heredocDelimiters(line) {
  const delims = [];
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '<' && line[i + 1] === '<' && line[i - 1] !== '<' && line[i + 2] !== '<') {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.slice(i));
      if (m) { delims.push(m[2]); i += m[0].length - 1; }
    }
  }
  return delims;
}

export function stripHeredocs(command) {
  const lines = command.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    out.push(lines[i]);
    let next = i + 1;
    for (const d of heredocDelimiters(lines[i])) {
      let j = next;
      while (j < lines.length && lines[j].trim() !== d) j += 1;
      if (j >= lines.length) break;
      next = j + 1;
    }
    i = next;
  }
  return out.join('\n');
}

/** Tokenize a shell command into segments of words, honouring quotes. */
export function splitSegments(input) {
  const command = stripHeredocs(input);
  const segments = [];
  let words = [];
  let cur = '';
  let has = false;
  let quote = null;
  const pushWord = () => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  const pushSeg = () => {
    pushWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) { i += 1; cur += command[i]; }
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < command.length) {
      i += 1;
      if (command[i] !== '\n') { cur += command[i]; has = true; }
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { pushSeg(); i += 1; continue; }
    if (c === '&' && (/[<>]$/.test(cur) || command[i + 1] === '>')) { cur += c; has = true; continue; }
    if (SEPARATORS.has(c)) { pushSeg(); continue; }
    if (c === '(' || c === ')' || c === '{' || c === '}') {
      if (!has) { pushSeg(); continue; }
    }
    if (c === ' ' || c === '\t') { pushWord(); continue; }
    cur += c;
    has = true;
  }
  pushSeg();
  return segments;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

const REDIRECT = /^(?:\d*|&)(?:>>?|<<?|>&|<&)(.*)$/;

function dropRedirections(words) {
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const m = REDIRECT.exec(words[i]);
    if (!m) { out.push(words[i]); continue; }
    if (!m[1]) i += 1;
  }
  return out;
}

export function parseSegment(input) {
  const words = dropRedirections(input);
  const env = {};
  let i = 0;
  while (i < words.length && ASSIGN.test(words[i])) {
    const eq = words[i].indexOf('=');
    env[words[i].slice(0, eq)] = words[i].slice(eq + 1);
    i += 1;
  }
  while (['env', 'command', 'exec', 'time', 'nohup'].includes(words[i])) i += 1;
  return { env, cmd: words[i], args: words.slice(i + 1) };
}

function resolveDir(base, target, home) {
  if (!target || target === '~') return home;
  let t = target;
  if (t.startsWith('~/')) t = join(home, t.slice(2));
  return normalize(isAbsolute(t) ? t : join(base, t));
}

function parseGit(args) {
  let dir = null;
  let inlineCredential = false;
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') { dir = args[i + 1]; i += 2; }
    else if (args[i] === '-c') { if (/^credential\./.test(args[i + 1] || '')) inlineCredential = true; i += 2; }
    else i += 1;
  }
  return { dir, inlineCredential, sub: args[i], rest: args.slice(i + 1) };
}

export function sanitizeBranch(name) {
  return name.toLowerCase().replace(/[^a-z0-9/._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function branchRule(cfg, repo) {
  const b = cfg.git.branch;
  let maxLength = b.maxLength;
  for (const rule of b.rules || []) {
    const repos = (rule.repos || []).map((r) => r.toLowerCase());
    if (repo && repos.includes(repo.toLowerCase())) {
      if (rule.maxLength) maxLength = Math.min(maxLength, rule.maxLength);
    }
  }
  return { maxLength, forbid: (b.forbidSubstrings || []).map((s) => s.toLowerCase()).filter(Boolean) };
}

export function suggestBranch(name, cfg, repo) {
  const { maxLength, forbid } = branchRule(cfg, repo);
  let base = sanitizeBranch(name);
  for (const f of [...forbid].sort((a, b) => b.length - a.length)) base = base.split(f).join('-');
  const parts = base.split(/[-_/]+/).filter(Boolean);
  let out = parts.join('-') || 'change';
  if (out.length > maxLength) {
    if (maxLength >= 10) out = out.slice(0, maxLength).replace(/-+$/, '');
    else {
      const per = Math.max(1, Math.floor(maxLength / parts.length));
      out = parts.map((p) => p.slice(0, per)).join('').slice(0, maxLength);
    }
  }
  return out;
}

/** Returns an error string if the branch name violates the configured rules, else null. */
export function validateBranch(name, cfg, repo) {
  if (!name || cfg.git.protectedBranches.includes(name)) return null;
  const { maxLength, forbid } = branchRule(cfg, repo);
  const problems = [];
  if (name.length > maxLength) problems.push(`longer than ${maxLength} chars`);
  const lower = name.toLowerCase();
  const bad = forbid.find((f) => lower.includes(f));
  if (bad) problems.push(`contains "${bad}" (no usernames in branch names)`);
  if (name !== sanitizeBranch(name)) problems.push('not lowercase-kebab');
  if (!problems.length) return null;
  return `Branch "${name}" ${problems.join(', ')}${repo ? ` for ${repo}` : ''}. `
    + `Use a short name describing only the change, e.g. "${suggestBranch(name, cfg, repo)}".`;
}

const GH_WRITES = {
  pr: ['create', 'merge', 'comment', 'edit', 'review', 'close', 'reopen', 'ready'],
  issue: ['create', 'comment', 'edit', 'close', 'reopen', 'delete', 'transfer'],
  repo: ['create', 'fork', 'edit', 'delete', 'rename', 'archive'],
  release: ['create', 'edit', 'delete', 'upload'],
  workflow: ['run', 'enable', 'disable'],
  run: ['rerun', 'cancel', 'delete'],
  label: ['create', 'edit', 'delete'],
  gist: ['create', 'edit', 'delete'],
  secret: ['set', 'delete'],
  variable: ['set', 'delete'],
};

export function isGhWrite(args) {
  const [group, action] = args;
  if (group === 'api') {
    for (let i = 1; i < args.length; i += 1) {
      const a = args[i];
      if ((a === '-X' || a === '--method') && args[i + 1] && args[i + 1].toUpperCase() !== 'GET') return true;
      if (/^--method=(?!GET)/i.test(a) || /^-X(?!GET)[A-Z]+$/.test(a)) return true;
      if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a)) return true;
    }
    return false;
  }
  return Boolean(GH_WRITES[group]?.includes(action));
}

function shipGateMsg(info, what) {
  return `Ship gate is locked${info.repo ? ` for ${info.repo}` : ''} (${what}). Changes stay local until the user approves shipping. `
    + 'Only if the user explicitly asked in this conversation to commit/push/open a PR (e.g. said "ship"), '
    + 'run `dev-harness unlock` in this repo and retry. Otherwise stop and present the ready-to-ship summary.';
}

function shipGateLocked(cfg, info) {
  if (!cfg.shipGate.enabled || !info.isRepo) return false;
  const excluded = (cfg.shipGate.excludeRepos || []).map((r) => r.toLowerCase());
  if (info.repo && excluded.includes(info.repo.toLowerCase())) return false;
  return !info.shipUnlocked;
}

function checkGit(git, info, cfg, env) {
  const { sub, rest } = git;
  const protectedBranches = cfg.git.protectedBranches;
  const flagValue = (flags) => {
    const i = rest.findIndex((a) => flags.includes(a));
    return i >= 0 ? rest[i + 1] : null;
  };
  if (sub === 'commit') {
    if (rest.includes('--dry-run')) return null;
    if (protectedBranches.includes(info.branch)) {
      return `Refusing to commit directly to "${info.branch}". Create a short feature branch first (git switch -c <name>).`;
    }
    if (shipGateLocked(cfg, info)) return shipGateMsg(info, 'git commit');
    return null;
  }
  if (sub === 'push') {
    if (rest.some((a) => a === '--force' || a === '-f' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a))) {
      return 'Plain force-push is blocked. Use --force-with-lease if a rewrite is really intended.';
    }
    const positional = rest.filter((a) => !a.startsWith('-'));
    const refspecs = positional.slice(1);
    const deleting = rest.includes('--delete') || rest.includes('-d');
    if (rest.includes('--mirror')) return '`git push --mirror` force-updates every ref including protected branches. Push specific branches instead.';
    if (rest.some((a) => a === '--all' || a === '--branches')) {
      return '`git push --all` would also push protected branches. Push the feature branch explicitly: git push -u origin <branch>.';
    }
    const tagsOnly = !refspecs.length && rest.includes('--tags');
    const targets = tagsOnly ? [] : refspecs.length
      ? refspecs.map((r) => r.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, ''))
        .map((t) => (t === 'HEAD' ? info.branch : t))
      : [info.branch];
    const prot = targets.find((t) => protectedBranches.includes(t));
    if (prot) return `Refusing to push to protected branch "${prot}". Push a feature branch and open a PR.`;
    if (!deleting) {
      for (const t of targets) {
        if (t) {
          const err = validateBranch(t, cfg, info.repo);
          if (err) return `${err} Rename before pushing: git branch -m ${t === info.branch ? '' : `${t} `}${suggestBranch(t, cfg, info.repo)}`;
        }
      }
    }
    if (shipGateLocked(cfg, info)) return shipGateMsg(info, 'git push');
    if (preferredToken(cfg, env) && !info.credHelperOk && !git.inlineCredential) {
      return `git push might authenticate with the wrong GitHub account: the dev-harness credential helper is not the only github.com helper. Run \`dev-harness doctor --fix\` (and check \`git config --show-origin --get-regexp '^credential'\` for a repo-level helper) so pushes use ${cfg.github.account || 'the configured account'}, then retry.`;
    }
    return null;
  }
  if (sub === 'checkout' || sub === 'switch') {
    const name = flagValue(['-b', '-B', '-c', '-C', '--create', '--force-create']);
    return name ? validateBranch(name, cfg, info.repo) : null;
  }
  if (sub === 'branch') {
    const mi = rest.findIndex((a) => ['-m', '-M', '--move'].includes(a));
    if (mi >= 0) {
      const names = rest.slice(mi + 1).filter((a) => !a.startsWith('-'));
      return validateBranch(names[names.length - 1], cfg, info.repo);
    }
    const positional = rest.filter((a) => !a.startsWith('-'));
    if (rest.length === positional.length && positional.length >= 1 && positional.length <= 2) {
      return validateBranch(positional[0], cfg, info.repo);
    }
    return null;
  }
  if (sub === 'worktree' && rest[0] === 'add') {
    const name = flagValue(['-b', '-B']);
    return name ? validateBranch(name, cfg, info.repo) : null;
  }
  return null;
}

function checkGh(args, segEnv, viaWrapper, info, cfg, env) {
  const write = isGhWrite(args);
  const pref = preferredToken(cfg, env);
  const enforce = cfg.github.enforce;
  if (!viaWrapper && pref && enforce !== 'off' && env.GH_TOKEN !== pref && !('GH_TOKEN' in segEnv)
    && (enforce === 'all' || write)) {
    return `This gh command would run as the wrong GitHub account. Use \`gh-me ${args.join(' ')}\` `
      + `(runs gh as ${cfg.github.account || 'the configured account'}) or prefix GH_TOKEN=$${cfg.github.tokenEnv}. `
      + 'Only use a different account if the user explicitly asked for it.';
  }
  if (args[0] === 'pr' && ['create', 'merge'].includes(args[1]) && shipGateLocked(cfg, info)) {
    return shipGateMsg(info, `gh pr ${args[1]}`);
  }
  return null;
}

/**
 * Evaluate a shell command against harness policy.
 * ctx: { cfg, env, cwd, home, gitInfo(dir) => { isRepo, branch, repo, shipUnlocked, credHelperOk } }
 */
export function evaluateCommand(command, ctx) {
  const { cfg, env = {}, home = '/' } = ctx;
  let dir = ctx.cwd;
  const shellEnv = {};
  for (const words of splitSegments(command || '')) {
    const parsed = parseSegment(words);
    const { cmd, args } = parsed;
    if (!cmd) { Object.assign(shellEnv, parsed.env); continue; }
    if (cmd === 'export' || cmd === 'declare' || cmd === 'typeset') {
      Object.assign(shellEnv, parseSegment(args.filter((a) => !a.startsWith('-'))).env);
      continue;
    }
    const segEnv = { ...shellEnv, ...parsed.env };
    if (cmd === 'cd' || cmd === 'pushd') { dir = resolveDir(dir, args[0], home); continue; }
    let reason = null;
    if (cmd === 'git') {
      const git = parseGit(args);
      const gdir = git.dir ? resolveDir(dir, git.dir, home) : dir;
      reason = checkGit(git, ctx.gitInfo(gdir), cfg, env);
    } else if (cmd === 'gh' || cmd === 'gh-me' || cmd.endsWith('/gh') || cmd.endsWith('/gh-me')) {
      reason = checkGh(args, segEnv, cmd.endsWith('gh-me'), ctx.gitInfo(dir), cfg, env);
    }
    if (reason) return { decision: 'deny', reason };
  }
  return { decision: 'allow' };
}
