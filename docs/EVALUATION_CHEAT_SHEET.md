# Lab 5 Evaluation Quick-Reference Cheat Sheet
**Course:** MCA Trimester 5 — DevOps Lab (Lab 5)  
**Student:** Achindra Sharma — 2547105 — 4MCA A  
**Application:** KubePulse — Deployments, Services, Scaling, Rolling Updates on a 3-node Kubernetes cluster  
**Dashboard:** `http://localhost:8088`  

---

## 1. 90-second pitch

> *"For Lab 5 the task was to deploy a containerized application on Kubernetes and configure Deployments, Services, scaling and rolling updates.*
>
> *I built KubePulse, a small service that tells you which Pod answered each request, and ran it on a real three-node cluster — one control-plane and two workers.*
>
> *Beyond the commands, I measured the behaviour:*
> 1. *A rolling update under live traffic with **zero failed requests**, versus a naive Recreate Deployment that drops requests — same update, same traffic, 7 failed vs 0, see report §5.*
> 2. *A deliberately broken release that never becomes Ready: the readiness gate and `maxUnavailable: 0` keep the old version serving, and `rollout undo` recovers.*
> 3. *A Horizontal Pod Autoscaler that scales out under CPU load and back in afterwards, and why the Deployment omits `replicas`.*
> 4. *Chaos tests: delete a Pod, fail readiness, crash a container — and what Kubernetes does for each.*
> 4 automated suites, 24 checks, plus CI on a real kind cluster."*

---

## 2. Live demo script (5 minutes)

```powershell
kubectl get nodes                                      # 3 nodes
kubectl -n kubepulse get deploy,pods,svc,hpa -o wide   # 3 Pods across 2 workers
node scripts/probe.js 12                               # different Pod answers each time
```
Open **http://localhost:8088** — point at the attribution banner and the per-Pod table.

```powershell
# Zero-downtime rolling update with the dashboard open (Failed requests must stay 0)
kubectl -n kubepulse set image deploy/kubepulse app=kubepulse:2.0.0
kubectl -n kubepulse rollout status deploy/kubepulse

# Bad release is contained
kubectl -n kubepulse set image deploy/kubepulse app=kubepulse:3.0.0-broken
kubectl -n kubepulse get pods            # one Pod stuck 0/1, others untouched
kubectl -n kubepulse rollout undo deploy/kubepulse

# Scale
kubectl -n kubepulse scale deploy/kubepulse --replicas=5
# dashboard: "Start CPU load (HPA)"; in a 2nd terminal: kubectl -n kubepulse get hpa -w
```

If the evaluator wants the automated proof: `npm run validate:deploy`, `npm run validate:rollout`.

---

## 3. Rubric mapping

| Requirement | Implementation | Evidence |
| :--- | :--- | :--- |
| Deploy containerized app on a cluster | Dockerfile → 3 images → kind (3 nodes) | Fig. 1–4 |
| Configure Deployments | strategy, probes, resources, ConfigMap/Secret, security, spread, PDB | `k8s/base/20-deployment.yaml`, Fig. 5, 7 |
| Configure Services | ClusterIP + NodePort, endpoints, in-cluster DNS | Fig. 6, 7 |
| Scaling | `kubectl scale` + HPA with behaviour tuning | Fig. 10 |
| Rolling updates | zero-downtime update, failed release, rollback, history | Fig. 9, 11 |

## 4. Self-learning initiatives (8)
1. Measured rolling update vs naive Recreate baseline.
2. Failed-release protection and rollback with revision history.
3. Startup/readiness/liveness model proven with chaos endpoints.
4. HPA with tuned scale behaviour; `replicas` omitted on purpose.
5. Topology spread + PodDisruptionBudget.
6. Pod hardening (numeric non-root UID, read-only rootfs, drop ALL, seccomp).
7. ConfigMap / Secret / Downward API.
8. Validation suites + CI (unit → kubeconform → kind e2e).

Bonus: real findings in `docs/SELF_LEARNING.md` §10 (per-connection balancing, event-loop-blocking test harness, port clash).

---

## 5. Viva questions and model answers

**Q1. Deployment vs ReplicaSet vs Pod?**  
A Pod runs containers. A ReplicaSet keeps N identical Pods alive. A Deployment manages ReplicaSets: each template change creates a new ReplicaSet and scales it up while scaling the old one down, which is what makes rolling updates and rollbacks possible. Old ReplicaSets are kept (`revisionHistoryLimit: 5`) for `rollout undo`.

**Q2. What do `maxSurge` and `maxUnavailable` mean, and why 1 and 0?**  
`maxSurge` is how many extra Pods may exist above the desired count; `maxUnavailable` is how many may be missing. With 1/0, a new Pod must become Ready before any old Pod is removed, so capacity never drops.

**Q3. Readiness vs liveness vs startup probe?**  
Readiness decides whether the Pod receives Service traffic (failure → removed from Endpoints, no restart). Liveness decides whether the container is restarted. Startup delays the other two until the app has booted, so slow boots do not cause restart loops. I proved the first and second with chaos tests.

**Q4. ClusterIP vs NodePort vs LoadBalancer?**  
ClusterIP: virtual IP and DNS name reachable only inside the cluster. NodePort: also opens a port (30000–32767) on every node; kind maps it to host port 8088. LoadBalancer: asks a cloud provider for an external load balancer (not available in kind without MetalLB).

**Q5. Why does my Service seem to send all my requests to one Pod?**  
kube-proxy balances per TCP connection (L4). A keep-alive client keeps one connection and therefore one Pod. I hit this in validation; the app now closes the connection after each API response. For gRPC or long-lived connections, use client-side balancing, a headless Service or a service mesh.

**Q6. How does the HPA decide how many replicas?**  
`desired = ceil(current × currentUtilisation / targetUtilisation)`, where utilisation is measured against the CPU **request** (100 m here). Needs metrics-server. `behavior` limits how fast it scales up or down; the default 300 s scale-down window prevents flapping and was shortened to 60 s so the lab can show scale-in.

**Q7. Why is `replicas` missing from the Deployment?**  
If the manifest sets `replicas`, every `kubectl apply` resets the count and fights the HPA. With the field omitted, the HPA's `minReplicas` is the source of truth.

**Q8. A rollout is stuck. What do you check, and how do you recover?**  
`kubectl rollout status`, `kubectl get pods`, `kubectl describe pod`, `kubectl logs`. In my test the new Pod never became Ready, so the rollout stalled but the old Pods kept serving; `progressDeadlineSeconds` marks it failed; `kubectl rollout undo` recovers.

**Q9. Why `preStop: sleep 5`?**  
When a Pod terminates, endpoint removal and kube-proxy updates propagate asynchronously. Without a short delay SIGTERM can arrive while some nodes still route traffic to the Pod. The app also fails readiness and drains in-flight requests on SIGTERM.

**Q10. Why did you use a numeric `runAsUser: 1000`?**  
`runAsNonRoot: true` can only be verified for numeric UIDs; with `USER node` the kubelet cannot prove the user is non-root and refuses to start the container.

**Q11. What is a PodDisruptionBudget?**  
It limits *voluntary* disruptions (drains, upgrades) — here at most 1 Pod unavailable at a time. It does not protect against node crashes.

**Q12. Why do kind images need `kind load docker-image`?**  
kind nodes are containers with their own image store; they cannot see the host's Docker images. Hence `imagePullPolicy: IfNotPresent` plus loading the image.

**Q13. Is the Secret secure?**  
No — base64 is encoding. It keeps the value out of the image and the ConfigMap and lets RBAC restrict it, but real clusters need encryption at rest and an external secret manager. The API never returns the value.
