'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

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
      const win = { url: w.url, position: w.position || null, index: i, child: null, timer: null };
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
      '--overscroll-history-navigation=0', '--check-for-update-interval=31536000'
    ];
    // Placing the window on the target monitor before kiosk goes fullscreen there.
    if (win.position) args.push(`--window-position=${win.position[0]},${win.position[1]}`);

    win.child = spawn(chrome, args, { stdio: 'ignore', detached: false, windowsHide: false });
    const where = win.position ? ` at ${win.position.join(',')}` : '';
    this.log('info', `display: opened ${win.url}${where} in Chrome kiosk (pid ${win.child.pid})`);
    win.child.on('exit', (code) => {
      win.child = null;
      if (!this.windows.includes(win)) return; // closed on purpose
      this.log('warn', `display: Chrome window ${win.index + 1} exited (${code}); reopening in 3s`);
      win.timer = setTimeout(() => this._launch(win), 3000);
    });
  }

  _close(win) {
    clearTimeout(win.timer);
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
