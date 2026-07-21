/**
 * Macro Step Execution Engine
 *
 * Executes a sequence of steps (edit, shell, read, write, conditional, assert)
 * sequentially below the model boundary. Stops early on first failure by default.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, realpathSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, normalize, sep } from 'path';
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
};

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

  // Resolve symlinks to real path
  let realPath;
  try {
    realPath = existsSync(resolved) ? realpathSync(resolved) : resolved;
  } catch (_) {
    realPath = resolved; // if realpath fails (broken symlink), use resolved
  }

  // Workspace root enforcement
  if (CONFIG.workspaceRoot && !CONFIG.allowOutsideWorkspace) {
    const root = normalize(resolve(CONFIG.workspaceRoot));
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
    this.stepResults = [];
    this.variables = {};
    this.startTime = Date.now();
  }

  addStepResult(index, result) {
    this.stepResults[index] = result;
  }

  setVariable(name, value) {
    this.variables[name] = value;
  }

  /**
   * Resolve a single property reference like step[0].exit_code to its value.
   * Returns the raw value string, or the input unchanged if it's not a reference.
   */
  resolvePropertyRef(ref) {
    // ${{variable_name}} — user-defined variables
    for (const [key, value] of Object.entries(this.variables)) {
      if (ref === `\${{${key}}}`) return String(value);
    }

    // ${{step[N].property}} — wrapped references
    const wrappedMatch = ref.match(/^\$\{\{step\[(\d+)\]\.(.+?)\}\}$/);
    if (wrappedMatch) {
      const result = this.stepResults[parseInt(wrappedMatch[1])];
      if (!result) return 'UNDEFINED';
      return String(this._getStepProp(result, wrappedMatch[2]));
    }

    // step[N].property — bare references (without ${{}})
    const bareMatch = ref.match(/^step\[(\d+)\]\.(.+?)$/);
    if (bareMatch) {
      const result = this.stepResults[parseInt(bareMatch[1])];
      if (!result) return 'UNDEFINED';
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
      default: return 'UNDEFINED';
    }
  }

  /**
   * Resolve all variable and step references in a string.
   */
  resolveString(str) {
    if (typeof str !== 'string') return str;

    let resolved = str;

    // First: ${{variable_name}} from user variables
    for (const [key, value] of Object.entries(this.variables)) {
      resolved = resolved.replace(
        new RegExp(`\\$\\{\\{${key}\\}\\}`, 'g'),
        String(value)
      );
    }

    // Then: ${{step[N].property}} — wrapped references
    resolved = resolved.replace(
      /\$\{\{step\[(\d+)\]\.(.+?)\}\}/g,
      (_, index, prop) => {
        const result = this.stepResults[parseInt(index)];
        if (!result) return 'UNDEFINED';
        return String(this._getStepProp(result, prop));
      }
    );

    // Finally: bare step[N].property — unwrapped references
    resolved = resolved.replace(
      /step\[(\d+)\]\.(exit_code|status|stdout|stderr)/g,
      (_, index, prop) => {
        const result = this.stepResults[parseInt(index)];
        if (!result) return 'UNDEFINED';
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
  const stepTimeout = step.timeout_ms || step.timeout || CONFIG.defaultTimeout;

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
  const offset = step.offset || 0;
  const limit = step.limit || 200;
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
 * Resolves all property references BEFORE comparison, so both forms work:
 *   step[0].exit_code == 0
 *   ${{step[0].exit_code}} == 0
 */
function evaluateCondition(condition, context) {
  // First resolve ${{...}} and step[N].property references
  const resolved = context.resolveString(condition);

  // Support: LHS OP RHS  (e.g. "0 == 0", "success == success")
  const cmpMatch = resolved.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (cmpMatch) {
    const [, left, op, right] = cmpMatch;
    const lVal = left.trim().replace(/^"(.*)"$/, '$1');
    const rVal = right.trim().replace(/^"(.*)"$/, '$1');

    // Try numeric comparison first
    const lNum = parseFloat(lVal);
    const rNum = parseFloat(rVal);
    if (!isNaN(lNum) && !isNaN(rNum)) {
      switch (op) {
        case '==': return lNum === rNum;
        case '!=': return lNum !== rNum;
        case '>=': return lNum >= rNum;
        case '<=': return lNum <= rNum;
        case '>': return lNum > rNum;
        case '<': return lNum < rNum;
      }
    }

    // String comparison
    switch (op) {
      case '==': return lVal === rVal;
      case '!=': return lVal !== rVal;
    }
  }

  // Support: step[N].stdout_contains("pattern")
  // Resolve the source first
  const containsMatch = resolved.match(
    /\b(\w+)\[(\d+)\]\.stdout_contains\("(.+?)"\)/
  );
  if (containsMatch) {
    const index = parseInt(containsMatch[2]);
    const pattern = containsMatch[3];
    const result = context.stepResults[index];
    if (result && result.stdout) {
      return result.stdout.includes(pattern);
    }
    return false;
  }

  // Boolean literals
  const trimmed = resolved.trim();
  if (trimmed === 'true' || trimmed === '1') return true;
  if (trimmed === 'false' || trimmed === '0' || trimmed === '') return false;

  // Fallback: truthy
  return !!trimmed;
}

/**
 * Execute a conditional step: evaluate condition and run then/else substeps.
 */
function executeConditional(step, context) {
  if (!step.condition) {
    return { ok: false, error: 'conditional step requires "condition" parameter' };
  }

  const conditionMet = evaluateCondition(step.condition, context);
  const branch = conditionMet ? (step.then || []) : (step.else || []);

  if (branch.length === 0) {
    return {
      ok: true,
      condition_met: conditionMet,
      summary: `Condition ${conditionMet ? 'met' : 'not met'} — no steps to run`,
    };
  }

  // Execute branch steps sequentially
  const results = [];
  for (let i = 0; i < branch.length; i++) {
    const subStep = branch[i];
    const result = executeStep(subStep, context, Infinity);
    results.push(result);
    context.addStepResult(context.stepResults.length, result);
    if (!result.ok) {
      return {
        ok: false,
        condition_met: conditionMet,
        summary: `Conditional branch failed at sub-step ${i}`,
        branch_results: results,
      };
    }
  }

  return {
    ok: true,
    condition_met: conditionMet,
    summary: `Condition ${conditionMet ? 'met' : 'not met'} — ran ${branch.length} sub-steps`,
    branches_executed: branch.length,
    branch_results: results,
  };
}

/**
 * Execute an assert step: check a condition and fail if not met.
 */
function executeAssert(step, context) {
  if (!step.condition) {
    return { ok: false, error: 'assert step requires "condition" parameter' };
  }

  const conditionMet = evaluateCondition(step.condition, context);
  if (!conditionMet) {
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
 * Dispatch a single step to its type-specific handler.
 */
function executeStep(step, context, remainingMs) {
  // Resolve variables in step parameters (safe: only string fields, validated inside handlers)
  const resolvedStep = { ...step };
  for (const key of ['path', 'file', 'command', 'old_str', 'old_string', 'new_str', 'new_string', 'content', 'condition', 'message']) {
    if (typeof step[key] === 'string') {
      resolvedStep[key] = context.resolveString(step[key]);
    }
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
      result = executeConditional(resolvedStep, context);
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

  // Handle variable assignment from read steps
  if (resolvedStep.assign_to && result.ok && result.content !== undefined) {
    context.setVariable(resolvedStep.assign_to, result.content);
  }

  return result;
}

// === Main Entry Point ===

/**
 * Run a complete macro: validate, audit, snapshot, execute, rollback.
 *
 * @param {Array} steps - Array of step objects
 * @param {Object} options - { stop_on_error, timeout_ms, dry_run, rollback_on_error, schema_version }
 * @returns {Object} Macro result with status, step results, and timing
 */
export function runMacro(steps, options = {}) {
  const runId = generateRunId();
  const stopOnError = options.stop_on_error !== false;
  const macroTimeoutMs = options.timeout_ms || null;
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

  // ---- Phase 2: Execute ----
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Check macro-level timeout before each step
    if (context.isTimedOut(macroTimeoutMs)) {
      timedOut = true;
      results.push({
        ok: false,
        error: 'Macro-level timeout reached before this step could start.',
        type: step.type || 'unknown',
        description: step.description || '',
        index: i,
        timed_out: true,
      });
      context.addStepResult(i, results[results.length - 1]);
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

    // Snapshot files before edit/write
    if (rollback && (step.type === 'edit' || step.type === 'write')) {
      const rawPath = step.path || step.file;
      if (rawPath && typeof rawPath === 'string') {
        const filePath = safeResolve(context.resolveString(rawPath));
        if (filePath) {
          rollback.snapshot(filePath);
          if (!existsSync(filePath) && step.type === 'write') {
            rollback.markCreated(filePath);
          }
        }
      }
    }

    // Execute step with remaining time budget
    const remaining = context.remainingMs(macroTimeoutMs);
    const result = executeStep(step, context, remaining);
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

  const executedSteps = results.length;
  const passedSteps = results.filter(r => r.ok).length;
  const failedSteps = results.filter(r => !r.ok).length;
  const totalDuration = Date.now() - context.startTime;
  const macroFailed = firstFailure >= 0 || timedOut;

  // ---- Phase 3: Rollback on failure ----
  if (macroFailed && rollback) {
    try {
      rollbackResult = rollback.rollback();
      rolledBack = true;
    } catch (err) {
      rollbackFailed = true;
      rollbackResult = { error: err.message };
    }
  } else if (!macroFailed && rollback) {
    rollback.clear(); // success — discard snapshots
  }

  // Determine status
  let status;
  if (timedOut) {
    status = 'timed_out';
  } else if (firstFailure >= 0) {
    if (rollbackFailed) {
      status = 'rollback_failed';
    } else if (rolledBack) {
      status = 'rolled_back';
    } else {
      status = stopOnError ? 'failed_early' : 'completed_with_failures';
    }
  } else {
    status = 'completed';
  }

  // Token savings estimate
  const tokenEstimate = estimateTokenSavings(steps.length, results);

  return {
    status,
    run_id: runId,
    executed_steps: executedSteps,
    passed_steps: passedSteps,
    failed_steps: failedSteps,
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
 * Heuristic token savings estimate.
 * NOTE: This is an experimental estimate, not a measured value.
 * Actual savings vary by workflow, model, and output verbosity.
 */
function estimateTokenSavings(totalSteps, results) {
  const stepsThatRan = results.length;
  const shellSteps = results.filter(r => r.type === 'shell').length;

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
    ...macroResult.token_savings_estimate,
  };

  // In-memory
  benchmarkLog.push(entry);
  macrosRun++;
  totalTokensSaved += macroResult.token_savings_estimate.tokens_saved;
  totalRoundTripsSaved += macroResult.token_savings_estimate.round_trips_saved;

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
