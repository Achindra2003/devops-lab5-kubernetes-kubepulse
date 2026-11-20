/**
 * Rolling update + failed-release protection + rollback, all under live traffic.
 * Expects the Deployment to start on kubepulse:1.0.0. Leaves it on 2.0.0.
 */
import { createSuite, kns, knsAsync, kjson, get, startTraffic, waitFor, sleep, NS } from './lib.js';

const s = createSuite('KUBEPULSE ROLLING UPDATE, FAILURE PROTECTION & ROLLBACK SUITE');
const image = () => kjson('-n', NS, 'get', 'deploy', 'kubepulse').spec.template.spec.containers[0].image;
// One atomic patch: image + change-cause land in the same Deployment revision.
const release = (img, cause) => kns('patch', 'deploy/kubepulse', '-p', JSON.stringify({
  metadata: { annotations: { 'kubernetes.io/change-cause': cause } },
  spec: { template: { spec: { containers: [{ name: 'app', image: img }] } } },
}));

await s.check('Starting point: v1.0.0 serving', async () => {
  const d = await get();
  if (d.version !== '1.0.0') throw new Error(`expected 1.0.0, got ${d.version} (reset: kubectl -n kubepulse set image deploy/kubepulse app=kubepulse:1.0.0)`);
  return `serving ${d.version} from ${image()}`;
});

await s.check('Rolling update v1 -> v2 with ZERO failed requests', async () => {
  const stop = startTraffic();
  await sleep(1000);
  release('kubepulse:2.0.0', 'upgrade to v2.0.0');
  await knsAsync('rollout', 'status', 'deploy/kubepulse', '--timeout=180s');
  await sleep(2000);
  const t = await stop();
  if (t.failed > 0) throw new Error(`${t.failed} failed requests: ${[...new Set(t.errors)]}`);
  if (!t.versions['1.0.0'] || !t.versions['2.0.0']) throw new Error(`no mixed-version window observed: ${JSON.stringify(t.versions)}`);
  return `${t.ok} requests, 0 failed. Served: ${JSON.stringify(t.versions)} (both versions live during the roll)`;
});

await s.check('Bad release v3 is stalled by the readiness gate; v2 keeps serving', async () => {
  const stop = startTraffic();
  release('kubepulse:3.0.0-broken', 'bad release v3.0.0 (never ready)');
  let stalled = false;
  try { await knsAsync('rollout', 'status', 'deploy/kubepulse', '--timeout=45s'); } catch { stalled = true; }
  if (!stalled) throw new Error('rollout of a broken image unexpectedly completed');
  const t = await stop();
  if (t.failed > 0) throw new Error(`${t.failed} failed requests while v3 was stuck`);
  if (t.versions['3.0.0']) throw new Error('traffic was routed to the broken v3 pod');
  const d = kjson('-n', NS, 'get', 'deploy', 'kubepulse');
  return `rollout stalled (available=${d.status.availableReplicas}, unavailable=${d.status.unavailableReplicas}); ${t.ok} requests all served by v${Object.keys(t.versions)}, 0 failed`;
});

await s.check('Rollback: "kubectl rollout undo" restores v2 under traffic, 0 failed', async () => {
  const stop = startTraffic();
  await knsAsync('rollout', 'undo', 'deploy/kubepulse');
  kns('annotate', 'deploy/kubepulse', 'kubernetes.io/change-cause=rollback to v2.0.0 (rollout undo)', '--overwrite');
  await knsAsync('rollout', 'status', 'deploy/kubepulse', '--timeout=180s');
  await waitFor('v2 restored', async () => (await get()).version === '2.0.0', { timeoutMs: 30000, everyMs: 500 });
  const t = await stop();
  if (t.failed > 0) throw new Error(`${t.failed} failed requests during rollback`);
  return `image back to ${image()}; ${t.ok} requests, 0 failed`;
});

await s.check('Revision history with change-cause is recorded', () => {
  const h = kns('rollout', 'history', 'deploy/kubepulse');
  if (!h.includes('v2.0.0')) throw new Error(h);
  console.log(h.split('\n').map((l) => `      ${l}`).join('\n'));
  return 'rollout history lists each release (kubectl rollout undo --to-revision=N targets any of them)';
});

s.finish();
