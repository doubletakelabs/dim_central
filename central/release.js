'use strict';

/**
 * Make a new release from the command line (same as the dashboard button).
 *
 *   node release.js influence                 release for room "influence"
 *   node release.js influence "fixed audio"   with a note
 *   node release.js all "bumped shared lib"   one release per configured room
 */
const path = require('path');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const [roomId, ...rest] = process.argv.slice(2);
const note = rest.join(' ');
if (!roomId) {
  console.error('Usage: node release.js <roomId|all> [note]\nRooms:', Object.keys(config.rooms || {}).join(', '));
  process.exit(1);
}

const url = roomId === 'all' ? '/api/releases/all' : '/api/releases';
fetch(`http://localhost:${config.port || 4000}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-token': config.token },
  body: JSON.stringify({ roomId, note })
})
  .then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    for (const rel of data.releases || [data]) {
      console.log(`Release ${rel.id} created: ${rel.fileCount} files, ${(rel.totalBytes / 1048576).toFixed(1)} MB`);
      if (rel.needsNpmInstall) console.log('  Note: no node_modules; rooms will run npm install (needs internet there).');
    }
    for (const [room, err] of Object.entries(data.errors || {})) console.error(`  ${room}: ${err}`);
  })
  .catch((err) => {
    console.error('Failed:', err.message, '\nIs central running? (npm start in this folder)');
    process.exit(1);
  });
