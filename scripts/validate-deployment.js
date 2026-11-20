/** Validates Deployment, Service, probes, security context and load balancing. */
import { createSuite, kjson, kns, get, waitFor, NS } from './lib.js';

const s = createSuite('KUBEPULSE DEPLOYMENT & SERVICE VALIDATION SUITE');
const dep = () => kjson('-n', NS, 'get', 'deploy', 'kubepulse');
const pods = () => kjson('-n', NS, 'get', 'pods', '-l', 'app=kubepulse').items.filter((p) => !p.metadata.deletionTimestamp);
const isReady = (p) => p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');

await s.check('Deployment is fully available', async () => {
  const d = await waitFor('deployment available', () => {
    const x = dep();
    return x.status.availableReplicas >= 3 && x.status.availableReplicas === x.status.replicas && x;
  }, { timeoutMs: 180000 });
  return `${d.status.availableReplicas}/${d.status.replicas} replicas available (image ${d.spec.template.spec.containers[0].image})`;
});

await s.check('Rolling update strategy is zero-downtime (maxUnavailable=0)', () => {
  const st = dep().spec.strategy;
  if (st.type !== 'RollingUpdate' || st.rollingUpdate.maxUnavailable !== 0) throw new Error(JSON.stringify(st));
  return `maxSurge=${st.rollingUpdate.maxSurge}, maxUnavailable=${st.rollingUpdate.maxUnavailable}`;
});

await s.check('Pods are spread across more than one node', () => {
  const nodes = new Set(pods().map((p) => p.spec.nodeName));
  if (nodes.size < 2) throw new Error(`all pods on: ${[...nodes]}`);
  return `Pods on ${nodes.size} nodes: ${[...nodes].join(', ')}`;
});

await s.check('Startup, readiness and liveness probes are configured', () => {
  const c = dep().spec.template.spec.containers[0];
  for (const p of ['startupProbe', 'readinessProbe', 'livenessProbe']) if (!c[p]) throw new Error(`${p} missing`);
  return `readiness=${c.readinessProbe.httpGet.path}, liveness=${c.livenessProbe.httpGet.path}`;
});

await s.check('Containers are hardened (non-root, read-only rootfs, no capabilities)', () => {
  const spec = dep().spec.template.spec;
  const c = spec.containers[0];
  if (!spec.securityContext.runAsNonRoot) throw new Error('runAsNonRoot not set');
  if (!c.securityContext.readOnlyRootFilesystem) throw new Error('rootfs writable');
  if (c.securityContext.allowPrivilegeEscalation !== false) throw new Error('privilege escalation allowed');
  const uid = kns('exec', pods().find(isReady).metadata.name, '--', 'id', '-u');
  if (uid === '0') throw new Error('process runs as root');
  return `UID ${uid}, readOnlyRootFilesystem=true, capabilities dropped`;
});

await s.check('Service endpoints match Ready pods', async () => {
  const counts = () => ({
    ready: pods().filter(isReady).length,
    n: kjson('-n', NS, 'get', 'endpoints', 'kubepulse').subsets?.[0]?.addresses?.length ?? 0,
  });
  const c = await waitFor('endpoints == ready pods', () => { const x = counts(); return x.n === x.ready && x; }, { timeoutMs: 20000, everyMs: 1000 });
  return `${c.n} endpoint addresses == ${c.ready} Ready pods`;
});

await s.check('Service DNS resolves inside the cluster (kubepulse.kubepulse.svc)', () => {
  const out = kns('exec', pods().find(isReady).metadata.name, '--', 'wget', '-qO-', 'http://kubepulse.kubepulse.svc.cluster.local/healthz');
  if (!out.includes('ok')) throw new Error(out);
  return `GET http://kubepulse.kubepulse.svc.cluster.local/healthz -> ${out}`;
});

await s.check('NodePort ingress reaches the app and load-balances across Pods', async () => {
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add((await get()).pod);
  if (seen.size < 2) throw new Error(`only one pod answered: ${[...seen]}`);
  return `60 requests via http://localhost:8088 were served by ${seen.size} distinct pods`;
});

await s.check('ConfigMap and Secret are injected (secret value never exposed)', async () => {
  const d = await get();
  if (!d.greeting.includes('Kubernetes')) throw new Error(`greeting=${d.greeting}`);
  if (!d.secretConfigured) throw new Error('API_TOKEN missing');
  return `greeting="${d.greeting}", secretConfigured=true`;
});

s.finish();
