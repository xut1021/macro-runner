/**
 * Macro Step Execution Engine
 *
 * Executes a sequence of steps (edit, shell, read, write, conditional, assert)
 * sequentially below the model boundary. Stops early on first failure by default.
 *
 * v0.1.4: All exceptions are caught and converted to structured step failures.
 *         try/finally guarantees rollback always runs. Branch results no longer
 *         pollute the top-level stepResults array. stop_on_error is recursive.
 *         Condition expressions are strictly validated.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, realpathSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, normalize, sep, dirname, basename, join } from 'path';
import { homedir } from 'os';
import { createRollbackManager } from './rollback.js';
import { checkCommand, auditSteps } from './guard.js';
import { sanitizeShellResult, sanitizeForLogging } from './sanitizer.js';
import { validateMacro } from './validator.js';

// === Configuration (dynamic to support runtime env changes) ===
const CONFIG = {
  get defaultTimeout() { return parseInt(process.env.MACRO_DEFAULT_TIMEOUT_MS || '300000'); },
  get defaultOutputMode() { return process.env.MACRO_DEFAULT_OUTPUT_MODE || 'summary'; },
  get trimOutputLines() { return parseInt(process.env.MACRO_TRIM_OUTPUT_LINES || '200'); },
  get workspaceRoot() { return process.env.MACRO_WORKSPACE_ROOT || null; },
  get allowOutsideWorkspace() { return process.env.MACRO_ALLOW_OUTSIDE_WORKSPACE === 'true'; },
  get benchmarkEnabled() { return process.env.MACRO_TOKEN_BENCHMARK_ENABLED === 'true'; },
  get benchmarkFile() { return process.env.MACRO_BENCHMARK_FILE || `${homedir()}/.claude/macro-benchmarks.jsonl`; },
  get stdoutMaxBytes() { return parseInt(process.env.MACRO_STDOUT_MAX_BYTES || '524288'); },
  get stderrMaxBytes() { return parseInt(process.env.MACRO_STDERR_MAX_BYTES || '524288'); },
  get dangerousCommandsMode() { return process.env.MACRO_DANGEROUS_COMMANDS || 'approve'; },
  get maxRollbackFileBytes() { return parseInt(process.env.MACRO_MAX_ROLLBACK_FILE_BYTES || '10485760'); },
  get maxRollbackTotalBytes() { return parseInt(process.env.MACRO_MAX_ROLLBACK_TOTAL_BYTES || '104857600'); },
};

// === Sentinel for unresolved references ===
// Must be a value that will never appear in real condition output.
// Used internally; checked in evaluateCondition after resolveString.
const UNRESOLVED = '__MACRO_UNRESOLVED__';

// === Run ID ===
let runCounter = 0;

export function generateRunId() {
  runCounter++;
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `mr_${date}_${rand}`;
}

// === Path Safety ===
function safeResolve(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;

  // Reject paths with suspicious patterns before resolution
  const normalized_input = filePath.replace(/\\/g, '/');
  if (normalized_input.includes('../') || normalized_input.includes('..\\')) {
    return null; // path traversal attempt
  }

  const resolved = resolve(filePath);
  const normalized = normalize(resolved);

  // Resolve symlinks to real path.
  // For files that don't exist yet, walk up to the nearest existing parent
  // and realpath THAT, then append the remaining relative path.
  let realPath;
  try {
    if (existsSync(resolved)) {
      realPath = realpathSync(resolved);
    } else {
      // Walk up to nearest existing parent
      let parent = resolved;
      const missingParts = [];
      while (parent && !existsSync(parent)) {
        const next = dirname(parent);
        if (next === parent) break; // reached root
        missingParts.unshift(basename(parent));
        parent = next;
      }
      if (parent && existsSync(parent)) {
        realPath = join(realpathSync(parent), ...missingParts);
      } else {
        realPath = resolved;
      }
    }
  } catch (_) {
    // v0.1.5: fail-closed — if workspace root is set and realpath fails,
    // reject rather than trust the lexical path
    if (CONFIG.workspaceRoot && !CONFIG.allowOutsideWorkspace) {
      return null;
    }
    realPath = resolved;
  }

  // Workspace root enforcement
  if (CONFIG.workspaceRoot && !CONFIG.allowOutsideWorkspace) {
    // v0.1.5: realpath the workspace root itself for consistent comparison
    let realRoot;
    try {
      realRoot = realpathSync(resolve(CONFIG.workspaceRoot));
    } catch (_) {
      realRoot = normalize(resolve(CONFIG.workspaceRoot));
    }
    const root = realRoot;
    // Ensure root ends with separator for proper prefix matching
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (!(realPath + sep).startsWith(rootWithSep) && realPath !== root) {
      return null; // outside workspace
    }
  }

  return resolved;
}

// === Execution Context ===
// Holds step results and variables accessible to later steps
class ExecutionContext {
  constructor() {
    /** Top-level step results only — indexed by position (0, 1, 2, ...) */
    this.stepResults = [];
    /** Step results keyed by explicit id (optional stable references) */
    this.idIndex = new Map();
    /** User-defined variables (assign_to) */
    this.variables = {};
    this.startTime = Date.now();
  }

  addStepResult(index, result) {
    this.stepResults[index] = result;
    this.registerResultId(result);
  }

  /**
   * v0.1.5: Register a result by its explicit step ID in the idIndex.
   * Called for ALL results including branch sub-steps. Top-level results
   * also go through addStepResult which calls this.
   */
  registerResultId(result) {
    if (result._step_id) {
      this.idIndex.set(result._step_id, result);
    }
  }

  setVariable(name, value) {
    this.variables[name] = value;
  }

  /**
   * Resolve a single property reference like step[0].exit_code to its value.
   * Also supports steps.{id}.property for explicit step IDs.
   * Returns the raw value string, or the input unchanged if it's not a reference.
   */
  resolvePropertyRef(ref) {
    // ${{variable_name}} — user-defined variables
    for (const [key, value] of Object.entries(this.variables)) {
      if (ref === `\${{${key}}}`) return String(value);
    }

    // ${{steps.ID.property}} — explicit ID references (checked before step[N])
    const idMatch = ref.match(/^\$\{\{steps\.(\w+)\.(.+?)\}\}$/);
    if (idMatch) {
      const result = this.idIndex.get(idMatch[1]);
      if (!result) return UNRESOLVED;
      return String(this._getStepProp(result, idMatch[2]));
    }

    // ${{step[N].property}} — wrapped references
    const wrappedMatch = ref.match(/^\$\{\{step\[(\d+)\]\.(.+?)\}\}$/);
    if (wrappedMatch) {
      const result = this.stepResults[parseInt(wrappedMatch[1])];
      if (!result) return UNRESOLVED;
      return String(this._getStepProp(result, wrappedMatch[2]));
    }

    // step[N].property — bare references (without ${{}})
    const bareMatch = ref.match(/^step\[(\d+)\]\.(.+?)$/);
    if (bareMatch) {
      const result = this.stepResults[parseInt(bareMatch[1])];
      if (!result) return UNRESOLVED;
      return String(this._getStepProp(result, bareMatch[2]));
    }

    return ref;
  }

  _getStepProp(result, prop) {
    switch (prop) {
      case 'exit_code': return result.exit_code ?? '';
      case 'status': return result.ok ? 'success' : 'failure';
      case 'stdout': return result.stdout ?? '';
      case 'stderr': return result.stderr ?? '';
      default: return UNRESOLVED;
    }
  }

  /**
   * Resolve all variable and step references in a string.
   */
  resolveString(str) {
    if (typeof str !== 'string') return str;

    let resolved = str;

    // First: ${{variable_name}} from user variables
    // v0.1.5: callback form prevents $&, $', $` interpretation in replacement
    for (const [key, value] of Object.entries(this.variables)) {
      resolved = resolved.replace(
        new RegExp(`\\$\\{\\{${key}\\}\\}`, 'g'),
        () => String(value)
      );
    }

    // Then: ${{step[N].property}} — wrapped references (before ID refs)
    resolved = resolved.replace(
      /\$\{\{step\[(\d+)\]\.(.+?)\}\}/g,
      (_, index, prop) => {
        const result = this.stepResults[parseInt(index)];
        if (!result) return UNRESOLVED;
        return String(this._getStepProp(result, prop));
      }
    );

    // Then: ${{steps.ID.property}} — explicit ID references
    resolved = resolved.replace(
      /\$\{\{steps\.(\w+)\.(.+?)\}\}/g,
      (_, id, prop) => {
        const result = this.idIndex.get(id);
        if (!result) return UNRESOLVED;
        return String(this._getStepProp(result, prop));
      }
    );

    // Bare step[N].property — unwrapped references
    resolved = resolved.replace(
      /step\[(\d+)\]\.(exit_code|status|stdout|stderr)/g,
      (_, index, prop) => {
        const result = this.stepResults[parseInt(index)];
        if (!result) return UNRESOLVED;
        return String(this._getStepProp(result, prop));
      }
    );

    // Bare steps.ID.property — unwrapped explicit ID references
    resolved = resolved.replace(
      /steps\.(\w+)\.(exit_code|status|stdout|stderr)/g,
      (_, id, prop) => {
        const result = this.idIndex.get(id);
        if (!result) return UNRESOLVED;
        return String(this._getStepProp(result, prop));
      }
    );

    return resolved;
  }

  /**
   * Calculate remaining time in ms from the macro-level timeout.
   */
  remainingMs(totalTimeoutMs) {
    if (!totalTimeoutMs) return Infinity;
    const elapsed = Date.now() - this.startTime;
    return Math.max(0, totalTimeoutMs - elapsed);
  }

  /**
   * Check if the macro-level timeout has expired.
   */
  isTimedOut(totalTimeoutMs) {
    return this.remainingMs(totalTimeoutMs) <= 0;
  }
}

// === Step Execution ===

/**
 * Execute an edit step: find old_str in file and replace with new_str.
 */
function executeEdit(step) {
  // Validate raw parameters BEFORE resolve()
  const rawPath = step.path || step.file;
  if (!rawPath || (typeof rawPath !== 'string')) {
    return { ok: false, error: 'edit step requires "path" or "file" (a non-empty string)' };
  }
  const oldStr = step.old_str ?? step.old_string;
  if (oldStr === undefined || oldStr === null || oldStr === '') {
    return { ok: false, error: 'edit step requires "old_str" (a non-empty string)' };
  }
  const newStr = step.new_str ?? step.new_string;
  if (newStr === undefined || newStr === null) {
    return { ok: false, error: 'edit step requires "new_str" (missing — would replace with nothing)' };
  }

  const filePath = safeResolve(rawPath);
  if (!filePath) {
    return { ok: false, error: `Invalid or unsafe path: ${rawPath}` };
  }

  const createIfMissing = step.create_if_missing || false;

  if (!existsSync(filePath)) {
    if (createIfMissing) {
      writeFileSync(filePath, newStr, 'utf8');
      return { ok: true, summary: `Created file ${rawPath}`, replacements: 1 };
    }
    return { ok: false, error: `File not found: ${rawPath}` };
  }

  const content = readFileSync(filePath, 'utf8');

  // Count occurrences
  const occurrences = content.split(oldStr).length - 1;
  if (occurrences === 0) {
    return {
      ok: false,
      error: `old_str not found in ${rawPath}. File has ${content.split('\n').length} lines.`,
      hint: 'The target text was not found. Try reading the file first to get exact content.',
    };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      error: `old_str matches ${occurrences} locations in ${rawPath}. Must be unique.`,
      hint: 'Add more surrounding context to make old_str match exactly one location.',
    };
  }

  const newContent = content.replace(oldStr, newStr);
  writeFileSync(filePath, newContent, 'utf8');

  return {
    ok: true,
    summary: `Replaced in ${rawPath} (1 match)`,
    replacements: 1,
  };
}

/**
 * Execute a write step: create or overwrite a file.
 */
function executeWrite(step) {
  // Validate raw parameters BEFORE resolve()
  const rawPath = step.path || step.file;
  if (!rawPath || (typeof rawPath !== 'string')) {
    return { ok: false, error: 'write step requires "path" (a non-empty string)' };
  }
  if (step.content === undefined || step.content === null) {
    return { ok: false, error: 'write step requires "content" parameter' };
  }

  const filePath = safeResolve(rawPath);
  if (!filePath) {
    return { ok: false, error: `Invalid or unsafe path: ${rawPath}` };
  }

  writeFileSync(filePath, step.content, 'utf8');
  const lineCount = String(step.content).split('\n').length;
  return {
    ok: true,
    summary: `Wrote ${lineCount} lines to ${rawPath}`,
  };
}

/**
 * Execute a shell step: run a command and capture output.
 * Uses spawnSync for proper stdout/stderr separation.
 */
function executeShell(step, remainingTimeout) {
  const command = step.command;
  if (!command || typeof command !== 'string') {
    return { ok: false, error: 'shell step requires "command" (a non-empty string)' };
  }

  const cwd = step.cwd ? resolve(step.cwd) : process.cwd();
  // v0.1.4: use ?? to respect explicit 0 as "immediate timeout"
  const stepTimeout = step.timeout_ms ?? step.timeout ?? CONFIG.defaultTimeout;

  // Enforce macro-level timeout: use the smaller of step timeout and remaining time
  const effectiveTimeout = Math.min(stepTimeout, remainingTimeout ?? Infinity);
  if (effectiveTimeout <= 0) {
    return {
      ok: false,
      error: 'Skipped: macro-level timeout would expire before this step could run',
      exit_code: null,
      stdout: '',
      stderr: '',
      duration_ms: 0,
      timed_out: true,
      summary: 'Step skipped due to macro timeout',
    };
  }

  const env = { ...process.env, ...(step.env || {}) };
  const startTime = Date.now();

  const result = spawnSync(command, [], {
    cwd,
    env,
    timeout: effectiveTimeout,
    maxBuffer: 10 * 1024 * 1024, // 10MB
    encoding: 'utf8',
    shell: true,
  });

  // Enforce per-channel output size limits
  let stdout = result.stdout || '';
  let stderr = result.stderr || '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const stdoutOrigBytes = Buffer.byteLength(stdout, 'utf8');
  const stderrOrigBytes = Buffer.byteLength(stderr, 'utf8');

  if (stdoutOrigBytes > CONFIG.stdoutMaxBytes) {
    stdout = stdout.slice(0, CONFIG.stdoutMaxBytes);
    stdout += `\n[... truncated: ${stdoutOrigBytes - CONFIG.stdoutMaxBytes} bytes omitted ...]`;
    stdoutTruncated = true;
  }
  if (stderrOrigBytes > CONFIG.stderrMaxBytes) {
    stderr = stderr.slice(0, CONFIG.stderrMaxBytes);
    stderr += `\n[... truncated: ${stderrOrigBytes - CONFIG.stderrMaxBytes} bytes omitted ...]`;
    stderrTruncated = true;
  }

  // Sanitize output for secrets
  const sanitized = sanitizeShellResult({ stdout, stderr });
  stdout = sanitized.stdout;
  stderr = sanitized.stderr;

  const duration = Date.now() - startTime;

  if (result.error) {
    // spawnSync error (e.g. command not found, killed by timeout)
    const isTimeout = result.error.code === 'ETIMEDOUT' ||
      result.error.message?.includes('timed out');
    return {
      ok: false,
      exit_code: result.status || (isTimeout ? 124 : 127),
      stdout,
      stderr: stderr || result.error.message,
      stdout_truncated: stdoutTruncated || undefined,
      stderr_truncated: stderrTruncated || undefined,
      sanitized: sanitized._sanitized || undefined,
      duration_ms: duration,
      summary: isTimeout
        ? `Command timed out after ${effectiveTimeout}ms`
        : `Command failed: ${result.error.message}`,
      error: result.error.message,
      timed_out: isTimeout,
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      exit_code: result.status,
      stdout,
      stderr,
      stdout_truncated: stdoutTruncated || undefined,
      stderr_truncated: stderrTruncated || undefined,
      sanitized: sanitized._sanitized || undefined,
      duration_ms: duration,
      summary: `Command failed with exit code ${result.status}`,
      error: stderr ? stderr.split('\n').slice(0, 20).join('\n') : stdout.split('\n').slice(0, 20).join('\n'),
    };
  }

  // Success — keep both stdout and stderr
  return {
    ok: true,
    exit_code: 0,
    stdout,
    stderr,
    stdout_truncated: stdoutTruncated || undefined,
    stderr_truncated: stderrTruncated || undefined,
    stdout_orig_bytes: stdoutTruncated ? stdoutOrigBytes : undefined,
    stderr_orig_bytes: stderrTruncated ? stderrOrigBytes : undefined,
    sanitized: sanitized._sanitized || undefined,
    duration_ms: duration,
    summary: `Command succeeded in ${duration}ms`,
  };
}

/**
 * Execute a read step: read file content (optionally with offset/limit).
 */
function executeRead(step) {
  // Validate raw parameters BEFORE resolve()
  const rawPath = step.path || step.file;
  if (!rawPath || (typeof rawPath !== 'string')) {
    return { ok: false, error: 'read step requires "path" (a non-empty string)' };
  }

  const filePath = safeResolve(rawPath);
  if (!filePath) {
    return { ok: false, error: `Invalid or unsafe path: ${rawPath}` };
  }
  if (!existsSync(filePath)) {
    return { ok: false, error: `File not found: ${rawPath}` };
  }

  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  // v0.1.4: use ?? to respect explicit 0 values
  const offset = step.offset ?? 0;
  const limit = step.limit ?? 200;
  const sliced = lines.slice(offset, offset + limit);

  return {
    ok: true,
    content: sliced.join('\n'),
    total_lines: lines.length,
    returned_lines: sliced.length,
    summary: `Read ${sliced.length} of ${lines.length} lines from ${rawPath}`,
  };
}

/**
 * Evaluate a condition string against the execution context.
 *
 * v0.1.4: Returns {valid, value, error} instead of boolean.
 * Invalid expressions now fail explicitly instead of defaulting to truthy.
 *
 * Resolves all property references BEFORE comparison, so both forms work:
 *   step[0].exit_code == 0
 *   ${{step[0].exit_code}} == 0
 *
 * @returns {{ valid: boolean, value: boolean, error?: string }}
 */
function evaluateCondition(condition, context) {
  // First resolve ${{var}} user-variable references (but NOT step[N] references)
  let partial = condition;
  for (const [key, value] of Object.entries(context.variables)) {
    partial = partial.replace(new RegExp(`\\$\\{\\{${key}\\}\\}`, 'g'), String(value));
  }

  // Match stdout_contains() BEFORE step[N] references are resolved
  // v0.1.5: anchored patterns — must be exactly step[N].stdout_contains("...")
  const containsMatch = partial.match(/^step\[(\d+)\]\.stdout_contains\("([^"]*)"\)$/);
  if (containsMatch) {
    const index = parseInt(containsMatch[1]);
    const pattern = containsMatch[2];
    const result = context.stepResults[index];
    if (result && result.stdout) {
      return { valid: true, value: result.stdout.includes(pattern) };
    }
    return { valid: true, value: false };
  }

  // Also support steps.ID.stdout_contains for explicit step IDs
  const idContainsMatch = partial.match(/^steps\.(\w+)\.stdout_contains\("([^"]*)"\)$/);
  if (idContainsMatch) {
    const id = idContainsMatch[1];
    const pattern = idContainsMatch[2];
    const result = context.idIndex.get(id);
    if (result && result.stdout) {
      return { valid: true, value: result.stdout.includes(pattern) };
    }
    return { valid: true, value: false };
  }

  // Now resolve step[N].property references
  const resolved = context.resolveString(partial);

  // v0.1.5: Detect unresolved step references (typo property names, missing steps, sentinel)
  // After resolveString, any remaining step[N].xxx or steps.X.yyy pattern, or the
  // UNRESOLVED sentinel, means the reference could not be resolved → invalid expression.
  if (resolved.includes(UNRESOLVED) ||
      /\b(?:step\[\d+\]\.\w+|steps\.\w+\.\w+)/.test(resolved)) {
    return {
      valid: false,
      value: false,
      error: `Unresolved step reference in condition: "${condition}". ` +
        'Check the step index/ID and property name. Valid properties: exit_code, status, stdout, stderr.',
    };
  }

  // Support: LHS OP RHS  (e.g. "0 == 0", "success == success")
  const cmpMatch = resolved.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (cmpMatch) {
    const [, left, op, right] = cmpMatch;
    const lVal = left.trim().replace(/^"(.*)"$/, '$1');
    const rVal = right.trim().replace(/^"(.*)"$/, '$1');

    // v0.1.5: strict number matching — "0abc" is NOT a number
    const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;
    const lNum = NUMBER_RE.test(lVal) ? parseFloat(lVal) : NaN;
    const rNum = NUMBER_RE.test(rVal) ? parseFloat(rVal) : NaN;
    if (!isNaN(lNum) && !isNaN(rNum)) {
      switch (op) {
        case '==': return { valid: true, value: lNum === rNum };
        case '!=': return { valid: true, value: lNum !== rNum };
        case '>=': return { valid: true, value: lNum >= rNum };
        case '<=': return { valid: true, value: lNum <= rNum };
        case '>': return { valid: true, value: lNum > rNum };
        case '<': return { valid: true, value: lNum < rNum };
      }
    }

    // String comparison
    switch (op) {
      case '==': return { valid: true, value: lVal === rVal };
      case '!=': return { valid: true, value: lVal !== rVal };
      default: return { valid: true, value: false };
    }
  }

  // Boolean literals
  const trimmed = resolved.trim();
  if (trimmed === 'true' || trimmed === '1') return { valid: true, value: true };
  if (trimmed === 'false' || trimmed === '0' || trimmed === '') return { valid: true, value: false };

  // v0.1.4: Unrecognized expression → fail explicitly (was: return !!trimmed)
  return {
    valid: false,
    value: false,
    error: `Unrecognized condition expression: "${trimmed}". ` +
      'Supported forms: step[N].exit_code == N, step[N].status == "success", ' +
      'step[N].stdout_contains("text"), steps.ID.property, true/false, or a comparison with ==/!=/>=/<=/>/<.',
  };
}

/**
 * Execute a conditional step: evaluate condition and run then/else substeps.
 *
 * v0.1.4: Branch sub-step results are NOT added to the global stepResults array.
 * They live only in the conditional result's branch_results field.
 * stop_on_error is now recursive within branches.
 */
function executeConditional(step, context, stopOnError) {
  if (!step.condition) {
    return { ok: false, error: 'conditional step requires "condition" parameter' };
  }

  const evalResult = evaluateCondition(step.condition, context);
  if (!evalResult.valid) {
    return {
      ok: false,
      error: evalResult.error,
      condition_error: true,
    };
  }

  const conditionMet = evalResult.value;
  const branch = conditionMet ? (step.then || []) : (step.else || []);

  if (branch.length === 0) {
    return {
      ok: true,
      condition_met: conditionMet,
      summary: `Condition ${conditionMet ? 'met' : 'not met'} — no steps to run`,
    };
  }

  // Execute branch steps sequentially (inherit deadline and rollback from parent)
  const results = [];
  const deadline = step._deadline !== undefined ? step._deadline : Infinity;
  for (let i = 0; i < branch.length; i++) {
    const subStep = branch[i];
    // Recalculate remaining from absolute deadline
    const remaining = deadline < Infinity ? Math.max(0, deadline - Date.now()) : Infinity;
    const result = executeStep(subStep, context, remaining, step._rollback, stopOnError);
    result._branch_index = i;
    result._branch_name = conditionMet ? 'then' : 'else';
    results.push(result);

    // v0.1.5: Register branch step IDs for cross-branch references.
    // Branch results are NOT added to context.stepResults (top-level only),
    // but explicit IDs are registered so steps.build.exit_code works.
    context.registerResultId(result);

    if (!result.ok) {
      if (stopOnError) {
        return {
          ok: false,
          condition_met: conditionMet,
          error: result.error || `Conditional branch sub-step ${i} failed`,
          timed_out: result.timed_out === true || undefined,
          summary: `Conditional ${conditionMet ? 'then' : 'else'} branch failed at sub-step ${i}: ${result.error || 'unknown error'}`,
          branch_results: results,
        };
      }
      // stop_on_error: false — record failure and continue branch
    }
  }

  // Determine overall status: ok if all branch steps passed
  const allOk = results.every(r => r.ok);
  const branchOk = results.filter(r => r.ok).length;
  const firstFail = results.find(r => !r.ok);
  // v0.1.5: propagate timeout from any branch sub-step
  const anyTimedOut = results.some(r => r.timed_out);

  return {
    ok: allOk,
    condition_met: conditionMet,
    // Propagate error from first failed branch step (both stop_on_error modes)
    error: firstFail ? (firstFail.error || 'Branch sub-step failed') : undefined,
    timed_out: anyTimedOut || undefined,
    summary: allOk
      ? `Condition ${conditionMet ? 'met' : 'not met'} — ran ${branch.length} sub-steps`
      : `Condition ${conditionMet ? 'met' : 'not met'} — ${branchOk}/${branch.length} sub-steps passed`,
    branches_executed: branch.length,
    branches_passed: branchOk,
    branches_failed: results.length - branchOk,
    branch_results: results,
  };
}

/**
 * Execute an assert step: check a condition and fail if not met.
 *
 * v0.1.4: Uses strict evaluateCondition — unrecognized expressions fail.
 */
function executeAssert(step, context) {
  if (!step.condition) {
    return { ok: false, error: 'assert step requires "condition" parameter' };
  }

  const evalResult = evaluateCondition(step.condition, context);
  if (!evalResult.valid) {
    return {
      ok: false,
      error: `Invalid assertion expression: ${evalResult.error}`,
      assertion: step.condition,
    };
  }

  if (!evalResult.value) {
    return {
      ok: false,
      error: step.message || `Assertion failed: ${step.condition}`,
      assertion: step.condition,
    };
  }

  return {
    ok: true,
    summary: `Assertion passed: ${step.condition}`,
  };
}

/**
 * Internal step dispatch — the actual logic without exception handling.
 */
function _executeStepImpl(step, context, remainingMs, rollback, stopOnError) {
  // Resolve variables in step parameters (safe: only string fields, validated inside handlers)
  const resolvedStep = { ...step };
  // Resolve variables in string fields EXCEPT condition (evaluated later in evaluateCondition)
  for (const key of ['path', 'file', 'command', 'old_str', 'old_string', 'new_str', 'new_string', 'content', 'message']) {
    if (typeof step[key] === 'string') {
      resolvedStep[key] = context.resolveString(step[key]);
    }
  }
  // Keep condition raw for evaluateCondition
  if (typeof step.condition === 'string') {
    resolvedStep.condition = step.condition;
  }

  // Snapshot files before edit/write at ALL nesting levels
  // v0.1.4: snapshot returns {ok, error} — fail if size limits exceeded
  if (rollback && (resolvedStep.type === 'edit' || resolvedStep.type === 'write')) {
    const rawPath = resolvedStep.path || resolvedStep.file;
    if (rawPath && typeof rawPath === 'string') {
      const filePath = safeResolve(rawPath);
      if (filePath) {
        const snapResult = rollback.snapshot(filePath);
        if (!snapResult.ok) {
          return { ok: false, error: snapResult.error, type: resolvedStep.type };
        }
        if (!existsSync(filePath) && resolvedStep.type === 'write') {
          rollback.markCreated(filePath);
        }
      }
    }
  }

  // Pass absolute deadline, rollback, and stop_on_error to conditional branches
  if (resolvedStep.type === 'conditional') {
    resolvedStep._deadline = remainingMs < Infinity
      ? Date.now() + remainingMs
      : Infinity;
    resolvedStep._rollback = rollback;
    resolvedStep._stopOnError = stopOnError;
  }

  let result;
  const startTime = Date.now();

  switch (resolvedStep.type) {
    case 'edit':
      result = executeEdit(resolvedStep);
      break;
    case 'write':
      result = executeWrite(resolvedStep);
      break;
    case 'shell':
      result = executeShell(resolvedStep, remainingMs);
      break;
    case 'read':
      result = executeRead(resolvedStep);
      break;
    case 'conditional':
      result = executeConditional(resolvedStep, context, stopOnError);
      break;
    case 'assert':
      result = executeAssert(resolvedStep, context);
      break;
    default:
      result = {
        ok: false,
        error: `Unknown step type: "${resolvedStep.type}". Supported: edit, write, shell, read, conditional, assert.`,
      };
  }

  result.duration_ms = Date.now() - startTime;
  result.type = resolvedStep.type;
  result.description = resolvedStep.description || '';
  // v0.1.5: carry trim_output_lines so summarizer uses the step's setting
  result.trim_output_lines = resolvedStep.trim_output_lines ?? CONFIG.trimOutputLines;
  // Preserve explicit step id for stable cross-step references
  if (resolvedStep.id) {
    result._step_id = resolvedStep.id;
  }

  // Handle variable assignment from read steps
  if (resolvedStep.assign_to && result.ok && result.content !== undefined) {
    const varName = resolvedStep.assign_to;
    // v0.1.4: validate variable name to prevent regex injection and ambiguity
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
      return {
        ok: false,
        error: `Invalid variable name "${varName}" in assign_to: must match /^[A-Za-z_][A-Za-z0-9_]*$/. ` +
          'Use only letters, digits, and underscores, starting with a letter or underscore.',
        type: resolvedStep.type,
        description: resolvedStep.description || '',
      };
    }
    context.setVariable(varName, result.content);
  }

  return result;
}

/**
 * Execute a single step with full exception safety.
 *
 * v0.1.4: All synchronous exceptions (ENOENT, EACCES, ENOSPC, etc.) are caught
 * and converted to structured step failures. This guarantees the main loop
 * always reaches the rollback/finalization phase.
 */
function executeStep(step, context, remainingMs, rollback, stopOnError) {
  try {
    return _executeStepImpl(step, context, remainingMs, rollback, stopOnError);
  } catch (error) {
    return {
      ok: false,
      type: step.type || 'unknown',
      description: step.description || '',
      error: error instanceof Error ? error.message : String(error),
      error_code: error?.code || undefined,
      exception: true,
      duration_ms: 0,
    };
  }
}

// === Main Entry Point ===

/**
 * Run a complete macro: validate, audit, snapshot, execute, rollback.
 *
 * v0.1.4: try/finally guarantees rollback always runs, even if an unexpected
 * exception escapes the main execution loop.
 *
 * @param {Array} steps - Array of step objects
 * @param {Object} options - { stop_on_error, timeout_ms, dry_run, rollback_on_error, schema_version }
 * @returns {Object} Macro result with status, step results, and timing
 */
export function runMacro(steps, options = {}) {
  const runId = generateRunId();
  const stopOnError = options.stop_on_error !== false;
  // v0.1.4: use ?? to respect explicit 0
  const macroTimeoutMs = options.timeout_ms ?? null;
  const dryRun = options.dry_run === true;
  const rollbackOnError = options.rollback_on_error === true;
  const context = new ExecutionContext();
  const results = [];
  let firstFailure = -1;
  let timedOut = false;
  let rolledBack = false;
  let rollbackFailed = false;
  let rollbackResult = null;

  // ---- Phase 0: Pre-validation ----
  const validation = validateMacro(steps, options);
  if (!validation.valid) {
    return {
      status: 'validation_failed',
      run_id: runId,
      errors: validation.errors,
      warnings: validation.warnings,
      executed_steps: 0,
      passed_steps: 0,
      failed_steps: 0,
      total_steps: steps.length,
      total_duration_ms: 0,
      steps: [],
    };
  }

  // ---- Dry run: preview only, no execution (runs before safety audit) ----
  if (dryRun) {
    // Still run audit to include risk info in preview
    const dangerPreview = auditSteps(steps);
    const preview = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      preview.push(dryRunPreview(step, context, i));
    }
    return {
      status: 'completed',
      run_id: runId,
      dry_run: true,
      executed_steps: 0,
      passed_steps: 0,
      failed_steps: 0,
      total_steps: steps.length,
      total_duration_ms: Date.now() - context.startTime,
      dry_run_safety: dangerPreview ? {
        has_danger: true,
        risk: dangerPreview.risk,
        reasons: dangerPreview.reasons,
      } : { has_danger: false },
      steps: preview,
    };
  }

  // ---- Phase 0.5: Command safety audit ----
  const danger = auditSteps(steps);
  if (danger && !danger.approved) {
    return {
      status: 'approval_required',
      run_id: runId,
      risk: danger.risk,
      reasons: danger.reasons,
      blocked_command: danger.command,
      blocked_at_step: danger.step_index,
      executed_steps: 0,
      passed_steps: 0,
      failed_steps: 0,
      total_steps: steps.length,
      total_duration_ms: 0,
      steps: [],
      hint: `Set MACRO_DANGEROUS_COMMANDS=warn to bypass, or =deny to block all dangerous commands. Currently: ${CONFIG.dangerousCommandsMode}`,
    };
  }

  // ---- Phase 1: Setup rollback (only when executing, not dry run) ----
  const rollback = rollbackOnError ? createRollbackManager() : null;

  // ---- Phase 2: Execute (with try/finally for guaranteed rollback) ----
  let macroFailed = false;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Check macro-level timeout before each step
      if (context.isTimedOut(macroTimeoutMs)) {
        timedOut = true;
        const timeoutResult = {
          ok: false,
          error: 'Macro-level timeout reached before this step could start.',
          type: step.type || 'unknown',
          description: step.description || '',
          index: i,
          timed_out: true,
        };
        results.push(timeoutResult);
        context.addStepResult(i, timeoutResult);
        if (firstFailure < 0) firstFailure = i;
        break;
      }

      // Validate step has a type
      if (!step.type) {
        const errResult = {
          ok: false,
          error: `Step ${i + 1} is missing "type" field. Each step must have a type.`,
          type: 'unknown',
          description: step.description || '',
          index: i,
        };
        results.push(errResult);
        context.addStepResult(i, errResult);
        if (firstFailure < 0) firstFailure = i;
        if (stopOnError) break;
        continue;
      }

      // Execute step with remaining time budget (snapshot handled in executeStep)
      const remaining = context.remainingMs(macroTimeoutMs);
      const result = executeStep(step, context, remaining, rollback, stopOnError);
      result.index = i;
      results.push(result);
      context.addStepResult(i, result);

      // Check for timeout
      if (result.timed_out) {
        timedOut = true;
        if (firstFailure < 0) firstFailure = i;
        break;
      }

      if (!result.ok) {
        if (firstFailure < 0) firstFailure = i;
        if (stopOnError) break;
      }
    }

    macroFailed = firstFailure >= 0 || timedOut;

  } finally {
    // ---- Phase 3: Rollback on failure — ALWAYS runs (v0.1.4) ----
    if (macroFailed && rollback) {
      try {
        rollbackResult = rollback.rollback();
        // Check for per-file failures in the rollback result
        if (rollbackResult.failed && rollbackResult.failed.length > 0) {
          rollbackFailed = true;
        } else {
          rolledBack = true;
        }
      } catch (err) {
        rollbackFailed = true;
        rollbackResult = { error: err.message };
      }
    } else if (!macroFailed && rollback) {
      rollback.clear(); // success — discard snapshots
    }
  }

  const executedSteps = results.length;
  const passedSteps = results.filter(r => r.ok).length;
  const failedSteps = results.filter(r => !r.ok).length;

  // Recursive leaf step counting
  const leafPlanned = countPlannedLeaves(steps);
  const leafExecuted = countExecutedLeaves(results);
  const totalDuration = Date.now() - context.startTime;

  // Determine status — rollback failure always takes highest priority
  let status;
  if (rollbackFailed) {
    status = 'rollback_failed';
  } else if (rolledBack) {
    status = 'rolled_back';
  } else if (timedOut) {
    status = 'timed_out';
  } else if (firstFailure >= 0) {
    status = stopOnError ? 'failed_early' : 'completed_with_failures';
  } else {
    status = 'completed';
  }

  // Preserve execution vs rollback distinction for diagnostics
  let execution_status;
  if (timedOut) execution_status = 'timed_out';
  else if (firstFailure >= 0) execution_status = stopOnError ? 'failed_early' : 'completed_with_failures';
  else execution_status = 'completed';

  let rollback_status;
  if (rollbackFailed) rollback_status = 'failed';
  else if (rolledBack) rollback_status = 'rolled_back';
  else rollback_status = 'none';

  // Token savings estimate
  const tokenEstimate = estimateTokenSavings(leafPlanned, leafExecuted, results);

  return {
    status,
    execution_status: execution_status || undefined,
    rollback_status: rollback_status || undefined,
    run_id: runId,
    top_level_steps: steps.length,
    executed_steps: executedSteps,
    passed_steps: passedSteps,
    failed_steps: failedSteps,
    leaf_steps_planned: leafPlanned,
    leaf_steps_executed: leafExecuted,
    leaf_steps_skipped: Math.max(0, leafPlanned - leafExecuted),
    total_steps: steps.length,
    failed_at_step: firstFailure >= 0 ? firstFailure : null,
    total_duration_ms: totalDuration,
    timed_out: timedOut,
    rolled_back: rolledBack || undefined,
    rollback_result: rollbackResult || undefined,
    token_savings_estimate: tokenEstimate,
    steps: results,
  };
}

/**
 * Generate a dry-run preview for a step without executing it.
 */
function dryRunPreview(step, context, index) {
  const resolvedStep = { ...step };
  for (const key of ['path', 'file', 'command', 'old_str', 'new_str', 'content', 'condition', 'message']) {
    if (typeof step[key] === 'string') {
      resolvedStep[key] = context.resolveString(step[key]);
    }
  }

  const preview = {
    index,
    type: resolvedStep.type || 'unknown',
    description: resolvedStep.description || '',
  };

  switch (resolvedStep.type) {
    case 'edit':
      preview.action = 'edit_file';
      preview.file = resolvedStep.path || resolvedStep.file || '(missing)';
      preview.will_replace = resolvedStep.old_str ? `${resolvedStep.old_str.slice(0, 80)}...` : '(missing)';
      preview.with = resolvedStep.new_str ? `${resolvedStep.new_str.slice(0, 80)}...` : '(missing)';
      preview.workspace_safe = safeResolve(resolvedStep.path || resolvedStep.file) !== null;
      break;
    case 'write':
      preview.action = 'write_file';
      preview.file = resolvedStep.path || resolvedStep.file || '(missing)';
      preview.content_lines = resolvedStep.content ? String(resolvedStep.content).split('\n').length : 0;
      preview.workspace_safe = safeResolve(resolvedStep.path || resolvedStep.file) !== null;
      break;
    case 'shell': {
      preview.action = 'shell';
      preview.command = resolvedStep.command || '(missing)';
      const check = checkCommand(resolvedStep.command || '');
      preview.risk = check.risk;
      preview.risk_reasons = check.reasons.length > 0 ? check.reasons : undefined;
      preview.needs_approval = !check.approved;
      break;
    }
    case 'read':
      preview.action = 'read_file';
      preview.file = resolvedStep.path || resolvedStep.file || '(missing)';
      preview.workspace_safe = safeResolve(resolvedStep.path || resolvedStep.file) !== null;
      break;
    case 'conditional':
      preview.action = 'conditional';
      preview.condition = resolvedStep.condition || '(missing)';
      preview.then_count = Array.isArray(step.then) ? step.then.length : 0;
      preview.else_count = Array.isArray(step.else) ? step.else.length : 0;
      // Recursively preview branch contents
      if (Array.isArray(step.then)) {
        preview.then_preview = step.then.map((s, j) => dryRunPreview(s, context, `${index}.then[${j}]`));
      }
      if (Array.isArray(step.else)) {
        preview.else_preview = step.else.map((s, j) => dryRunPreview(s, context, `${index}.else[${j}]`));
      }
      break;
    case 'assert':
      preview.action = 'assert';
      preview.condition = resolvedStep.condition || '(missing)';
      break;
    default:
      preview.action = 'unknown';
  }

  return preview;
}

/**
 * v0.1.5: Count ALL planned leaf steps recursively from the original steps array.
 * This represents what WOULD execute if the macro ran to completion.
 */
function countPlannedLeaves(steps) {
  let total = 0;
  function walk(stepList) {
    for (const s of stepList) {
      if (!s || typeof s !== 'object') continue;
      if (s.type === 'conditional') {
        // Walk the taken branch (then) for planned count
        // For accuracy, count both branches since we don't know which will run
        if (Array.isArray(s.then)) walk(s.then);
        if (Array.isArray(s.else)) walk(s.else);
      } else {
        total++;
      }
    }
  }
  walk(steps);
  return total;
}

/**
 * v0.1.5: Count actually executed leaf steps from results.
 */
function countExecutedLeaves(results) {
  let executed = 0;

  function walk(steps) {
    for (const step of steps) {
      if (!step) continue;
      // Recurse into conditional branch results
      if (step.branch_results && Array.isArray(step.branch_results)) {
        walk(step.branch_results);
      } else if (step.type !== 'conditional') {
        executed++;
      }
    }
  }

  walk(results);
  return executed;
}

/**
 * Heuristic token savings estimate.
 * NOTE: This is an experimental estimate, not a measured value.
 * Actual savings vary by workflow, model, and output verbosity.
 */
function countShellSteps(results) {
  let count = 0;
  function walk(steps) {
    for (const s of steps) {
      if (s.type === 'shell') count++;
      if (s.branch_results) walk(s.branch_results);
    }
  }
  walk(results);
  return count;
}

function estimateTokenSavings(totalLeafPlanned, executedLeafSteps, results) {
  const stepsThatRan = Math.max(executedLeafSteps, 1);
  const shellSteps = countShellSteps(results);

  // Conservative estimate: each individual round trip ≈ 1500 tokens
  const estimatedWithoutMacro = (stepsThatRan * 1500) + (shellSteps * 500);
  const roundTripsSaved = Math.max(0, stepsThatRan - 1);
  const estimatedWithMacro = Math.floor(estimatedWithoutMacro * 0.35);

  return {
    estimated_tokens_without_macro: estimatedWithoutMacro,
    tokens_consumed: estimatedWithMacro,
    tokens_saved: estimatedWithoutMacro - estimatedWithMacro,
    round_trips_saved: roundTripsSaved,
    _note: 'Experimental heuristic estimate — not based on real measurement.',
  };
}

// === Benchmark Logging ===

let benchmarkLog = [];
let macrosRun = 0;
let totalTokensSaved = 0;
let totalRoundTripsSaved = 0;

export function logBenchmark(macroResult) {
  // v0.1.5: Always track session counters (independent of benchmark toggle)
  const estimate = macroResult.token_savings_estimate ?? {
    estimated_tokens_without_macro: 0,
    tokens_consumed: 0,
    tokens_saved: 0,
    round_trips_saved: 0,
  };

  macrosRun++;
  totalTokensSaved += estimate.tokens_saved ?? 0;
  totalRoundTripsSaved += estimate.round_trips_saved ?? 0;

  if (!CONFIG.benchmarkEnabled) return;

  const entry = {
    timestamp: new Date().toISOString(),
    run_id: macroResult.run_id || 'unknown',
    status: macroResult.status,
    steps_total: macroResult.total_steps,
    steps_executed: macroResult.executed_steps,
    steps_passed: macroResult.passed_steps,
    steps_failed: macroResult.failed_steps,
    duration_ms: macroResult.total_duration_ms,
    rolled_back: macroResult.rolled_back || false,
    ...estimate,
  };

  // In-memory ring buffer (last 20 entries)
  benchmarkLog.push(entry);
  if (benchmarkLog.length > 20) benchmarkLog.shift();

  // Persist to JSONL file
  try {
    appendFileSync(CONFIG.benchmarkFile, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {
    // Best-effort; disk full or permission issues shouldn't crash the server
  }
}

export function getStats() {
  return {
    macros_run: macrosRun,
    estimated_tokens_saved: totalTokensSaved,
    estimated_round_trips_saved: totalRoundTripsSaved,
    recent_benchmarks: benchmarkLog.slice(-20),
    benchmark_file: CONFIG.benchmarkEnabled ? CONFIG.benchmarkFile : null,
    _note: 'Statistics are session-only for in-memory counters. Benchmark data is appended to the JSONL file when enabled.',
  };
}
