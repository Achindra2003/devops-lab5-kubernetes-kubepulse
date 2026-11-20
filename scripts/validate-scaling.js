/** Manual scaling, then HPA-driven scale-out under CPU load and scale-in afterwards. */
import { createSuite, kns, kjson, waitFor, startTraffic, NS } from './lib.js';

const s = createSuite('KUBEPULSE SCALING VALIDATION SUITE (MANUAL + HPA)');
const dep = () => kjson('-n', NS, 'get', 'deploy', 'kubepulse');
const hpa = () => kjson('-n', NS, 'get', 'hpa', 'kubepulse');
const min = hpa().spec.minReplicas;
const cpu = () => hpa().status.currentMetrics?.[0]?.resource?.current?.averageUtilization;

await s.check('metrics-server is serving pod metrics', async () => {
  await waitFor('kubectl top pods', () => kns('top', 'pods').includes('kubepulse'), { timeoutMs: 120000, everyMs: 5000 });
  return kns('top', 'pods').split('\n')[1].trim().replace(/\s+/g, ' ');
});

await s.check('HPA reports live CPU utilisation', async () => {
  await waitFor('hpa has currentMetrics', () => cpu() !== undefined, { timeoutMs: 120000, everyMs: 5000 });
  return `current CPU ${cpu()}% (target 50%), replicas ${hpa().status.currentReplicas}`;
});

await s.check('Manual scale: kubectl scale to 5 works (HPA reclaims control later)', async () => {
  kns('scale', 'deploy/kubepulse', '--replicas=5');
  await waitFor('5 ready', () => dep().status.readyReplicas === 5, { timeoutMs: 120000 });
  return `scaled to ${dep().status.readyReplicas} ready replicas by hand`;
});

await s.check('HPA overrides the manual scale and settles at minReplicas when idle', async () => {
  await waitFor(`replicas back to ${min}`, () => dep().spec.replicas === min, { timeoutMs: 360000, everyMs: 10000 });
  return `HPA scaled 5 -> ${dep().spec.replicas} (scaleDown: 1 pod / 30s after a 60s window)`;
});

await s.check('HPA scales OUT under sustained CPU load', async () => {
  const stops = Array.from({ length: 8 }, () => startTraffic('/api/load?ms=400', 0));
  let peak = min;
  try {
    await waitFor('replicas > min', () => { peak = Math.max(peak, dep().spec.replicas); return peak > min; }, { timeoutMs: 240000, everyMs: 5000 });
    await waitFor('new pods ready', () => dep().status.readyReplicas >= peak, { timeoutMs: 120000 });
  } finally {
    await Promise.all(stops.map((f) => f()));
  }
  return `scaled ${min} -> ${peak} replicas (last CPU sample ${cpu()}%)`;
});

await s.check('HPA scales IN after load stops', async () => {
  const peak = dep().spec.replicas;
  await waitFor('replicas decreased', () => dep().spec.replicas < peak, { timeoutMs: 300000, everyMs: 10000 });
  return `scaled in from ${peak} to ${dep().spec.replicas}`;
});

s.finish();
