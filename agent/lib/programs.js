'use strict';

const path = require('path');
const { spawn, spawnSync } = require('child_process');

/**
 * Extra programs this machine should always have running, from "keepRunning"
 * in config.json. Each one starts when the agent starts and is reopened if it
 * exits. A relative "cmd" is found in the agent folder. Whatever the program
 * prints goes to the agent log. There is no keyboard: pass every setting as
 * an argument so it never stops to ask for one. Closing the agent closes
 * these programs too.
 *
 *   "keepRunning": [
 *     { "cmd": "Tractus.HtmlToNdi.exe",
 *       "args": ["--ndiname=dimcyc", "--w=5000", "--h=1080", "--port=9999",
 *                "--url=http://localhost:8080/index.html"] }
 *   ]
 */
class Programs {
  constructor({ list, agentDir, log }) {
    this.log = log;
    this.programs = (list || []).map((p) => {
      const cmd = path.resolve(agentDir, p.cmd);
      return {
        cmd,
        args: p.args || [],
        cwd: p.cwd ? path.resolve(agentDir, p.cwd) : path.dirname(cmd),
        name: path.basename(cmd),
        child: null,
        timer: null,
        crashTimes: []
      };
    });
    this.stopped = false;
  }

  start() {
    for (const p of this.programs) {
      // A copy left over from an agent that was killed outright would run
      // twice (two NDI sources with one name), so close it first.
      if (process.platform === 'win32') {
        const r = spawnSync('taskkill', ['/IM', p.name, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        if (r.status === 0) this.log('warn', `${p.name}: closed a copy left running from before`);
      }
      this._launch(p);
    }
  }

  _launch(p) {
    if (this.stopped) return;
    const child = spawn(p.cmd, p.args, { cwd: p.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    p.child = child;
    this._pipe(p, child.stdout, 'info');
    this._pipe(p, child.stderr, 'error');
    child.on('spawn', () => this.log('info', `${p.name}: started (pid ${child.pid})`));
    // A missing exe only fires 'error', a normal exit only fires 'exit'.
    child.on('error', (err) => this._retry(p, child, `could not start: ${err.message}`));
    child.on('exit', (code) => this._retry(p, child, `exited (${code})`));
  }

  _retry(p, child, why) {
    if (p.child !== child) return; // already handled
    p.child = null;
    if (this.stopped) return;
    const now = Date.now();
    p.crashTimes = p.crashTimes.filter((t) => now - t < 60000);
    p.crashTimes.push(now);
    const delay = Math.min(3000 * p.crashTimes.length, 30000);
    this.log('warn', `${p.name}: ${why}; reopening in ${delay / 1000}s`);
    p.timer = setTimeout(() => this._launch(p), delay);
  }

  _pipe(p, stream, level) {
    let partial = '';
    let timer = null;
    stream.on('data', (chunk) => {
      partial += chunk.toString();
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const l of lines) if (l.trim()) this.log(level, l.trimEnd(), p.name);
      // A prompt has no newline, so show it after a moment of silence.
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (partial.trim()) this.log(level, partial.trimEnd(), p.name);
        partial = '';
      }, 1000);
    });
    stream.on('close', () => clearTimeout(timer));
  }

  close() {
    this.stopped = true;
    for (const p of this.programs) {
      clearTimeout(p.timer);
      if (!p.child) continue;
      this.log('info', `${p.name}: closing (pid ${p.child.pid})`);
      // On Windows kill the whole tree: browser-based programs start helpers.
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else try { p.child.kill(); } catch { /* gone */ }
      p.child = null;
    }
  }

  status() {
    if (!this.programs.length) return null;
    return this.programs.map((p) => ({ name: p.name, running: !!(p.child && p.child.pid) }));
  }
}

module.exports = { Programs };
