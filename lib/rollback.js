/**
 * Transaction Rollback Manager
 *
 * Saves original file content before edit/write steps so changes can be
 * rolled back if the macro fails. Only handles file operations —
 * shell side effects (npm install, git push, etc.) are NOT reversible.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { createHash, randomBytes } from 'crypto';
import { homedir } from 'os';

const BACKUP_DIR = `${homedir()}/.claude/macro-rollback`;

class RollbackManager {
  constructor() {
    /** @type {Map<string, {path: string, original: string|null, existed: boolean}>} */
    this.snapshots = new Map();
    /** @type {Set<string>} created files that didn't exist before */
    this.createdFiles = new Set();
    this.enabled = true;
  }

  /**
   * Take a snapshot of a file before editing/writing.
   * Call BEFORE the file is modified.
   */
  snapshot(filePath) {
    if (!this.enabled) return;
    const resolved = resolve(filePath);
    if (this.snapshots.has(resolved)) return; // already saved

    const existed = existsSync(resolved);
    const original = existed ? readFileSync(resolved, 'utf8') : null;

    this.snapshots.set(resolved, { path: resolved, original, existed });
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
   * @returns {{ restored: string[], deleted: string[], failed: string[] }}
   */
  rollback() {
    const restored = [];
    const deleted = [];
    const failed = [];

    for (const [path, snap] of this.snapshots) {
      try {
        if (snap.existed && snap.original !== null) {
          // Restore original content
          writeFileSync(path, snap.original, 'utf8');
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

    return { restored, deleted, failed };
  }

  /**
   * Discard all snapshots (called on successful completion, no rollback needed).
   */
  clear() {
    this.snapshots.clear();
    this.createdFiles.clear();
  }

  /**
   * Return summary of what's being tracked.
   */
  summary() {
    return {
      files_tracked: this.snapshots.size,
      files_created: this.createdFiles.size,
      files_modified: [...this.snapshots.values()].filter(s => s.existed).length,
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
