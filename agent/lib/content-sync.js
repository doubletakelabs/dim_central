'use strict';

const path = require('path');
const { syncManifest } = require('./fetcher');

/**
 * Content sync. Same manifest/verify machinery as releases, different target
 * and different expectations: content is large, changes rarely, and is pulled
 * before doors rather than during a show.
 *
 * Content lands in <baseDir>/content/<manifestPath>, where manifestPath is
 * already namespaced by central as "_common/..." or "<roomId>/...".
 */
async function syncContent(config, { log, sendProgress }) {
  const started = Date.now();
  const url = `${config.central}/api/content/${encodeURIComponent(config.roomId)}/manifest`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Content manifest failed: HTTP ${res.status}`);
  const manifest = await res.json();

  log('info', `Content sync: ${manifest.fileCount} files, ${(manifest.totalBytes / 1048576).toFixed(1)} MB declared`);

  const destDir = path.join(config.baseDir, 'content');

  const result = await syncManifest({
    manifest,
    destDir,
    concurrency: 8,
    prune: true,
    urlFor: (entry) =>
      `${config.central}/api/content/file?path=${encodeURIComponent(entry.path)}`,
    onProgress: (p) => {
      if (p.done % 5 === 0 || p.done === p.total) {
        sendProgress({ phase: 'content', ...p });
      }
    }
  });

  log(
    'info',
    `Content sync complete: ${result.downloaded} downloaded, ${result.skipped} already current, ${result.pruned} pruned (${Date.now() - started}ms)`
  );

  return {
    ok: true,
    contentVersion: manifest.version,
    ...result,
    ms: Date.now() - started
  };
}

module.exports = { syncContent };
