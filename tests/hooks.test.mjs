import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let home;
let repo;
let env;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dh-home-'));
  repo = join(home, 'code', 'web');
  mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('remote', 'add', 'origin', 'https://github.com/acme/web.git');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  g('switch', '-q', '-c', 'fix-nav');
  mkdirSync(join(home, '.dev-harness', 'local', 'profiles'), { recursive: true });
  mkdirSync(join(home, '.dev-harness', 'local', 'lessons'), { recursive: true });
  writeFileSync(join(home, '.dev-harness', 'config.json'), JSON.stringify({
    github: { account: 'octo-dev' },
    git: { branch: { forbidSubstrings: ['octo'] } },
  }));
  writeFileSync(join(home, '.dev-harness', 'local', 'profiles', 'acme__web.md'), '# Profile: acme/web\n- **Test:** `npm test`');
  writeFileSync(join(home, '.dev-harness', 'local', 'lessons', 'acme__web.md'), '- Never use esmock here');
  env = {
    PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  };
});

after(() => rmSync(home, { recursive: true, force: true }));

function run(script, payload, extraEnv = {}) {
  const r = spawnSync('node', [join(ROOT, 'hooks', script)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload), env: { ...env, ...extraEnv }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test('copilot payload: ship gate denies commit, unlock allows it', () => {
  const p = { toolName: 'bash', toolArgs: { command: 'git commit -m x' }, cwd: repo };
  const out = run('guard.mjs', p);
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /Ship gate is locked for acme\/web/);
  execFileSync('node', [join(ROOT, 'bin', 'dev-harness'), 'unlock', '--minutes', '1'], { cwd: repo, env });
  assert.equal(run('guard.mjs', p), null);
  execFileSync('node', [join(ROOT, 'bin', 'dev-harness'), 'lock'], { cwd: repo, env });
  assert.equal(run('guard.mjs', p).permissionDecision, 'deny');
});

test('copilot payload with stringified toolArgs', () => {
  const out = run('guard.mjs', { toolName: 'bash', toolArgs: JSON.stringify({ command: 'git checkout -b octo-dev-x' }), cwd: repo });
  assert.equal(out.permissionDecision, 'deny');
});

test('claude payload format', () => {
  const out = run('guard.mjs', {
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cd ${repo} && git push origin main` }, cwd: home,
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /protected branch "main"/);
});

test('non-shell tools and harmless commands pass through', () => {
  assert.equal(run('guard.mjs', { toolName: 'edit', toolArgs: { path: 'x' }, cwd: repo }), null);
  assert.equal(run('guard.mjs', { toolName: 'bash', toolArgs: { command: 'git status' }, cwd: repo }), null);
});

test('fail-safe: malformed input never blocks', () => {
  assert.equal(run('guard.mjs', '{not json'), null);
  assert.equal(run('guard.mjs', ''), null);
  assert.equal(run('guard.mjs', { toolName: 'bash', toolArgs: { command: 'git commit -m x' }, cwd: repo }, { DEV_HARNESS_CONFIG: join(home, 'missing', 'bad.json') }).permissionDecision, 'deny');
  writeFileSync(join(home, 'broken.json'), '{oops');
  assert.equal(run('guard.mjs', { toolName: 'bash', toolArgs: { command: 'git commit -m x' }, cwd: repo }, { DEV_HARNESS_CONFIG: join(home, 'broken.json') }), null);
});

test('session-start injects profile and lessons (both formats)', () => {
  const c = run('session-start.mjs', { sessionId: 's', cwd: repo, source: 'new' });
  assert.match(c.additionalContext, /Repo: acme\/web \(branch: fix-nav\)/);
  assert.match(c.additionalContext, /npm test/);
  assert.match(c.additionalContext, /Never use esmock/);
  const cl = run('session-start.mjs', { hook_event_name: 'SessionStart', session_id: 's', cwd: repo });
  assert.match(cl.hookSpecificOutput.additionalContext, /Ship gate: ON/);
});

test('handoff write/show/done via CLI and session-start listing', () => {
  const cli = (args, input) => spawnSync('node', [join(ROOT, 'bin', 'dev-harness'), ...args], { cwd: repo, env, input, encoding: 'utf8' });
  assert.match(cli(['handoff', 'write'], '# Plan\nStatus: implementing\n').stdout, /Wrote .*acme__web\/fix-nav\.md/);
  assert.match(cli(['handoff', 'show']).stdout, /Status: implementing/);
  assert.match(run('session-start.mjs', { cwd: repo }).additionalContext, /Open handoffs/);
  cli(['handoff', 'done']);
  assert.doesNotMatch(run('session-start.mjs', { cwd: repo }).additionalContext, /Open handoffs/);
});
