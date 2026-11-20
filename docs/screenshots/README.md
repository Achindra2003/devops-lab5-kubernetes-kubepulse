# Evidence Guide — Real Captures

**Course:** MCA Trimester 5 — DevOps Lab (Lab 5)  
**Student:** Achindra Sharma (2547105) — 4MCA A  

Every figure is generated from **real command output** against the live cluster by `scripts/capture-evidence.py`. The raw text for each figure is saved next to it in [`../evidence/`](../evidence) so any figure can be checked against its source. Nothing is typed or edited by hand. To regenerate: `python scripts/capture-evidence.py`.

| Fig. | File | Command(s) | What an evaluator should look for |
| :--: | :--- | :--- | :--- |
| 1 | `01-cluster-nodes.png` | `kubectl get nodes -o wide` | 3 nodes (1 control-plane, 2 workers), Kubernetes v1.32.2; metrics-server available |
| 2 | `02-docker-images.png` | `docker images kubepulse` | Three tags from one Dockerfile: `1.0.0`, `2.0.0`, `3.0.0-broken` |
| 3 | `03-kubectl-apply.png` | `kubectl apply -k k8s/base` | Namespace, ConfigMap, Secret, 2 Services, Deployment, PDB, HPA created declaratively |
| 4 | `04-get-all.png` | `kubectl get deploy,rs,pods,svc,hpa,pdb -o wide` | 3/3 Pods across two worker nodes; ClusterIP + NodePort 30080; HPA 3–8; PDB |
| 5 | `05-describe-deployment.png` | `kubectl describe deploy kubepulse` | `RollingUpdate 0 max unavailable, 1 max surge`, probes, resources, env sources |
| 6 | `06-service-load-balancing.png` | `kubectl get svc,endpoints`, `node scripts/probe.js 12` | Endpoints list 3 Pod IPs; consecutive requests answered by different Pods |
| 7 | `07-validate-deployment.png` | `node scripts/validate-deployment.js` | 9/9 PASS |
| 8 | `08-validate-resilience.png` | `node scripts/validate-resilience.js` | 4/4 PASS: Pod replaced, readiness gating without restart, crash restart |
| 9 | `09-validate-rollout.png` | `node scripts/validate-rollout.js`, `kubectl get rs` | 5/5 PASS: 0 failed requests during update, stalled bad release, rollback; old ReplicaSets retained |
| 10 | `10-validate-scaling.png` | `node scripts/validate-scaling.js`, `kubectl get hpa` | 6/6 PASS: manual scale, HPA scale-out (CPU above 50 %), scale-in |
| 11 | `11-naive-vs-production.png` | `node scripts/compare-naive.js` | Naive `Recreate` manifest: 7 failed requests. Production manifest: 0 |
| 12 | `12-kubepulse-dashboard.png` | browser at `http://localhost:8088` | Student attribution, version, pods answering with their nodes, 0 failed requests |

## Taking the dashboard screenshot yourself
1. `kubectl -n kubepulse get pods` — all `1/1 Running`.
2. Open `http://localhost:8088`, click **Send 100 requests**, then capture with `Win + Shift + S`.
3. For a stronger shot: run `kubectl -n kubepulse set image deploy/kubepulse app=kubepulse:2.0.0` while the page is open — the table shows `1.0.0 + 2.0.0 (rolling)` with **Failed requests: 0**.
