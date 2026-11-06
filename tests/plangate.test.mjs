import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, merge, modelFamily } from '../lib/config.mjs';
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
  assert.equal(modelFamily('gpt-6.1-sol'), 'gpt');
  assert.notEqual(modelFamily(cfg.dev.model), modelFamily(cfg.review.securityModel));
});
