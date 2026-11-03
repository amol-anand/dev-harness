import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, merge } from '../lib/config.mjs';
import {
  splitSegments, parseSegment, evaluateCommand, validateBranch, suggestBranch, isGhWrite,
} from '../lib/rules.mjs';

const cfg = merge(DEFAULTS, {
  github: { account: 'octo-dev', tokenEnv: 'PREF_TOKEN', enforce: 'writes' },
  git: { branch: { forbidSubstrings: ['octo-dev', 'octo'], rules: [{ repos: ['acme/tiny'], maxLength: 7 }] } },
});

function ctx(over = {}) {
  const repoInfo = {
    isRepo: true, branch: 'fix-nav', repo: 'acme/web', shipUnlocked: true, credHelperOk: true, ...over.info,
  };
  return {
    cfg: over.cfg || cfg,
    env: over.env || { PREF_TOKEN: 'good', GH_TOKEN: 'other' },
    cwd: '/work/web',
    home: '/h',
    gitInfo: over.gitInfo || (() => repoInfo),
  };
}

const deny = (cmd, c = ctx()) => {
  const r = evaluateCommand(cmd, c);
  assert.equal(r.decision, 'deny', `expected deny: ${cmd}`);
  return r.reason;
};
const allow = (cmd, c = ctx()) => assert.equal(evaluateCommand(cmd, c).decision, 'allow', `expected allow: ${cmd} → ${evaluateCommand(cmd, c).reason}`);

test('splitSegments handles quotes and operators', () => {
  assert.deepEqual(splitSegments('cd a && git commit -m "x && y" | cat; echo hi'), [
    ['cd', 'a'], ['git', 'commit', '-m', 'x && y'], ['cat'], ['echo', 'hi'],
  ]);
  assert.deepEqual(parseSegment(['GH_TOKEN=$X', 'gh', 'pr', 'create']), { env: { GH_TOKEN: '$X' }, cmd: 'gh', args: ['pr', 'create'] });
});

test('branch validation', () => {
  assert.equal(validateBranch('fix-nav', cfg, 'acme/web'), null);
  assert.match(validateBranch('octo-dev-fix-nav', cfg, 'acme/web'), /no usernames/);
  assert.match(validateBranch('navfixes', cfg, 'acme/tiny'), /longer than 7/);
  assert.equal(validateBranch('navfix', cfg, 'acme/tiny'), null);
  assert.match(validateBranch('Fix_Nav', cfg, 'acme/web'), /lowercase-kebab/);
  assert.equal(validateBranch('main', cfg, 'acme/web'), null);
  assert.equal(suggestBranch('octo-dev-fix-optel-dialog', cfg, 'acme/web'), 'fix-optel-dialog');
  assert.ok(suggestBranch('octo-schedule-fix', cfg, 'acme/tiny').length <= 7);
});

test('protected branches', () => {
  deny('git commit -m wip', ctx({ info: { branch: 'main' } }));
  deny('git push origin main');
  deny('git push origin HEAD:refs/heads/main');
  deny('git push', ctx({ info: { branch: 'master' } }));
  allow('git commit --dry-run', ctx({ info: { branch: 'main' } }));
  allow('git push origin fix-nav');
  allow('git push --delete origin old-branch');
});

test('force push', () => {
  deny('git push --force origin fix-nav');
  deny('git push -f');
  allow('git push --force-with-lease origin fix-nav');
});

test('branch creation and rename rules', () => {
  deny('git checkout -b octo-dev-feature');
  deny('git switch -c this-branch-name-is-way-too-long-for-anyone-to-type-out');
  deny('git -C ../tiny switch -c longername', ctx({ gitInfo: () => ({ isRepo: true, branch: 'x', repo: 'acme/tiny', shipUnlocked: true, credHelperOk: true }) }));
  allow('git checkout -b fix-nav');
  allow('git checkout main');
  deny('git branch -m octo-dev-thing');
  allow('git branch -m fix-thing');
  deny('git worktree add -b octo-x ../wt');
  const reason = deny('git push -u origin HEAD', ctx({ info: { branch: 'octo-dev-glowing-doodle' } }));
  assert.match(reason, /git branch -m glowing-doodle/);
});

test('ship gate', () => {
  const locked = ctx({ info: { shipUnlocked: false } });
  assert.match(deny('git commit -m x', locked), /Ship gate is locked for acme\/web/);
  deny('git push origin fix-nav', locked);
  deny('gh-me pr create --fill', locked);
  allow('git status && git diff', locked);
  allow('git add -A', locked);
  const excluded = ctx({ info: { shipUnlocked: false }, cfg: merge(cfg, { shipGate: { excludeRepos: ['acme/web'] } }) });
  allow('git commit -m x', excluded);
  const disabled = ctx({ info: { shipUnlocked: false }, cfg: merge(cfg, { shipGate: { enabled: false } }) });
  allow('git commit -m x', disabled);
  allow('git commit -m x', ctx({ info: { isRepo: false, shipUnlocked: false } }));
});

test('gh identity', () => {
  assert.match(deny('gh pr create --fill'), /gh-me pr create --fill/);
  deny('gh api -X POST repos/a/b/issues');
  deny('gh api repos/a/b/issues -f title=x');
  allow('gh pr view 12');
  allow('gh api repos/a/b');
  allow('gh-me pr create --fill');
  allow('GH_TOKEN=$PREF_TOKEN gh pr create --fill');
  allow('GH_TOKEN=$OTHER gh pr comment 3 -b hi');
  allow('gh pr create', ctx({ env: { PREF_TOKEN: 'good', GH_TOKEN: 'good' } }));
  allow('gh pr create', ctx({ env: { GH_TOKEN: 'other' } }));
  deny('gh pr view 1', ctx({ cfg: merge(cfg, { github: { enforce: 'all' } }) }));
  allow('gh pr create', ctx({ cfg: merge(cfg, { github: { enforce: 'off' } }) }));
  assert.equal(isGhWrite(['issue', 'create']), true);
  assert.equal(isGhWrite(['issue', 'list']), false);
});

test('exported and standalone env assignments carry across segments', () => {
  allow('export GH_TOKEN=$PREF_TOKEN; gh pr create --fill');
  allow('export GH_HOST=github.com GH_TOKEN=$PREF_TOKEN && gh api repos/a/b/pulls/1/comments -f body=x');
  allow('GH_TOKEN=$PREF_TOKEN; gh pr edit 3 --body-file b.md');
  allow('export GH_HOST=github.com GH_TOKEN=$X gh api repos/a/b -f x=1');
  deny('export GH_HOST=github.com; gh pr create --fill');
  allow('git -c credential.helper= -c "credential.helper=!f() { echo x; }; f" push origin fix-nav', ctx({ info: { credHelperOk: false } }));
});

test('git push requires credential helper when a preferred token is configured', () => {
  assert.match(deny('git push origin fix-nav', ctx({ info: { credHelperOk: false } })), /doctor --fix/);
  allow('git push origin fix-nav', ctx({ info: { credHelperOk: false }, env: {} }));
});

test('cd tracking resolves the right repo', () => {
  const seen = [];
  const c = ctx({ gitInfo: (d) => { seen.push(d); return { isRepo: true, branch: 'fix', repo: 'acme/web', shipUnlocked: true, credHelperOk: true }; } });
  evaluateCommand('cd ~/code/app && git commit -m x && cd sub && git push', c);
  assert.deepEqual(seen, ['/h/code/app', '/h/code/app/sub']);
});

test('heredoc bodies are data, not commands', () => {
  allow("node - <<'EOF'\nconst x = 'gh pr create --fill && git push origin main';\nEOF\necho done");
  allow('cat > f.md <<EOF\ngit commit -m x\nEOF');
  deny("cat > f <<'EOF'\nhello\nEOF\ngit push origin main");
  deny('git commit -F - <<< "msg"\ngit push origin main');
  deny('echo "x<<y"\ngit push origin main');
  deny('cat <<EOF\nnever closed\ngit push origin main');
});

test('redirections are not arguments', () => {
  allow('git branch 2>&1');
  allow('git push -u origin fix-nav 2>&1 | tail -5');
  allow('git push origin fix-nav > /dev/null');
  allow('git push origin fix-nav &>/dev/null');
  allow('git branch -a 2>/dev/null');
  deny('git push origin main 2>&1');
});

test('tag pushes from the default branch are allowed', () => {
  allow('git push --tags', ctx({ info: { branch: 'main' } }));
  allow('git push origin --tags', ctx({ info: { branch: 'main' } }));
  deny('git push --follow-tags', ctx({ info: { branch: 'main' } }));
  deny('git push --mirror');
  deny('git push origin --all');
});

test('non git commands are ignored', () => {
  allow('npm test && echo "git push origin main"');
  allow('ls -la');
});
