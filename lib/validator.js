/**
 * Macro Step Validator
 *
 * Recursively validates all steps BEFORE execution so we don't fail
 * mid-macro on a step format error in a deep conditional branch.
 *
 * v0.1.4: Enforces valid variable names for assign_to and step id.
 *         Reports duplicate step IDs.
 */

const VALID_TYPES = ['edit', 'write', 'shell', 'read', 'conditional', 'assert'];
const VALID_OUTPUT_MODES = ['summary', 'full', 'errors_only'];

// v0.1.4: variable names must be safe for regex interpolation and unambiguous
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const REQUIRED_FIELDS = {
  edit: ['path', 'old_str', 'new_str'],
  write: ['path', 'content'],
  shell: ['command'],
  read: ['path'],
  conditional: ['condition'],
  assert: ['condition'],
};

// Aliases: supporting both path/file, old_str/old_string, new_str/new_string
const ALIASES = {
  path: ['file'],
  old_str: ['old_string'],
  new_str: ['new_string'],
};

const MAX_NESTING_DEPTH = 5;
const MAX_TOTAL_STEPS = 100;

/**
 * Check if a required field is present (including via aliases).
 */
function hasField(step, field) {
  if (step[field] !== undefined && step[field] !== null) return true;
  const aliases = ALIASES[field] || [];
  return aliases.some(a => step[a] !== undefined && step[a] !== null);
}

/**
 * Validate a single step object.
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateStep(step, path = '', assignedVars = new Set(), stepIds = new Set()) {
  const errors = [];
  const warnings = [];

  if (!step || typeof step !== 'object') {
    errors.push(`${path}: step is not an object`);
    return { errors, warnings };
  }

  // Type
  if (!step.type) {
    errors.push(`${path}: missing required field "type"`);
  } else if (!VALID_TYPES.includes(step.type)) {
    errors.push(`${path}: unknown type "${step.type}" — must be: ${VALID_TYPES.join(', ')}`);
    return { errors, warnings }; // can't validate further without a valid type
  }

  const type = step.type;
  const prefix = path || `step[type=${type}]`;

  // v0.1.4: validate step id if present
  if (step.id !== undefined) {
    if (typeof step.id !== 'string' || step.id === '') {
      errors.push(`${prefix}: id must be a non-empty string`);
    } else if (!IDENTIFIER_RE.test(step.id)) {
      errors.push(`${prefix}: invalid id "${step.id}" — must match ${IDENTIFIER_RE.toString()}`);
    } else if (stepIds.has(step.id)) {
      errors.push(`${prefix}: duplicate step id "${step.id}" — step IDs must be unique`);
    } else {
      stepIds.add(step.id);
    }
  }

  // Required fields
  const required = REQUIRED_FIELDS[type] || [];
  for (const field of required) {
    if (!hasField(step, field)) {
      const aliases = (ALIASES[field] || []).join(' or ');
      errors.push(`${prefix}: missing required field "${field}"${aliases ? ` (or ${aliases})` : ''}`);
    }
  }

  // Type-specific validations
  if (type === 'edit') {
    if (hasField(step, 'old_str') && step.old_str === '') {
      warnings.push(`${prefix}: old_str is empty — will match nothing`);
    }
  }

  if (type === 'shell') {
    if (step.timeout_ms !== undefined && (typeof step.timeout_ms !== 'number' || step.timeout_ms < 0)) {
      errors.push(`${prefix}: timeout_ms must be a non-negative number`);
    }
    if (step.trim_output_lines !== undefined && (typeof step.trim_output_lines !== 'number' || step.trim_output_lines < 0)) {
      errors.push(`${prefix}: trim_output_lines must be a non-negative number`);
    }
  }

  if (type === 'read') {
    if (step.offset !== undefined && (typeof step.offset !== 'number' || step.offset < 0)) {
      errors.push(`${prefix}: offset must be a non-negative number`);
    }
    if (step.limit !== undefined && (typeof step.limit !== 'number' || step.limit <= 0)) {
      errors.push(`${prefix}: limit must be a positive number`);
    }
    if (step.assign_to !== undefined) {
      if (typeof step.assign_to !== 'string' || step.assign_to === '') {
        errors.push(`${prefix}: assign_to must be a non-empty string`);
      } else if (!IDENTIFIER_RE.test(step.assign_to)) {
        errors.push(`${prefix}: invalid assign_to "${step.assign_to}" — must match ${IDENTIFIER_RE.toString()}`);
      } else if (assignedVars.has(step.assign_to)) {
        errors.push(`${prefix}: duplicate assign_to "${step.assign_to}" — variable names must be unique`);
      } else if (step.assign_to === 'step' || step.assign_to === 'steps') {
        errors.push(`${prefix}: assign_to "${step.assign_to}" is a reserved word`);
      } else {
        assignedVars.add(step.assign_to);
      }
      if (/^step\[\d+\]\./.test(step.assign_to)) {
        errors.push(`${prefix}: assign_to cannot use step[N] prefix — this is a reserved pattern`);
      }
    }
  }

  if (type === 'conditional') {
    if (step.then !== undefined && !Array.isArray(step.then)) {
      errors.push(`${prefix}: "then" must be an array`);
    }
    if (step.else !== undefined && !Array.isArray(step.else)) {
      errors.push(`${prefix}: "else" must be an array`);
    }
    if (!step.then && !step.else) {
      warnings.push(`${prefix}: conditional has no "then" or "else" branch`);
    }
  }

  if (type === 'assert') {
    if (step.message !== undefined && typeof step.message !== 'string') {
      errors.push(`${prefix}: message must be a string`);
    }
  }

  // General field type checks
  if (step.description !== undefined && typeof step.description !== 'string') {
    warnings.push(`${prefix}: description should be a string`);
  }

  return { errors, warnings };
}

/**
 * Recursively validate steps, checking nesting depth and total count.
 * @param {Array} steps - Top-level steps array
 * @param {Object} macroOptions - { stop_on_error, timeout_ms, output_mode, ... }
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateMacro(steps, macroOptions = {}) {
  const errors = [];
  const warnings = [];

  if (!steps || !Array.isArray(steps)) {
    errors.push('"steps" must be an array');
    return { valid: false, errors, warnings };
  }

  if (steps.length === 0) {
    errors.push('"steps" array is empty — at least one step is required');
    return { valid: false, errors, warnings };
  }

  if (macroOptions.schema_version && macroOptions.schema_version !== '1') {
    errors.push(`Unsupported schema_version: "${macroOptions.schema_version}" — only "1" is supported`);
    return { valid: false, errors, warnings };
  }

  if (steps.length > MAX_TOTAL_STEPS) {
    errors.push(`Macro has ${steps.length} steps — maximum is ${MAX_TOTAL_STEPS}`);
    return { valid: false, errors, warnings };
  }

  // Validate macro-level options
  if (macroOptions.output_mode && !VALID_OUTPUT_MODES.includes(macroOptions.output_mode)) {
    errors.push(`output_mode "${macroOptions.output_mode}" is invalid — must be: ${VALID_OUTPUT_MODES.join(', ')}`);
  }
  if (macroOptions.timeout_ms !== undefined && (typeof macroOptions.timeout_ms !== 'number' || macroOptions.timeout_ms <= 0)) {
    errors.push('timeout_ms must be a positive number');
  }
  if (macroOptions.stop_on_error !== undefined && typeof macroOptions.stop_on_error !== 'boolean') {
    errors.push('stop_on_error must be a boolean');
  }
  if (macroOptions.dry_run !== undefined && typeof macroOptions.dry_run !== 'boolean') {
    errors.push('dry_run must be a boolean');
  }
  if (macroOptions.rollback_on_error !== undefined && typeof macroOptions.rollback_on_error !== 'boolean') {
    errors.push('rollback_on_error must be a boolean');
  }

  const assignedVars = new Set();
  const stepIds = new Set();

  function walk(stepList, depth, pathBase) {
    if (depth > MAX_NESTING_DEPTH) {
      errors.push(`${pathBase}: maximum nesting depth ${MAX_NESTING_DEPTH} exceeded`);
      return; // don't recurse further
    }

    for (let i = 0; i < stepList.length; i++) {
      const step = stepList[i];
      const stepPath = `${pathBase}[${i}]`;

      if (!step || typeof step !== 'object') {
        errors.push(`${stepPath}: invalid step (not an object)`);
        continue;
      }

      const result = validateStep(step, stepPath, assignedVars, stepIds);
      errors.push(...result.errors);
      warnings.push(...result.warnings);

      // Recurse into conditional branches
      if (step.type === 'conditional') {
        if (Array.isArray(step.then)) walk(step.then, depth + 1, `${stepPath}.then`);
        if (Array.isArray(step.else)) walk(step.else, depth + 1, `${stepPath}.else`);
      }
    }
  }

  // Also count total recursive steps
  let recursiveTotal = 0;
  function countAll(stepList) {
    for (const s of stepList) {
      recursiveTotal++;
      if (s.type === 'conditional') {
        if (Array.isArray(s.then)) countAll(s.then);
        if (Array.isArray(s.else)) countAll(s.else);
      }
    }
  }
  countAll(steps);
  if (recursiveTotal > MAX_TOTAL_STEPS) {
    errors.push(`Macro has ${recursiveTotal} total steps recursively — maximum is ${MAX_TOTAL_STEPS}`);
  }

  walk(steps, 1, 'steps');

  return { valid: errors.length === 0, errors, warnings };
}
