---
name: macro-runner
description: >
  Macro Runner for batching multi-step tool sequences below the model boundary.
  Use when you need to edit files, run shell commands, and read results in a
  predictable sequence without intermediate LLM responses. Reduces round trips
  and token consumption for fix-build-test, install-verify, and refactoring workflows.
license: MIT
metadata:
  version: "0.1.4"
  tags: [macro, automation, batch, performance, token-savings, rollback, safety]
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
| `edit` | `path`, `old_str`, `new_str` | `create_if_missing`, `id` | Find-and-replace in a file |
| `write` | `path`, `content` | `id` | Create or overwrite a file |
| `shell` | `command` | `cwd`, `timeout_ms`, `env`, `trim_output_lines`, `id` | Run a shell command |
| `read` | `path` | `offset`, `limit`, `assign_to`, `id` | Read file content |
| `conditional` | `condition`, `then` | `else`, `id` | Branch on previous step outcomes |
| `assert` | `condition`, `message` | `id` | Fail early if condition fails |

All step types accept an optional `id` field (must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, must be unique). Use `steps.{id}.property` for stable cross-step references that survive index changes.

### Variable References

Use `assign_to` on read steps to store content. Reference with `${{variable_name}}` in later steps.
Variable names must match `/^[A-Za-z_][A-Za-z0-9_]*$/` (letters, digits, underscores; start with letter or underscore).
Reserved words (`step`, `steps`) cannot be used as variable names.

Pre-defined references:
- `${{step[0].exit_code}}` or `step[0].exit_code` — top-level step N (not branch steps)
- `${{steps.build.exit_code}}` or `steps.build.status` — by explicit step ID (stable, recommended)
- `${{step[1].stdout}}` — captured stdout
- `step[2].stdout_contains("text")` — substring match in stdout

### Condition Expressions

**Important (v0.1.4):** Conditions are now strictly validated. Typo property names (e.g. `exut_code`),
unresolved step references, and unrecognized expression syntax will fail explicitly — they no longer
default to truthy.

Supported forms:
- `step[0].exit_code == 0` or `${{step[0].exit_code}} == 0` — numeric comparison
- `steps.build.status == "success"` — by explicit step ID (recommended for stability)
- `step[1].status == "success"` — string comparison
- `step[2].stdout_contains("PASS")` — content check
- `true` / `false` — boolean literals

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
