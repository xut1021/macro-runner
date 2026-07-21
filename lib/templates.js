/**
 * Template Loader — loads and resolves YAML macro templates.
 *
 * Uses a minimal inline parser for our simple YAML template format
 * (no external dependency required — templates use only basic YAML features).
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

const TEMPLATES_DIR = process.env.MACRO_TEMPLATES_DIR ||
  join(homedir(), '.claude', 'mcp-servers', 'macro-runner', 'macros');

/**
 * Minimal YAML parser for our constrained template format.
 * Only handles the subset we use: strings, numbers, booleans, arrays, nested objects.
 */
function parseSimpleYAML(text) {
  const lines = text.split('\n');
  const root = {};
  // Stack entries: { container, indent, parentKey }
  // parentKey is the key in the parent container that points to this container
  const stack = [{ container: root, indent: -1, parentKey: null }];
  let multilineTarget = null; // { container, key }
  let multilineValue = '';
  let multilineBaseIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.replace(/\r$/, '').trimStart();
    const indent = rawLine.replace(/\r$/, '').length - trimmed.length;

    // Skip blank lines and comments
    if (trimmed === '' || trimmed.startsWith('#')) {
      if (multilineTarget && indent >= multilineBaseIndent) {
        multilineValue += '\n';
      }
      continue;
    }

    // Multiline continuation
    if (multilineTarget && indent >= multilineBaseIndent && !trimmed.startsWith('- ')) {
      multilineValue += (multilineValue ? ' ' : '') + trimmed;
      continue;
    }
    if (multilineTarget) {
      // Flush multiline
      multilineTarget.container[multilineTarget.key] = multilineValue.trim();
      multilineTarget = null;
      multilineValue = '';
    }

    // Pop stack on dedent
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const frame = stack[stack.length - 1];
    const parent = frame.container;

    // Array item: "- ..."
    if (trimmed.startsWith('- ')) {
      const item = trimmed.slice(2);
      const ci = item.indexOf(': ');

      // Ensure parent is an array
      if (!Array.isArray(parent)) {
        // Convert parent from {} to []
        const arr = [];
        const parentFrame = stack.length >= 2 ? stack[stack.length - 2] : null;
        if (parentFrame && parentFrame.container && frame.parentKey) {
          parentFrame.container[frame.parentKey] = arr;
        }
        frame.container = arr;
      }

      if (ci >= 0) {
        const k = item.slice(0, ci).trim();
        const v = item.slice(ci + 2).trim().replace(/^"(.*)"$/, '$1');
        const obj = {};
        obj[k] = coerceValue(v);
        frame.container.push(obj);
        stack.push({ container: obj, indent, parentKey: null });
      } else {
        frame.container.push(coerceValue(item.replace(/^"(.*)"$/, '$1')));
      }
      continue;
    }

    // Key-value
    const ci = trimmed.indexOf(':');
    if (ci === -1) continue;

    const key = trimmed.slice(0, ci).trim();
    const rest = trimmed.slice(ci + 1).trim();

    // If we're "inside" the last array item (indented properties), add to it
    if (Array.isArray(parent) && parent.length > 0) {
      const last = parent[parent.length - 1];
      if (typeof last === 'object' && indent > frame.indent) {
        if (rest === '>-' || rest === '>' || rest === '|-' || rest === '|') {
          multilineTarget = { container: last, key };
          multilineValue = '';
          multilineBaseIndent = indent + 1;
        } else if (rest === '') {
          const child = {};
          last[key] = child;
          stack.push({ container: child, indent, parentKey: key });
        } else {
          last[key] = coerceValue(rest.replace(/^"(.*)"$/, '$1'));
        }
        continue;
      }
    }

    // Top-level or nested key in object
    if (rest === '>-' || rest === '>' || rest === '|-' || rest === '|') {
      multilineTarget = { container: parent, key };
      multilineValue = '';
      multilineBaseIndent = indent + 1;
    } else if (rest === '') {
      const child = {};
      parent[key] = child;
      stack.push({ container: child, indent, parentKey: key });
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      parent[key] = rest.slice(1, -1).split(',').map(s => coerceValue(s.trim().replace(/^"(.*)"$/, '$1')));
    } else {
      parent[key] = coerceValue(rest.replace(/^"(.*)"$/, '$1'));
    }
  }

  // Finalize multiline
  if (multilineTarget) {
    multilineTarget.container[multilineTarget.key] = multilineValue.trim();
  }

  return root;
}

function coerceValue(v) {
  if (typeof v !== 'string') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  const num = Number(v);
  if (!isNaN(num) && v !== '') return num;
  return v;
}

// === Template Loading ===

let _templatesCache = null;

export function loadAllTemplates() {
  if (_templatesCache) return _templatesCache;

  _templatesCache = [];

  if (!existsSync(TEMPLATES_DIR)) {
    console.error(`[macro-runner] Templates directory not found: ${TEMPLATES_DIR}`);
    return _templatesCache;
  }

  try {
    const files = readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      try {
        const content = readFileSync(join(TEMPLATES_DIR, file), 'utf8');
        const parsed = parseSimpleYAML(content);
        if (parsed.name) {
          _templatesCache.push({
            name: parsed.name,
            description: parsed.description || '',
            parameters: parsed.parameters || {},
            steps: parsed.steps || [],
            source_file: file,
          });
        }
      } catch (err) {
        console.error(`[macro-runner] Failed to load template ${file}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[macro-runner] Failed to read templates directory: ${err.message}`);
  }

  return _templatesCache;
}

/**
 * Find a template by name.
 */
export function findTemplate(name) {
  const templates = loadAllTemplates();
  return templates.find(t => t.name === name) || null;
}

/**
 * List all templates with metadata (no step details).
 */
export function listTemplates() {
  const templates = loadAllTemplates();
  return templates.map(t => ({
    name: t.name,
    description: t.description,
    parameters: Object.keys(t.parameters || {}).reduce((acc, k) => {
      const p = t.parameters[k];
      acc[k] = typeof p === 'object' ? p : { description: String(p) };
      return acc;
    }, {}),
    step_count: (t.steps || []).length,
  }));
}

/**
 * Resolve a template with parameter overrides to produce executable steps.
 */
export function resolveTemplate(template, overrides = {}) {
  if (!template || !template.steps) return null;

  // Merge defaults with overrides
  const params = {};
  for (const [key, def] of Object.entries(template.parameters || {})) {
    const defaultVal = typeof def === 'object' ? def.default : undefined;
    params[key] = overrides[key] !== undefined ? overrides[key] : defaultVal;
  }

  // Validate required parameters
  const missing = [];
  for (const [key, def] of Object.entries(template.parameters || {})) {
    const required = typeof def === 'object' ? def.required : false;
    if (required && (params[key] === undefined || params[key] === null || params[key] === '')) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    return { error: `Missing required parameters: ${missing.join(', ')}`, missing };
  }

  // Deep-clone and substitute {{param}} placeholders in step fields
  const resolvedSteps = JSON.parse(JSON.stringify(template.steps));

  function substitute(obj) {
    if (typeof obj === 'string') {
      return obj.replace(/\{\{(\w+)\}\}/g, (_, name) => {
        return params[name] !== undefined ? String(params[name]) : `{{${name}}}`;
      });
    }
    if (Array.isArray(obj)) return obj.map(item => substitute(item));
    if (obj && typeof obj === 'object') {
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = substitute(v);
      }
      return result;
    }
    return obj;
  }

  return { steps: resolvedSteps.map(step => substitute(step)) };
}
