'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { syncManifest } = require('./fetcher');
const pointer = require('./pointer');
const { waitHealthy, probe } = require('./supervisor');

/**
 * Deploy = download the release folder, point at it, restart, report.
 *
 * Nothing here reverts automatically. If the new release does not come up,
 * the result says so and the dashboard shows it; a person clicks Rollback.
 */

function releasesDir(config) {
  return path.join(config.baseDir, 'releases');
}

function releaseDir(config, id) {
  return path.join(releasesDir(config), id);
}

/** Work out what file to run. Config wins, then package.json, then server.js. */
function findEntry(config, dir) {
  if (config.roomServerEntry) return config.roomServerEntry;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const start = pkg.scripts && pkg.scripts.start;
    const m = start && /^node\s+(\S+)/.exec(start.trim());
    if (m) return m[1];
    if (pkg.main) return pkg.main;
  } catch { /* no package.json */ }
  return 'server.js';
}

/** experience.json from a release, or null for a plain server. */
function readExperience(config, releaseId) {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(releaseDir(config, releaseId), 'experience.json'), 'utf8'));
    return { id: e.experienceId, name: e.name, version: e.version, display: e.entry && e.entry.display };
  } catch { return null; }
}

function roomServerEnv(config, releaseId) {
  return {
    ROOM_ID: config.roomId,
    RELEASE_ID: releaseId,
    PORT: String(config.roomServerPort),
    CONTENT_DIR: path.join(config.baseDir, 'content'),
    SHARED_DIR: path.join(config.baseDir, 'shared'),
    CENTRAL_HTTP: config.central,
    // Room experiences (see handover ROOM-EXPERIENCE.md) read these two so
    // media and calibration live outside the release and survive deploys.
    MEDIA_DIR: path.join(config.baseDir, 'content', config.roomId),
    CALIBRATION_FILE: path.join(config.baseDir, 'shared', 'calibration.json'),
    ...(config.roomServerEnv || {})
  };
}

/** Start the room server at a release and wait for it to answer HTTP. */
async function startRelease(ctx, releaseId) {
  const { config, supervisor, log } = ctx;
  const dir = releaseDir(config, releaseId);
  const entry = findEntry(config, dir);
  if (!fs.existsSync(path.join(dir, entry))) {
    return { ok: false, error: `Entry file not found in release: ${entry}` };
  }
  // Our own previous room server is stopped first, so anything answering now
  // is some other program. Without this check its answer would count as "up".
  await supervisor.stop();
  if ((await probe(config.healthUrl, 1500)).ok) {
    return { ok: false, error: `Port ${config.roomServerPort} is already in use by another program on this machine` };
  }
  await supervisor.start({ releaseId, dir, entry, env: roomServerEnv(config, releaseId) });
  const h = await waitHealthy(supervisor, config.healthUrl, config.healthGraceMs);
  if (!h.healthy) {
    log('error', `Release ${releaseId} is not answering: ${h.reason}`);
    return { ok: false, error: h.reason };
  }
  if (ctx.display && config.display === 'chrome') {
    const exp = readExperience(config, releaseId);
    const defaultPage = config.displayPath || (exp && exp.display) || '/';
    const base = `http://localhost:${config.roomServerPort}`;
    const windows = (config.displays && config.displays.length ? config.displays : [{}]).map((d) => ({
      url: base + (d.path || defaultPage),
      position: Array.isArray(d.position) && d.position.length === 2 ? d.position : null
    }));
    ctx.display.open(windows);
  }
  return { ok: true };
}

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, shell: process.platform === 'win32', windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => resolve({ code: -1, out: out + err.message }));
    child.on('close', (code) => resolve({ code, out: out.slice(-2000) }));
  });
}

async function deploy(ctx, releaseId) {
  const { config, log, sendProgress } = ctx;
  const started = Date.now();
  const dir = releaseDir(config, releaseId);

  // 1. download (files already present with the right hash are skipped)
  log('info', `Deploy ${releaseId}: fetching manifest`);
  const res = await fetch(`${config.central}/api/releases/${encodeURIComponent(releaseId)}/manifest`);
  if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
  const manifest = await res.json();

  log('info', `Deploy ${releaseId}: downloading ${manifest.fileCount} files`);
  const sync = await syncManifest({
    manifest,
    destDir: dir,
    concurrency: 8,
    prune: true,
    urlFor: (e) => `${config.central}/api/releases/${encodeURIComponent(releaseId)}/file?path=${encodeURIComponent(e.path)}`,
    onProgress: (p) => {
      if (p.done % 25 === 0 || p.done === p.total) sendProgress({ phase: 'download', ...p });
    }
  });
  log('info', `Deploy ${releaseId}: ${sync.downloaded} downloaded, ${sync.skipped} already present`);

  // 2. npm install only if the release did not ship node_modules
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath) && !fs.existsSync(path.join(dir, 'node_modules'))) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
      log('info', `Deploy ${releaseId}: release has no node_modules, running npm install`);
      sendProgress({ phase: 'npm install' });
      const r = await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir });
      if (r.code !== 0) throw new Error(`npm install failed: ${r.out.slice(-500)}`);
    }
  }

  // 3. make it live and start it
  const before = pointer.read(config.baseDir);
  pointer.flipTo(config.baseDir, releaseId);
  log('info', `Deploy ${releaseId}: now live (was ${before.release || 'nothing'})`);
  sendProgress({ phase: 'starting' });

  const result = await startRelease(ctx, releaseId);
  sendProgress(null);
  if (result.ok) {
    log('info', `Deploy ${releaseId}: up in ${Math.round((Date.now() - started) / 1000)}s`);
    await prune(ctx);
  }
  return { ...result, releaseId, previous: pointer.read(config.baseDir).previous, ms: Date.now() - started };
}

async function rollback(ctx) {
  const { config, log } = ctx;
  const next = pointer.rollback(config.baseDir);
  if (!next) return { ok: false, error: 'No previous release to roll back to' };
  if (!fs.existsSync(releaseDir(config, next.release))) {
    return { ok: false, error: `Previous release ${next.release} is no longer on disk` };
  }
  log('warn', `Rolling back to ${next.release}`);
  const result = await startRelease(ctx, next.release);
  return { ...result, releaseId: next.release };
}

/** Delete old release folders, keeping the newest N plus current and previous. */
async function prune(ctx) {
  const { config, log } = ctx;
  const cur = pointer.read(config.baseDir);
  const keep = new Set([cur.release, cur.previous].filter(Boolean));
  let entries = [];
  try {
    entries = fs.readdirSync(releasesDir(config), { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch { return; }
  const sorted = entries.map((e) => e.name).sort().reverse(); // ids sort by date
  const doomed = sorted.filter((n) => !keep.has(n)).slice(Math.max(0, config.keepReleases - keep.size));
  for (const name of doomed) {
    try {
      await fs.promises.rm(releaseDir(config, name), { recursive: true, force: true });
      log('info', `Removed old release ${name}`);
    } catch (err) {
      log('warn', `Could not remove ${name}: ${err.message}`);
    }
  }
}

module.exports = { deploy, rollback, startRelease, prune, releaseDir, readExperience };
