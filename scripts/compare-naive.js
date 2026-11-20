/**
 * Measured baseline: the same v1 -> v2 update done with a naive Deployment (Recreate, no probes)
 * versus the production manifest (RollingUpdate, maxUnavailable=0, readiness, preStop).
 * Leaves the cluster on the production manifest.
 */
import { createSuite, kns, knsAsync, kubectl, get, startTraffic, waitFor, sleep } from './lib.js';

const s = createSuite('NAIVE vs PRODUCTION DEPLOYMENT: DOWNTIME UNDER A v1 -> v2 UPDATE');

async function measure(label) {
  await waitFor('v1 serving', async () => (await get()).version === '1.0.0', { timeoutMs: 90000, everyMs: 1000 });
  const stop = startTraffic('/api/info', 25);
  await sleep(1000);
  kns('set', 'image', 'deploy/kubepulse', 'app=kubepulse:2.0.0');
  await knsAsync('rollout', 'status', 'deploy/kubepulse', '--timeout=180s');
  await sleep(2000);
  const t = await stop();
  console.log(`   ${label}: ${t.ok + t.failed} requests, ${t.failed} FAILED (${[...new Set(t.errors)].join(', ') || 'no errors'})`);
  return t;
}

let naive;
await s.check('Naive manifest (Recreate, no probes) drops requests during the update', async () => {
  kubectl('replace', '--force', '-f', 'k8s/unoptimized/naive-deployment.yaml');
  await knsAsync('rollout', 'status', 'deploy/kubepulse', '--timeout=120s');
  naive = await measure('naive     ');
  if (naive.failed === 0) throw new Error('expected downtime with Recreate, saw none');
  return `outage observed: ${naive.failed} failed requests`;
});

await s.check('Production manifest (RollingUpdate, readiness, preStop) drops ZERO requests', async () => {
  kns('delete', 'deploy/kubepulse', '--wait=true');
  kubectl('apply', '-k', 'k8s/base');
  await knsAsync('rollout', 'status', 'deploy/kubepulse', '--timeout=180s');
  const prod = await measure('production');
  if (prod.failed > 0) throw new Error(`${prod.failed} failed requests`);
  return `no outage: 0 failed requests (naive had ${naive?.failed})`;
});

s.finish();
