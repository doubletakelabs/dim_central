'use strict';

/**
 * Example room server. Replace with the real one.
 *
 * The deploy agent starts this with `node server.js` from the release folder
 * (or whatever `scripts.start` in package.json says) and gives it:
 *
 *   ROOM_ID      which room this is
 *   RELEASE_ID   which release is running
 *   PORT         port to listen on (default 5050)
 *   CONTENT_DIR  synced media lives here (<CONTENT_DIR>/_common and /<ROOM_ID>)
 *   SHARED_DIR   per-machine files that survive deploys (config, state)
 *   CENTRAL_HTTP central's address
 *
 * The agent considers the server "up" as soon as it answers any HTTP request
 * on PORT. If it exits, the agent restarts it and the dashboard shows the count.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOM_ID = process.env.ROOM_ID || 'dev';
const RELEASE_ID = process.env.RELEASE_ID || 'dev';
const PORT = Number(process.env.PORT || 5050);
const CONTENT_DIR = process.env.CONTENT_DIR || '';
const SHARED_DIR = process.env.SHARED_DIR || '';

let roomConfig = {};
try { roomConfig = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'room-config.json'), 'utf8')); }
catch { roomConfig = { note: 'no shared/room-config.json on this machine' }; }

const startedAt = Date.now();

function listContent() {
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}${e.name}/`);
      else out.push(`${rel}${e.name}`);
    }
  };
  if (CONTENT_DIR) walk(CONTENT_DIR, '');
  return out;
}

http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, roomId: ROOM_ID, release: RELEASE_ID, uptimeMs: Date.now() - startedAt }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${ROOM_ID}</title>
<style>body{background:#111;color:#eee;font:16px/1.6 system-ui,sans-serif;padding:3rem}code{background:#222;padding:.15em .4em;border-radius:3px}pre{background:#1a1a1a;padding:1rem;border-radius:6px}</style>
<h1>Room: ${ROOM_ID}</h1>
<p>Release <code>${RELEASE_ID}</code>, up ${Math.round((Date.now() - startedAt) / 1000)}s</p>
<h3>shared/room-config.json</h3><pre>${JSON.stringify(roomConfig, null, 2)}</pre>
<h3>content (${listContent().length} files)</h3><pre>${listContent().join('\n') || '(none synced yet)'}</pre>`);
}).listen(PORT, () => {
  console.log(`Room "${ROOM_ID}" release ${RELEASE_ID} listening on http://localhost:${PORT}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
