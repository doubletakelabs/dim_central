'use strict';

const { spawn } = require('child_process');

/**
 * Keeps a kiosk window in front: every 1.5 s, if the Chrome window the agent
 * opened has been minimized, hidden, or put behind another program, it is
 * brought back. For rooms where guests have a mouse and keyboard (Consumption1,
 * Consumption3, the control room — 2026-09-27): kiosk mode has no minimize
 * button, but Win+D, Alt+Tab, Cmd+H and Cmd+Tab still work, and only the OS
 * can refuse those. Closing is already handled — the agent reopens Chrome.
 *
 * Opt-in per room ("keepFront": true in config.json): on a machine someone is
 * working at, it would pull the wall back over whatever they opened.
 *
 * One small helper per window (PowerShell on Windows, AppleScript on a Mac),
 * running until that Chrome exits or the agent closes it.
 *
 * macOS asks once for permission — "node wants to control System Events" —
 * and needs node (or the Terminal that runs the agent) allowed under System
 * Settings → Privacy & Security → Accessibility. Until then the helper logs
 * the refusal and does nothing.
 */

const MAC_SCRIPT = `
on run argv
  set p to (item 1 of argv) as integer
  set lastError to ""
  repeat
    delay 1.5
    try
      tell application "System Events"
        set procs to (every process whose unix id is p)
        if (count of procs) is 0 then return
        set proc to item 1 of procs
        set whatChanged to ""
        if visible of proc is false then
          set visible of proc to true
          set whatChanged to "hidden"
        end if
        try
          repeat with w in (windows of proc)
            if value of attribute "AXMinimized" of w is true then
              set value of attribute "AXMinimized" of w to false
              set whatChanged to "minimized"
            end if
          end repeat
        end try
        -- Another of our kiosk windows in front (a second monitor) is fine.
        set frontApp to name of first process whose frontmost is true
        if frontApp is not (name of proc) then
          set frontmost of proc to true
          if whatChanged is "" then set whatChanged to "behind " & frontApp
        end if
        if whatChanged is not "" then log "restored: " & whatChanged
      end tell
      set lastError to ""
    on error msg
      if msg is not lastError then log "error: " & msg
      set lastError to msg
    end try
  end repeat
end run
`;

function windowsScript(pid) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$ChromePid = ${Number(pid)}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KeepFront {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
while ($true) {
  Start-Sleep -Milliseconds 1500
  $p = Get-Process -Id $ChromePid
  if (-not $p) { exit 0 }
  $p.Refresh()
  $h = $p.MainWindowHandle
  if ($h -eq [IntPtr]::Zero) { continue }
  if ([KeepFront]::IsIconic($h)) {
    [void][KeepFront]::ShowWindow($h, 9)
    Write-Output "restored: minimized"
  }
  $fg = [KeepFront]::GetForegroundWindow()
  [uint32]$fgPid = 0
  [void][KeepFront]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $fgName = (Get-Process -Id $fgPid).ProcessName
  # Another of our kiosk windows in front (a second monitor) is fine.
  if ($fgName -ne 'chrome') {
    # Windows only lets the program the user last touched take the foreground;
    # a tap of Alt counts as touching this one.
    [KeepFront]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [KeepFront]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][KeepFront]::ShowWindow($h, 9)
    [void][KeepFront]::SetForegroundWindow($h)
    Write-Output "restored: behind $fgName"
  }
}
`;
}

/**
 * Watch one Chrome window's process. Returns { stop() }, or null where this
 * platform has no helper.
 */
function keepInFront(pid, log) {
  let child;
  if (process.platform === 'darwin') {
    child = spawn('osascript', ['-e', MAC_SCRIPT, String(pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else if (process.platform === 'win32') {
    const encoded = Buffer.from(windowsScript(pid), 'utf16le').toString('base64');
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
  } else {
    log('warn', 'display: keepFront has no helper on this platform; ignored');
    return null;
  }
  // AppleScript's `log` goes to stderr; PowerShell's Write-Output to stdout.
  const relay = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      log(text.startsWith('error') ? 'warn' : 'info', `display: keepFront ${text}`);
    }
  };
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);
  child.on('error', (err) => log('warn', `display: keepFront could not start: ${err.message}`));
  return {
    stop() { try { child.kill(); } catch { /* gone */ } }
  };
}

module.exports = { keepInFront };
