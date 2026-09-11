'use strict';

const crypto = require('crypto');

/**
 * Connected room agents, one record per roomId. A reconnect replaces the
 * socket but keeps the last known status so the dashboard does not blank out.
 */
class AgentRegistry {
  constructor() {
    this.agents = new Map();
  }

  register(roomId, ws, hello) {
    const old = this.agents.get(roomId);
    if (old && old.ws && old.ws !== ws) {
      try { old.ws.close(4000, 'Replaced by a new connection'); } catch { /* gone */ }
    }
    const rec = {
      roomId,
      ws,
      connected: true,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      platform: hello.platform || '?',
      nodeVersion: hello.nodeVersion || '?',
      agentVersion: hello.agentVersion || '?',
      baseDir: hello.baseDir || '',
      ip: hello.ip || null,
      port: hello.port || null,
      status: old ? old.status : null,
      lastResult: old ? old.lastResult : null,
      pending: new Map()
    };
    this.agents.set(roomId, rec);
    return rec;
  }

  markDisconnected(roomId) {
    const rec = this.agents.get(roomId);
    if (!rec) return;
    rec.connected = false;
    rec.ws = null;
    for (const p of rec.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Agent disconnected'));
    }
    rec.pending.clear();
  }

  get(roomId) {
    return this.agents.get(roomId);
  }

  connectedIds() {
    return [...this.agents.values()].filter((r) => r.connected).map((r) => r.roomId);
  }

  list() {
    return [...this.agents.values()].map((r) => ({
      roomId: r.roomId,
      connected: r.connected,
      platform: r.platform,
      nodeVersion: r.nodeVersion,
      agentVersion: r.agentVersion,
      baseDir: r.baseDir,
      ip: r.ip,
      port: r.port,
      lastSeen: r.lastSeen,
      status: r.status,
      lastResult: r.lastResult
    })).sort((a, b) => a.roomId.localeCompare(b.roomId));
  }

  /** Send a command and wait for the agent's reply. */
  command(roomId, type, payload = {}, timeoutMs = 10 * 60 * 1000) {
    const rec = this.agents.get(roomId);
    if (!rec || !rec.connected || !rec.ws) return Promise.reject(new Error('not connected'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        rec.pending.delete(requestId);
        reject(new Error(`${type} timed out`));
      }, timeoutMs);
      rec.pending.set(requestId, { resolve, reject, timer });
      try {
        rec.ws.send(JSON.stringify({ type, requestId, ...payload }));
      } catch (err) {
        clearTimeout(timer);
        rec.pending.delete(requestId);
        reject(err);
      }
    });
  }

  resolveReply(roomId, requestId, ok, result) {
    const rec = this.agents.get(roomId);
    const p = rec && rec.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    rec.pending.delete(requestId);
    if (ok) p.resolve(result);
    else p.reject(new Error((result && result.error) || 'failed'));
  }
}

module.exports = { AgentRegistry };
