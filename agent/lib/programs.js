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
/** Send a program's output to the agent log, one line at a time. */
function pipe(stream, level, name, log) {
  let partial = '';
  let timer = null;
  stream.on('data', (chunk) => {
    partial += chunk.toString();
    const lines = partial.split('\n');
    partial = lines.pop();
    for (const l of lines) if (l.trim()) log(level, l.trimEnd(), name);
    // A prompt has no newline, so show it after a moment of silence.
    clearTimeout(timer);
    timer = setTimeout(flush, 1000);
  });
  const flush = () => {
    clearTimeout(timer);
    if (partial.trim()) log(level, partial.trimEnd(), name);
    partial = '';
  };
  stream.on('close', flush);
}

/**
 * Commands to run once when the agent starts, from "runAtStart" in
 * config.json. Each is typed as in a terminal and runs in the agent folder:
 *
 *   "runAtStart": ["setup.bat", "powershell -ExecutionPolicy Bypass -File setup.ps1"]
 *
 * Nothing waits for them and nothing reopens them.
 */
function runAtStart(list, agentDir, log) {
  for (const command of list || []) {
    const name = 'runAtStart';
    const child = spawn(command, { cwd: agentDir, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    log('info', `${name}: ${command}`);
    pipe(child.stdout, 'info', name, log);
    pipe(child.stderr, 'error', name, log);
    child.on('error', (err) => log('error', `${name}: could not run: ${command}: ${err.message}`));
    child.on('exit', (code) => log(code === 0 ? 'info' : 'warn', `${name}: finished (${code}): ${command}`));
  }
}

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
    pipe(child.stdout, 'info', p.name, this.log);
    pipe(child.stderr, 'error', p.name, this.log);
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

module.exports = { Programs, runAtStart };
