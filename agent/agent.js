'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const pointer = require('./lib/pointer');
const deployLib = require('./lib/deploy');
const { Supervisor, probe, machineStats } = require('./lib/supervisor');
const { Display } = require('./lib/display');
const { syncContent } = require('./lib/content-sync');
const { LogShipper } = require('./lib/logship');

const AGENT_VERSION = '2.0.0';

// ---------------------------------------------------------------------------
// Config: config.json next to this file. Only roomId, central, token matter.
// ---------------------------------------------------------------------------
function loadConfig() {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const port = file.roomServerPort || 8080; // what room experiences expect; never 5000 (macOS AirPlay)
  const config = {
    roomId: file.roomId,
    central: String(file.central || '').replace(/\/+$/, ''),
    token: file.token,
    baseDir: path.resolve(file.baseDir || path.join(os.homedir(), 'show')),
    roomServerPort: port,
    roomServerEntry: file.roomServerEntry || null,
    roomServerEnv: file.roomServerEnv || {},
    healthUrl: file.healthUrl || `http://127.0.0.1:${port}/`,
    healthGraceMs: file.healthGraceMs || 30000,
    heartbeatMs: file.heartbeatMs || 5000,
    keepReleases: file.keepReleases || 4,
    display: file.display || null,          // "chrome" opens the display page in kiosk mode
    displayPath: file.displayPath || null,  // overrides entry.display from experience.json
    displays: Array.isArray(file.displays) ? file.displays : null, // one entry per monitor, see lib/display.js
    chromePath: file.chromePath || null     // only if Chrome is somewhere unusual
  };
  for (const k of ['roomId', 'central', 'token']) {
    if (!config[k]) throw new Error(`config.json is missing "${k}"`);
  }
  if (!/^https?:\/\//.test(config.central)) throw new Error('"central" must look like http://192.168.x.x:4000');
  return config;
}

const config = loadConfig();
for (const d of ['releases', 'content', 'shared', 'shared/logs']) {
  fs.mkdirSync(path.join(config.baseDir, d), { recursive: true });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
let ws = null;
let heartbeatTimer = null;
let reconnectDelay = 1000;
let busy = null; // name of the command in flight, if any
let progress = null;
let contentVersion = null;
try {
  contentVersion = JSON.parse(fs.readFileSync(path.join(config.baseDir, 'shared', 'content-state.json'), 'utf8')).version;
} catch { /* first run */ }

function wsSend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
}

const shipper = new LogShipper({ baseDir: config.baseDir, send: wsSend });
const log = (level, message, source = 'agent') => shipper.log(level, message, source);
const supervisor = new Supervisor({ log });
const sendProgress = (p) => { progress = p; heartbeat(); };
const display = new Display({ config, log });
const ctx = { config, supervisor, display, log, sendProgress };

// ---------------------------------------------------------------------------
// Commands from central
// ---------------------------------------------------------------------------
const commands = {
  deploy: (msg) => deployLib.deploy(ctx, msg.releaseId),
  rollback: () => deployLib.rollback(ctx),
  restart: async () => {
    const cur = pointer.read(config.baseDir);
    if (!cur.release) return { ok: false, error: 'No release deployed yet' };
    return deployLib.startRelease(ctx, cur.release);
  },
  stop: async () => { await supervisor.stop(); return { ok: true }; },
  syncContent: async () => {
    const r = await syncContent(config, { log, sendProgress });
    contentVersion = r.contentVersion;
    fs.writeFileSync(
      path.join(config.baseDir, 'shared', 'content-state.json'),
      JSON.stringify({ version: contentVersion, updatedAt: new Date().toISOString() })
    );
    progress = null;
    return r;
  }
};

async function handleCommand(msg) {
  const reply = (ok, result) => wsSend({ type: 'reply', requestId: msg.requestId, ok, result });
  const fn = commands[msg.type];
  if (!fn) return reply(false, { error: `Unknown command: ${msg.type}` });
  if (busy) return reply(false, { error: `Busy with "${busy}", try again in a moment` });

  busy = msg.type;
  heartbeat();
  try {
    const result = await fn(msg);
    reply(result.ok !== false, result);
  } catch (err) {
    log('error', `${msg.type} failed: ${err.message}`);
    reply(false, { error: err.message });
  } finally {
    busy = null;
    progress = null;
    heartbeat();
  }
}

// ---------------------------------------------------------------------------
// Heartbeat: everything the dashboard shows about this room
// ---------------------------------------------------------------------------
// Probe the room server's port every 30s, not every heartbeat: pieces log
// every request, and a 5s poll drowns their real output.
let lastProbe = { at: 0, pid: null, result: { ok: false, error: 'not running' } };
async function probeThrottled(server) {
  if (!server.running) return { ok: false, error: 'not running' };
  const stale = Date.now() - lastProbe.at > 30000 || lastProbe.pid !== server.pid || !lastProbe.result.ok;
  if (stale) lastProbe = { at: Date.now(), pid: server.pid, result: await probe(config.healthUrl) };
  return lastProbe.result;
}

async function heartbeat() {
  const cur = pointer.read(config.baseDir);
  const server = supervisor.status();
  const http = await probeThrottled(server);
  wsSend({
    experience: cur.release ? deployLib.readExperience(config, cur.release) : null,
    display: display.status(),
    type: 'status',
    agentTime: Date.now(),
    release: cur.release,
    previousRelease: cur.previous,
    contentVersion,
    busy,
    progress,
    server: { ...server, http },
    machine: machineStats(config.baseDir)
  });
}

// ---------------------------------------------------------------------------
// Connection to central (reconnects forever)
// ---------------------------------------------------------------------------
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

function connect() {
  const url = `${config.central.replace(/^http/, 'ws')}/agent?token=${encodeURIComponent(config.token)}`;
  ws = new WebSocket(url);

  ws.on('open', () => {
    reconnectDelay = 1000;
    log('info', `Connected to central at ${config.central}`);
    wsSend({
      type: 'hello',
      roomId: config.roomId,
      platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.version,
      agentVersion: AGENT_VERSION,
      baseDir: config.baseDir,
      ip: lanIp(),
      port: config.roomServerPort
    });
    shipper.flush();
    heartbeat();
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(heartbeat, config.heartbeatMs);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.requestId) handleCommand(msg);
  });

  ws.on('close', () => {
    clearInterval(heartbeatTimer);
    console.log(`[agent] central unreachable, retrying in ${Math.round(reconnectDelay / 1000)}s`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  });

  ws.on('error', () => { /* close fires next */ });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  log('info', `Deploy agent ${AGENT_VERSION}: room "${config.roomId}", ${process.platform} node ${process.version}`);
  log('info', `  files in ${config.baseDir}`);
  log('info', `  central  ${config.central}`);

  // After a power cycle, bring the room server up without waiting for central.
  const cur = pointer.read(config.baseDir);
  if (cur.release && fs.existsSync(deployLib.releaseDir(config, cur.release))) {
    log('info', `Starting room server at release ${cur.release}`);
    deployLib.startRelease(ctx, cur.release);
  } else {
    log('warn', 'No release deployed yet. Deploy one from the central dashboard.');
  }
  connect();
}

function shutdown(signal) {
  log('info', `${signal}: agent shutting down, stopping room server too`);
  display.close();
  supervisor.stop().finally(() => {
    shipper.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => log('error', `Uncaught: ${err.stack || err}`));
process.on('unhandledRejection', (err) => log('error', `Unhandled: ${err && err.stack ? err.stack : err}`));

main().catch((err) => {
  console.error('Agent failed to start:', err.message);
  process.exit(1);
});
