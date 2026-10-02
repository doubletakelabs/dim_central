'use strict';

const { spawn } = require('child_process');

/**
 * Keeps a room machine's screen on, with no screensaver, for as long as the
 * agent runs (2026-10-01: SaaS and Consumption 3 kept going to the
 * screensaver). Without moving the mouse — a cursor jumping about on a wall
 * a guest is typing at is its own problem — by telling the OS directly:
 *
 * - macOS: `caffeinate -d -i` keeps the display and the machine awake, and
 *   `caffeinate -u` every 30 s declares the user active, which is what holds
 *   off the screensaver. Both ship with macOS, 10.13 included.
 * - Windows: SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED |
 *   ES_DISPLAY_REQUIRED) from a small PowerShell that lives as long as the
 *   agent — the same request a video player makes.
 * - Linux (X): `xset s off -dpms` once, and `xset s reset` every 30 s.
 *
 * Every room machine is a screen someone is meant to be looking at, so this
 * is always on.
 */

const NUDGE_MS = 30000;

const WINDOWS_SCRIPT = `
Add-Type -Namespace DimAgent -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
while ($true) {
  [DimAgent.Power]::SetThreadExecutionState(0x80000003) | Out-Null
  Start-Sleep -Seconds 30
}
`;

function keepAwake(log) {
  const helpers = [];
  let timer = null;

  const run = (cmd, args, { keep = false } = {}) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      log('warn', `keepAwake: ${cmd}: ${err.message}`);
      return;
    }
    child.on('error', (err) => log('warn', `keepAwake: ${cmd}: ${err.message}`));
    if (keep) helpers.push(child);
  };

  if (process.platform === 'darwin') {
    // -w: caffeinate ends with the agent, whatever happens to the agent.
    run('caffeinate', ['-d', '-i', '-w', String(process.pid)], { keep: true });
    const nudge = () => run('caffeinate', ['-u', '-t', '2']);
    nudge();
    timer = setInterval(nudge, NUDGE_MS);
  } else if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT], { keep: true });
  } else if (process.env.DISPLAY) {
    run('xset', ['s', 'off', '-dpms']);
    timer = setInterval(() => run('xset', ['s', 'reset']), NUDGE_MS);
  } else {
    log('info', 'keepAwake: no display to keep awake');
    return { close() {} };
  }
  log('info', 'keepAwake: the screen stays on, no screensaver');

  return {
    close() {
      clearInterval(timer);
      for (const child of helpers) {
        try { child.kill(); } catch { /* already gone */ }
      }
    },
  };
}

module.exports = { keepAwake };
