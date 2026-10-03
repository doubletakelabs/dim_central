'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execSync, execFileSync } = require('child_process');
const { keepInFront } = require('./keep-front');

/**
 * Opens the room's display page in Chrome kiosk mode and keeps it open.
 * Only used when config.json has "display": "chrome". Rooms that show their
 * display some other way (TouchDesigner, no browser) leave that out.
 *
 * Several monitors: list them in "displays", one entry per window:
 *   "displays": [
 *     { "path": "/wall.html?screen=1", "position": [0, 0] },
 *     { "path": "/wall.html?screen=2", "position": [1920, 0] }
 *   ]
 * position is the monitor's top-left corner in the OS display arrangement.
 */

function findChrome(configured) {
  if (configured) return fs.existsSync(configured) ? configured : null;
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ],
    win32: [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
    ],
    linux: []
  }[process.platform] || [];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { return execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${name}`, { stdio: 'pipe' }).toString().split('\n')[0].trim(); } catch { /* next */ }
  }
  return null;
}

/**
 * Close any Chrome still running with this window's profile (2026-10-03).
 *
 * Chrome lets only one browser use a profile. Start it again with a profile
 * already in use — a Chrome left over from before the agent restarted, say —
 * and the new process hands the page to the running one, which opens one more
 * window, and exits at once. The agent took that exit for Chrome closing and
 * reopened it three seconds later, forever: Consumption 2 had 389 copies of
 * its page open and climbing. Only Chrome with this exact profile is closed,
 * so nothing else on the machine is touched. Returns how many it closed.
 */
function closeStrayChrome(profile, log) {
  try {
    if (process.platform === 'win32') {
      const needle = profile.replace(/'/g, "''");
      const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | `
        + `Where-Object { $_.CommandLine -like '*--user-data-dir=${needle}*' } | `
        + `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`;
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, windowsHide: true }).toString().trim();
      const n = out ? out.split(/\s+/).length : 0;
      // Give them a moment to let go of the profile before the new one starts.
      if (n) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      return n;
    }
    let pids = [];
    try {
      pids = execFileSync('pgrep', ['-f', '--', `--user-data-dir=${profile}`], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().split(/\s+/).filter(Boolean);
    } catch { return 0; } // pgrep: none found
    for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ } }
    if (pids.length) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    return pids.length;
  } catch (err) {
    log('warn', `display: could not check for a Chrome already using ${profile}: ${err.message}`);
    return 0;
  }
}

/** Chrome gone this soon after opening was not closed by anyone: something is wrong. */
const QUICK_EXIT_MS = 10000;
/** That many quick exits in a row: stop retrying every few seconds. */
const QUICK_EXITS_BEFORE_BACKOFF = 3;
const BACKOFF_MS = 60000;

class Display {
  constructor({ config, log }) {
    this.config = config;
    this.log = log;
    this.windows = []; // [{ url, position, child, timer }]
  }

  /**
   * Show these windows: [{ url, position: [x, y] | null }]. One per monitor.
   * Already-open windows with the same url and position are left alone, so
   * calling this after every deploy does not flicker the screens.
   */
  open(wanted) {
    const key = (w) => `${w.url}@${(w.position || []).join(',')}`;
    const keep = new Set(wanted.map(key));
    for (const w of this.windows) if (!keep.has(key(w))) this._close(w);
    this.windows = this.windows.filter((w) => keep.has(key(w)));
    wanted.forEach((w, i) => {
      if (this.windows.some((o) => key(o) === key(w))) return;
      const win = { url: w.url, position: w.position || null, index: i, child: null, timer: null, front: null };
      this.windows.push(win);
      this._launch(win);
    });
  }

  _launch(win) {
    const chrome = findChrome(this.config.chromePath);
    if (!chrome) {
      this.log('error', 'display: Chrome not found on this machine; install it or remove "display" from config.json');
      return;
    }
    // Every window needs its own profile folder, or Chrome just opens a tab
    // in the first window instead of a second window.
    const profile = path.join(this.config.baseDir, 'shared', win.index === 0 ? 'chrome-profile' : `chrome-profile-${win.index + 1}`);
    const args = [
      '--kiosk', win.url,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--noerrdialogs', '--disable-infobars', '--disable-session-crashed-bubble',
      '--disable-features=TranslateUI', '--autoplay-policy=no-user-gesture-required',
      '--overscroll-history-navigation=0', '--check-for-update-interval=31536000',
      // A wall on a touchscreen never zooms, whatever its page says (2026-09-27).
      '--disable-pinch',
      // Linux: never ask for the desktop keyring. A room machine logs in
      // automatically, so the keyring is locked and Chromium would put up an
      // "unlock Default Keyring" prompt nobody is there to answer (2026-09-30).
      '--password-store=basic'
    ];
    // Placing the window on the target monitor before kiosk goes fullscreen there.
    if (win.position) args.push(`--window-position=${win.position[0]},${win.position[1]}`);

    const stray = closeStrayChrome(profile, this.log);
    if (stray) this.log('warn', `display: closed ${stray} Chrome process${stray === 1 ? '' : 'es'} already using window ${win.index + 1}'s profile`);

    win.startedAt = Date.now();
    win.child = spawn(chrome, args, { stdio: 'ignore', detached: false, windowsHide: false });
    const where = win.position ? ` at ${win.position.join(',')}` : '';
    this.log('info', `display: opened ${win.url}${where} in Chrome kiosk (pid ${win.child.pid})`);
    // Guests with a keyboard can minimize or hide it; bring it back (lib/keep-front.js).
    if (this.config.keepFront) win.front = keepInFront(win.child.pid, this.log);
    win.child.on('exit', (code) => {
      win.child = null;
      win.front?.stop();
      win.front = null;
      if (!this.windows.includes(win)) return; // closed on purpose
      win.quickExits = Date.now() - win.startedAt < QUICK_EXIT_MS ? (win.quickExits || 0) + 1 : 0;
      if (win.quickExits >= QUICK_EXITS_BEFORE_BACKOFF) {
        this.log('error', `display: Chrome window ${win.index + 1} keeps closing as soon as it opens `
          + `(${win.quickExits} times, last exit ${code}); trying again in ${BACKOFF_MS / 1000}s`);
        win.timer = setTimeout(() => this._launch(win), BACKOFF_MS);
        return;
      }
      this.log('warn', `display: Chrome window ${win.index + 1} exited (${code}); reopening in 3s`);
      win.timer = setTimeout(() => this._launch(win), 3000);
    });
  }

  _close(win) {
    clearTimeout(win.timer);
    win.front?.stop();
    win.front = null;
    if (win.child) { try { win.child.kill(); } catch { /* gone */ } win.child = null; }
  }

  close() {
    for (const w of this.windows) this._close(w);
    this.windows = [];
  }

  status() {
    if (!this.windows.length) return null;
    return {
      windows: this.windows.map((w) => ({ url: w.url, position: w.position, open: !!w.child })),
      open: this.windows.every((w) => !!w.child)
    };
  }
}

module.exports = { Display };
