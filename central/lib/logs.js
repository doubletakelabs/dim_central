'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Log aggregator.
 *
 * Every line carries two timestamps:
 *   ts        - the room machine's own clock (may be skewed)
 *   centralTs - arrival time on central (authoritative for correlation)
 *
 * This is why OS-level NTP across the fleet is not required to reconstruct
 * "what happened at 8:42" across 20 machines.
 */
class LogStore {
  constructor(rootDir, opts = {}) {
    this.rootDir = rootDir;
    this.maxBuffer = opts.maxBuffer || 2000;
    this.buffer = []; // recent lines across all rooms, for live tail
    this.streams = new Map();
    fs.mkdirSync(rootDir, { recursive: true });
  }

  _stream(roomId) {
    if (!/^[A-Za-z0-9._-]+$/.test(roomId)) throw new Error(`Invalid roomId: ${roomId}`);
    if (this.streams.has(roomId)) return this.streams.get(roomId);
    const file = path.join(this.rootDir, `${roomId}.log`);
    const stream = fs.createWriteStream(file, { flags: 'a' });
    this.streams.set(roomId, stream);
    return stream;
  }

  /** lines: [{ ts, level, source, message }] */
  append(roomId, lines) {
    const centralTs = Date.now();
    const stream = this._stream(roomId);

    for (const line of lines) {
      const record = {
        roomId,
        ts: line.ts || centralTs,
        centralTs,
        level: line.level || 'info',
        source: line.source || 'room',
        message: String(line.message ?? '').slice(0, 8000)
      };

      stream.write(`${JSON.stringify(record)}\n`);

      this.buffer.push(record);
      if (this.buffer.length > this.maxBuffer) {
        this.buffer.splice(0, this.buffer.length - this.maxBuffer);
      }
    }
  }

  tail(n = 200, roomId = null) {
    const src = roomId ? this.buffer.filter((l) => l.roomId === roomId) : this.buffer;
    return src.slice(-n);
  }

  close() {
    for (const s of this.streams.values()) s.end();
    this.streams.clear();
  }
}

module.exports = { LogStore };
