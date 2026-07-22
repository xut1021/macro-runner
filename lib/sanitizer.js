/**
 * Output Sanitizer
 *
 * Masks secrets (API keys, tokens, passwords, auth headers) in text output
 * before it's returned to the LLM or written to benchmark logs.
 */

// === Secret Patterns ===
// Structured as [pattern, replacement, label] for transparency

const SECRET_PATTERNS = [
  // Key=value assignment patterns
  {
    pattern: /(API[_-]?KEY|api[_-]?key|apikey)\s*[=:]\s*['"]?\S+['"]?/gi,
    replace: '$1=[REDACTED]',
    label: 'API key assignment',
  },
  {
    pattern: /(TOKEN|token|AUTH_TOKEN|auth_token)\s*[=:]\s*['"]?\S+['"]?/gi,
    replace: '$1=[REDACTED]',
    label: 'Token assignment',
  },
  {
    pattern: /(PASSWORD|password|PASSWD|passwd)\s*[=:]\s*['"]?\S+['"]?/gi,
    replace: '$1=[REDACTED]',
    label: 'Password assignment',
  },
  {
    pattern: /(SECRET|secret)\s*[=:]\s*['"]?\S+['"]?/gi,
    replace: '$1=[REDACTED]',
    label: 'Secret assignment',
  },

  // Authorization headers
  {
    pattern: /(Authorization|authorization)\s*[=:]\s*['"]?(Bearer|Basic|Token)\s+\S+['"]?/gi,
    replace: '$1=[REDACTED]',
    label: 'Authorization header',
  },

  // JWT tokens (base64url-encoded JSON)
  {
    pattern: /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\b/g,
    replace: '[REDACTED_JWT]',
    label: 'JWT token',
  },

  // AWS-style keys
  {
    pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replace: '[REDACTED_AWS_KEY]',
    label: 'AWS access key',
  },

  // GitHub tokens
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g,
    replace: '[REDACTED_GH_TOKEN]',
    label: 'GitHub token',
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    replace: '[REDACTED_GH_PAT]',
    label: 'GitHub PAT',
  },

  // Generic long hex/base64 secrets (>32 chars, looks like a key)
  {
    pattern: /\b(sk|pk|rk)-[a-zA-Z0-9]{32,}\b/g,
    replace: '[REDACTED_KEY]',
    label: 'Stripe-style key',
  },

  // OpenAI/Anthropic API key patterns
  {
    pattern: /\bsk-(proj-)?[a-zA-Z0-9_-]{32,}\b/g,
    replace: '[REDACTED_API_KEY]',
    label: 'OpenAI/Anthropic API key',
  },

  // Private key markers
  {
    pattern: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH|PGP)\s+PRIVATE\s+KEY-----[^-]*-----END\s+\1\s+PRIVATE\s+KEY-----/gs,
    replace: '[REDACTED_PRIVATE_KEY]',
    label: 'Private key PEM',
  },

  // Connection strings with credentials
  {
    pattern: /(mongodb|mysql|postgres|postgresql|redis|jdbc):\/\/[^:@\s]+:[^@\s]+@/gi,
    replace: '$1://[REDACTED]:[REDACTED]@',
    label: 'Database connection string with credentials',
  },
];

/**
 * Sanitize a string by masking all detected secrets.
 * @param {string} text - Raw text to sanitize
 * @returns {{ sanitized: string, redactions: number, labels: string[] }}
 */
export function sanitize(text) {
  if (!text || typeof text !== 'string') {
    return { sanitized: text || '', redactions: 0, labels: [] };
  }

  let result = text;
  let redactions = 0;
  const labels = [];

  for (const { pattern, replace, label } of SECRET_PATTERNS) {
    // Handle $1 back-references by using the regex directly
    const regex = new RegExp(pattern.source, pattern.flags);
    const before = result;
    result = result.replace(regex, (...args) => {
      redactions++;
      if (!labels.includes(label)) labels.push(label);
      // If replace uses $1, substitute from match
      if (replace.includes('$1')) {
        return replace.replace('$1', args[1] || '');
      }
      return replace;
    });
  }

  return { sanitized: result, redactions, labels };
}

/**
 * Sanitize a shell step result's stdout and stderr.
 * @param {Object} stepResult - { stdout, stderr }
 * @returns {Object} Sanitized result
 */
export function sanitizeShellResult(stepResult) {
  const stdoutResult = sanitize(stepResult.stdout);
  const stderrResult = sanitize(stepResult.stderr);

  return {
    ...stepResult,
    stdout: stdoutResult.sanitized,
    stderr: stderrResult.sanitized,
    _sanitized: (stdoutResult.redactions + stderrResult.redactions) > 0,
    _redactions: stdoutResult.redactions + stderrResult.redactions,
    _redaction_labels: [...new Set([...stdoutResult.labels, ...stderrResult.labels])],
  };
}

/**
 * Sanitize command and env for benchmark logging.
 * Strips environment variable values.
 */
/**
 * Recursively sanitize all string values in an object tree.
 * Covers dry_run commands, approval_required responses, error messages, etc.
 * @param {*} obj - Any value (object, array, string, primitive)
 * @returns {*} Deep copy with all strings sanitized
 */
// v0.1.9: Broader key-name matching — catches OPENAI_API_KEY, DATABASE_PASSWORD, etc.
const SENSITIVE_KEY_RE = /(^|[_-])(api[_-]?key|token|password|passwd|secret|credential|authorization|auth|cookie|private[_-]?key)($|[_-])/i;

export function sanitizeObject(obj) {
  if (typeof obj === 'string') {
    return sanitize(obj).sanitized;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      // v0.1.8: Redact values under sensitive key names, even if the value
      // string itself doesn't contain "PASSWORD=" pattern
      result[key] = SENSITIVE_KEY_RE.test(key)
        ? '[REDACTED]'
        : sanitizeObject(value);
    }
    return result;
  }
  return obj;
}

export function sanitizeForLogging(command, env) {
  // Don't log full env — just keys
  const safeEnv = env ? Object.keys(env) : [];
  return { command, env_keys: safeEnv };
}
