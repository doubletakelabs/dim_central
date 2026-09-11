'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

/**
 * Runs the room server as a child process and keeps it running.
 *
 * If the room server exits, it is restarted after a short delay. That is the
 * only automatic behavior: the supervisor never changes which release is
 * live. It just reports what is happening so a person can decide.
 */
class Supervisor {
  constructor({ log }) {
    this.log = log;
    this.child = null;
    this.desired = null;   // { releaseId, dir, entry, env } while we want it running
    this.restarts = 0;     // restarts since the last explicit start()
    this.crashTimes = [];  // timestamps of recent unexpected exits
    this.startedAt = null;
    this.lastExit = null;  // { code, signal, at }
    this.restartTimer = null;
  }

  /** Start (or replace) the room server. Resolves once the process is spawned. */
  async start(target) {
    await this.stop();
    this.desired = target;
    this.restarts = 0;
    this.crashTimes = [];
    this._spawn();
  }

  /** Stop the room server and do not restart it. */
  async stop() {
    this.desired = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) return;

    this.log('info', `Stopping room server (pid ${child.pid})`);
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }, 5000);
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      try { child.kill('SIGTERM'); } catch { resolve(); }
    });
    this.child = null;
  }

  /** Restart at the same target. */
  async restart() {
    const target = this.desired;
    if (!target) throw new Error('Room server is not configured to run');
    await this.start(target);
  }

  _spawn() {
    const t = this.desired;
    if (!t) return;

    const child = spawn(process.execPath, [t.entry], {
      cwd: t.dir,
      env: { ...process.env, ...t.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    this.startedAt = Date.now();
    this.log('info', `Room server started: release ${t.releaseId}, pid ${child.pid}`);

    this._pipe(child.stdout, 'info');
    this._pipe(child.stderr, 'error');

    child.on('error', (err) => this.log('error', `Room server spawn error: ${err.message}`));

    child.on('exit', (code, signal) => {
      if (this.child !== child) return; // an older process we already replaced
      this.child = null;
      this.lastExit = { code, signal, at: Date.now() };

      if (!this.desired) return; // stopped on purpose

      const now = Date.now();
      this.crashTimes = this.crashTimes.filter((ts) => now - ts < 60000);
      this.crashTimes.push(now);
      this.restarts += 1;

      const delay = Math.min(1000 * this.crashTimes.length, 10000);
      this.log('error', `Room server exited (code ${code}, signal ${signal}); restarting in ${delay / 1000}s`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this._spawn();
      }, delay);
    });
  }

  _pipe(stream, level) {
    let partial = '';
    stream.on('data', (chunk) => {
      partial += chunk.toString();
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const l of lines) if (l.trim()) this.log(level, l.trimEnd(), 'room');
    });
  }

  /** Snapshot for the heartbeat. */
  status() {
    const running = !!this.child;
    return {
      running,
      pid: running ? this.child.pid : null,
      releaseId: this.desired ? this.desired.releaseId : null,
      restarts: this.restarts,
      recentCrashes: this.crashTimes.filter((ts) => Date.now() - ts < 60000).length,
      uptimeMs: running ? Date.now() - this.startedAt : null,
      lastExit: this.lastExit
    };
  }
}

/** Any HTTP answer at all means the server is up. */
async function probe(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'deploy-agent-health' } });
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Poll until the room server answers HTTP, or give up after graceMs. */
async function waitHealthy(supervisor, url, graceMs) {
  const deadline = Date.now() + graceMs;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    last = await probe(url);
    if (last.ok) return { healthy: true };
    const s = supervisor.status();
    if (s.recentCrashes >= 3) return { healthy: false, reason: `crashed ${s.recentCrashes} times` };
  }
  return { healthy: false, reason: `no HTTP answer on ${url} after ${graceMs / 1000}s` };
}

function machineStats(baseDir) {
  let disk = null;
  try {
    const st = fs.statfsSync(baseDir);
    disk = { freeMb: Math.round((st.bfree * st.bsize) / 1048576) };
  } catch { /* unsupported */ }
  return { disk, freeMemMb: Math.round(os.freemem() / 1048576), loadAvg: os.loadavg()[0] };
}

module.exports = { Supervisor, probe, waitHealthy, machineStats };
