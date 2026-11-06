import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// eslint-disable-next-line no-new-func
const run = new Function(`return (${readFileSync(join(ROOT, 'workflows', 'feature-graph.run.js'), 'utf8')})`)();

function mockCtx(args, respond) {
  const calls = [];
  const prompts = new Map();
  return {
    calls,
    prompts,
    ctx: {
      args,
      phase: () => {},
      log: () => {},
      parallel: async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))),
      agent: async (prompt, opts = {}) => { calls.push(opts); prompts.set(opts.label, prompt); return respond(opts, prompt); },
    },
  };
}

const args = {
  goal: 'Add DELETE route',
  plan: '# Plan\nAdd DELETE /schedule route and UI button',
  repos: [
    { path: '/w/api', repo: 'acme/api', branch: 'del-route' },
    { path: '/w/ui', repo: 'acme/ui', branch: 'del-ui' },
  ],
};

test('fix loop re-reviews only failing repos and runs the contract check', async () => {
  let apiCodeRound = 0;
  const { ctx, calls, prompts } = mockCtx(args, (o) => {
    if (o.label.startsWith('implement:')) return { summary: 'done', filesChanged: ['a.js'], verification: [], notVerified: '', diffPath: `/tmp/${o.label}.diff` };
    if (o.label.startsWith('code-review:acme/api')) {
      apiCodeRound += 1;
      return apiCodeRound === 1
        ? { verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'HIGH', location: 'a.js:1', issue: 'x', fix: 'y' }] }
        : { verdict: 'PASS', findings: [] };
    }
    if (o.label.includes('review')) return { verdict: o.agent === 'security-reviewer' ? 'NO_FINDINGS' : 'PASS', findings: [] };
    if (o.label.startsWith('fix:')) return { fixed: ['a.js:1'], disputed: [], diffPath: '/tmp/fixed.diff' };
    if (o.label === 'contract-check') return { verdict: 'PASS', findings: [] };
    return null;
  });
  const out = await run(ctx);
  const labels = calls.map((c) => c.label);
  assert.deepEqual(labels.filter((l) => l.startsWith('fix:')), ['fix:acme/api:r1']);
  assert.ok(labels.includes('code-review:acme/api:r1'));
  assert.ok(!labels.includes('code-review:acme/ui:r1'));
  assert.ok(labels.includes('contract-check'));
  assert.equal(calls.find((c) => c.label === 'code-review:acme/api:r0').model, 'gpt-6.1-sol');
  assert.equal(calls.find((c) => c.label === 'code-review:acme/api:r0').agent, 'code-reviewer');
  assert.equal(calls.find((c) => c.label === 'implement:acme/api').model, 'claude-opus-5.5');
  assert.equal(calls.find((c) => c.label === 'fix:acme/api:r1').model, 'claude-opus-5.5');
  assert.match(prompts.get('implement:acme/api'), /handoff write.*plan approve/);
  assert.equal(out.repos[0].codeVerdict, 'PASS');
  assert.match(prompts.get('code-review:acme/api:r1'), /\/tmp\/fixed\.diff/);
  assert.match(prompts.get('code-review:acme/ui:r0'), /\/tmp\/implement:acme\/ui\.diff/);
  assert.match(prompts.get('contract-check'), /untrusted/);
  assert.match(prompts.get('implement:acme/api'), /Add DELETE \/schedule route/);
  assert.equal(out.repos[0].openFindings.length, 0);
  assert.equal(out.repos[1].securityVerdict, 'NO_FINDINGS');
});

test('stops after maxFixRounds and reports open findings; gpt author gets claude reviewer', async () => {
  const { ctx, calls } = mockCtx({ ...args, repos: [args.repos[0]], authorFamily: 'gpt', maxFixRounds: 1 }, (o) => {
    if (o.label.startsWith('implement:')) return { summary: 'done', filesChanged: [], verification: [], notVerified: '', diffPath: '/tmp/x.diff' };
    if (o.label.startsWith('security-review')) return { verdict: 'FINDINGS', findings: [{ severity: 'CRITICAL', location: 'w.js:3', issue: 'authz', fix: 'check' }] };
    if (o.label.startsWith('code-review')) return { verdict: 'PASS', findings: [] };
    return 'ok';
  });
  const out = await run(ctx);
  assert.equal(calls.filter((c) => c.label.startsWith('fix:')).length, 1);
  assert.equal(out.repos[0].openFindings[0].severity, 'CRITICAL');
  assert.equal(out.contract, null);
  assert.equal(calls.find((c) => c.label.startsWith('security-review')).model, 'claude-opus-5.5');
  assert.equal(calls.find((c) => c.label.startsWith('implement:')).model, 'gpt-6.1-sol');
});

test('rejects same-family dev and review models', async () => {
  const { ctx } = mockCtx({ ...args, devModel: 'claude-opus-5.5', reviewModel: 'claude-sonnet-5.5' }, () => null);
  await assert.rejects(run(ctx), /different model family/);
});

test('validates args', async () => {
  const { ctx } = mockCtx({}, () => null);
  await assert.rejects(run(ctx), /args required/);
});
