/**
 * Transaction Rollback Manager
 *
 * v0.1.11: markCreated() captures file identity immediately after creation.
 *          Deletion of created files during rollback verifies identity first.
 *          Uses shared config module (no duplicated safeParseInt).
 * v0.1.10: File identity tracking (dev, ino, symlink) prevents TOCTOU attacks.
 * v0.1.4:  Uses Buffer (not utf8 strings) for binary-safe snapshots.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync, lstatSync, realpathSync } from 'fs';
import { resolve } from 'path';
import { CONFIG } from './config.js';

const MAX_ROLLBACK_FILE_BYTES = CONFIG.maxRollbackFileBytes;
const MAX_ROLLBACK_TOTAL_BYTES = CONFIG.maxRollbackTotalBytes;

function captureIdentity(filePath) {
  try {
    const lst = lstatSync(filePath);
    let real;
    try { real = realpathSync(filePath); } catch (_) { real = null; }
    return {
      dev: lst.dev,
      ino: lst.ino,
      isSymlink: lst.isSymbolicLink(),
      isDirectory: lst.isDirectory(),
      isFile: lst.isFile(),
      realPath: real,
    };
  } catch (_) {
    return null;
  }
}

class RollbackManager {
  constructor() {
    this.snapshots = new Map();
    this.createdFiles = new Set();
    this.totalBytes = 0;
    this.enabled = true;
  }

  snapshot(filePath) {
    if (!this.enabled) return { ok: true };
    const resolved = resolve(filePath);
    if (this.snapshots.has(resolved)) return { ok: true };

    const existed = existsSync(resolved);
    if (existed) {
      let fileBytes;
      try { fileBytes = statSync(resolved).size; } catch (_) { fileBytes = 0; }
      if (fileBytes > MAX_ROLLBACK_FILE_BYTES) {
        return {
          ok: false,
          error: `File too large for rollback: ${resolved} (${(fileBytes / 1024 / 1024).toFixed(1)} MB). ` +
            `Max per-file: ${MAX_ROLLBACK_FILE_BYTES / 1024 / 1024} MB.`
        };
      }
      if (this.totalBytes + fileBytes > MAX_ROLLBACK_TOTAL_BYTES) {
        return {
          ok: false,
          error: `Rollback total limit would be exceeded: ${((this.totalBytes + fileBytes) / 1024 / 1024).toFixed(1)} MB. ` +
            `Max total: ${MAX_ROLLBACK_TOTAL_BYTES / 1024 / 1024} MB.`
        };
      }
      this.totalBytes += fileBytes;
    }

    const original = existed ? readFileSync(resolved) : null;
    const identity = existed ? captureIdentity(resolved) : null;
    this.snapshots.set(resolved, { path: resolved, original, existed, identity });
    return { ok: true };
  }

  /**
   * v0.1.11: Mark a file as newly created AND capture its identity.
   * Must be called AFTER the file has been written to disk.
   */
  markCreated(filePath) {
    const resolved = resolve(filePath);
    this.createdFiles.add(resolved);
    const identity = captureIdentity(resolved);
    if (identity && !identity.isFile && !identity.isSymlink) {
      // Created file is not a regular file — track but don't risk deleting
      identity._unexpected_type = true;
    }
    // Always save with identity; overwrite previous null-identity entry if present
    this.snapshots.set(resolved, { path: resolved, original: null, existed: false, identity });
  }

  verifyIdentity(resolved, snap) {
    if (!snap.identity) {
      return { ok: false, error: `Rollback blocked: no identity snapshot for "${resolved}". Cannot verify file integrity.` };
    }

    const current = captureIdentity(resolved);
    if (!current) {
      return {
        ok: false,
        error: `Rollback blocked: file at "${resolved}" no longer accessible.`
      };
    }

    if (current.isSymlink) {
      return {
        ok: false,
        error: `Rollback blocked: "${resolved}" is now a symbolic link. Refusing to operate through symlink.`
      };
    }

    if (current.isDirectory) {
      return {
        ok: false,
        error: `Rollback blocked: "${resolved}" is now a directory. Refusing to delete.`
      };
    }

    if (!current.isFile && !snap.identity._unexpected_type) {
      return {
        ok: false,
        error: `Rollback blocked: "${resolved}" is no longer a regular file.`
      };
    }

    // For files that existed initially, check inode hasn't changed
    if (snap.existed && (current.dev !== snap.identity.dev || current.ino !== snap.identity.ino)) {
      return {
        ok: false,
        error: `Rollback blocked: "${resolved}" has been replaced since snapshot (inode changed).`
      };
    }

    // For newly created files, check the current file still has our identity
    if (!snap.existed && snap.identity.dev !== undefined &&
        (current.dev !== snap.identity.dev || current.ino !== snap.identity.ino)) {
      return {
        ok: false,
        error: `Rollback blocked: created file "${resolved}" was replaced (inode changed). Refusing to delete a different file.`
      };
    }

    return { ok: true };
  }

  rollback() {
    const restored = [];
    const deleted = [];
    const failed = [];

    for (const [path, snap] of this.snapshots) {
      try {
        if (snap.existed && snap.original !== null) {
          const check = this.verifyIdentity(path, snap);
          if (!check.ok) { failed.push({ path, error: check.error }); continue; }
          writeFileSync(path, snap.original);
          restored.push(path);
        } else if (!snap.existed) {
          if (existsSync(path)) {
            const check = this.verifyIdentity(path, snap);
            if (!check.ok) { failed.push({ path, error: check.error }); continue; }
            unlinkSync(path);
            deleted.push(path);
          }
        }
      } catch (err) {
        failed.push({ path, error: err.message });
      }
    }

    for (const path of this.createdFiles) {
      if (!this.snapshots.has(path) && existsSync(path)) {
        try { unlinkSync(path); deleted.push(path); } catch (_) {}
      }
    }

    this.snapshots.clear();
    this.createdFiles.clear();
    this.totalBytes = 0;
    return { restored, deleted, failed };
  }

  /**
   * v0.1.11: Capture identity of a just-created file (called AFTER writeFileSync succeeds).
   */
  captureCreatedIdentity(filePath) {
    const resolved = resolve(filePath);
    const snap = this.snapshots.get(resolved);
    if (snap && !snap.existed) {
      snap.identity = captureIdentity(resolved);
    }
  }

  clear() {
    this.snapshots.clear();
    this.createdFiles.clear();
    this.totalBytes = 0;
  }

  summary() {
    return {
      files_tracked: this.snapshots.size,
      files_created: this.createdFiles.size,
      files_modified: [...this.snapshots.values()].filter(s => s.existed).length,
      total_bytes: this.totalBytes,
    };
  }
}

export function createRollbackManager() { return new RollbackManager(); }
export { RollbackManager };
