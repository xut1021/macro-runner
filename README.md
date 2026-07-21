# Macro Runner for Claude Code

**Multi-step macro execution below the model boundary — reduce LLM round trips for deterministic workflows.**

Inspired by [Tura-AI/tura](https://github.com/Tura-AI/tura), Macro Runner brings macro-command batching to Claude Code via MCP (Model Context Protocol).

> **Version 0.1.0 — Experimental.** Core engine is solid and tested; some features are still maturing. See [CHANGELOG](#) and [BENCHMARK.md](./BENCHMARK.md) for details.

## The Problem

In long coding tasks, the LLM wastes tokens on deterministic sequences:

```
Turn 1: Edit file A → wait for result
Turn 2: Build → wait for result
Turn 3: Run tests → wait for result
Turn 4: Read test output → make decision
```

Each round trip sends the full context to the model. For a 3-step fix-build-test cycle, that's 3× context + 3× model thinking.

## The Solution

Specify all deterministic steps upfront as a single macro:

```
Turn 1: run_macro([edit A, build, test]) → get structured result → ONE decision
```

Steps execute sequentially below the model boundary. The model only gets called back when:
- All steps complete, or
- A step fails (early stop), or
- The macro times out

## Architecture

```
Claude Code → MCP → run_macro tool → executor.js → summarizer.js → structured result
                        ↑
                   templates/*.yaml
```

## Quick Start

### Install

```bash
# Clone the repo
git clone https://github.com/xut1021/macro-runner.git
cd macro-runner
npm install
```

### Configure via Claude Code CLI (recommended)

```bash
# Register as a user-scoped MCP server
claude mcp add macro-runner --scope user -- node /absolute/path/to/macro-runner/index.js

# Verify it's registered
claude mcp get macro-runner
```

### Or configure manually

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "macro-runner": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/macro-runner/index.js"],
      "env": {
        "MACRO_DEFAULT_TIMEOUT_MS": "300000",
        "MACRO_TOKEN_BENCHMARK_ENABLED": "true"
      }
    }
  }
}
```

And enable in `~/.claude/settings.json`:

```json
"enabledMcpjsonServers": ["macro-runner"]
```

### Windows (PowerShell)

```powershell
claude mcp add macro-runner --scope user -- node C:\Users\YOURNAME\.claude\mcp-servers\macro-runner\index.js
```

### Restart Claude Code

The `mcp__macro-runner__run_macro` tool will be available.

## Usage Examples

### Fix a bug and verify

```
mcp__macro-runner__run_macro({
  steps: [
    { type: "edit", description: "Fix null check", path: "src/auth.ts",
      old_str: "if (user.name)", new_str: "if (user?.name)" },
    { type: "shell", description: "TypeScript build", command: "npm run build" },
    { type: "shell", description: "Run tests", command: "npm test" }
  ]
})
```

### Use a pre-defined template

```
mcp__macro-runner__run_macro({
  template: "fix-build-test",
  overrides: {
    file_path: "src/auth.ts",
    old_code: "if (user.name)",
    new_code: "if (user?.name)"
  }
})
```

Use `list_macros` to see all available templates, and `show_macro` for details.

## Step Types

| Type | Purpose | Key Params |
|------|---------|------------|
| `edit` | Find-and-replace in file | `path`, `old_str`, `new_str` |
| `write` | Create or overwrite file | `path`, `content` |
| `shell` | Run command | `command`, `cwd`, `timeout_ms` |
| `read` | Read file content | `path`, `offset`, `limit` |
| `conditional` | Branch on condition | `condition`, `then`, `else` |
| `assert` | Fail early check | `condition`, `message` |

### Condition Expressions

Both forms are supported:

```
step[0].exit_code == 0
${{step[1].status}} == "success"
step[2].stdout_contains("PASS")
```

### Variable References

Use `assign_to` on read steps to store content. Reference with `${{variable_name}}` in later steps.

## Tools

| Tool | Purpose |
|------|---------|
| `run_macro` | Execute a multi-step macro (main tool) |
| `list_macros` | List pre-defined macro templates |
| `show_macro` | Show template details and steps |
| `macro_status` | Cumulative execution statistics and estimated savings |

## Output Summarization

Three output modes control how much data is returned:

| Mode | Returns | Use Case |
|------|---------|----------|
| `summary` (default) | Step statuses + trimmed output + errors/warnings | Normal workflow |
| `errors_only` | Only failed step details | "Just show me what to fix" |
| `full` | Complete stdout/stderr | Debugging |

Smart extraction: error lines, warning lines, test summaries, build status — extracted from raw output via regex patterns.

## Token Savings

Each `run_macro` result includes a `token_savings_estimate` field with an **experimental heuristic estimate** (not based on real measurement yet). Real-world savings vary by workflow, model, and output verbosity.

A/B benchmarking against real Claude Code usage data is planned for a future release. See [BENCHMARK.md](./BENCHMARK.md).

## Security Model

**This tool executes arbitrary shell commands and file operations.** Treat it with the same caution as any shell access.

### Built-in Protections

- **Workspace Root**: Set `MACRO_WORKSPACE_ROOT` to restrict file reads/writes to a specific directory tree
- **Outside Workspace Lock**: Set `MACRO_ALLOW_OUTSIDE_WORKSPACE=false` (default) to block file access outside the workspace root
- **No Shell Command Filtering**: The tool does not restrict which commands can run — it trusts the LLM's judgment

### Recommendations

- Do **not** use with `--dangerously-skip-permissions` or equivalent flags
- Set `MACRO_WORKSPACE_ROOT` to your project directory when running untrusted macros
- Review the steps in a macro before running if you did not write them yourself
- Templates that include `git push` or destructive commands require explicit step inclusion — no template runs destructive commands by default

## Comparison with Tura

| Dimension | Tura (Codex) | Macro Runner |
|-----------|-------------|-------------|
| Integration | Replaces CLI (highly invasive) | MCP tool + Skill (zero migration) |
| Control | Forced batching | Model chooses when to use |
| Ecosystem | Standalone | Claude Code native |
| Maturity | Production (AGPL-3.0) | Experimental v0.1.0 (MIT) |

## License

MIT — see [LICENSE](./LICENSE)
