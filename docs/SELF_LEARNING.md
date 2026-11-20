# Self-Learning Report: Production-Grade Kubernetes Deployment Engineering

**Course:** MCA Trimester 5 — DevOps Lab (Lab 5)  
**Student Name:** Achindra Sharma (2547105) — 4MCA A  
**Application:** KubePulse — Kubernetes-aware microservice with live dashboard  
**Context:** Deploying containerized applications on Kubernetes: Deployments, Services, scaling, rolling updates

---

## 1. Why go beyond the baseline?

The baseline prompt for Lab 5 is:
> *"Deploy containerized applications on a Kubernetes cluster, configure Deployments, Services, scaling and rolling updates."*

A minimal submission runs `kubectl create deployment nginx --image=nginx`, exposes it, runs `kubectl scale`, and changes the image once. That demonstrates the commands but not the engineering: it does not show *why* an update is safe, *what* happens when a release is bad, or *how* the cluster reacts to load and failure. Every initiative below was built so that its claim is **measured** by an automated check against a live cluster, not asserted.

All results were produced on a real three-node cluster (kind v0.27.0, Kubernetes v1.32.2: one control-plane, two workers), not a single-node toy.

---

## 2. Initiative 1 — Zero-downtime rolling updates, with a measured baseline

### The problem
`kubectl set image` "works" on any Deployment, but whether users see errors depends entirely on the strategy, probes and shutdown behaviour. The default `maxUnavailable: 25%` plus no readiness probe routinely drops requests.

### What was implemented
```yaml
strategy:
  type: RollingUpdate
  rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }   # never below desired capacity
minReadySeconds: 5                                    # new Pod must stay Ready 5s to count
readinessProbe: { httpGet: { path: /readyz } }        # traffic only after the app says so
lifecycle: { preStop: { exec: { command: ["sleep","5"] } } }
```
plus an application that fails readiness and drains in-flight requests on `SIGTERM` (`server.js`).

Why each piece exists:
- `maxUnavailable: 0` + `maxSurge: 1`: a new Pod must be Ready *before* an old one is removed.
- `readinessProbe`: a Pod only receives traffic when it can serve it.
- `preStop sleep`: endpoint removal and kube-proxy rule updates propagate asynchronously; without the sleep, SIGTERM can arrive while some nodes still route to the Pod.

### How it was proven
`scripts/compare-naive.js` performs the identical v1→v2 update twice under continuous traffic (one request every ~25 ms): once with `k8s/unoptimized/naive-deployment.yaml` (`Recreate`, no probes) and once with the production manifest. The script asserts that the naive manifest **drops requests** and the production manifest **drops none**. Measured numbers are in the report (§6).

---

## 3. Initiative 2 — Failed-release protection and rollback

### The problem
Most outages come from bad releases, not hardware. A rollout that replaces healthy Pods with broken ones turns a deploy into an incident.

### What was implemented
A third image, `kubepulse:3.0.0-broken`, is built from the same Dockerfile with `--build-arg BROKEN=true`. Its process is alive but never answers readiness. `progressDeadlineSeconds: 60` makes Kubernetes report the stalled rollout as failed.

### Engineering impact (measured by `validate:rollout`)
- The rollout **stalls** with 1 new Pod `0/1` — old v2 Pods are never removed (`available=3, unavailable=1`).
- Hundreds of requests during the stall are **all served by v2, none failed, none reached v3**.
- `kubectl rollout undo` restores v2 under traffic with zero failed requests.
- `kubernetes.io/change-cause` gives `kubectl rollout history` meaningful entries. Image and annotation are applied in one `kubectl patch`, because annotating separately races with the controller that creates the new ReplicaSet and mislabels revisions (found by testing; see §10).

---

## 4. Initiative 3 — Three-probe health model proven with chaos

### The problem
Teams add one probe, copy it to all three roles, and then watch Pods restart under load or stay in rotation while broken.

### What was implemented
| Probe | Endpoint | Purpose | Failure effect |
| :--- | :--- | :--- | :--- |
| `startupProbe` | `/healthz` (30 × 1 s) | tolerate slow boot without loosening liveness | container restart if never starts |
| `readinessProbe` | `/readyz` | gate Service traffic | Pod removed from endpoints, **no restart** |
| `livenessProbe` | `/healthz` | detect a hung process | container restart |

The app exposes `POST /api/chaos/{unready,ready,crash}` (enabled only when `CHAOS_ENABLED=true` in the ConfigMap) so each behaviour can be triggered on one specific Pod.

### Engineering impact (measured by `validate:resilience`)
1. Deleting a Pod → ReplicaSet creates a replacement; the Deployment returns to full strength.
2. Forced unready → the Pod's IP disappears from the Service Endpoints; `restartCount` is unchanged; it rejoins when ready.
3. Crash → kubelet restarts the container; `restartCount` increments; Pod Ready again.
4. `PodDisruptionBudget` (`maxUnavailable: 1`) caps voluntary evictions during drains/upgrades.

---

## 5. Initiative 4 — Autoscaling (HPA) tuned and validated

### What was implemented
- **metrics-server** installed with `--kubelet-insecure-tls` (required for kind's self-signed kubelet certs; lab-only).
- `HorizontalPodAutoscaler` (autoscaling/v2): 3–8 replicas, target 50 % of the **CPU request** (100 m).
- Custom `behavior`: scale-up +2 Pods / 15 s with no stabilisation; scale-down −1 Pod / 30 s after a 60 s window (default window is 300 s, shortened so the lab can show scale-in).
- `/api/load?ms=` burns CPU on demand; the dashboard and `validate:scaling` drive it through the Service.

### Subtle design decision: no `replicas:` in the Deployment
If `spec.replicas` is set in the manifest, every `kubectl apply` resets the replica count and fights the HPA. The Deployment therefore omits it; the HPA's `minReplicas: 3` is the source of truth. (Verified: after `kubectl apply -k`, the HPA brought the Deployment to 3 replicas even before metrics were available.)

### Engineering impact (measured by `validate:scaling`)
Manual `kubectl scale` to 5 works but is **overridden** by the HPA back to the minimum when idle; sustained load scales out; removing load scales in.

---

## 6. Initiative 5 — Multi-node placement and disruption safety

### The Problem
By default the scheduler may place every replica on one node, and a node drain or upgrade can evict all of them at once — "3 replicas" then gives no availability.

### What was implemented
`topologySpreadConstraints` (`maxSkew: 1` on `kubernetes.io/hostname`, `ScheduleAnyway`) spreads replicas over both worker nodes, and a PodDisruptionBudget (`maxUnavailable: 1`) limits voluntary evictions. `ScheduleAnyway` was chosen over `DoNotSchedule` so a node outage degrades spreading rather than blocking scheduling.

### Engineering Impact
`validate:deploy` asserts the Pods occupy more than one node (observed: `kubepulse-worker` and `kubepulse-worker2`); `validate:resilience` confirms the PDB allows exactly 1 disruption.

---

## 7. Initiative 6 — Container and Pod hardening

### The Problem
Default Pods run with a writable root filesystem, default Linux capabilities and no syscall filter, so a compromised process can modify the image's files and escalate.

### What was implemented
```yaml
securityContext (Pod):  runAsNonRoot: true, runAsUser: 1000, seccompProfile: RuntimeDefault
securityContext (container): allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: drop [ALL]
volumes: emptyDir {medium: Memory, sizeLimit: 16Mi} mounted at /tmp
```
### Engineering Impact
`validate:deploy` verifies UID 1000, a read-only root filesystem and no privilege escalation on the live Pod. Lessons learned:
- `runAsNonRoot` can only be verified against a **numeric** UID. The Dockerfile uses `USER 1000`, not `USER node`; with a name, the kubelet refuses to start the container ("cannot verify user is non-root").
- A read-only root filesystem requires an explicit writable mount for anything that writes (`/tmp`).
- The Dockerfile `HEALTHCHECK` is **ignored by Kubernetes**; it only serves `docker run`. Kubernetes uses its own probes.
- The Secret is injected as an environment variable and the API reports only `secretConfigured: true`. Base64 in a manifest is encoding, not encryption; production would use an external secret store.

---

## 8. Initiative 7 — Externalised configuration and Downward API

### The Problem
Configuration baked into the image forces a rebuild for every change, and a Pod has no way to know its own name or node — making it impossible to see which replica served a request.

### What was implemented
`ConfigMap` (greeting, startup delay, chaos switch) and `Secret` (token) are injected with `envFrom`. The **Downward API** exposes Pod name, namespace, IP and node name to the process so the dashboard can show where each response came from. 
### Engineering Impact
Configuration changes need no image rebuild, and every response identifies its Pod and node, which is what makes load balancing and rollouts visible. `validate:deploy` confirms the greeting arrives from the ConfigMap and the secret is present but never echoed.

---

## 9. Initiative 8 — Automation: validation suites and CI

| Suite | Checks | What it proves |
| :--- | :---: | :--- |
| `validate:deploy` | 9 | availability, strategy, node spread, probes, hardening, endpoints, in-cluster DNS, NodePort balancing, config injection |
| `validate:resilience` | 4 | pod replacement, readiness gating, crash restart, PDB |
| `validate:rollout` | 5 | zero-downtime update, bad-release stall, rollback, history |
| `validate:scaling` | 6 | metrics, HPA utilisation, manual scale, HPA override, scale-out, scale-in |
| `compare:naive` | 2 | measured downtime of naive vs production |

`.github/workflows/k8s-ci.yml`: unit tests → `kubeconform -strict` schema validation of the rendered kustomization → a real 3-node kind cluster running the deploy/resilience/rollout suites. (The ~8-minute HPA suite is run locally rather than on every push.)

---

## 10. Real problems found while building this (and what they taught me)

| # | Symptom | Root cause | Fix / lesson |
| :-: | :--- | :--- | :--- |
| 1 | 60 sequential requests through the NodePort all hit **one** Pod | `kube-proxy` load-balances per **TCP connection**; an HTTP keep-alive client reuses one connection | API replies `Connection: close`, so each request re-balances. Lesson: Services are L4, not L7; gRPC/keep-alive clients need a mesh, headless Service or client-side balancing |
| 2 | "Zero-downtime" test showed only ~50 requests during a rollout that takes ~30 s | The test harness ran `kubectl rollout status` with a *synchronous* child process, freezing Node's event loop and the background traffic generator | Use async `execFile` for long calls. Lesson: a validation that cannot fail is worthless — check that the measurement itself ran |
| 3 | `kind create cluster` failed: `port is already allocated` | An unrelated container was already bound to host port 8080 | Cluster publishes on 8088 instead of stopping it |
| 4 | Rollout history labels were wrong (revision 1 labelled "upgrade to v2") | Annotating after `set image` races with the controller that stamps the new ReplicaSet | Single atomic `kubectl patch` for image + change-cause; annotate after `rollout undo` |
| 5 | After `rollout undo`, history skips the number of the re-used revision | Kubernetes re-uses the old ReplicaSet and renumbers it as the newest revision | Expected behaviour; documented |
| 6 | Intermittent failure of the endpoints == Ready Pods check right after a rollout | A terminating Pod is still `Ready` for a moment after it leaves Endpoints | Ignore Pods with a `deletionTimestamp`; poll briefly |

---

## 11. Synthesis

| Initiative | Technical domain | Operational value |
| :--- | :--- | :--- |
| Measured rolling update vs naive | Release engineering | Zero failed requests during upgrades, with numbers |
| Failed-release protection + rollback | Reliability | A bad image cannot take capacity away; recovery in one command |
| Three-probe model + chaos | Self-healing | Correct restart-vs-remove semantics, demonstrated |
| HPA with tuned behaviour | Capacity | Elastic scale-out/in on real CPU load |
| Topology spread + PDB | Availability | Node loss and drains stay within a safe budget |
| Pod hardening | Security | Non-root, read-only, no capabilities, secret handled safely |
| ConfigMap/Secret/Downward API | Configuration | Config separate from image; Pod identity visible |
| Validation suites + CI | Automation | Every claim re-checked on a fresh cluster |
