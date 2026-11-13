import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULTS, merge, modelFamily, loadConfig, reviewConfigChecks,
} from '../lib/config.mjs';
import { buildSessionContext } from '../lib/context.mjs';
import { editTargets, planGateDecision } from '../lib/plangate.mjs';

const cfg = merge(DEFAULTS, {});
const state = (over = {}) => ({
  root: '/r', branch: 'feat', repo: 'acme/web', changed: new Set(), planExists: false, approved: false, ...over,
});

test('editTargets reads Copilot, Claude and apply_patch shapes', () => {
  assert.deepEqual(editTargets('edit', { path: 'a.js' }, '/r'), ['/r/a.js']);
  assert.deepEqual(editTargets('Write', { file_path: '/r/b.js' }, '/x'), ['/r/b.js']);
  assert.deepEqual(editTargets('apply_patch', { input: '*** Begin Patch\n*** Update File: src/a.js\n@@\n*** Add File: src/b.js\n*** End Patch' }, '/r'), ['/r/src/a.js', '/r/src/b.js']);
  assert.deepEqual(editTargets('apply_patch', { input: '*** Update File: notes.yml\n*** Move to: .github/workflows/ci.yml\n' }, '/r'), ['/r/notes.yml', '/r/.github/workflows/ci.yml']);
  assert.match(planGateDecision(editTargets('apply_patch', { input: '*** Update File: notes.yml\n*** Move to: .github/workflows/ci.yml\n' }, '/r'), state(), cfg), /contract/);
});

test('minor tweaks (≤2 files) pass without a plan', () => {
  assert.equal(planGateDecision(['/r/a.js'], state(), cfg), null);
  assert.equal(planGateDecision(['/r/b.js'], state({ changed: new Set(['a.js']) }), cfg), null);
});

test('a third file needs a written AND approved plan', () => {
  const s = state({ changed: new Set(['a.js', 'b.js']) });
  assert.match(planGateDecision(['/r/c.js'], s, cfg), /3 changed files.*Write the plan first.*STOP — even in autopilot/);
  assert.match(planGateDecision(['/r/c.js'], { ...s, planExists: true }, cfg), /NOT approved.*STOP until they explicitly approve/);
  assert.equal(planGateDecision(['/r/c.js'], { ...s, planExists: true, approved: true }, cfg), null);
  assert.match(planGateDecision(['/r/c.js'], { ...s, planExists: false, approved: true }, cfg), /Write the plan first/);
});

test('re-editing an already changed file is always allowed', () => {
  assert.equal(planGateDecision(['/r/a.js'], state({ changed: new Set(['a.js', 'b.js', 'c.js']) }), cfg), null);
});

test('contract files need a plan even as the first change', () => {
  assert.match(planGateDecision(['/r/package.json'], state(), cfg), /"package.json" is a contract\/config file/);
  assert.match(planGateDecision(['/r/.github/workflows/ci.yml'], state(), cfg), /contract/);
  assert.match(planGateDecision(['/r/sub/wrangler.toml'], state(), cfg), /contract/);
});

test('files outside the repo, disabled gate and excluded repos are ignored', () => {
  const big = state({ changed: new Set(['a', 'b', 'c']) });
  assert.equal(planGateDecision(['/elsewhere/plan.md'], big, cfg), null);
  assert.equal(planGateDecision(['/r/d.js'], big, merge(cfg, { planGate: { enabled: false } })), null);
  assert.equal(planGateDecision(['/r/d.js'], big, merge(cfg, { planGate: { excludeRepos: ['ACME/web'] } })), null);
  assert.equal(planGateDecision(['/r/d.js'], big, merge(cfg, { planGate: { maxUnplannedFiles: 10 } })), null);
});

test('model defaults and family detection', () => {
  assert.equal(cfg.dev.model, 'claude-opus-5.5');
  assert.equal(cfg.review.codeModel, 'gpt-6.1-sol');
  assert.equal(modelFamily('claude-opus-5.5'), 'claude');
  assert.equal(modelFamily('opus'), 'claude');
  assert.notEqual(modelFamily(DEFAULTS.dev.claudeModel), modelFamily('gpt-6.1-sol'));
  assert.equal(modelFamily(DEFAULTS.dev.claudeModel), modelFamily('claude-opus-5.5'));
  assert.equal(modelFamily('gpt-6.1-sol'), 'gpt');
  assert.notEqual(modelFamily(cfg.dev.model), modelFamily(cfg.review.securityModel));
});

test('review.altModel defaults to the dev model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dh-cfg-'));
  const path = join(dir, 'config.json');
  try {
    assert.equal(loadConfig(join(dir, 'missing.json')).review.altModel, 'claude-opus-5.5');
    writeFileSync(path, JSON.stringify({ dev: { model: 'gpt-6.1-sol' }, review: { codeModel: 'claude-opus-5.5', securityModel: 'claude-opus-5.5' } }));
    assert.equal(loadConfig(path).review.altModel, 'gpt-6.1-sol');
    writeFileSync(path, JSON.stringify({ dev: { model: 'gpt-6.1-sol' } }));
    const defaulted = reviewConfigChecks(loadConfig(path)).find((c) => !c.ok && c.label.startsWith('review.altModel'));
    assert.match(defaulted.hint, /defaults to dev\.model \(gpt-6\.1-sol\).*or change the reviewer models/);
    assert.equal(DEFAULTS.review.altModel, '');
    writeFileSync(path, JSON.stringify({ review: { altModel: 'claude-sonnet-5.5' } }));
    assert.equal(loadConfig(path).review.altModel, 'claude-sonnet-5.5');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('review model checks flag same-family altModel once per distinct reviewer model', () => {
  const ok = reviewConfigChecks({ ...cfg, review: { ...cfg.review, altModel: 'claude-opus-5.5' } });
  assert.equal(ok.length, 3);
  assert.ok(ok.every((c) => c.ok));
  const bad = reviewConfigChecks({ ...cfg, review: { ...cfg.review, altModel: 'o3' } });
  assert.deepEqual(bad.filter((c) => !c.ok).map((c) => c.label), ['review.altModel o3 alternates with reviewer gpt-6.1-sol']);
  const legacy = reviewConfigChecks({ ...cfg, review: { ...cfg.review, altModel: 'claude-opus-5.5', maxFixRounds: 2 } });
  assert.deepEqual(legacy.filter((c) => !c.ok).map((c) => c.label), ['review.maxFixRounds is no longer used']);
  const limits = reviewConfigChecks({ ...cfg, review: { ...cfg.review, altModel: 'claude-opus-5.5', maxRounds: 0, cleanRoundsToStop: 1.5 } });
  assert.deepEqual(limits.filter((c) => !c.ok).map((c) => c.label), ['review.maxRounds 0 is a positive integer', 'review.cleanRoundsToStop 1.5 is a positive integer']);
  const pair = reviewConfigChecks({ ...cfg, review: { ...cfg.review, altModel: 'claude-opus-5.5', maxRounds: 1 } });
  assert.deepEqual(pair.filter((c) => !c.ok).map((c) => c.label), ['review.cleanRoundsToStop 2 is not more than review.maxRounds 1']);
});

test('session context Models line names the alternate model and stop rules', () => {
  const c = { ...cfg, review: { ...cfg.review, altModel: 'claude-opus-5.5' } };
  const text = buildSessionContext(c, {});
  assert.match(text, /alternating with claude-opus-5\.5 on every other round/);
  assert.match(text, /stop after 2 clean rounds in a row for both reviewers or 10 rounds/);
});
