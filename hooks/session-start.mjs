#!/usr/bin/env node
// sessionStart hook: injects repo profile, lessons and open handoffs; self-heals the git credential helper.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, preferredToken } from '../lib/config.mjs';
import { makeGitInfo } from '../lib/git.mjs';
import { buildSessionContext } from '../lib/context.mjs';
import { installCredentialHelper } from '../lib/credential.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readStdin() {
  return new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', () => res(data));
  });
}

async function main() {
  const raw = await readStdin();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const claude = 'hook_event_name' in payload;
  const cfg = loadConfig();
  if (preferredToken(cfg)) {
    try { installCredentialHelper(join(root, 'bin', 'git-credential-dev-harness')); } catch { /* best effort */ }
  }
  const info = makeGitInfo()(payload.cwd || process.cwd());
  const additionalContext = buildSessionContext(cfg, info);
  const out = claude
    ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }
    : { additionalContext };
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  if (process.env.DEV_HARNESS_DEBUG) process.stderr.write(`dev-harness session-start error: ${err.stack}\n`);
}).finally(() => process.exit(0));
