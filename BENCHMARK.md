# Benchmark Methodology

## Current Status: Experimental Estimator

The `token_savings_estimate` returned by each `run_macro` call and the `macro_status` tool use a **heuristic formula**, not real measurement:

```
tokens_without = (steps_ran × 1500) + (shell_steps × 500)
tokens_with = tokens_without × 0.35
round_trips_saved = steps_ran - 1
```

This is a conservative starting point. Real savings depend on:
- Model context window size at the time of each call
- Output verbosity of build/test commands
- Model reasoning effort and response length
- Whether steps succeed or fail early

## Planned: A/B Measurement

A future release will add real A/B benchmarking:
1. Run identical tasks with and without `run_macro`
2. Record actual Claude Code usage/token data for each
3. Publish results with methodology

## Enabling Benchmark Logging

Set `MACRO_TOKEN_BENCHMARK_ENABLED=true` in your `.mcp.json` env. Each macro run appends a line to `~/.claude/macro-benchmarks.jsonl`:

```jsonl
{"timestamp":"2026-07-22T...","status":"completed","steps_total":3,"steps_executed":3,"steps_passed":3,"steps_failed":0,"duration_ms":3420,"estimated_tokens_without_macro":4500,"tokens_consumed":1575,"tokens_saved":2925,"round_trips_saved":2,"_note":"Experimental heuristic estimate — not based on real measurement."}
```

Use `macro_status` to view cumulative in-session statistics.

## Tura Reference (for context)

Tura's published benchmark (60 DeepSWE tasks, GPT-5.6 SOL High):

| Configuration | Pass Rate | Tokens | Rounds |
|--------------|-----------|--------|--------|
| Codex CLI High | 60.0% | 455.7M | 6,074 |
| Tura Macro Direct | 65.0% | 75.1M | 969 |
| Tura Balanced | 80.0% | 229.7M | 2,017 |

Tura achieves higher savings by replacing the entire CLI harness. Macro Runner, as an opt-in MCP tool, provides a different trade-off: lower savings ceiling but zero migration cost.
