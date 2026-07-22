# Changelog

## v0.1.6 — Reliability Hardening (2026-07-23)

### P0 Fixes
- **Default timeout restored**: `timeout_ms` defaults to 300000ms (was accidentally `null`/infinite
  since v0.1.4). `remainingMs()` uses explicit null-check instead of falsy check.
- **Deadline check before all step types**: `_executeStepImpl` checks `remainingMs <= 0` BEFORE
  any side effects (edit/write/shell/read). Prevents writes after macro deadline.
- **Timeout always stops execution**: `timed_out` is not overridable by `stop_on_error: false`.
  Branches always stop on timeout; main loop always breaks.
- **Unexpected exception rollback guarantee**: Added `catch` block between `try`/`finally`.
  Any exception escaping the execution loop sets `macroFailed = true` and triggers rollback.
  Previously, `macroFailed` stayed `false` and `rollback.clear()` would discard snapshots.

### P1 Fixes
- **Condition variable substitution unified**: `evaluateCondition` now uses callback form
  `() => String(value)` for user-variable substitution (same as `resolveString`). No more
  duplicate `String(value)` with `$&` interpretation risk.
- **stdout_contains missing ID**: Returns `valid: false` with error message instead of
  `valid: true, value: false`. Empty pattern `stdout_contains("")` now correctly returns
  `true` (per JS `String.includes("") === true`).
- **Leaf stats renamed**: `leaf_steps_planned` → `leaf_steps_declared`,
  `leaf_steps_skipped` → `leaf_steps_not_reached`. Declared counts both branches.
- **Metrics categorized**: `getStats()` now returns `requests_total`, `completed`, `failed`,
  `dry_runs`, `approval_blocked`, `validation_failed` instead of monolithic `macros_run`.
- **Workspace root fail-closed**: `realpathSync` failure on workspace root now returns `null`
  (reject) instead of falling back to lexical path.
- **`estimateTokenSavings` uses declared count**: Now bases estimate on declared leaf steps
  rather than ignoring the parameter.

### P2 Fixes
- **Byte-level output truncation**: Uses `Buffer.slice()` instead of `String.slice()` for
  accurate per-channel size limits with multi-byte UTF-8 characters.
- **Step ID in formatted results**: `formatStepResult` now includes `id` field when
  `_step_id` is present.
- **JSONL benchmark fields**: Now includes `execution_status`, `rollback_status`, `timed_out`,
  `dry_run`, `leaf_steps_declared`, `leaf_steps_executed`.

### Engineering
- 8 new tests (108 total, 0 failures): default timeout enforcement, branch deadline check,
  stdout_contains strict missing, empty string semantics, step ID formatting,
  categorized stats

## v0.1.5 — State, Reference & Audit Integrity (2026-07-23)

### P0 Bug Fixes
- **Benchmark crash on early returns**: `logBenchmark()` now uses `??` fallback for
  missing `token_savings_estimate`. `dry_run`, `validation_failed`, and
  `approval_required` results no longer crash when benchmark is enabled.
- **Branch step ID registration**: `registerResultId()` called for ALL results
  including branch sub-steps. `steps.build.status` now works from inside
  conditional branches.
- **Branch timeout propagation**: `executeConditional` aggregates `timed_out`
  from all branch sub-steps, even in `stop_on_error: false` mode.
  `executeShell` now sets `timed_out: true` on macro-timeout skip.

### P1 Fixes
- **UNRESOLVED sentinel**: Replaced literal `"UNDEFINED"` with `__MACRO_UNRESOLVED__`
  sentinel constant. `evaluateCondition` checks for sentinel explicitly — missing
  step IDs can no longer match as valid strings (`"UNDEFINED" === "UNDEFINED"`).
- **stdout_contains anchoring**: Patterns now anchored with `^...$` and require
  exact `step[N].stdout_contains("...")` or `steps.ID.stdout_contains("...")`.
  Arbitrary prefixes like `foo[0].stdout_contains(...)` are rejected.
- **Strict number parsing**: `parseFloat("0abc") === 0` fixed. Uses
  `/^-?(?:\d+\.?\d*|\.\d+)$/` to validate before numeric comparison.
- **$ variable substitution**: Callback form `() => String(value)` prevents
  `$&`, `$'`, `$\`` interpretation in replacement strings.
- **trim_output_lines connected**: Step result now carries `trim_output_lines`
  from resolved step config. Summarizer uses `??` instead of `||`.
- **Leaf step counts split**: `countPlannedLeaves(steps)` and
  `countExecutedLeaves(results)` replace the single `countLeafSteps`.
  New fields: `leaf_steps_planned`, `leaf_steps_executed`, `leaf_steps_skipped`.
- **Session stats independent of benchmark**: `logBenchmark()` always increments
  in-memory counters. JSONL persistence still controlled by
  `MACRO_TOKEN_BENCHMARK_ENABLED`. `macro_status` now works for all users.
- **Workspace path fail-closed**: `safeResolve()` returns `null` on `realpathSync`
  failure when workspace root is set. Workspace root itself is `realpath`'d for
  consistent comparison.

### Schema
- **`id` field exposed to MCP schema**: Agents can now discover and use
  `steps.ID.property` references.

### Engineering
- 16 new tests (100 total, 0 failures): benchmark safety, branch ID registration,
  branch timeout propagation, UNRESOLVED sentinel, stdout_contains anchoring,
  strict number parsing, leaf count semantics, session stats, trim_output_lines

## v0.1.4 — Trusted Execution Hardening (2026-07-23)

### P0 Bug Fixes
- **Exception → rollback guarantee**: All synchronous exceptions (ENOENT, EACCES, ENOSPC, etc.)
  are now caught and converted to structured step failures via `safeExecuteStep`. The main
  execution loop uses `try/finally` so Phase 3 rollback ALWAYS runs, even if an unexpected
  exception escapes. This is the core reliability fix — rollback is no longer bypassable.
- **Nested step index isolation**: Branch sub-step results no longer pollute the top-level
  `stepResults` array. `step[N]` always refers to top-level step N. Branch results live
  exclusively in the conditional result's `branch_results` field.

### P1 Fixes
- **`stop_on_error` recursive**: `stop_on_error` now propagates into conditional branches.
  With `stop_on_error: true` (default), branch stops on first failure. With `false`,
  all branch steps execute and failures are recorded.
- **Strict condition evaluation**: `evaluateCondition` now returns `{valid, value, error}`.
  Unrecognized expressions (typo property names, missing steps, invalid syntax) fail
  explicitly instead of silently defaulting to truthy.
- **Variable name validation**: `assign_to` names must match `/^[A-Za-z_][A-Za-z0-9_]*$/`.
  Reserved words (`step`, `steps`) are rejected. Invalid names are caught at validation
  time before execution.
- **Step ID support**: Steps can now have an optional `id` field for stable cross-step
  references. IDs must be unique and use the same identifier pattern. Reference by ID
  via `steps.{id}.property` or `${{steps.{id}.property}}` syntax.
- **Rollback Buffer-ized**: `RollbackManager` now reads/writes raw `Buffer` instead of
  UTF-8 strings, preventing corruption of binary files during rollback restore.
- **Rollback size limits**: `MACRO_MAX_ROLLBACK_FILE_BYTES` (default 10 MB) and
  `MACRO_MAX_ROLLBACK_TOTAL_BYTES` (default 100 MB) prevent memory exhaustion.
  Exceeding limits produces a structured error before any file is modified.
- **Timeout `??` semantics**: All `timeout_ms || default` patterns replaced with `??`
  so that explicit `0` values are respected instead of being silently replaced.
- **Unified MCP sanitization**: All four MCP handlers (`run_macro`, `list_macros`,
  `show_macro`, `macro_status`) now pass through `sanitizeResponse` at the dispatch
  level, preventing credential leakage from custom templates.

### Engineering
- 18 new tests (84 total, 0 failures): exception→rollback, nested index isolation,
  condition strictness, variable name validation, step ID validation,
  `steps.ID.property` references, branch `stop_on_error` propagation

## v0.1.2 — Bug Fix & Stabilization (2026-07-22)

### P0 Bug Fixes
- **Template entry point**: Fixed `handleRunMacro()` incorrectly rejecting template-resolved steps when no inline `steps` were provided
- **Conditional branch timeout**: Conditional branches now inherit remaining macro timeout instead of using `Infinity`
- **Conditional branch rollback**: File snapshots are now taken inside conditional branches, not just top-level
- **stdout_contains()**: Fixed resolution order — function-call patterns are now matched before variable substitution
- **Partial rollback**: Fixed `rolled_back` status when some file restorations fail (now correctly reports `rollback_failed`)
- **Template directory**: Uses `import.meta.url` for template path resolution instead of hardcoded home directory path
- **Template parameter types**: Template parameters now preserve their original type (number, boolean) when substituted as the entire field value

### P1 Fixes
- **Guard false positive**: Tightened `format` pattern to avoid flagging `npm run format` as disk formatting
- **Summarizer**: Conditional `branch_results` are now recursively formatted with `_branch_path` for error location
- **Version**: Single source of truth — server reads version from `package.json`

### Engineering
- Added `CHANGELOG.md`, `SECURITY.md`
- Added `.github/workflows/ci.yml` (Windows, Ubuntu, macOS matrix)
- Added `engines`, `files`, `scripts` to `package.json`
- Cross-platform test commands (replaced `dir` with `node -e`)

## v0.1.1 — Trusted Macro Execution (2026-07-22)

### Added
- File rollback (`rollback_on_error`)
- Dry run mode (`dry_run`)
- Dangerous command detection (30+ patterns)
- Secret sanitization (API keys, tokens, JWTs, etc.)
- Workspace root enforcement with path traversal detection
- Recursive pre-execution validation
- Output size limits per channel (512KB each)
- Unique run IDs (`mr_YYYYMMDD_rand6`)
- 8 status types: completed, completed_with_failures, failed_early, timed_out, validation_failed, approval_required, rolled_back, rollback_failed

## v0.1.0 — Experimental Release (2026-07-22)

### Initial Release
- 6 step types: edit, write, shell, read, conditional, assert
- 3 output modes with smart error/warning/summary extraction
- YAML template system with parameter resolution
- Variable references and condition expressions
- Macro-level timeout enforcement
- Benchmark JSONL persistence
- Companion Skill for Claude Code
