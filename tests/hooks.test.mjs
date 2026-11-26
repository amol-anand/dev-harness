import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
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

test('rename_branch is validated with the branch rules', () => {
  const config = join(home, 'rename-config.json');
  writeFileSync(config, JSON.stringify({
    github: { account: 'octo-dev' },
    git: { branch: { forbidSubstrings: ['octo'], rules: [{ repos: ['acme/web'], maxLength: 8 }] } },
  }));
  const rename = (toolArgs, cwd = repo) => run('guard.mjs', { toolName: 'rename_branch', toolArgs, cwd }, { DEV_HARNESS_CONFIG: config });
  assert.equal(rename({ name: 'fix-nav' }), null);
  assert.equal(rename(JSON.stringify({ name: 'fix-nav' })), null);
  assert.match(rename({ name: 'fix-navbar' }).permissionDecisionReason, /longer than 8 chars for acme\/web/);
  assert.equal(rename({ name: 'fix-navbar' }, home), null, 'per-repo limit only applies in that repo');
  assert.match(rename({ name: 'octo-fix' }).permissionDecisionReason, /contains "octo"/);
  assert.match(rename({ name: 'main' }).permissionDecisionReason, /protected branch "main"/);
  for (const bad of [{}, { name: '' }, { name: 7 }, 'not json']) {
    assert.match(rename(bad).permissionDecisionReason, /needs a branch name/);
  }
  const claude = run('guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'rename_branch', tool_input: { name: 'Fix_Nav' }, cwd: repo });
  assert.match(claude.hookSpecificOutput.permissionDecisionReason, /not lowercase-kebab/);
});

test('edits are blocked while the current branch breaks the rules, even with the plan gate off', () => {
  const config = join(home, 'nogate-config.json');
  writeFileSync(config, JSON.stringify({ github: { account: 'octo-dev' }, git: { branch: { forbidSubstrings: ['octo'] } }, planGate: { enabled: false } }));
  const edit = (payload, extraEnv) => run('guard.mjs', payload, extraEnv);
  const copilot = { toolName: 'edit', toolArgs: { path: 'a.css' }, cwd: repo };
  const claude = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(repo, 'a.css') }, cwd: repo };
  execFileSync('git', ['-C', repo, 'switch', '-q', '-c', 'octo-dev-session'], { env });
  try {
    for (const extraEnv of [{}, { DEV_HARNESS_CONFIG: config }]) {
      assert.match(edit(copilot, extraEnv).permissionDecisionReason, /contains "octo".*rename_branch/);
      assert.match(edit(claude, extraEnv).hookSpecificOutput.permissionDecisionReason, /contains "octo"/);
      assert.equal(edit({ toolName: 'view', toolArgs: { path: 'a.css' }, cwd: repo }, extraEnv), null);
      assert.equal(edit({ toolName: 'create', toolArgs: { path: join(home, 'scratch.md') }, cwd: repo }, extraEnv), null);
    }
    const patch = `*** Begin Patch\n*** Add File: ${join(home, 'notes.md')}\n*** Update File: ${join(repo, 'a.css')}\n*** End Patch`;
    assert.match(edit({ toolName: 'apply_patch', toolArgs: JSON.stringify({ input: patch }), cwd: home }).permissionDecisionReason, /octo-dev-session/);
    execFileSync('git', ['-C', repo, 'switch', '-q', 'main'], { env });
    assert.match(edit(copilot, { DEV_HARNESS_CONFIG: config }).permissionDecisionReason, /protected branch "main"/);
  } finally {
    execFileSync('git', ['-C', repo, 'switch', '-q', 'fix-nav'], { env });
    execFileSync('git', ['-C', repo, 'branch', '-q', '-D', 'octo-dev-session'], { env });
  }
  assert.equal(edit(copilot, { DEV_HARNESS_CONFIG: config }), null);
  assert.equal(edit(copilot), null);
});

test('branch rules apply to edits in repos without a GitHub origin', () => {
  const config = join(home, 'nogate-config.json');
  writeFileSync(config, JSON.stringify({ github: { account: 'octo-dev' }, git: { branch: { forbidSubstrings: ['octo'] } }, planGate: { enabled: false } }));
  const local = join(home, 'code', 'local-only');
  const gitlab = join(home, 'code', 'gitlab');
  for (const dir of [local, gitlab]) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { env });
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { env });
  }
  execFileSync('git', ['-C', gitlab, 'remote', 'add', 'origin', 'https://gitlab.com/acme/web.git'], { env });
  try {
    for (const dir of [local, gitlab]) {
      const edit = (extraEnv) => run('guard.mjs', { toolName: 'edit', toolArgs: { path: join(dir, 'a.css') }, cwd: dir }, extraEnv);
      for (const extraEnv of [{}, { DEV_HARNESS_CONFIG: config }]) {
        execFileSync('git', ['-C', dir, 'switch', '-q', 'main'], { env });
        assert.match(edit(extraEnv).permissionDecisionReason, new RegExp(`protected branch "main" of repository \\S*${basename(dir)}\\.`));
        execFileSync('git', ['-C', dir, 'switch', '-q', '-c', 'octo-dev-x'], { env });
        assert.match(edit(extraEnv).permissionDecisionReason, new RegExp(`contains "octo".*\\(repository \\S*${basename(dir)}\\)`));
        execFileSync('git', ['-C', dir, 'switch', '-q', '-c', 'fix-ui'], { env });
        assert.equal(edit(extraEnv), null);
        execFileSync('git', ['-C', dir, 'switch', '-q', 'main'], { env });
        execFileSync('git', ['-C', dir, 'branch', '-q', '-D', 'octo-dev-x', 'fix-ui'], { env });
      }
    }
  } finally {
    for (const dir of [local, gitlab]) rmSync(dir, { recursive: true, force: true });
  }
});

test('edits through a symlink check the repo holding the link and the repo it points to', () => {
  const links = join(home, 'code', 'links');
  const dest = join(home, 'code', 'dest');
  const outside = join(home, 'outside.txt');
  for (const [dir, branch] of [[links, 'main'], [dest, 'octo-dev-x']]) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', branch], { env });
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { env });
  }
  writeFileSync(outside, 'x');
  writeFileSync(join(dest, 'a.css'), 'x');
  symlinkSync(outside, join(links, 'out-link'));
  symlinkSync(join(dest, 'a.css'), join(links, 'in-link'));
  const patch = (...ops) => run('guard.mjs', { toolName: 'apply_patch', toolArgs: { input: `*** Begin Patch\n${ops.join('\n')}\n*** End Patch` }, cwd: home });
  try {
    assert.match(patch(`*** Delete File: ${join(links, 'out-link')}`).permissionDecisionReason, /protected branch "main" of repository \S*links\./);
    assert.match(patch(`*** Update File: ${join(links, 'out-link')}`, `*** Move to: ${join(home, 'moved.txt')}`).permissionDecisionReason, /protected branch "main" of repository \S*links\./);
    assert.equal(run('guard.mjs', { toolName: 'view', toolArgs: { path: join(links, 'out-link') }, cwd: home }), null);
    execFileSync('git', ['-C', links, 'switch', '-q', '-c', 'fix-ui'], { env });
    assert.equal(patch(`*** Delete File: ${join(links, 'out-link')}`, `*** Add File: ${join(home, 'scratch-2.md')}`), null);
    assert.match(patch(`*** Delete File: ${join(links, 'in-link')}`).permissionDecisionReason, /contains "octo".*\(repository \S*dest\)/);
  } finally {
    for (const p of [links, dest, outside]) rmSync(p, { recursive: true, force: true });
  }
});

test('plan gate counts only where a symlink edit lands, not the link itself', () => {
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { env });
  const outside = join(home, 'alias-outside.txt');
  const edit = (p) => run('guard.mjs', { toolName: 'edit', toolArgs: { path: join(repo, p) }, cwd: repo });
  g('switch', '-q', '-c', 'alias-test');
  try {
    writeFileSync(join(repo, 'AGENTS.md'), 'a');
    writeFileSync(outside, 'x');
    symlinkSync('AGENTS.md', join(repo, 'CLAUDE.md'));
    symlinkSync(outside, join(repo, 'ext-link'));
    g('add', 'AGENTS.md', 'CLAUDE.md', 'ext-link');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'alias');
    writeFileSync(join(repo, 'other.js'), '1');
    assert.equal(edit('CLAUDE.md'), null, 'link + destination count once');
    writeFileSync(join(repo, 'AGENTS.md'), 'b');
    assert.equal(edit('CLAUDE.md'), null, 'already-changed destination adds nothing');
    assert.equal(edit('ext-link'), null, 'a link to a file outside the repo is not gated in the repo holding it');
    assert.equal(edit('c.js').permissionDecision, 'deny');
  } finally {
    rmSync(join(repo, 'other.js'), { force: true });
    rmSync(outside, { force: true });
    g('checkout', '-q', '--', '.');
    g('switch', '-q', 'fix-nav');
    g('branch', '-q', '-D', 'alias-test');
  }
});

test('str_replace_editor view is read-only; its mutating commands stay gated', () => {
  const config = join(home, 'nogate-config.json');
  writeFileSync(config, JSON.stringify({ github: { account: 'octo-dev' }, git: { branch: { forbidSubstrings: ['octo'] } }, planGate: { enabled: false } }));
  const path = join(repo, 'a.css');
  const view = { command: 'view', path };
  const mutate = { command: 'str_replace', path, old_str: 'a', new_str: 'b' };
  try {
    for (const branch of ['main', 'octo-dev-session']) {
      execFileSync('git', ['-C', repo, 'switch', '-q', ...(branch === 'main' ? [] : ['-c']), branch], { env });
      for (const extraEnv of [{}, { DEV_HARNESS_CONFIG: config }]) {
        assert.equal(run('guard.mjs', { toolName: 'str_replace_editor', toolArgs: view, cwd: repo }, extraEnv), null);
        assert.equal(run('guard.mjs', { toolName: 'str_replace_editor', toolArgs: JSON.stringify(view), cwd: repo }, extraEnv), null);
        assert.equal(run('guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'str_replace_editor', tool_input: view, cwd: repo }, extraEnv), null);
        assert.equal(run('guard.mjs', { toolName: 'str_replace_editor', toolArgs: JSON.stringify(mutate), cwd: repo }, extraEnv).permissionDecision, 'deny');
        assert.equal(run('guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'str_replace_editor', tool_input: mutate, cwd: repo }, extraEnv).hookSpecificOutput.permissionDecision, 'deny');
      }
    }
  } finally {
    execFileSync('git', ['-C', repo, 'switch', '-q', 'fix-nav'], { env });
    execFileSync('git', ['-C', repo, 'branch', '-q', '-D', 'octo-dev-session'], { env });
  }
});

test('session-start flags an app-created branch that breaks the rules', () => {
  assert.doesNotMatch(run('session-start.mjs', { cwd: repo }).additionalContext, /## Branch/);
  execFileSync('git', ['-C', repo, 'switch', '-q', '-c', 'octo-dev-session'], { env });
  try {
    const c = run('session-start.mjs', { cwd: repo });
    assert.match(c.additionalContext, /## Branch\nBranch "octo-dev-session" contains "octo"/);
    assert.match(c.additionalContext, /git switch -c <name>/);
  } finally {
    execFileSync('git', ['-C', repo, 'switch', '-q', 'fix-nav'], { env });
  }
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

test('review accepts --kind conventions and rejects unknown kinds', () => {
  const bin = join(home, 'fake-bin');
  const argsFile = join(home, 'copilot-args.json');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'copilot'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('VERDICT: PASS');\n`, { mode: 0o755 });
  const config = join(home, 'review-config.json');
  writeFileSync(config, JSON.stringify({ github: { account: 'octo-dev' }, review: { codeModel: 'gpt-code', securityModel: 'gpt-sec' } }));
  const cliEnv = { ...env, PATH: `${bin}:${env.PATH}`, DEV_HARNESS_CONFIG: config };
  const cli = (args) => spawnSync('node', [join(ROOT, 'bin', 'dev-harness'), ...args], { cwd: repo, env: cliEnv, encoding: 'utf8' });
  const sent = () => {
    const a = JSON.parse(readFileSync(argsFile, 'utf8'));
    return { prompt: a[a.indexOf('-p') + 1], model: a[a.indexOf('--model') + 1] };
  };
  assert.match(cli(['review', '--kind', 'conventions', '--base', 'HEAD']).stdout, /No changes to review/);
  writeFileSync(join(repo, 'conv.js'), 'x');
  try {
    const r = cli(['review', '--kind', 'conventions', '--base', 'HEAD']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /VERDICT: PASS/);
    assert.match(sent().prompt, /does this change look like it belongs in this repo\?/);
    assert.equal(sent().model, 'gpt-code');
    const o = cli(['review', '--kind', 'conventions', '--base', 'HEAD', '--model', 'claude-opus-5.5']);
    assert.equal(o.status, 0, o.stderr);
    assert.equal(sent().model, 'claude-opus-5.5');
    const s = cli(['review', '--kind', 'security', '--base', 'HEAD']);
    assert.equal(s.status, 0, s.stderr);
    assert.match(sent().prompt, /application security engineer/);
    assert.equal(sent().model, 'gpt-sec');
    const c = cli(['review', '--kind', 'code', '--base', 'HEAD']);
    assert.equal(c.status, 0, c.stderr);
    assert.equal(sent().model, 'gpt-code');
  } finally {
    rmSync(join(repo, 'conv.js'));
  }
  const bad = cli(['review', '--kind', 'style']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--kind must be code, security or conventions/);
});

test('plan gate end to end: blocks a 3rd file until plan written + approved', () => {
  const cli = (args, input) => spawnSync('node', [join(ROOT, 'bin', 'dev-harness'), ...args], { cwd: repo, env, input, encoding: 'utf8' });
  execFileSync('git', ['-C', repo, 'switch', '-q', '-c', 'gate-test'], { env });
  try {
    writeFileSync(join(repo, 'a.js'), '1');
    writeFileSync(join(repo, 'b.js'), '2');
    const edit = (p) => run('guard.mjs', { toolName: 'create', toolArgs: { path: p, file_text: 'x' }, cwd: repo });
    assert.equal(edit('a.js'), null);
    let out = edit('c.js');
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /Plan gate: .*3 changed files.*Write the plan first/);
    assert.match(cli(['plan', 'approve']).stderr, /no plan for this branch/);
    cli(['handoff', 'write'], '# Plan\nStatus: planned\n');
    out = run('guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(repo, 'c.js') }, cwd: repo });
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /NOT approved/);
    assert.match(cli(['plan', 'approve']).stdout, /Plan approved for acme\/web@gate-test/);
    assert.equal(edit('c.js'), null);
    assert.match(cli(['plan', 'status']).stdout, /plan: written · approval: approved/);
    execFileSync('git', ['-C', repo, 'stash', '-u', '-q'], { env });
    execFileSync('git', ['-C', repo, 'switch', '-q', 'fix-nav'], { env });
    writeFileSync(join(repo, 'x.js'), '1');
    writeFileSync(join(repo, 'y.js'), '1');
    assert.equal(edit('z.js').permissionDecision, 'deny', 'approval is per branch');
    assert.equal(edit('package.json').permissionDecision, 'deny');
    writeFileSync(join(repo, 'package.json'), '{}');
    execFileSync('git', ['-C', repo, 'add', 'package.json'], { env });
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'pkg'], { env });
    rmSync(join(repo, 'x.js')); rmSync(join(repo, 'y.js'));
    symlinkSync(join(repo, 'package.json'), join(repo, 'notes.txt'));
    execFileSync('git', ['-C', repo, 'add', 'notes.txt'], { env });
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'link'], { env });
    assert.equal(edit('notes.txt').permissionDecision, 'deny', 'symlink to a contract file is gated');
    const other = join(home, 'code', 'other');
    mkdirSync(other, { recursive: true });
    execFileSync('git', ['-C', other, 'init', '-q', '-b', 'other-change'], { env });
    execFileSync('git', ['-C', other, 'remote', 'add', 'origin', 'https://github.com/acme/other.git'], { env });
    const patch = `*** Begin Patch\n*** Update File: ${join(home, 'scratch.md')}\n*** Add File: ${join(other, 'package.json')}\n*** End Patch`;
    assert.match(run('guard.mjs', { toolName: 'apply_patch', toolArgs: { input: patch }, cwd: repo }).permissionDecisionReason, /Plan gate: .*acme\/other@other-change/, 'every repo in a patch is checked');
  } finally {
    for (const f of ['x.js', 'y.js']) rmSync(join(repo, f), { force: true });
    execFileSync('git', ['-C', repo, 'switch', '-q', 'fix-nav'], { env });
    cli(['plan', 'revoke']);
  }
});
