'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { ReleaseStore } = require('./lib/releases');
const { ContentStore } = require('./lib/content');
const { AgentRegistry } = require('./lib/agents');
const { LogStore } = require('./lib/logs');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PORT = Number(process.env.PORT || config.port || 4000);
const TOKEN = process.env.TOKEN || config.token;
if (!TOKEN) throw new Error('config.json needs a "token"');
if (!config.rooms || !Object.keys(config.rooms).length) {
  throw new Error('config.json needs "rooms": { "<roomId>": "<path to that room\'s server folder>", ... }');
}
// roomId -> absolute source folder for that room's piece
const ROOMS = Object.fromEntries(Object.entries(config.rooms).map(([id, dir]) => [id, path.resolve(__dirname, dir)]));

const releases = new ReleaseStore(path.join(__dirname, 'releases'));
const content = new ContentStore(path.join(__dirname, 'content'));
const agents = new AgentRegistry();
const logs = new LogStore(path.join(__dirname, 'logs'));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  if ((req.get('x-token') || req.query.token) !== TOKEN) return res.status(401).json({ error: 'Bad token' });
  next();
}

// ---------------------------------------------------------------------------
// Files for agents (no auth: LAN only, and they are only hashes + files)
// ---------------------------------------------------------------------------
function serveFile(absPath, res) {
  let stat;
  try { stat = fs.statSync(absPath); } catch { return res.status(404).json({ error: 'Not found' }); }
  res.set({ 'Content-Length': stat.size, 'Content-Type': 'application/octet-stream' });
  fs.createReadStream(absPath).pipe(res);
}

app.get('/api/releases/:id/manifest', async (req, res) => {
  try { res.json(await releases.getManifest(req.params.id)); } catch (err) { res.status(404).json({ error: err.message }); }
});
app.get('/api/releases/:id/file', (req, res) => {
  try { serveFile(releases.filePath(req.params.id, String(req.query.path || '')), res); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/content/:roomId/manifest', async (req, res) => {
  try { res.json(await content.getManifest(req.params.roomId)); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/content/file', (req, res) => {
  try { serveFile(content.filePath(String(req.query.path || '')), res); } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Dashboard API
// ---------------------------------------------------------------------------
function state() {
  return { agents: agents.list(), releases: releases.list(), rooms: ROOMS, contentVersion: content.version };
}

async function createRelease(roomId, note, sourceDirOverride) {
  const sourceDir = sourceDirOverride ? path.resolve(__dirname, sourceDirOverride) : ROOMS[roomId];
  if (!sourceDir) throw new Error(`Room "${roomId}" is not in config.json`);
  const rel = await releases.create(roomId, sourceDir, note || '');
  console.log(`[release] ${rel.id} created from ${sourceDir} (${rel.fileCount} files)`);
  return rel;
}

app.get('/api/state', auth, (req, res) => res.json(state()));
app.get('/api/logs', auth, (req, res) => {
  res.json({ lines: logs.tail(Number(req.query.n || 300), req.query.roomId || null) });
});

app.post('/api/releases', auth, async (req, res) => {
  try {
    const rel = await createRelease(req.body.roomId, req.body.note, req.body.sourceDir);
    broadcastState();
    res.json(rel);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** One new release for every configured room. */
app.post('/api/releases/all', auth, async (req, res) => {
  const made = [];
  const errors = {};
  for (const roomId of Object.keys(ROOMS)) {
    try { made.push(await createRelease(roomId, req.body.note)); } catch (err) { errors[roomId] = err.message; }
  }
  broadcastState();
  res.json({ releases: made, errors });
});

app.delete('/api/releases/:id', auth, async (req, res) => {
  await releases.remove(req.params.id);
  broadcastState();
  res.json({ ok: true });
});

/** Run one command on many rooms at once; never throws, reports per room. */
async function fanout(req, res, type, payload = {}) {
  const rooms = Array.isArray(req.body.rooms) && req.body.rooms.length ? req.body.rooms : agents.connectedIds();
  if (!rooms.length) return res.status(400).json({ error: 'No rooms connected' });

  const results = {};
  await Promise.all(rooms.map(async (roomId) => {
    const rec = agents.get(roomId);
    try {
      const p = typeof payload === 'function' ? payload(roomId) : payload;
      if (p && p.error) throw new Error(p.error);
      results[roomId] = await agents.command(roomId, type, p || {});
    } catch (err) {
      results[roomId] = { ok: false, error: err.message };
    }
    if (rec) rec.lastResult = { type, at: Date.now(), ...results[roomId] };
    broadcastState();
  }));

  const failed = Object.keys(results).filter((r) => results[r].ok === false);
  console.log(`[${type}] ${rooms.length} room(s), ${failed.length} failed${failed.length ? ': ' + failed.join(', ') : ''}`);
  res.json({ results, failed });
}

/**
 * Deploy. Body is either { roomId, releaseId } for one room, or
 * { deploys: { <roomId>: <releaseId>, ... } } for several at once.
 * A release can only go to the room it was made for.
 */
app.post('/api/deploy', auth, (req, res) => {
  const deploys = req.body.deploys || (req.body.roomId ? { [req.body.roomId]: req.body.releaseId } : null);
  if (!deploys || !Object.keys(deploys).length) return res.status(400).json({ error: 'Nothing to deploy' });
  req.body.rooms = Object.keys(deploys);
  return fanout(req, res, 'deploy', (roomId) => {
    const rel = deploys[roomId] && releases.get(deploys[roomId]);
    if (!rel) return { error: `Pick a release for ${roomId} first` };
    if (rel.roomId !== roomId) return { error: `${rel.id} is a release for room "${rel.roomId}", not "${roomId}"` };
    return { releaseId: rel.id };
  });
});
app.post('/api/rollback', auth, (req, res) => fanout(req, res, 'rollback'));
app.post('/api/restart', auth, (req, res) => fanout(req, res, 'restart'));
app.post('/api/stop', auth, (req, res) => fanout(req, res, 'stop'));
app.post('/api/sync-content', auth, (req, res) => {
  content.rescan(); // pick up anything dropped into content/ since last time
  return fanout(req, res, 'syncContent');
});

// ---------------------------------------------------------------------------
// WebSockets: agents on /agent, browsers on /dashboard
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const dashboards = new Set();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  if ((url.pathname !== '/agent' && url.pathname !== '/dashboard') || token !== TOKEN) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.kind = url.pathname.slice(1);
    wss.emit('connection', ws);
  });
});

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of dashboards) if (ws.readyState === ws.OPEN) ws.send(payload);
}
let stateTimer = null;
function broadcastState() {
  // coalesce: many heartbeats arrive together
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    broadcast({ type: 'state', ...state() });
  }, 100);
}

wss.on('connection', (ws) => {
  if (ws.kind === 'dashboard') {
    dashboards.add(ws);
    ws.send(JSON.stringify({ type: 'state', ...state() }));
    ws.on('close', () => dashboards.delete(ws));
    return;
  }

  let roomId = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'hello') {
      roomId = msg.roomId;
      if (!roomId) return ws.close(4002, 'roomId required');
      agents.register(roomId, ws, msg);
      console.log(`[agent] ${roomId} connected (${msg.platform}, node ${msg.nodeVersion})`);
      broadcastState();
      return;
    }
    if (!roomId) return;

    const rec = agents.get(roomId);
    if (msg.type === 'status' && rec) {
      rec.lastSeen = Date.now();
      rec.status = msg;
      broadcastState();
    } else if (msg.type === 'logs' && Array.isArray(msg.lines)) {
      logs.append(roomId, msg.lines);
      broadcast({ type: 'logs', roomId, lines: msg.lines });
    } else if (msg.type === 'reply') {
      agents.resolveReply(roomId, msg.requestId, msg.ok, msg.result);
    }
  });

  ws.on('close', () => {
    const rec = roomId && agents.get(roomId);
    if (!rec || rec.ws !== ws) return; // an older socket for a room that has since reconnected
    console.log(`[agent] ${roomId} disconnected`);
    agents.markDisconnected(roomId);
    broadcastState();
  });
  ws.on('error', () => {});
});

// A room whose heartbeats stop is shown as stale even if the socket is open.
setInterval(broadcastState, 5000);

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('Central is running.');
  console.log(`  dashboard : http://localhost:${PORT}/?token=${TOKEN}`);
  for (const ip of ips) console.log(`  agents use: http://${ip}:${PORT}   (put this in each agent's config.json as "central")`);
  console.log(`  releases  : ${path.join(__dirname, 'releases')}`);
  console.log(`  content   : ${path.join(__dirname, 'content')}`);
  for (const [id, dir] of Object.entries(ROOMS)) console.log(`  room ${id.padEnd(12)} <- ${dir}${fs.existsSync(dir) ? '' : '   (FOLDER NOT FOUND)'}`);
});
