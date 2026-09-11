'use strict';

/**
 * Make the agent start when the machine boots (and restart if it crashes).
 *
 *   node install-startup.js          install
 *   node install-startup.js --remove uninstall
 *
 * macOS   -> launchd user agent   (~/Library/LaunchAgents/com.show.deploy-agent.plist)
 * Linux   -> systemd user service (~/.config/systemd/user/show-deploy-agent.service)
 * Windows -> a .cmd in the Startup folder that loops the agent forever
 *
 * All three need the machine to auto-login to this user account.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const remove = process.argv.includes('--remove');
const agentDir = __dirname;
const node = process.execPath;
const logDir = path.join(os.homedir(), 'show', 'shared', 'logs');
fs.mkdirSync(logDir, { recursive: true });

function sh(cmd) {
  try { execSync(cmd, { stdio: 'inherit' }); } catch { /* reported by the tool itself */ }
}

if (process.platform === 'darwin') {
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.show.deploy-agent.plist');
  sh(`launchctl unload "${plist}" 2>/dev/null`);
  if (remove) {
    fs.rmSync(plist, { force: true });
    console.log('Removed', plist);
  } else {
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.show.deploy-agent</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${path.join(agentDir, 'agent.js')}</string></array>
  <key>WorkingDirectory</key><string>${agentDir}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDir, 'agent-stdout.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'agent-stdout.log')}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string></dict>
</dict></plist>
`);
    sh(`launchctl load "${plist}"`);
    console.log('Installed and started. Check with: launchctl list | grep show.deploy');
    console.log('Logs:', path.join(logDir, 'agent-stdout.log'));
  }
} else if (process.platform === 'linux') {
  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'show-deploy-agent.service');
  if (remove) {
    sh('systemctl --user disable --now show-deploy-agent');
    fs.rmSync(unit, { force: true });
    console.log('Removed', unit);
  } else {
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, `[Unit]
Description=Show deploy agent
After=network-online.target

[Service]
ExecStart=${node} ${path.join(agentDir, 'agent.js')}
WorkingDirectory=${agentDir}
Restart=always
RestartSec=3
Environment=PATH=${process.env.PATH}

[Install]
WantedBy=default.target
`);
    sh('systemctl --user daemon-reload');
    sh('systemctl --user enable --now show-deploy-agent');
    sh(`loginctl enable-linger ${os.userInfo().username}`);
    console.log('Installed. Check with: systemctl --user status show-deploy-agent');
  }
} else if (process.platform === 'win32') {
  const startup = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const cmd = path.join(startup, 'show-deploy-agent.cmd');
  if (remove) {
    fs.rmSync(cmd, { force: true });
    console.log('Removed', cmd, '(a running agent keeps running until you close its window)');
  } else {
    fs.writeFileSync(cmd, `@echo off
title Show deploy agent
cd /d "${agentDir}"
:loop
"${node}" agent.js
echo Agent exited, restarting in 3s...
timeout /t 3 /nobreak >nul
goto loop
`);
    console.log('Installed', cmd);
    console.log('It runs at next login. To start it now, double-click that file.');
    console.log('Make sure Windows auto-logs-in and never sleeps.');
  }
} else {
  console.error('Unsupported platform', process.platform);
  process.exit(1);
}
