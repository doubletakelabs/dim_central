'use strict';
// What the agent needs from Node 18 that Node 16 lacks: a global fetch and
// AbortSignal.timeout. The SaaS room is an older Mac that cannot run a newer
// Node, and on it every deploy failed with "fetch is not defined". Installed
// only where missing, so on a current Node this file does nothing.
//
// Covers what the agent itself asks of fetch — GET and POST, headers, an
// abort signal, redirects, and a response with ok/status/json()/text() and a
// streamable body — not the whole of the standard.

const http = require('http');
const https = require('https');

function nodeFetch(url, options = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const { method = 'GET', headers = {}, body = null, signal } = options;
    if (signal?.aborted) return reject(abortError(signal));
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, { method, headers }, (res) => {
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location && redirects > 0) {
        res.resume();
        resolve(nodeFetch(new URL(location, target).toString(), options, redirects - 1));
        return;
      }
      resolve(response(res));
    });
    req.on('error', reject);
    if (signal) {
      const onAbort = () => req.destroy(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    if (body != null) req.write(body);
    req.end();
  });
}

function response(res) {
  let consumed = null;
  const buffer = () => {
    consumed ??= new Promise((resolve, reject) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    return consumed;
  };
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage,
    headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
    // A Node stream rather than a web one: fetcher.js pipes either.
    body: res,
    text: async () => (await buffer()).toString('utf8'),
    json: async () => JSON.parse((await buffer()).toString('utf8')),
    arrayBuffer: async () => {
      const b = await buffer();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

function abortError(signal) {
  const err = new Error(signal?.reason?.message ?? 'The operation was aborted');
  err.name = signal?.reason?.name ?? 'AbortError';
  return err;
}

if (typeof globalThis.fetch !== 'function') globalThis.fetch = nodeFetch;

if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const reason = new Error('The operation timed out');
      reason.name = 'TimeoutError';
      controller.abort(reason);
    }, ms);
    timer.unref?.();
    return controller.signal;
  };
}

module.exports = { nodeFetch };
