/**
 * KubePulse — Kubernetes-aware microservice (zero dependencies)
 * MCA Trimester 5 - DevOps Lab 5
 * Author: Achindra Sharma (2547105) — 4MCA A
 *
 * The app reports which Pod served each request, so Kubernetes behaviour
 * (load balancing, rolling updates, autoscaling, self-healing) is visible.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = parseInt(process.env.PORT || '3000', 10);
const VERSION = process.env.APP_VERSION || '0.0.0-dev';
const STARTUP_DELAY_MS = parseInt(process.env.STARTUP_DELAY_MS || '0', 10);
// BROKEN=true simulates a bad release: process is alive but never becomes Ready.
const BROKEN = process.env.BROKEN === 'true';
const CHAOS_ENABLED = process.env.CHAOS_ENABLED === 'true';
const MAX_LOAD_MS = 2000;

const student = { name: 'Achindra Sharma', regNo: '2547105', class: '4MCA A' };
const startedAt = Date.now();

let started = false; // flips true after STARTUP_DELAY_MS (simulates slow boot)
let forcedUnready = false; // chaos switch
let shuttingDown = false;
let requestsServed = 0;

setTimeout(() => { started = true; }, STARTUP_DELAY_MS).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const isReady = () => started && !BROKEN && !forcedUnready && !shuttingDown;

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // kube-proxy balances per TCP *connection*; a keep-alive client would stick to one Pod.
    // Closing after each API response makes every request re-balance (and re-resolve during rollouts).
    Connection: 'close',
    'X-Served-By': process.env.POD_NAME || os.hostname(),
  });
  res.end(JSON.stringify(body));
}

function info() {
  return {
    app: 'KubePulse',
    version: VERSION,
    release: BROKEN ? 'broken' : 'stable',
    student,
    pod: process.env.POD_NAME || os.hostname(),
    namespace: process.env.POD_NAMESPACE || null,
    node: process.env.NODE_NAME || null,
    podIP: process.env.POD_IP || null,
    greeting: process.env.GREETING || 'Hello from KubePulse',
    secretConfigured: Boolean(process.env.API_TOKEN), // never echo the value
    ready: isReady(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requestsServed,
  };
}

// Busy-wait to burn CPU so the HorizontalPodAutoscaler has something to react to.
function burnCpu(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function serveStatic(req, res) {
  const rel = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');

  if (pathname === '/healthz') return sendJson(res, 200, { status: 'ok' }); // liveness
  if (pathname === '/readyz') {
    return sendJson(res, isReady() ? 200 : 503, { status: isReady() ? 'ready' : 'not-ready' });
  }

  if (pathname === '/api/info') {
    requestsServed++;
    return sendJson(res, 200, info());
  }

  if (pathname === '/api/load') {
    requestsServed++;
    const ms = Math.min(Math.max(parseInt(searchParams.get('ms') || '200', 10) || 0, 0), MAX_LOAD_MS);
    burnCpu(ms);
    return sendJson(res, 200, { pod: info().pod, burnedMs: ms });
  }

  if (pathname.startsWith('/api/chaos/')) {
    if (!CHAOS_ENABLED) return sendJson(res, 403, { error: 'chaos endpoints disabled (CHAOS_ENABLED!=true)' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' });
    const action = pathname.slice('/api/chaos/'.length);
    if (action === 'unready') forcedUnready = true;
    else if (action === 'ready') forcedUnready = false;
    else if (action === 'crash') {
      sendJson(res, 200, { pod: info().pod, action: 'crashing in 200ms' });
      setTimeout(() => process.exit(1), 200);
      return;
    } else return sendJson(res, 404, { error: 'unknown chaos action' });
    return sendJson(res, 200, { pod: info().pod, action, ready: isReady() });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
  return serveStatic(req, res);
});

// Graceful shutdown: fail readiness, finish in-flight requests, then exit.
// Together with the Deployment's preStop sleep this is what makes rolling updates lossless.
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${signal}] draining ${process.env.POD_NAME || os.hostname()}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 20000).unref();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`KubePulse ${VERSION} listening on :${PORT} (startup delay ${STARTUP_DELAY_MS}ms, broken=${BROKEN})`);
  });
}

export default server;
