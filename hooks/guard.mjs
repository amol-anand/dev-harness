#!/usr/bin/env node
// preToolUse guard for Copilot (camelCase payload) and Claude Code (PreToolUse payload).
// Must never crash: Copilot treats a failing command preToolUse hook as "deny".
import { homedir } from 'node:os';
import { loadConfig } from '../lib/config.mjs';
import { evaluateCommand } from '../lib/rules.mjs';
import { makeGitInfo } from '../lib/git.mjs';

const SHELL_TOOLS = new Set(['bash', 'Bash', 'shell', 'run_in_terminal']);

function readStdin() {
  return new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', () => res(data));
  });
}

function extract(payload) {
  const claude = 'hook_event_name' in payload || 'tool_input' in payload;
  const tool = payload.toolName ?? payload.tool_name;
  let args = payload.toolArgs ?? payload.tool_input;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = { command: args }; }
  }
  return { claude, tool, command: args?.command, cwd: payload.cwd || process.cwd() };
}

function emit(claude, decision, reason) {
  if (decision !== 'deny') return;
  const out = claude
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
    : { permissionDecision: 'deny', permissionDecisionReason: reason };
  process.stdout.write(JSON.stringify(out));
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;
  const { claude, tool, command, cwd } = extract(JSON.parse(raw));
  if (!SHELL_TOOLS.has(tool) || typeof command !== 'string') return;
  if (!/\bgit\b|\bgh\b|gh-me/.test(command)) return;
  const res = evaluateCommand(command, {
    cfg: loadConfig(),
    env: process.env,
    cwd,
    home: process.env.HOME || homedir(),
    gitInfo: makeGitInfo(),
  });
  emit(claude, res.decision, `[dev-harness] ${res.reason || ''}`);
}

main().catch((err) => {
  if (process.env.DEV_HARNESS_DEBUG) process.stderr.write(`dev-harness guard error: ${err.stack}\n`);
}).finally(() => process.exit(0));
