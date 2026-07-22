/**
 * MCP Stdio End-to-End Test (v0.1.11)
 *
 * Starts index.js as a child process, connects via MCP stdio transport,
 * and verifies: tools/list, run_macro, dry_run, approval_required,
 * full mode, validation_failed, macro_status.
 *
 * Cross-platform: uses `node -e` for shell commands.
 */

import { spawn } from 'child_process';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync, rmdirSync, existsSync } from 'fs';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'index.js');

const NODE_BIN = existsSync('C:/Program Files/qclaw/resources/node/node.exe')
  ? 'C:/Program Files/qclaw/resources/node/node.exe'
  : 'node';
const ECHO = 'echo hello';
const STDERR_CMD = `"${NODE_BIN}" -e "console.error('warn msg'); console.log('ok')"`;

const TEST_DIR = resolve(__dirname, '..', '_test_e2e');
const TEST_FILE = join(TEST_DIR, 'test.txt');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  catch (err) { console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

function send(proc, id, method, params) {
  const req = { jsonrpc: '2.0', id, method, params };
  proc.stdin.write(JSON.stringify(req) + '\n');
}

function recv(rl, expectedId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for id ${expectedId}`)), timeoutMs);
    const handler = (line) => {
      try {
        const resp = JSON.parse(line);
        if (resp.id === expectedId) {
          clearTimeout(timer);
          rl.removeListener('line', handler);
          resolve(resp);
        }
      } catch (_) {}
    };
    rl.on('line', handler);
  });
}

// Setup
console.log('\n🔧 Setting up test workspace...');
try { rmdirSync(TEST_DIR, { recursive: true }); } catch (_) {}
mkdirSync(TEST_DIR, { recursive: true });
writeFileSync(TEST_FILE, 'hello world', 'utf8');

console.log('🔧 Starting MCP server...');
const proc = spawn(NODE_BIN, [SERVER_PATH], {
  cwd: join(__dirname, '..'),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MACRO_WORKSPACE_ROOT: TEST_DIR },
});

const rl = createInterface({ input: proc.stdout });
let id = 0;

// MCP initialize handshake
send(proc, ++id, 'initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'e2e-test', version: '1.0.0' },
});
const initResp = await recv(rl, id);
test('initialize succeeds', () => {
  assert(initResp.result, `Initialize failed: ${JSON.stringify(initResp.error)}`);
});

// Send initialized notification
send(proc, null, 'notifications/initialized', {});

// === Tests ===
console.log('\n📦 MCP E2E Tests');

// 1. tools/list
send(proc, ++id, 'tools/list', {});
const listResp = await recv(rl, id);
test('tools/list returns tools', () => {
  const names = listResp.result.tools.map(t => t.name);
  assert(names.includes('run_macro'), 'Missing run_macro');
  assert(names.includes('list_macros'), 'Missing list_macros');
  assert(names.includes('show_macro'), 'Missing show_macro');
  assert(names.includes('macro_status'), 'Missing macro_status');
});

// Parse text result helper
function parseText(resp) {
  return JSON.parse(resp.result.content[0].text);
}

// 2. run_macro (safe command)
send(proc, ++id, 'tools/call', {
  name: 'run_macro',
  arguments: { steps: [{ type: 'shell', command: ECHO, description: 'E2E safe' }] },
});
const runResp = await recv(rl, id);
test('run_macro completes', () => {
  const d = parseText(runResp);
  assert(d.status === 'completed', `Expected completed, got ${d.status}`);
  assert(d.passed_steps === 1, `Expected 1 passed, got ${d.passed_steps}`);
});

// 3. dry_run
send(proc, ++id, 'tools/call', {
  name: 'run_macro',
  arguments: { steps: [{ type: 'shell', command: 'npm test' }], dry_run: true },
});
const dryResp = await recv(rl, id);
test('dry_run returns preview', () => {
  const d = parseText(dryResp);
  assert(d.dry_run === true);
  assert(d.steps[0].action === 'shell', `Got ${d.steps[0]?.action}`);
  assert(d.steps[0].risk, 'Missing risk');
});

// 4. dry_run: dynamic command = risk_unknown
send(proc, ++id, 'tools/call', {
  name: 'run_macro',
  arguments: { steps: [{ type: 'shell', command: '${{cmd}}' }], dry_run: true },
});
const dryDynResp = await recv(rl, id);
test('dry_run: dynamic → risk_unknown', () => {
  const d = parseText(dryDynResp);
  assert(d.steps[0].risk === 'unknown', `Got ${d.steps[0]?.risk}`);
  assert(d.steps[0].dynamic === true);
});

// 5. approval_required
send(proc, ++id, 'tools/call', {
  name: 'run_macro',
  arguments: { steps: [{ type: 'shell', command: 'rm -rf /' }] },
});
const apprResp = await recv(rl, id);
test('dangerous → approval_required', () => {
  const d = parseText(apprResp);
  assert(d.status === 'approval_required', `Got ${d.status}`);
});

// 6. full mode preserves stderr
send(proc, ++id, 'tools/call', {
  name: 'run_macro',
  arguments: { steps: [{ type: 'shell', command: STDERR_CMD }], output_mode: 'full' },
});
const fullResp = await recv(rl, id);
test('full mode has stderr', () => {
  const d = parseText(fullResp);
  assert(typeof d.steps[0].stderr === 'string', 'Missing stderr');
});

// 7. validation_failed (unknown step type triggers validation error)
send(proc, ++id, 'tools/call', {
  name: 'run_macro',
  arguments: { steps: [{ type: 'bogus' }] },
});
const valResp = await recv(rl, id);
test('validation_failed', () => {
  const d = parseText(valResp);
  assert(d.status === 'validation_failed', `Got ${d.status}`);
});

// 8. macro_status
send(proc, ++id, 'tools/call', {
  name: 'macro_status',
  arguments: {},
});
const statResp = await recv(rl, id);
test('macro_status', () => {
  const d = parseText(statResp);
  assert(typeof d.requests_total === 'number');
  assert(d.requests_total > 0, 'No requests');
});

// Cleanup
console.log('\n🔧 Shutting down...');
proc.kill();
try { rmdirSync(TEST_DIR, { recursive: true }); } catch (_) {}
console.log('  Cleaned');

console.log(`\n${'='.repeat(40)}`);
console.log(`MCP E2E: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
