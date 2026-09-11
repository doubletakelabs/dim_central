'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Build a file manifest for a directory tree.
 *
 * The same manifest shape is used for code releases and for content, so the
 * agent has exactly one download/verify implementation.
 *
 *   { files: [ { path: 'lib/foo.js', size: 1234, sha256: 'abc...' }, ... ],
 *     totalBytes: 99999 }
 *
 * Paths are POSIX-style and relative to the root.
 */

// node_modules is deliberately NOT ignored: releases ship their dependencies.
const IGNORE = new Set(['.git', '.DS_Store', 'Thumbs.db', '.env', 'logs']);

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function buildManifest(rootDir, options = {}) {
  const ignore = new Set([...IGNORE, ...(options.ignore || [])]);
  const files = [];
  let totalBytes = 0;

  async function walk(dir, relBase) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;

      const abs = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(abs);
        const sha256 = await sha256File(abs);
        files.push({ path: rel, size: stat.size, sha256 });
        totalBytes += stat.size;
      }
      // symlinks intentionally skipped: they do not survive a mixed-OS fleet
    }
  }

  await walk(rootDir, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalBytes, fileCount: files.length };
}

module.exports = { buildManifest, sha256File, IGNORE };
