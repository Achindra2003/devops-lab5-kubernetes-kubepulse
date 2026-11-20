// Shared helpers for the validation suites.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

export const NS = 'kubepulse';
export const URL_BASE = process.env.KUBEPULSE_URL || 'http://localhost:8088';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function kubectl(...args) {
  return execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Async variant for long-running calls (rollout status). A sync call would freeze the
// event loop and silently pause any background traffic generator.
const execFileP = promisify(execFile);
export const kubectlAsync = async (...args) => (await execFileP('kubectl', args, { encoding: 'utf8' })).stdout.trim();
export const knsAsync = (...args) => kubectlAsync('-n', NS, ...args);

export const kjson = (...args) => JSON.parse(kubectl(...args, '-o', 'json'));
export const kns = (...args) => kubectl('-n', NS, ...args);

export async function get(path = '/api/info') {
  const res = await fetch(URL_BASE + path, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function waitFor(label, fn, { timeoutMs = 120000, everyMs = 2000 } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for: ${label} (last: ${last})`);
}

// Fires requests through the Service in the background; stop() reports totals.
export function startTraffic(path = '/api/info', everyMs = 40) {
  const stats = { ok: 0, failed: 0, versions: {}, pods: new Set(), errors: [] };
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const d = await get(path);
        stats.ok++;
        if (d.version) stats.versions[d.version] = (stats.versions[d.version] || 0) + 1;
        if (d.pod) stats.pods.add(d.pod);
      } catch (e) {
        stats.failed++;
        stats.errors.push(e.message);
      }
      await sleep(everyMs);
    }
  })();
  return async () => { running = false; await loop; return stats; };
}

export function createSuite(title) {
  let pass = 0;
  let fail = 0;
  console.log('\n===============================================================');
  console.log(` ${title}`);
  console.log(' Student: Achindra Sharma (2547105) — 4MCA A');
  console.log('===============================================================\n');
  return {
    async check(name, fn) {
      process.stdout.write(`Checking: ${name}... `);
      try {
        const detail = await fn();
        console.log('[PASS]');
        if (detail) console.log(`   -> ${detail}`);
        pass++;
      } catch (e) {
        console.log('[FAIL]');
        console.log(`   -> ${e.message}`);
        fail++;
      }
    },
    finish() {
      console.log('\n===============================================================');
      console.log(` SUMMARY: ${pass} PASSED, ${fail} FAILED`);
      console.log('===============================================================\n');
      process.exit(fail ? 1 : 0);
    },
  };
}
