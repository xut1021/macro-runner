# Security Policy

## Scope

Macro Runner executes arbitrary shell commands and modifies files on your system. It is designed as a **productivity tool for trusted development workflows**, not as a security sandbox.

## Built-in Protections

### File Safety
- **Rollback**: When `rollback_on_error: true`, file changes from `edit`/`write` steps are automatically restored on macro failure
- **Dry Run**: `dry_run: true` previews all operations without any side effects
- **Workspace Root**: `MACRO_WORKSPACE_ROOT` restricts file operations (read/edit/write) to a specific directory tree. **Shell commands are not sandboxed** — workspace root does not constrain shell access
- **Path Traversal**: `../` escapes and symlink bypasses are detected and blocked when workspace root is configured

### Command Safety
- **Dangerous Command Detection**: 30+ heuristic patterns identify destructive commands (`rm -rf /`, `git push --force`, `curl | sh`, etc.)
- **Configurable**: `MACRO_DANGEROUS_COMMANDS` can be set to `deny`, `approve` (default), or `warn`
- **Risk Levels**: Commands are classified as `critical`, `high`, `medium`, or `low` risk

### Data Safety
- **Secret Sanitization**: API keys, tokens, JWTs, private keys, and database connection strings are automatically redacted from output
- **Output Limits**: Per-channel size limits (512KB default) prevent memory exhaustion from verbose commands
- **Benchmark Privacy**: Environment variable values are never logged

## Limitations

### Known Risks

1. **Shell Side Effects Are Not Reversible**: Rollback only restores file changes. `npm install`, `git push`, database operations, and other shell side effects cannot be rolled back.

2. **Guard Is Heuristic, Not a Sandbox**: The dangerous command detection uses regex patterns and can be bypassed (e.g., `bash -c "..."`, `python -c "..."`, base64-encoded commands). It is a **warning layer**, not a security boundary.

3. **No Process Isolation**: Shell commands run with the same privileges as the MCP server process. Use `MACRO_WORKSPACE_ROOT` to limit filesystem access.

4. **Denial of Service**: Commands with infinite loops, fork bombs, or excessive resource consumption will not be detected by the guard.

### Recommendations

- **Do NOT** use with `--dangerously-skip-permissions` or equivalent flags
- Set `MACRO_WORKSPACE_ROOT` to your project directory
- Use `dry_run: true` to preview macros before execution
- Enable `rollback_on_error: true` for macros that modify files
- Review templates before running — especially those from untrusted sources
- Do not run macros that contain secrets in command arguments (use environment variables instead)

## Reporting a Vulnerability

If you discover a security vulnerability, please report it via GitHub Security Advisory:
https://github.com/xut1021/macro-runner/security/advisories/new

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Yes   |
| < 0.1.0 | ❌ No    |
