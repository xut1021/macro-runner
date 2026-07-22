/**
 * Transaction Rollback Manager
 *
 * Saves original file content before edit/write steps so changes can be
 * rolled back if the macro fails. Only handles file operations —
 * shell side effects (npm install, git push, etc.) are NOT reversible.
 *
 * v0.1.4: Uses Buffer (not utf8 strings) for binary-safe snapshots.
 *         Added per-file and total size limits.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';

// v0.1.9: Safe config parsing — NaN silently disables safety limits
function safeParseInt(envName, fallback) {
  const raw = process.env[envName];
  if (raw === undefined) return fallback;
  const val = parseInt(raw, 10);
  if (isNaN(val) || val < 0) {
    console.error(`[macro-runner] Invalid ${envName}="${raw}" — using default ${fallback}`);
    return fallback;
  }
  return val;
}

const MAX_ROLLBACK_FILE_BYTES = safeParseInt('MACRO_MAX_ROLLBACK_FILE_BYTES', 10 * 1024 * 1024);
const MAX_ROLLBACK_TOTAL_BYTES = safeParseInt('MACRO_MAX_ROLLBACK_TOTAL_BYTES', 100 * 1024 * 1024);

class RollbackManager {
  constructor() {
    /** @type {Map<string, {path: string, original: Buffer|null, existed: boolean}>} */
    this.snapshots = new Map();
    /** @type {Set<string>} created files that didn't exist before */
    this.createdFiles = new Set();
    /** @type {number} total bytes tracked */
    this.totalBytes = 0;
    this.enabled = true;
  }

  /**
   * Take a snapshot of a file before editing/writing.
   * Call BEFORE the file is modified.
   *
   * v0.1.4: Reads as Buffer for binary safety. Rejects files exceeding
   * per-file and total size limits.
   *
   * @returns {{ ok: boolean, error?: string }}
   */
  snapshot(filePath) {
    if (!this.enabled) return { ok: true };
    const resolved = resolve(filePath);
    if (this.snapshots.has(resolved)) return { ok: true }; // already saved

    const existed = existsSync(resolved);

    if (existed) {
      let fileBytes;
      try {
        fileBytes = statSync(resolved).size;
      } catch (_) {
        fileBytes = 0;
      }

      if (fileBytes > MAX_ROLLBACK_FILE_BYTES) {
        return {
          ok: false,
          error: `File too large for rollback: ${resolved} (${(fileBytes / 1024 / 1024).toFixed(1)} MB). ` +
            `Max per-file: ${MAX_ROLLBACK_FILE_BYTES / 1024 / 1024} MB. ` +
            'Set MACRO_MAX_ROLLBACK_FILE_BYTES to increase, or disable rollback_on_error.'
        };
      }

      if (this.totalBytes + fileBytes > MAX_ROLLBACK_TOTAL_BYTES) {
        return {
          ok: false,
          error: `Rollback total limit would be exceeded: ${((this.totalBytes + fileBytes) / 1024 / 1024).toFixed(1)} MB. ` +
            `Max total: ${MAX_ROLLBACK_TOTAL_BYTES / 1024 / 1024} MB. ` +
            'Set MACRO_MAX_ROLLBACK_TOTAL_BYTES to increase, or disable rollback_on_error.'
        };
      }

      this.totalBytes += fileBytes;
    }

    // Read as Buffer for binary-safe restoration
    const original = existed ? readFileSync(resolved) : null;

    this.snapshots.set(resolved, { path: resolved, original, existed });
    return { ok: true };
  }

  /**
   * Mark a file as newly created (didn't exist before write).
   */
  markCreated(filePath) {
    const resolved = resolve(filePath);
    this.createdFiles.add(resolved);
    if (!this.snapshots.has(resolved)) {
      this.snapshots.set(resolved, { path: resolved, original: null, existed: false });
    }
  }

  /**
   * Roll back all changes: restore modified files, delete created files.
   *
   * v0.1.4: Writes original Buffer back (not utf8 string), preserving
   * binary content for non-text files.
   *
   * @returns {{ restored: string[], deleted: string[], failed: Array<{path: string, error: string}> }}
   */
  rollback() {
    const restored = [];
    const deleted = [];
    const failed = [];

    for (const [path, snap] of this.snapshots) {
      try {
        if (snap.existed && snap.original !== null) {
          // Restore original content from Buffer
          writeFileSync(path, snap.original);
          restored.push(path);
        } else if (!snap.existed) {
          // Delete newly created file
          if (existsSync(path)) {
            unlinkSync(path);
            deleted.push(path);
          }
        }
      } catch (err) {
        failed.push({ path, error: err.message });
      }
    }

    // Also clean up any created files not tracked in snapshots
    for (const path of this.createdFiles) {
      if (!this.snapshots.has(path) && existsSync(path)) {
        try {
          unlinkSync(path);
          deleted.push(path);
        } catch (_) {}
      }
    }

    this.snapshots.clear();
    this.createdFiles.clear();
    this.totalBytes = 0;

    return { restored, deleted, failed };
  }

  /**
   * Discard all snapshots (called on successful completion, no rollback needed).
   */
  clear() {
    this.snapshots.clear();
    this.createdFiles.clear();
    this.totalBytes = 0;
  }

  /**
   * Return summary of what's being tracked.
   */
  summary() {
    return {
      files_tracked: this.snapshots.size,
      files_created: this.createdFiles.size,
      files_modified: [...this.snapshots.values()].filter(s => s.existed).length,
      total_bytes: this.totalBytes,
    };
  }
}

/**
 * Create a new RollbackManager instance.
 */
export function createRollbackManager() {
  return new RollbackManager();
}

export { RollbackManager };
