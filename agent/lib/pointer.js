'use strict';

const fs = require('fs');
const path = require('path');

/**
 * current.json says which release is live and which one was live before it:
 *
 *   { "release": "20260911-1432", "previous": "20260910-1801" }
 *
 * It is written to a temp file and renamed, so it is never half-written.
 * No symlinks, so it works the same on Windows, macOS, and Linux.
 */

function file(baseDir) {
  return path.join(baseDir, 'current.json');
}

function read(baseDir) {
  try {
    const p = JSON.parse(fs.readFileSync(file(baseDir), 'utf8'));
    return { release: p.release || null, previous: p.previous || null };
  } catch {
    return { release: null, previous: null };
  }
}

function write(baseDir, next) {
  const target = file(baseDir);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, target);
  return next;
}

/** Make releaseId live, remembering what it replaced. */
function flipTo(baseDir, releaseId) {
  const cur = read(baseDir);
  if (cur.release === releaseId) return cur;
  return write(baseDir, { release: releaseId, previous: cur.release });
}

/** Swap release and previous. Returns null if there is no previous. */
function rollback(baseDir) {
  const cur = read(baseDir);
  if (!cur.previous) return null;
  return write(baseDir, { release: cur.previous, previous: cur.release });
}

module.exports = { read, flipTo, rollback };
