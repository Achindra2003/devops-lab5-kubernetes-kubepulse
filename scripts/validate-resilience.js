/** Self-healing: pod deletion, readiness removal from endpoints, crash restart. */
import { createSuite, kjson, kns, waitFor, NS } from './lib.js';

const s = createSuite('KUBEPULSE SELF-HEALING & PROBE VALIDATION SUITE');
const pods = () => kjson('-n', NS, 'get', 'pods', '-l', 'app=kubepulse').items.filter((p) => !p.metadata.deletionTimestamp);
const isReady = (p) => p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
const readyCount = () => pods().filter(isReady).length;
const endpointIps = () => (kjson('-n', NS, 'get', 'endpoints', 'kubepulse').subsets?.[0]?.addresses ?? []).map((a) => a.ip);
// Hit the chaos endpoint inside one specific pod (bypasses the Service load balancer).
const chaos = (pod, action) => kns('exec', pod, '--', 'wget', '-qO-', '--post-data=', `http://127.0.0.1:3000/api/chaos/${action}`);

const desired = pods().length;

await s.check('Deleting a Pod: ReplicaSet recreates it and the Deployment self-heals', async () => {
  const victim = pods()[0].metadata.name;
  kns('delete', 'pod', victim, '--wait=false');
  await waitFor('replacement pod ready', () => readyCount() >= desired && !pods().some((p) => p.metadata.name === victim));
  return `Deleted ${victim}; back to ${readyCount()}/${desired} Ready pods with a new name`;
});

await s.check('Failing readiness removes a Pod from Service endpoints (no restart)', async () => {
  const target = pods().find(isReady);
  const ip = target.status.podIP;
  const restartsBefore = target.status.containerStatuses[0].restartCount;
  chaos(target.metadata.name, 'unready');
  await waitFor('pod removed from endpoints', () => !endpointIps().includes(ip), { timeoutMs: 30000, everyMs: 1000 });
  const after = pods().find((p) => p.metadata.name === target.metadata.name);
  if (after.status.containerStatuses[0].restartCount !== restartsBefore) throw new Error('container restarted — readiness must not restart');
  chaos(target.metadata.name, 'ready');
  await waitFor('pod back in endpoints', () => endpointIps().includes(ip), { timeoutMs: 30000, everyMs: 1000 });
  return `${target.metadata.name} (${ip}) left endpoints while unready, rejoined when ready, restarts unchanged`;
});

await s.check('Crashing a container: kubelet restarts it (restartCount increments)', async () => {
  const target = pods().find(isReady);
  const before = target.status.containerStatuses[0].restartCount;
  chaos(target.metadata.name, 'crash');
  await waitFor('restartCount incremented', () => {
    const p = pods().find((x) => x.metadata.name === target.metadata.name);
    return p.status.containerStatuses[0].restartCount > before && isReady(p);
  }, { timeoutMs: 90000 });
  return `${target.metadata.name}: restartCount ${before} -> ${before + 1}, Pod Ready again`;
});

await s.check('PodDisruptionBudget limits voluntary evictions to 1', () => {
  const pdb = kjson('-n', NS, 'get', 'pdb', 'kubepulse');
  if (pdb.spec.maxUnavailable !== 1) throw new Error(JSON.stringify(pdb.spec));
  return `allowed disruptions now: ${pdb.status.disruptionsAllowed}, maxUnavailable=1`;
});

s.finish();
