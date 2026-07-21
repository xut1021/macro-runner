/**
 * Command Safety Guard
 *
 * Detects dangerous shell commands before execution and returns
 * risk assessments. Supports three modes: deny, approve, warn.
 */

// === Risk Levels ===
const RISK = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

// === Dangerous Command Patterns ===

// CRITICAL — data destruction, system compromise
const CRITICAL_PATTERNS = [
  // Recursive force delete
  { pattern: /\brm\s+-rf\s+(\/|\/etc|\/home|\/var|~|\.\.?\/\.\.)/i, reason: 'Recursive force delete of system or parent directories' },
  { pattern: /\brm\s+-rf\s+\/\s*$/i, reason: 'Delete root filesystem' },
  { pattern: /\bdel\s+\/[sq]\s+[A-Z]:\\/i, reason: 'Force delete of drive root (Windows)' },
  { pattern: /\brd\s+\/[sq]\s+[A-Z]:\\/i, reason: 'Force remove directory tree (Windows)' },

  // Disk formatting
  { pattern: /\b(format|mkfs\.|diskutil\s+eraseDevice)/i, reason: 'Disk formatting operation' },
  { pattern: /\bdd\s+if=/i, reason: 'Raw disk write (dd)' },

  // Force push to main/master
  { pattern: /\bgit\s+push\s+(-f|--force)\b/i, reason: 'Force push to remote' },
  { pattern: /\bgit\s+push\s+.*--delete\b/i, reason: 'Delete remote branch' },

  // Destructive git operations
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'Hard git reset (discards working tree)' },
  { pattern: /\bgit\s+clean\s+-[fdx]+\b/i, reason: 'Git clean (removes untracked files)' },

  // npm unpublish
  { pattern: /\bnpm\s+unpublish\b/i, reason: 'Unpublish npm package' },
];

// HIGH — remote side effects, deployment, privilege escalation
const HIGH_PATTERNS = [
  { pattern: /\bnpm\s+publish\b/i, reason: 'Publish npm package' },
  { pattern: /\bdocker\s+(push|rm\s+-f|system\s+prune)\b/i, reason: 'Docker push or destructive operation' },
  { pattern: /\bkubectl\s+(delete|apply)\b/i, reason: 'Kubernetes cluster modification' },
  { pattern: /\bterraform\s+(apply|destroy)\b/i, reason: 'Terraform infrastructure modification' },
  { pattern: /\b(ansible|ansible-playbook)\b/i, reason: 'Ansible automation execution' },
  { pattern: /\bsudo\b/i, reason: 'Privilege escalation (sudo)' },
  { pattern: /\bpip\s+install\b.*\bsudo\b|\bsudo\b.*\bpip\s+install\b/i, reason: 'System-wide pip install' },
  { pattern: /\bchmod\s+[0-7]*7[0-7]*\s+\/\S+/i, reason: 'World-writable permissions on system paths' },
  { pattern: /\bchown\s+-R\s+\S+\s+\/\S+/i, reason: 'Recursive ownership change on system path' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'System shutdown/reboot' },

  // Database destructive operations
  { pattern: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, reason: 'Database destructive operation' },

  // Curl/wget piped to shell
  { pattern: /\bcurl\s+\S+\s*\|\s*(ba)?sh\b/i, reason: 'Curl piped to shell' },
  { pattern: /\bwget\s+\S+\s*-O\s*-\s*\|\s*(ba)?sh\b/i, reason: 'Wget piped to shell' },

  // PowerShell remote execution
  { pattern: /\bInvoke-(Expression|WebRequest|Command)\b/i, reason: 'PowerShell remote execution' },
  { pattern: /\biex\s*\(/i, reason: 'PowerShell Invoke-Expression (iex)' },
];

// MEDIUM — credential exposure, network exfiltration
const MEDIUM_PATTERNS = [
  { pattern: /\b(env|printenv|set)\s*$/i, reason: 'Print all environment variables (may expose secrets)' },
  { pattern: /\bcat\s+\S*\.env\b/i, reason: 'Read .env file (may contain secrets)' },
  { pattern: /\becho\s+\$?(API_KEY|TOKEN|PASSWORD|SECRET|AUTH)/i, reason: 'Echo may expose credential variable' },
  { pattern: /\bcurl\s+-d\s/i, reason: 'Curl POST with data (potential data exfiltration)' },
  { pattern: /\bnc\s+-[lL]\b/i, reason: 'Netcat listener (opens network port)' },
  { pattern: /\bssh\s+-[iLDR]\b/i, reason: 'SSH tunneling or key usage' },
  { pattern: /\bscp\b/i, reason: 'Secure copy (file transfer)' },
  { pattern: /\bgit\s+push\b(?!.*(-f|--force))/i, reason: 'Git push to remote' },
];

/**
 * Check a shell command against dangerous patterns.
 * @param {string} command - The shell command to check
 * @returns {{ risk: string, reasons: string[], approved: boolean }}
 */
export function checkCommand(command) {
  if (!command || typeof command !== 'string') {
    return { risk: RISK.LOW, reasons: [], approved: true };
  }

  const mode = process.env.MACRO_DANGEROUS_COMMANDS || 'approve';
  const allReasons = [];

  // Check CRITICAL patterns
  for (const { pattern, reason } of CRITICAL_PATTERNS) {
    if (pattern.test(command)) {
      allReasons.push(`[CRITICAL] ${reason}`);
    }
  }

  // Check HIGH patterns
  for (const { pattern, reason } of HIGH_PATTERNS) {
    if (pattern.test(command)) {
      allReasons.push(`[HIGH] ${reason}`);
    }
  }

  // Check MEDIUM patterns
  for (const { pattern, reason } of MEDIUM_PATTERNS) {
    if (pattern.test(command)) {
      allReasons.push(`[MEDIUM] ${reason}`);
    }
  }

  if (allReasons.length === 0) {
    return { risk: RISK.LOW, reasons: [], approved: true };
  }

  // Determine risk level
  const hasCritical = allReasons.some(r => r.startsWith('[CRITICAL]'));
  const hasHigh = allReasons.some(r => r.startsWith('[HIGH]'));
  const risk = hasCritical ? RISK.CRITICAL : hasHigh ? RISK.HIGH : RISK.MEDIUM;

  switch (mode) {
    case 'deny':
      return { risk, reasons: allReasons, approved: false };
    case 'warn':
      return { risk, reasons: allReasons, approved: true };
    case 'approve':
    default:
      // MEDIUM: auto-approve; HIGH/CRITICAL: require approval
      return {
        risk,
        reasons: allReasons,
        approved: risk === RISK.MEDIUM,
      };
  }
}

/**
 * Check all shell steps in a macro for dangerous commands.
 * Returns the first non-approved result, or null if all clear.
 */
export function auditSteps(steps) {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.type === 'shell' && step.command) {
      const result = checkCommand(step.command);
      if (!result.approved) {
        return { step_index: i, command: step.command, ...result };
      }
    }
    // Recurse into conditional branches
    if (step.type === 'conditional') {
      for (const branch of [step.then, step.else]) {
        if (Array.isArray(branch)) {
          const subResult = auditSteps(branch);
          if (subResult) return subResult;
        }
      }
    }
  }
  return null;
}

export { RISK };
