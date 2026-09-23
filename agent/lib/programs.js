'use strict';

const path = require('path');
const { spawn } = require('child_process');

/**
 * Extra programs this machine should always have running, from "keepRunning"
 * in config.json. Each one starts when the agent starts and is reopened if it
 * exits. A relative "cmd" is found in the agent folder.
 *
 *   "keepRunning": [
 *     { "cmd": "Tractus.HtmlToNdi.exe",
 *       "args": ["--ndiname=dimcyc", "--w=5000", "--h=1080", "--url=http://localhost:8080/index.html"] }
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
    for (const p of this.programs) this._launch(p);
  }

  _launch(p) {
    if (this.stopped) return;
    const child = spawn(p.cmd, p.args, { cwd: p.cwd, stdio: 'ignore', windowsHide: false });
    p.child = child;
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

  close() {
    this.stopped = true;
    for (const p of this.programs) {
      clearTimeout(p.timer);
      if (p.child) { try { p.child.kill(); } catch { /* gone */ } p.child = null; }
    }
  }

  status() {
    if (!this.programs.length) return null;
    return this.programs.map((p) => ({ name: p.name, running: !!(p.child && p.child.pid) }));
  }
}

module.exports = { Programs };
