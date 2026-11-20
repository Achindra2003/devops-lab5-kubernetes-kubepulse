// metrics-server feeds CPU/memory numbers to the HPA. kind's kubelets use self-signed
// certs, so --kubelet-insecure-tls is required (lab clusters only — never in production).
import { execFileSync } from 'node:child_process';

const VERSION = 'v0.7.2';
const kubectl = (...a) => execFileSync('kubectl', a, { encoding: 'utf8' }).trim();
const run = (...a) => console.log(kubectl(...a));

run('apply', '-f', `https://github.com/kubernetes-sigs/metrics-server/releases/download/${VERSION}/components.yaml`);
const args = kubectl('-n', 'kube-system', 'get', 'deploy', 'metrics-server', '-o', 'jsonpath={.spec.template.spec.containers[0].args}');
if (!args.includes('--kubelet-insecure-tls')) {
  run('-n', 'kube-system', 'patch', 'deployment', 'metrics-server', '--type=json',
    '-p', JSON.stringify([{ op: 'add', path: '/spec/template/spec/containers/0/args/-', value: '--kubelet-insecure-tls' }]));
}
run('-n', 'kube-system', 'rollout', 'status', 'deployment/metrics-server', '--timeout=120s');
