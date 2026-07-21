# Changelog

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
