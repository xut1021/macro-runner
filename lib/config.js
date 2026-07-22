/**
 * Shared Configuration Module (v0.1.11)
 *
 * Single source of truth for all environment-variable-driven configuration.
 * Every module imports from here — no duplicated safeParseInt or env parsing.
 *
 * Integer env vars use strict Number() parsing: rejects "100MB", "3.5", NaN, Infinity, -1.
 * Unknown dangerous-command modes fail closed to "approve".
 */

import { homedir } from 'os';

/**
 * Parse a positive safe integer from env. Rejects:
 *   - undefined (returns fallback)
 *   - "abc", "100MB", "3.5"
 *   - NaN, Infinity, -Infinity
 *   - values <= 0
 *   - non-safe integers (> Number.MAX_SAFE_INTEGER)
 */
function safePositiveInt(envName, fallback) {
  const raw = process.env[envName];
  if (raw === undefined) return fallback;
  const val = Number(raw);
  if (!Number.isSafeInteger(val) || val <= 0) {
    console.error(`[macro-runner] Invalid ${envName}="${raw}" — using default ${fallback}`);
    return fallback;
  }
  return val;
}

const VALID_DANGER_MODES = new Set(['deny', 'approve', 'warn']);

function dangerMode() {
  const raw = (process.env.MACRO_DANGEROUS_COMMANDS || 'approve').toLowerCase();
  if (!VALID_DANGER_MODES.has(raw)) {
    console.error(`[macro-runner] Invalid MACRO_DANGEROUS_COMMANDS="${raw}" — using "approve"`);
    return 'approve';
  }
  return raw;
}

// v0.1.11: Single shared dangerous env key list (case-normalized)
export const DANGEROUS_ENV_KEYS = [
  'NODE_OPTIONS', 'NODE_PATH', 'PATH', 'PATHEXT', 'COMSPEC',
  'SHELL', 'BASH_ENV', 'ENV',
  'PYTHONPATH', 'PYTHONSTARTUP', 'RUBYOPT', 'PERL5OPT', 'PERL5LIB',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
  'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'GIT_ASKPASS',
  'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'RUSTC_WRAPPER',
];

/** Check if an env key is dangerous (case-insensitive). Returns the normalized key name if dangerous, null otherwise. */
export function isDangerousEnvKey(key) {
  const upper = String(key).toUpperCase();
  return DANGEROUS_ENV_KEYS.find(dk => dk.toUpperCase() === upper) || null;
}

export const CONFIG = {
  // Timeout
  get defaultTimeout() { return safePositiveInt('MACRO_DEFAULT_TIMEOUT_MS', 300000); },
  get defaultOutputMode() { return process.env.MACRO_DEFAULT_OUTPUT_MODE || 'summary'; },
  get trimOutputLines() { return safePositiveInt('MACRO_TRIM_OUTPUT_LINES', 200); },

  // Workspace
  get workspaceRoot() { return process.env.MACRO_WORKSPACE_ROOT || null; },
  get allowOutsideWorkspace() { return process.env.MACRO_ALLOW_OUTSIDE_WORKSPACE === 'true'; },

  // Benchmark
  get benchmarkEnabled() { return process.env.MACRO_TOKEN_BENCHMARK_ENABLED === 'true'; },
  get benchmarkFile() { return process.env.MACRO_BENCHMARK_FILE || `${homedir()}/.claude/macro-benchmarks.jsonl`; },

  // Output limits
  get stdoutMaxBytes() { return safePositiveInt('MACRO_STDOUT_MAX_BYTES', 524288); },
  get stderrMaxBytes() { return safePositiveInt('MACRO_STDERR_MAX_BYTES', 524288); },

  // Danger mode
  get dangerousCommandsMode() { return dangerMode(); },

  // File size limits
  get maxRollbackFileBytes() { return safePositiveInt('MACRO_MAX_ROLLBACK_FILE_BYTES', 10 * 1024 * 1024); },
  get maxRollbackTotalBytes() { return safePositiveInt('MACRO_MAX_ROLLBACK_TOTAL_BYTES', 100 * 1024 * 1024); },
  get maxReadFileBytes() { return safePositiveInt('MACRO_MAX_READ_FILE_BYTES', 50 * 1024 * 1024); },
  get maxEditFileBytes() { return safePositiveInt('MACRO_MAX_EDIT_FILE_BYTES', 10 * 1024 * 1024); },
};
