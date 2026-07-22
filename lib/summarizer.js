/**
 * Output Summarizer
 *
 * Transforms raw shell/build/test output into structured, token-efficient summaries.
 * Extracts errors, warnings, and summary lines; trims verbose output.
 */

// === Pattern Definitions ===

const ERROR_PATTERNS = [
  /error:/i, /Error:/, /ERROR\s/, /^\s*at\s+/m,
  /^FAIL\s/, /failed:/i, /FAILED/i,
  /SyntaxError/, /TypeError/, /ReferenceError/, /RangeError/,
  /command not found/i, /No such file/i,
  /Module not found/i, /Cannot find module/i,
  /EACCES/i, /EPERM/i, /ENOENT/i,
  /AssertionError/, /Assertion failed/,
  /Compilation failed/i, /Build failed/i,
  /exit code [1-9]/i,
  /FATAL/i,
  /Traceback\s*\(most recent call last\)/i,
  /panic/i,
  /unresolved/i, /undefined reference/i,
];

const WARNING_PATTERNS = [
  /warning:/i, /WARNING/i, /warn\s/i,
  /deprecated/i, /DEPRECATED/i,
  /is deprecated/i,
  /will be removed/i,
  /not recommended/i,
];

const SUMMARY_PATTERNS = [
  /Tests:\s+\d+\s+passed/i,
  /(\d+)\s+passing/i,
  /(\d+)\s+failing/i,
  /(\d+)\s+skipped/i,
  /Build succeeded/i,
  /Compilation successful/i,
  /compiled successfully/i,
  /built in \d+/i,
  /Done in \d+/i,
  /finished in \d+/i,
  /\d+ passed/i,
  /\d+ failed/i,
  /SUCCESS/i,
];

// === Core Functions ===

/**
 * Extract lines matching any of the given patterns.
 */
function extractMatchingLines(text, patterns) {
  if (!text) return [];
  const lines = text.split('\n');
  return lines.filter(line =>
    patterns.some(pattern => pattern.test(line))
  );
}

/**
 * Trim output to head + tail, keeping the most relevant content.
 */
function trimOutput(text, maxLines) {
  if (!text) return { trimmed: false, text: '', full_lines: 0 };

  const lines = text.split('\n');
  const totalLines = lines.length;

  if (totalLines <= maxLines) {
    return { trimmed: false, text, full_lines: totalLines };
  }

  const headLines = Math.floor(maxLines * 0.1);  // 10% from head
  const tailLines = maxLines - headLines;          // 90% from tail

  const head = lines.slice(0, headLines).join('\n');
  const tail = lines.slice(-tailLines).join('\n');
  const omitted = totalLines - maxLines;

  return {
    trimmed: true,
    text: head + `\n... (${omitted} lines trimmed) ...\n` + tail,
    full_lines: totalLines,
    returned_lines: maxLines,
    head_lines: headLines,
    tail_lines: tailLines,
  };
}

/**
 * Summarize shell command output based on mode.
 *
 * @param {Object} result - Raw shell step result { stdout, stderr, exit_code, ok }
 * @param {string} mode - 'summary' | 'full' | 'errors_only'
 * @param {number} maxLines - Max lines to return in summary mode
 * @returns {Object} Summarized output
 */
export function summarizeShellOutput(result, mode = 'summary', maxLines = 50) {
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  if (mode === 'full') {
    return {
      stdout,
      stderr,
      trimmed: false,
      error_lines: extractMatchingLines(stdout + '\n' + stderr, ERROR_PATTERNS),
      warning_lines: extractMatchingLines(stdout + '\n' + stderr, WARNING_PATTERNS),
      summary_lines: extractMatchingLines(stdout + '\n' + stderr, SUMMARY_PATTERNS),
    };
  }

  if (mode === 'errors_only' && result.ok) {
    return {
      stdout: '',
      stderr: '',
      trimmed: true,
      output_omitted: true,
      note: 'Step succeeded — output omitted in errors_only mode',
    };
  }

  // summary mode (default)
  const errors = extractMatchingLines(stdout + '\n' + stderr, ERROR_PATTERNS);
  const warnings = extractMatchingLines(stdout + '\n' + stderr, WARNING_PATTERNS);
  const summaryLines = extractMatchingLines(stdout + '\n' + stderr, SUMMARY_PATTERNS);

  // For failed commands, prioritize error context
  if (!result.ok) {
    const trimmed = trimOutput(stderr || stdout, maxLines * 2);
    return {
      stdout: trimOutput(stdout, maxLines).text,
      stderr: trimmed.text,
      trimmed: true,
      error_lines: errors,
      warning_lines: warnings,
      summary_lines: summaryLines,
      // Extract last few error lines as the most useful failure message
      failure_context: errors.slice(-10),
    };
  }

  // For successful commands, return tail of output + summary
  const combined = stdout + (stderr ? '\n--- stderr ---\n' + stderr : '');
  const trimmed = trimOutput(combined, maxLines);

  return {
    stdout: trimmed.text,
    stderr: '',
    trimmed: trimmed.trimmed,
    full_lines: trimmed.full_lines,
    returned_lines: trimmed.returned_lines,
    error_lines: errors,
    warning_lines: warnings,
    summary_lines: summaryLines,
  };
}

/**
 * Format a complete step result for return to the LLM.
 *
 * @param {Object} stepResult - Raw step execution result
 * @param {string} mode - Output mode
 * @returns {Object} Formatted step result
 */
export function formatStepResult(stepResult, mode = 'summary') {
  const formatted = {
    index: stepResult.index,
    type: stepResult.type,
    description: stepResult.description || '',
    status: stepResult.ok ? 'success' : 'failure',
    duration_ms: stepResult.duration_ms,
    summary: stepResult.summary || '',
  };

  // v0.1.6: expose step ID in formatted results for audit traceability
  if (stepResult._step_id) {
    formatted.id = stepResult._step_id;
  }

  // For shell steps, include summarized output
  if (stepResult.type === 'shell') {
    const trimLines = stepResult.trim_output_lines ?? 50;
    const shellSummary = summarizeShellOutput(stepResult, mode, trimLines);
    formatted.exit_code = stepResult.exit_code;
    formatted.output_trimmed = shellSummary.trimmed;
    if (stepResult.stdout_truncated) formatted.stdout_truncated = true;
    if (stepResult.stderr_truncated) formatted.stderr_truncated = true;
    if (stepResult.sanitized) formatted.sanitized = true;
    if (shellSummary.error_lines?.length > 0) {
      formatted.error_lines = shellSummary.error_lines;
    }
    if (shellSummary.warning_lines?.length > 0) {
      formatted.warning_lines = shellSummary.warning_lines;
    }
    if (shellSummary.summary_lines?.length > 0) {
      formatted.output_summary = shellSummary.summary_lines;
    }
    if (shellSummary.failure_context?.length > 0) {
      formatted.failure_context = shellSummary.failure_context;
    }
    // v0.1.8: full mode preserves both stdout AND stderr
    if (mode === 'full') {
      formatted.stdout = shellSummary.stdout;
      formatted.stderr = shellSummary.stderr;
      formatted.stdout_truncated = stepResult.stdout_truncated || false;
      formatted.stderr_truncated = stepResult.stderr_truncated || false;
    } else if (shellSummary.stdout && mode !== 'errors_only') {
      formatted.output = shellSummary.stdout;
    }
  }

  // For edit steps, include what changed
  if (stepResult.type === 'edit' || stepResult.type === 'write') {
    if (stepResult.replacements !== undefined) {
      formatted.replacements = stepResult.replacements;
    }
  }

  // For read steps, include content in summary mode, omit in errors_only
  if (stepResult.type === 'read') {
    if (stepResult.content !== undefined && mode !== 'errors_only') {
      formatted.content = stepResult.content;
      formatted.total_lines = stepResult.total_lines;
      formatted.returned_lines = stepResult.returned_lines;
    }
  }

  // For failed steps, include error details
  if (!stepResult.ok) {
    formatted.error = stepResult.error || 'Unknown error';
    if (stepResult.hint) {
      formatted.hint = stepResult.hint;
    }
    if (stepResult.assertion) {
      formatted.assertion = stepResult.assertion;
    }
  }

  // For conditional steps, include branch info and recursively format branch results
  if (stepResult.type === 'conditional') {
    formatted.condition_met = stepResult.condition_met;
    formatted.branches_executed = stepResult.branches_executed;
    if (stepResult.branch_results && Array.isArray(stepResult.branch_results)) {
      formatted.branch_results = stepResult.branch_results.map((sr, j) => {
        const branchStep = formatStepResult(sr, mode);
        // v0.1.7: use stable execution path from executor, not guessed from index
        branchStep._branch_path = sr._execution_path ||
          `steps[${stepResult.index}].${sr._branch_name || 'then'}[${sr._branch_index ?? j}]`;
        return branchStep;
      });
    }
  }

  return formatted;
}

/**
 * Format the complete macro result for return to the LLM.
 *
 * @param {Object} macroResult - Result from runMacro()
 * @param {string} mode - Output mode
 * @returns {Object} Formatted macro result
 */
export function formatMacroResult(macroResult, mode = 'summary') {
  const formatted = {
    status: macroResult.status,
    run_id: macroResult.run_id,
    executed_steps: macroResult.executed_steps,
    passed_steps: macroResult.passed_steps,
    failed_steps: macroResult.failed_steps,
    total_steps: macroResult.total_steps,
    total_duration_ms: macroResult.total_duration_ms,
  };

  if (macroResult.dry_run) {
    formatted.dry_run = true;
    // v0.1.8: preserve safety audit information from dry-run
    if (macroResult.dry_run_safety) {
      formatted.dry_run_safety = macroResult.dry_run_safety;
    }
  }

  // v0.1.9: Expose internal diagnostic fields for audit traceability
  if (macroResult.execution_status) formatted.execution_status = macroResult.execution_status;
  if (macroResult.rollback_status && macroResult.rollback_status !== 'none') {
    formatted.rollback_status = macroResult.rollback_status;
  }
  if (macroResult.fatal_error) formatted.fatal_error = macroResult.fatal_error;

  if (macroResult.rolled_back) {
    formatted.rolled_back = true;
    formatted.rollback_result = macroResult.rollback_result;
  }

  if (macroResult.risk) {
    formatted.risk = macroResult.risk;
    formatted.reasons = macroResult.reasons;
    formatted.blocked_command = macroResult.blocked_command;
    formatted.blocked_at_step = macroResult.blocked_at_step;
  }

  if (macroResult.errors) {
    formatted.errors = macroResult.errors;
  }
  if (macroResult.warnings) {
    formatted.warnings = macroResult.warnings;
  }

  if (macroResult.hint) {
    formatted.hint = macroResult.hint;
  }

  if (macroResult.failed_at_step !== null && macroResult.failed_at_step >= 0) {
    formatted.failed_at_step = macroResult.failed_at_step;
    const statusMsgs = {
      rolled_back: `Macro failed and file changes were rolled back. ${macroResult.passed_steps} of ${macroResult.total_steps} steps passed before failure at step ${macroResult.failed_at_step + 1}.`,
      rollback_failed: `Macro failed and rollback encountered errors. Some files may not have been restored.`,
      failed_early: `Macro stopped at step ${macroResult.failed_at_step + 1} due to failure. ${macroResult.passed_steps} of ${macroResult.total_steps} steps passed.`,
      completed_with_failures: `Macro completed with ${macroResult.failed_steps} failure(s). ${macroResult.passed_steps} of ${macroResult.total_steps} steps passed.`,
      timed_out: `Macro timed out at step ${macroResult.failed_at_step + 1}. ${macroResult.passed_steps} steps passed before timeout.`,
    };
    formatted.message = statusMsgs[macroResult.status] ||
      `Macro stopped at step ${macroResult.failed_at_step + 1}.`;
  }

  if (macroResult.token_savings_estimate) {
    formatted.token_savings_estimate = macroResult.token_savings_estimate;
  }

  // Format each step result (v0.1.8: dry-run previews pass through as-is)
  if (macroResult.dry_run) {
    formatted.steps = macroResult.steps; // preview objects — action, file, risk, etc.
  } else {
    formatted.steps = macroResult.steps.map(step => formatStepResult(step, mode));
  }

  return formatted;
}
