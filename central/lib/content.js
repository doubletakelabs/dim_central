'use strict';

const fs = require('fs');
const path = require('path');
const { buildManifest } = require('./manifest');

/**
 * Content store.
 *
 *   content/
 *     _common/          <- synced to every room
 *     library/          <- synced only to roomId "library"
 *     greenhouse/
 *
 * A room's content set is _common plus its own directory. Manifests are cached
 * and invalidated by rescan(), because hashing large video files is expensive
 * and content changes rarely.
 */
class ContentStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.cache = new Map(); // roomId -> manifest
    this.version = 0;
    fs.mkdirSync(path.join(rootDir, '_common'), { recursive: true });
  }

  _safeDir(name) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid name: ${name}`);
    return path.join(this.rootDir, name);
  }

  /** Force a rehash on next request (call after dropping in new media). */
  rescan() {
    this.cache.clear();
    this.version += 1;
    return this.version;
  }

  async getManifest(roomId) {
    const key = roomId || '_common';
    if (this.cache.has(key)) return this.cache.get(key);

    const common = await buildManifest(path.join(this.rootDir, '_common'));
    const commonFiles = common.files.map((f) => ({ ...f, path: `_common/${f.path}` }));

    let roomFiles = [];
    let roomBytes = 0;
    if (roomId) {
      const roomDir = this._safeDir(roomId);
      if (fs.existsSync(roomDir)) {
        const room = await buildManifest(roomDir);
        roomFiles = room.files.map((f) => ({ ...f, path: `${roomId}/${f.path}` }));
        roomBytes = room.totalBytes;
      }
    }

    const files = [...commonFiles, ...roomFiles];
    const manifest = {
      version: this.version,
      files,
      fileCount: files.length,
      totalBytes: common.totalBytes + roomBytes
    };
    this.cache.set(key, manifest);
    return manifest;
  }

  filePath(relPath) {
    const abs = path.resolve(this.rootDir, relPath);
    if (!abs.startsWith(path.resolve(this.rootDir) + path.sep)) {
      throw new Error('Path traversal blocked');
    }
    return abs;
  }
}

module.exports = { ContentStore };
