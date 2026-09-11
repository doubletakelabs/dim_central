'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

/**
 * One implementation used for both code releases and media content, because
 * both are described by the same manifest shape. Uses global fetch (Node 18+),
 * so the agent needs no HTTP dependency.
 *
 * Guarantees:
 *  - every file hash-verified after download; mismatches retried then failed
 *  - downloads land on a temp name and are renamed into place
 *  - existing files with a matching hash are skipped (delta sync)
 *  - bounded concurrency so a sync cannot saturate the room's link
 */

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function needsDownload(destPath, entry) {
  try {
    const stat = await fs.promises.stat(destPath);
    if (stat.size !== entry.size) return true;
    const actual = await sha256File(destPath);
    return actual !== entry.sha256;
  } catch {
    return true;
  }
}

async function downloadOne(url, destPath, entry, attempt = 1) {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.part`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${entry.path}`);

  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));

  const actual = await sha256File(tmp);
  if (actual !== entry.sha256) {
    await fs.promises.rm(tmp, { force: true });
    if (attempt < 3) return downloadOne(url, destPath, entry, attempt + 1);
    throw new Error(`Hash mismatch for ${entry.path} after ${attempt} attempts`);
  }

  // Windows will not overwrite an open file; remove first, tolerate absence.
  await fs.promises.rm(destPath, { force: true });
  await fs.promises.rename(tmp, destPath);
}

/**
 * @param {object} opts
 *   manifest    {files:[{path,size,sha256}]}
 *   destDir     where files land
 *   urlFor      (entry) => absolute URL
 *   concurrency default 4
 *   onProgress  ({done,total,bytes,totalBytes,current})
 *   prune       delete files in destDir not present in the manifest
 */
async function syncManifest(opts) {
  const {
    manifest,
    destDir,
    urlFor,
    concurrency = 4,
    onProgress = () => {},
    prune = false
  } = opts;

  await fs.promises.mkdir(destDir, { recursive: true });

  const work = [];
  for (const entry of manifest.files) {
    const destPath = path.join(destDir, ...entry.path.split('/'));
    if (await needsDownload(destPath, entry)) work.push({ entry, destPath });
  }

  const totalBytes = work.reduce((n, w) => n + w.entry.size, 0);
  let done = 0;
  let bytes = 0;
  const errors = [];

  let cursor = 0;
  async function worker() {
    while (cursor < work.length) {
      const item = work[cursor++];
      try {
        await downloadOne(urlFor(item.entry), item.destPath, item.entry);
        bytes += item.entry.size;
      } catch (err) {
        errors.push({ path: item.entry.path, error: err.message });
      }
      done += 1;
      onProgress({
        done,
        total: work.length,
        bytes,
        totalBytes,
        current: item.entry.path
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(work.length, 1)) }, worker)
  );

  if (errors.length) {
    const err = new Error(`${errors.length} file(s) failed to sync`);
    err.details = errors;
    throw err;
  }

  let pruned = 0;
  if (prune) {
    const keep = new Set(manifest.files.map((f) => path.join(destDir, ...f.path.split('/'))));
    async function walk(dir) {
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (!keep.has(abs)) {
          await fs.promises.rm(abs, { force: true });
          pruned += 1;
        }
      }
    }
    await walk(destDir);
  }

  return { downloaded: work.length, skipped: manifest.files.length - work.length, bytes, pruned };
}

module.exports = { syncManifest, sha256File };
