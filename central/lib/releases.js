'use strict';

const fs = require('fs');
const path = require('path');
const { buildManifest, IGNORE } = require('./manifest');

/**
 * Release store on central. Every room has its own stream of releases, made
 * from that room's source folder (config.json "rooms").
 *
 *   releases/
 *     20260911-1432-influence/   <- copy of the piece folder, never edited
 *     20260911-1432-library/
 *     _index.json                <- all releases, newest first, with roomId
 *
 * The room name is part of the id so the agent (which only knows ids) needs
 * no idea of rooms, and so a folder on a room machine says what it is.
 */

function hasDependencies(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return !!(pkg.dependencies && Object.keys(pkg.dependencies).length);
  } catch { return false; }
}

class ReleaseStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.indexPath = path.join(rootDir, '_index.json');
    this.manifestCache = new Map();
    fs.mkdirSync(rootDir, { recursive: true });
  }

  _readIndex() {
    try { return JSON.parse(fs.readFileSync(this.indexPath, 'utf8')); } catch { return { releases: [] }; }
  }

  _writeIndex(index) {
    fs.writeFileSync(`${this.indexPath}.tmp`, JSON.stringify(index, null, 2));
    fs.renameSync(`${this.indexPath}.tmp`, this.indexPath);
  }

  /** All releases, newest first. Pass roomId to get one room's. */
  list(roomId = null) {
    const all = this._readIndex().releases;
    return roomId ? all.filter((r) => r.roomId === roomId) : all;
  }

  get(id) {
    return this.list().find((r) => r.id === id) || null;
  }

  dirFor(id) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Invalid release id: ${id}`);
    return path.join(this.rootDir, id);
  }

  _newId(roomId) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const base = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    let id = `${base}-${roomId}`;
    for (let n = 2; this.get(id); n += 1) id = `${base}-${n}-${roomId}`;
    return id;
  }

  /** Copy sourceDir into the store as a new release for roomId. */
  async create(roomId, sourceDir, note = '') {
    if (!/^[A-Za-z0-9._-]+$/.test(roomId)) throw new Error(`Invalid room id: ${roomId}`);
    const looksLikeServer = ['package.json', 'experience.json', 'server.js'].some((f) => fs.existsSync(path.join(sourceDir, f)));
    if (!looksLikeServer) {
      throw new Error(`No package.json, experience.json or server.js in ${sourceDir}. Is that the room server folder?`);
    }

    // Room experiences declare where media and calibration live (experience.json).
    // Media ships via content sync and calibration is per machine: neither goes in a release.
    const skip = new Set();
    let experience = null;
    try {
      const e = JSON.parse(fs.readFileSync(path.join(sourceDir, 'experience.json'), 'utf8'));
      if (e.media && e.media.dir) skip.add(path.resolve(sourceDir, e.media.dir));
      if (e.calibration && e.calibration.file) skip.add(path.resolve(sourceDir, e.calibration.file));
      experience = { id: e.experienceId, name: e.name, version: e.version };
    } catch { /* plain server, no manifest */ }

    const id = this._newId(roomId);
    const dest = this.dirFor(id);
    await fs.promises.cp(sourceDir, dest, {
      recursive: true,
      filter: (src) => !IGNORE.has(path.basename(src)) && !skip.has(path.resolve(src))
    });
    const manifest = await buildManifest(dest);
    this.manifestCache.set(id, manifest);

    const index = this._readIndex();
    index.releases.unshift({
      id,
      roomId,
      note,
      experience,
      sourceDir,
      createdAt: new Date().toISOString(),
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      needsNpmInstall: hasDependencies(dest) && !fs.existsSync(path.join(dest, 'node_modules'))
    });
    this._writeIndex(index);
    return index.releases[0];
  }

  async remove(id) {
    const index = this._readIndex();
    index.releases = index.releases.filter((r) => r.id !== id);
    this._writeIndex(index);
    this.manifestCache.delete(id);
    await fs.promises.rm(this.dirFor(id), { recursive: true, force: true });
  }

  async getManifest(id) {
    if (this.manifestCache.has(id)) return this.manifestCache.get(id);
    const dir = this.dirFor(id);
    if (!fs.existsSync(dir)) throw new Error(`Unknown release: ${id}`);
    const manifest = await buildManifest(dir);
    this.manifestCache.set(id, manifest);
    return manifest;
  }

  filePath(id, relPath) {
    const dir = this.dirFor(id);
    const abs = path.resolve(dir, relPath);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) throw new Error('Path traversal blocked');
    return abs;
  }
}

module.exports = { ReleaseStore };
