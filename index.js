#!/usr/bin/env node
/**
 * Macro Runner MCP Server
 *
 * Exposes a `run_macro` tool that executes multi-step workflows
 * (edit files, run commands, read results) below the model boundary.
 * Reduces LLM round trips and token consumption for deterministic sequences.
 *
 * Tools:
 *   run_macro    — Execute a multi-step macro (main tool)
 *   list_macros  — List available pre-defined macro templates
 *   show_macro   — Show details of a specific macro template
 *   macro_status — Show cumulative execution statistics
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { runMacro, logBenchmark, getStats } from './lib/executor.js';
import { formatMacroResult } from './lib/summarizer.js';
import { findTemplate, listTemplates, resolveTemplate } from './lib/templates.js';
import { sanitizeObject } from './lib/sanitizer.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

function errorResponse(message) {
  return sanitizeResponse({
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
    isError: true,
  });
}

function sanitizeResponse(response) {
  if (response.content) {
    for (const c of response.content) {
      if (typeof c.text === 'string') {
        try {
          const parsed = JSON.parse(c.text);
          const clean = sanitizeObject(parsed);
          c.text = JSON.stringify(clean, null, 2);
        } catch (_) {
          // Not JSON — sanitize directly
          c.text = sanitizeObject(c.text);
        }
      }
    }
  }
  return response;
}

// === Server Setup ===

const server = new Server(
  {
    name: 'macro-runner',
    version: pkg.version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// === Tool Definitions ===

const TOOLS = [
  {
    name: 'run_macro',
    description:
      'Execute a multi-step macro that batches deterministic actions below the model boundary. ' +
      'Use this when you need to edit files, run shell commands, and read results in a predictable sequence — ' +
      'instead of making individual tool calls and waiting between each one. ' +
      'Steps execute sequentially in order. Stops on first failure by default. ' +
      'Returns structured results with error/warning extraction and output summarization. ' +
      'Common use cases: fix → build → test, npm install → verify, multi-file refactor → build.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description:
            'Ordered list of steps to execute sequentially. Each step must have a "type" field. ' +
            'Supported types: edit, write, shell, read, conditional, assert.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['edit', 'write', 'shell', 'read', 'conditional', 'assert'],
                description: 'Step type.',
              },
              id: {
                type: 'string',
                description: 'Optional stable identifier for cross-step references. Must match /^[A-Za-z_][A-Za-z0-9_]*$/ and be unique. Reference via steps.ID.property or ${{steps.ID.property}}.',
              },
              description: {
                type: 'string',
                description: 'Human-readable description of what this step does (shown in results).',
              },
              // edit / write params
              path: { type: 'string', description: 'File path (edit, write, read).' },
              file: { type: 'string', description: 'Alias for path (edit, write, read).' },
              old_str: { type: 'string', description: 'Exact text to find and replace (edit).' },
              old_string: { type: 'string', description: 'Alias for old_str (edit).' },
              new_str: { type: 'string', description: 'Replacement text (edit).' },
              new_string: { type: 'string', description: 'Alias for new_str (edit).' },
              create_if_missing: { type: 'boolean', description: 'Create file if missing (edit, default false).' },
              content: { type: 'string', description: 'Full file content (write).' },
              // shell params
              command: { type: 'string', description: 'Shell command to run (shell).' },
              cwd: { type: 'string', description: 'Working directory for command (shell).' },
              timeout_ms: { type: 'number', description: 'Timeout in ms (shell, default 120000).' },
              env: { type: 'object', description: 'Extra environment variables (shell).' },
              trim_output_lines: { type: 'number', description: 'Max output lines to return (shell, default 50).' },
              // read params
              offset: { type: 'number', description: 'Start line offset (read, default 0).' },
              limit: { type: 'number', description: 'Max lines to read (read, default 200).' },
              assign_to: { type: 'string', description: 'Store result in named variable for later ${{var}} references.' },
              // conditional / assert params
              condition: { type: 'string', description: 'Condition expression: step[N].exit_code == 0, step[N].status == "success", step[N].stdout_contains("text").' },
              then: { type: 'array', description: 'Steps to run if condition is true (conditional).' },
              else: { type: 'array', description: 'Steps to run if condition is false (conditional).' },
              message: { type: 'string', description: 'Failure message if assertion fails (assert).' },
            },
            required: ['type'],
          },
        },
        template: {
          type: 'string',
          description:
            'Name of a pre-defined macro template to use instead of inline steps. ' +
            'Use list_macros to see available templates.',
        },
        overrides: {
          type: 'object',
          description: 'Key-value overrides for template parameters (only with template).',
        },
        stop_on_error: {
          type: 'boolean',
          description: 'Stop execution on first step failure. Default: true.',
        },
        output_mode: {
          type: 'string',
          enum: ['summary', 'full', 'errors_only'],
          description:
            'How much output to return. summary (default): step statuses + trimmed output + errors/warnings. ' +
            'full: complete stdout/stderr. errors_only: only failed step details.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Maximum total execution time in ms. Default: 300000 (5 minutes).',
        },
        schema_version: {
          type: 'string',
          description: 'Schema version for forward compatibility. Currently "1".',
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, preview all steps without executing. Returns what would be modified, which commands would run, and their risk levels. No side effects.',
        },
        rollback_on_error: {
          type: 'boolean',
          description: 'If true, save original file content before edit/write steps and restore on failure. Only reverts file changes — shell side effects (npm install, git push, etc.) are NOT reversible.',
        },
      },
    },
  },
  {
    name: 'list_macros',
    description:
      'List all available pre-defined macro templates. Each template has a name, description, ' +
      'parameter list, and step count. Use with run_macro\'s "template" parameter to run.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'show_macro',
    description:
      'Show the full definition of a specific macro template, including all steps and parameter descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the macro template to show (e.g., "fix-build-test").',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'macro_status',
    description:
      'Show cumulative macro execution statistics: total macros run, estimated tokens and round trips saved.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// === Tool Handlers ===

async function handleRunMacro(args) {
  const mode = args.output_mode || 'summary';
  const options = {
    stop_on_error: args.stop_on_error !== false,
    timeout_ms: args.timeout_ms ?? null,  // v0.1.4: ?? respects explicit 0
    dry_run: args.dry_run === true,
    rollback_on_error: args.rollback_on_error === true,
    schema_version: args.schema_version || '1',
    output_mode: mode,
  };

  let steps;

  // Template and inline steps are mutually exclusive
  if (args.template) {
    const template = findTemplate(args.template);
    if (!template) {
      const available = listTemplates().map(t => t.name).join(', ');
      return errorResponse(`Unknown template: "${args.template}". Available: ${available || '(none)'}. Use list_macros to see all templates.`);
    }

    const resolved = resolveTemplate(template, args.overrides || {});
    if (resolved.error) {
      return errorResponse(`Template parameter error: ${resolved.error}. Required: ${Object.keys(template.parameters || {}).join(', ')}`);
    }

    steps = resolved.steps;
  } else if (Array.isArray(args.steps) && args.steps.length > 0) {
    steps = args.steps;
  } else {
    return errorResponse('Either "steps" (array of step objects) or "template" (macro template name) must be provided.');
  }

  // Validate that all steps have a type
  const invalidSteps = steps.filter(s => !s.type);
  if (invalidSteps.length > 0) {
    return errorResponse(`${invalidSteps.length} step(s) missing required "type" field. Each step must have a type (edit, write, shell, read, conditional, assert).`);
  }

  // Execute
  try {
    const result = runMacro(steps, options);
    logBenchmark(result);
    const formatted = formatMacroResult(result, mode);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(formatted, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: `Macro execution error: ${err.message}`,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
}

async function handleListMacros() {
  const list = listTemplates();
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          templates: list,
          total: list.length,
        }, null, 2),
      },
    ],
  };
}

async function handleShowMacro(args) {
  const template = findTemplate(args.name);

  if (!template) {
    const available = listTemplates().map(t => t.name).join(', ');
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: `Unknown template: "${args.name}". Available: ${available || '(none)'}`,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  // Return template with steps — steps are the blueprint, not yet parameter-resolved
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          name: template.name,
          description: template.description,
          parameters: template.parameters,
          steps: template.steps,
          step_count: (template.steps || []).length,
        }, null, 2),
      },
    ],
  };
}

async function handleMacroStatus() {
  const stats = getStats();
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ...stats,
          message: stats.macros_run === 0
            ? 'No macros have been run yet in this session.'
            : `${stats.macros_run} macros run, ~${stats.estimated_tokens_saved.toLocaleString()} tokens saved, ${stats.estimated_round_trips_saved} round trips saved.`,
        }, null, 2),
      },
    ],
  };
}

// === Request Handlers ===

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let response;
  switch (name) {
    case 'run_macro':
      response = await handleRunMacro(args || {});
      break;
    case 'list_macros':
      response = await handleListMacros();
      break;
    case 'show_macro':
      response = await handleShowMacro(args || {});
      break;
    case 'macro_status':
      response = await handleMacroStatus();
      break;
    default:
      response = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: `Unknown tool: "${name}". Available: run_macro, list_macros, show_macro, macro_status.`,
            }, null, 2),
          },
        ],
        isError: true,
      };
  }

  // v0.1.4: unified sanitization — all responses pass through sanitizer
  return sanitizeResponse(response);
});

// === Start Server ===

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[macro-runner] Macro Runner MCP Server v${pkg.version} started`);
  console.error('[macro-runner] Tools: run_macro, list_macros, show_macro, macro_status');
}

main().catch((err) => {
  console.error('[macro-runner] Fatal error:', err);
  process.exit(1);
});
