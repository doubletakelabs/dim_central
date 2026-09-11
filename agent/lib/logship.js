'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Log shipper.
 *
 * Ships over the deployment agent's existing WebSocket, batched on an interval
 * rather than per line. A bounded ring buffer means a log storm drops old lines
 * instead of exhausting memory, and every line is also written locally so that
 * a disconnected room is still debuggable if someone reaches the machine.
 *
 * Never blocks the agent: if the socket is closed or backed up, lines queue
 * (up to the cap) and flush on reconnect.
 */
class LogShipper {
  constructor({ baseDir, send, maxQueue = 5000, flushMs = 1000, maxBatch = 200 }) {
    this.send = send;
    this.queue = [];
    this.maxQueue = maxQueue;
    this.maxBatch = maxBatch;
    this.dropped = 0;

    const logDir = path.join(baseDir, 'shared', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    this.localStream = fs.createWriteStream(path.join(logDir, 'agent.log'), { flags: 'a' });

    this.timer = setInterval(() => this.flush(), flushMs);
    if (this.timer.unref) this.timer.unref();
  }

  log(level, message, source = 'agent') {
    const line = { ts: Date.now(), level, source, message: String(message) };

    // local first: this path must never fail because the socket is down
    try {
      this.localStream.write(`${JSON.stringify(line)}\n`);
    } catch { /* disk full or stream closed; nothing useful to do */ }

    if (level === 'error') console.error(`[${source}] ${message}`);
    else console.log(`[${source}] ${message}`);

    this.queue.push(line);
    if (this.queue.length > this.maxQueue) {
      const over = this.queue.length - this.maxQueue;
      this.queue.splice(0, over);
      this.dropped += over;
    }
  }

  flush() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.maxBatch);

    if (this.dropped > 0) {
      batch.unshift({
        ts: Date.now(),
        level: 'warn',
        source: 'agent',
        message: `log shipper dropped ${this.dropped} line(s) under backpressure`
      });
      this.dropped = 0;
    }

    const sent = this.send({ type: 'logs', lines: batch });
    if (!sent) {
      // socket unavailable: put them back at the front, respecting the cap
      this.queue.unshift(...batch);
      if (this.queue.length > this.maxQueue) {
        this.queue.length = this.maxQueue;
      }
    }
  }

  /** Attach a child process's stdout/stderr (e.g. PM2 log tail). */
  attachStream(stream, source, level = 'info') {
    let partial = '';
    stream.on('data', (chunk) => {
      partial += chunk.toString();
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const l of lines) {
        if (l.trim()) this.log(level, l.trim(), source);
      }
    });
  }

  close() {
    clearInterval(this.timer);
    this.flush();
    try {
      this.localStream.end();
    } catch { /* noop */ }
  }
}

module.exports = { LogShipper };
