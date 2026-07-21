---
name: macro-runner
description: >
  Macro Runner for batching multi-step tool sequences below the model boundary.
  Use when you need to edit files, run shell commands, and read results in a
  predictable sequence without intermediate LLM responses. Reduces round trips
  and token consumption for fix-build-test, install-verify, and refactoring workflows.
license: MIT
metadata:
  version: "1.0"
  tags: [macro, automation, batch, performance, token-savings]
trigger:
  keywords: [fix and verify, batch operations, multi-step, build and test, macro]
---

# Macro Runner — Multi-Step Batch Execution

## Core Concept

Instead of calling tools one-by-one (edit → wait → build → wait → test → wait),
**specify all steps upfront** as a single `run_macro` call via `mcp__macro-runner__run_macro`.
Steps execute sequentially below the model boundary. You only get results back when:

- All steps complete successfully, OR
- A step fails (early stop by default), OR
- The macro times out

## When to Use Macros

### ✅ STRONG SIGNALS — use a macro

| Situation | Example |
|-----------|---------|
| Fix a bug → build → run tests | "This function has a typo, let me fix it and verify" |
| Install → verify installation | "Let me install the package and check it works" |
| Multiple file edits with no inter-dependency | "Rename this function in 5 files" |
| Create file → format → lint | "Let me create this module and make sure it passes checks" |
| Refactor → build → test | Pattern: deterministic edits followed by deterministic verification |

### ❌ WEAK SIGNALS — do NOT use a macro

| Situation | Why not |
|-----------|---------|
| Step N output determines step N+1 content | Need intermediate reasoning |
| The fix strategy is uncertain | Blind macro may be wrong |
| Destructive operations (push, deploy, delete) | Each needs a checkpoint |
| Exploring unfamiliar codebase | Need feedback after each command |
| User asked for step-by-step confirmation | Respect preference |

## Step Reference

| type | Required params | Optional params | Description |
|------|----------------|-----------------|-------------|
| `edit` | `path`, `old_str`, `new_str` | `create_if_missing` | Find-and-replace in a file |
| `write` | `path`, `content` | — | Create or overwrite a file |
| `shell` | `command` | `cwd`, `timeout_ms`, `env`, `trim_output_lines` | Run a shell command |
| `read` | `path` | `offset`, `limit`, `assign_to` | Read file content |
| `conditional` | `condition`, `then` | `else` | Branch on previous step outcomes |
| `assert` | `condition`, `message` | — | Fail early if condition fails |

### Variable References

Use `assign_to` on read steps to store content. Reference with `${{variable_name}}` in later steps.
Pre-defined references: `${{step[0].exit_code}}`, `${{step[1].status}}`, `${{step[2].stdout}}`.

### Condition Expressions

Both bare and `${{}}`-wrapped forms work:
- `step[0].exit_code == 0` or `${{step[0].exit_code}} == 0` — numeric comparison
- `step[1].status == "success"` — string comparison
- `step[2].stdout_contains("PASS")` — content check

## Pre-Defined Templates

| Template | Steps | When to use |
|----------|-------|-------------|
| `fix-build-test` | edit → build → test | Standard bug-fix workflow |
| `install-and-verify` | install → read(package.json) → verify | Install and check a package |
| `git-commit-push` | add → commit → push | Standard git workflow |

Use `list_macros` to see all available templates. Use `show_macro` to see a template's full definition.

## Output Modes

| Mode | What it returns | When to use |
|------|----------------|-------------|
| `summary` (default) | Step statuses + trimmed output + errors | Normal workflow |
| `errors_only` | Only failed step details | You just need to know what to fix |
| `full` | Complete stdout/stderr | Debugging or when you need full context |

## Anti-Patterns

1. **Don't macro-ize exploration** — if you're reading files to understand code, individual calls give tighter feedback
2. **Don't macro-ize unknown-answer chains** — if step 2 depends on the output of step 1 in unpredictable ways
3. **Don't nest deeply with conditionals** — >3 conditional branches means you need intermediate reasoning
4. **Don't over-optimize for token savings** — a few extra round trips for clarity beats 10 minutes of blind execution
5. **Don't use for destructive ops without asserts** — always assert preconditions before pushes, deploys, or data mutations
