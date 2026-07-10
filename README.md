# MERN App — Full CI/CD on Azure DevOps to a VirtualBox Kubernetes Cluster

This repo ships a MERN app (React + Express + MongoDB) to a self-hosted
Kubernetes cluster running in VirtualBox. **One Azure DevOps pipeline does the
whole job** — security check, build & push images, then deploy — all on a
self-hosted agent that lives *inside* the cluster network.

- **CI/CD — Azure DevOps** (self-hosted agent on the cluster master), one
  pipeline, three gated stages:
  1. **Security check** — backend `npm audit`, frontend lint + build.
  2. **Build & push** — build backend + frontend images, push to a **private**
     Docker Hub repo tagged `backend-<sha>` / `frontend-<sha>`.
  3. **Deploy** — refresh the `regcred` image pull Secret, then `helm upgrade`
     with the exact `<sha>` just built. Runs only if the first two stages pass.
- **No secrets in git** — the Docker token is a secret variable in the ADO variable
  group (it also feeds the cluster's `regcred` pull Secret); app secrets live in
  a k8s Secret (see **Config & secrets** below).

```mermaid
flowchart LR
    P["push → Azure Repos"] --> S["Stage 1<br/>Security check"]
    S -->|ok| B["Stage 2 · Build & push<br/>backend-&lt;sha&gt; / frontend-&lt;sha&gt;"]
    B -->|ok| D["Stage 3<br/>helm upgrade (sha)"]
    B --> H[("Docker Hub<br/>(private)")]
    H -. "pull (regcred)" .-> K["vbox cluster"]
    D --> K
```

**Why a self-hosted agent for everything?** The vbox cluster has no public
endpoint, so the deploy has to run from a machine inside the network. That same
agent (on the master) also has Docker, so it builds and pushes the images too —
no external CI system needs to reach the cluster, and no cluster credentials ever
leave the network.

> **GitHub Actions were removed.** Earlier this repo split CI (GitHub) from CD
> (Azure DevOps) and handed off via a REST call. That is gone — Azure DevOps now
> owns the full pipeline. GitHub (`github` remote) is optional, a plain mirror.

---

## How to read this doc

| Section | When you use it |
|---|---|
| [1. Cluster topology](#1-cluster-topology) · [2. Prerequisites](#2-prerequisites) | Reference — read once |
| [3. One-time bring-up](#3-one-time-bring-up-in-order) | Setting the system up, top to bottom |
| [4. Everyday workflow](#4-everyday-workflow-the-loop) | Every change, after bring-up |
| [5. Operate](#5-operate-verify-rollback-troubleshoot) | Health checks, rollback, debugging |
| [6. Hardening roadmap](#6-hardening-roadmap) · [7. File map](#7-file-map) | Reference |

The bring-up in §3 is **ordered and gated** — each step assumes the previous one
passed. Do not automate the pipeline (§3.5) before the manual deploy (§3.3) works.

---

## 1. Cluster topology

| Role | Host | IP |
|---|---|---|
| Master (+ Azure DevOps agent) | `sv-k8s-master` | 192.168.100.233 |
| Worker 1 | `sv-k8s-wk-1` | 192.168.100.231 |
| Worker 2 | `sv-k8s-wk-2` | 192.168.100.232 |

Conventions used throughout: namespace `mern-app`, Helm release `mern-app`,
ingress host `mern-app.deploy`, image repo `<DOCKERHUB_USERNAME>/web-app-mern`. The
ingress starts out exposed as a **NodePort** (bare-metal cluster, no cloud LB) —
that port is written as `<INGRESS_NODEPORT>` below (e.g. `30080`) and is reachable
on **any** node IP. §6.1 later upgrades it to a MetalLB **LoadBalancer** at
`192.168.100.248`, after which the port-free `http://mern-app.deploy/` is the
primary URL (the NodePort keeps working as a fallback).

---

## 2. Prerequisites

- [ ] kubeadm cluster up; `kubectl get nodes` shows all 3 `Ready`.
- [ ] On the master (the agent host): `helm` v3, `kubectl`, **and Docker** — the
      agent now builds images too, so a working Docker daemon is required.
- [ ] Azure DevOps org + project (free tier is fine) with this repo in Azure Repos.
- [ ] A **private** Docker Hub repo `web-app-mern` — create it on hub.docker.com
      *before* the first push (a push to a non-existent repo auto-creates it
      **public**) or flip it after: repo → Settings → Visibility → Private.
      The cluster pulls it via the `regcred` pull Secret (§3.1).
- [ ] A Docker Hub personal access token (Read & Write) for `DOCKERHUB_TOKEN` (§3.5).

---

## 3. One-time bring-up (in order)

### 3.1 Prepare the cluster

Run on the **master** (`192.168.100.233`).

**Ingress controller** (bare-metal → NodePort):
```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/baremetal/deploy.yaml
kubectl -n ingress-nginx get svc ingress-nginx-controller
# note the http NodePort, e.g. 80:3XXXX/TCP  → this is your <INGRESS_NODEPORT>
```

The NodePort above is **random** by default (K8s picks a free port in 30000–32767,
e.g. `32652`). This port belongs to the ingress controller, **not** to this app's
Helm chart — redeploying the app never changes it. To pin it to a fixed, memorable
value of your own so the app URL is stable, patch the controller Service:
```bash
kubectl -n ingress-nginx patch svc ingress-nginx-controller \
  -p '{"spec":{"ports":[{"name":"http","port":80,"nodePort":30080},{"name":"https","port":443,"nodePort":30443}]}}'
kubectl -n ingress-nginx get svc ingress-nginx-controller   # http now shows 80:30080/TCP
```
`<INGRESS_NODEPORT>` is then `30080`. Constraints: the value **must** be in
30000–32767 and unused — you can't use `80`/`8080` here without widening the
apiserver's `--service-node-port-range`. To drop the `:<port>` from the URL
entirely, install MetalLB instead (see [§6.1](#61-drop-the-port-with-metallb)).

**Namespace**:
```bash
kubectl create namespace mern-app
```
> No manual app Secret anymore: the **chart renders `mern-app-secrets` itself**
> (`templates/secret.yaml`) from values injected at deploy time — the pipeline
> takes `JWT_SECRET` / `MONGO_URI` from the variable group (§3.5); the manual
> gate deploy passes them by hand (§3.3). Design details: §6.3.

**Image pull Secret** — the Docker Hub repo is **private**, so the nodes need
credentials to pull it:
```bash
kubectl create secret docker-registry regcred -n mern-app \
  --docker-server=https://index.docker.io/v1/ \
  --docker-username=<DOCKERHUB_USERNAME> \
  --docker-password=<DOCKERHUB_TOKEN>
```
> This manual copy only has to be right for the manual deploy in §3.3 — once the
> pipeline is live (§3.5), its Deploy stage **recreates `regcred` on every run**
> from the variable group, so token rotations propagate automatically.

**Hosts entry** on your **Windows host** (`C:\Windows\System32\drivers\etc\hosts`,
as admin) so the browser resolves the app to a node:
```
192.168.100.231  mern-app.deploy
```
The app URL is then `http://mern-app.deploy:<INGRESS_NODEPORT>`.

> The master itself has **no** such entry — that's expected. When you `curl` the
> health endpoint from the master, use the Host-header form in §5.1, not the
> `mern-app.deploy` name.

### 3.2 Build + push images once, by hand

Prove the images build and push before wiring the pipeline. On the master (which
has Docker), with a Docker Hub login (`docker login`):

```bash
git clone https://lfglobaltech@dev.azure.com/lfglobaltech/DevOps/_git/MERN-simple-app
cd MERN-simple-app
SHA=$(git rev-parse HEAD)

docker build -t <DOCKERHUB_USERNAME>/web-app-mern:backend-$SHA  -f Dockerfile .
docker build -t <DOCKERHUB_USERNAME>/web-app-mern:frontend-$SHA -f client/Dockerfile client
docker push <DOCKERHUB_USERNAME>/web-app-mern:backend-$SHA
docker push <DOCKERHUB_USERNAME>/web-app-mern:frontend-$SHA
```

Confirm both tags appear on Docker Hub and the repo shows **Private** (pushing
to a private repo needs nothing extra — `docker login` covers it; only *pulls*
from the cluster need `regcred`). Note the `<sha>` — that's the tag you deploy
next. (This is exactly what the pipeline's **Build & push** stage automates
later.)

### 3.3 Manual Helm deploy — prove it by hand ⛔ (gate)

Before automating anything, deploy once by hand using the **same values file the
pipeline uses**, just rendered locally. On the master:

```bash
# render the tokenized values (exactly what the Deploy stage does)
sed -e "s|__crServer__|<DOCKERHUB_USERNAME>|g" \
    -e "s|__IMAGE_TAG__|<sha>|g" \
    -e "s|__ingressHost__|mern-app.deploy|g" \
    k8s-helm/mern-app/values.tokenized.yaml > /tmp/values.yaml

helm upgrade --install mern-app k8s-helm/mern-app \
  -n mern-app -f /tmp/values.yaml \
  --set-string secrets.jwtSecret="$(openssl rand -hex 24)" \
  --set-string secrets.mongoUri='mongodb://mern-app-mongodb:27017/mern-app' \
  --wait --timeout 5m
```

> The two `--set-string` flags feed `templates/secret.yaml`, which renders the
> `mern-app-secrets` Secret (§6.3). Use the **same** JWT value you'll later put
> in the variable group, or every deploy that changes it logs users out.

Verify (see §5.1 for the health check), then open
`http://mern-app.deploy:<INGRESS_NODEPORT>` from your Windows host → register → login →
dashboard. That confirms the whole path: **frontend → ingress → backend → MongoDB.**

> **Gate:** do not wire up the pipeline (§3.4–3.5) until this manual deploy works.

### 3.4 Install the Azure DevOps self-hosted agent

The agent runs the **entire** pipeline on your network, so it needs
`docker` + `helm` + `kubectl` + a kubeconfig.

**In Azure DevOps:** Project settings → Agent pools → **Add pool** → Self-hosted →
name **`vbox-k8s`**. Create a PAT (User settings → PAT → scope **Agent Pools
(Read & manage)**).

**On the master** (`192.168.100.233`):
```bash
# docker (build stage) — install if not already present, and let the agent user
# run it without sudo:
#   sudo apt-get install -y docker.io && sudo usermod -aG docker "$USER"   # re-login after
docker version    # must succeed as the agent user, no sudo

# helm (kubectl already present from kubeadm)
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# kubeconfig for the agent user (must work WITHOUT sudo)
mkdir -p ~/.kube && sudo cp /etc/kubernetes/admin.conf ~/.kube/config
sudo chown "$USER" ~/.kube/config
kubectl get nodes && helm version

# agent (grab the current download URL from the pool's "New agent → Linux" page)
mkdir ~/azagent && cd ~/azagent
curl -LO https://download.agent.dev.azure.com/agent/4.255.0/vsts-agent-linux-x64-4.255.0.tar.gz
tar zxvf vsts-agent-linux-x64-*.tar.gz
./config.sh   # Server: https://dev.azure.com/<org> · PAT · pool: vbox-k8s
sudo ./svc.sh install && sudo ./svc.sh start
```
Verify: Agent pools → `vbox-k8s` shows the agent **Online**.

> If Docker was installed *after* the agent service started, restart the agent
> (`sudo ./svc.sh stop && sudo ./svc.sh start`) so it picks up the new `docker`
> group membership — otherwise the build stage hits "permission denied" on the
> Docker socket.

### 3.5 Variable group + pipeline

**1. Variable group** — Pipelines → Library → + Variable group. Name: `mern-app-dev`.

Variables (🔒 off):

| Variable | Value |
|---|---|
| `CR_SERVER` | Docker Hub username, e.g. `thientr18` |
| `INGRESS_HOST` | `mern-app.deploy` |

Secrets (🔒 on):

| Variable | Value |
|---|---|
| `DOCKERHUB_TOKEN` | Docker Hub PAT (Read & Write) |
| `JWT_SECRET` | the value used in §3.3 (e.g. output of `openssl rand -hex 24`) |
| `MONGO_URI` | `mongodb://mern-app-mongodb:27017/mern-app` |

> `DOCKERHUB_TOKEN` is used twice: **Build & push** logs in to push the private
> repo, and **Deploy** recreates the `regcred` pull Secret from it so the
> cluster can pull. Rotate the PAT here and the next deploy updates the cluster.
>
> `JWT_SECRET` / `MONGO_URI` feed the Helm-rendered `mern-app-secrets` Secret
> (§6.3) — rotate them here and the next deploy updates the cluster the same
> way. Rotating `JWT_SECRET` logs every user out (tokens no longer verify).

**2. Pipeline** — Pipelines → New pipeline → Azure Repos Git → `MERN-simple-app`
→ branch `side-branch` → Existing YAML → `/azure-pipelines.yml`. Run once manually
to authorize the pool + variable group. Every push to `main` / `side-branch` then
runs it. **Bring-up complete.**

---

## 4. Everyday workflow (the loop)

Once §3 is done, every change is a **single push to Azure Repos**:

```powershell
git add -A && git commit -m "describe what changed"
git push origin side-branch           # Azure Repos → triggers the pipeline
```

What then happens automatically, all in Azure DevOps:
1. **Security check** — backend `npm audit`, frontend lint + build.
2. **Build & push** — `backend-<sha>` / `frontend-<sha>` to the private Docker Hub repo.
3. **Deploy** — refresh the `regcred` pull Secret, then `helm upgrade` to the
   exact `<sha>` image on the `vbox-k8s` agent.
4. **You verify** (§5.1).

That's the whole loop: **push → security → build → deploy the exact image.**

> **Mirroring to GitHub is optional now.** GitHub Actions were removed, so
> `git push github side-branch:main` only updates a mirror; it no longer runs any
> CI. Skip it unless you want the mirror.

---

## 5. Operate — verify, rollback, troubleshoot

### 5.1 Health check

Confirm pods and image tag, then hit the health endpoint ([app.js](app.js) →
`GET /api/v1/health`):

```bash
kubectl get pods -n mern-app -o wide     # backend, frontend, mongodb → Running 1/1
helm history mern-app -n mern-app        # latest revision = deployed

# From the MASTER (which has no mern-app.deploy hosts entry): send the Host header
# the ingress routes on, and target any node IP directly.
curl -H 'Host: mern-app.deploy' http://192.168.100.231:<INGRESS_NODEPORT>/api/v1/health
# → {"status":"UP","message":"Server is healthy"}

# after §6.1 (MetalLB): same check, port-free, via the VIP
curl -H 'Host: mern-app.deploy' http://192.168.100.248/api/v1/health
```

> **From your Windows host** (which *does* have the hosts entry from §3.1) just use
> the name directly: `curl http://mern-app.deploy:<INGRESS_NODEPORT>/api/v1/health`, or
> open it in the browser.

Why the Host header? The ingress routes by hostname. If you `curl mern-app.deploy` on a
machine with no hosts entry you get `curl: (6) Could not resolve host: mern-app.deploy`
— that's a DNS failure on *your* side, **not** an unhealthy app. `-H 'Host: ...'`
lets you target the node IP while still presenting the hostname ingress expects.

### 5.2 Rollback

```bash
helm history mern-app -n mern-app                     # pick the last good REVISION
helm rollback mern-app <REVISION> -n mern-app --wait
```
Or re-run the pipeline manually against an older commit (that image is still on
Docker Hub). Note: rolling back to the revision that is already `deployed` is a
no-op that just creates an identical new revision.

### 5.3 Troubleshooting

| Symptom | Fix |
|---|---|
| `curl: (6) Could not resolve host: mern-app.deploy` on the master | Expected — the master has no hosts entry. Use `curl -H 'Host: mern-app.deploy' http://192.168.100.231:<INGRESS_NODEPORT>/api/v1/health` (§5.1). **Not** an app failure. |
| Pipeline "waiting for agent" | agent offline (`sudo ./svc.sh status`) or pool name ≠ `vbox-k8s` |
| Build stage: `docker: command not found` (exit 127) | Docker not installed on the agent — `sudo apt-get install -y docker.io`, then **restart the agent** (§3.4) |
| Build stage: `permission denied … /var/run/docker.sock` | agent user not in the `docker` group, or agent started before Docker install — add the user and restart the agent (§3.4) |
| Build stage: auth / `denied: requested access` | `DOCKERHUB_TOKEN` wrong/expired, or `CR_SERVER` ≠ your Docker Hub username |
| Deploy stage: "JWT_SECRET is missing" / helm `secrets.jwtSecret is required` | add `JWT_SECRET` + `MONGO_URI` as **secret** variables to `mern-app-dev` (§3.5) — the chart renders the Secret from them (§6.3) |
| `ImagePullBackOff` | image tag not on Docker Hub, or `regcred` stale/missing (pull error says `unauthorized`). The Deploy stage recreates `regcred` each run — re-run the pipeline with a valid `DOCKERHUB_TOKEN`, or recreate it by hand (§3.1). Check with `kubectl describe pod <pod> -n mern-app` |
| backend `CrashLoopBackOff` | `kubectl logs -n mern-app deploy/mern-app-backend` — usually a bad `MONGO_URI` |
| `http://mern-app.deploy:<port>` unreachable | wrong NodePort/IP, hosts entry missing, or ingress-nginx pods not Running |
| VIP URL works from one machine, 404/hangs from another | ARP conflict — another LAN device owns the VIP. Compare `arp -a` / `ip neigh show <VIP>` MACs against the nodes' `08:00:27:*`; foreign MAC → move the VIP (§6.1 notes) |
| 404 from nginx on a URL that should exist | Host header ≠ the ingress rule's host — `kubectl get ingress -n mern-app` and make browser URL / hosts entry / `INGRESS_HOST` all match |
| Deploy stage: unreplaced-tokens error | a variable is missing from `mern-app-dev` (`CR_SERVER` / `INGRESS_HOST`) |
| Mongo data lost after reschedule | fixed in §6.2 (PVC) — if it still happens, `kubectl get pvc -n mern-app` must show `Bound`, and the mongo deployment must mount it (not an `emptyDir`) |
| Mongo PVC stuck `Pending` | no StorageClass — install the local-path provisioner (§6.2, step 1) |

Debug order: pipeline log → `kubectl get pods -n mern-app` →
`kubectl describe pod <pod> -n mern-app` → `kubectl logs <pod> -n mern-app`.

---

## 6. Hardening roadmap

- **Persistent Mongo:** done in §6.2 — local-path provisioner + PVC. For real
  HA, move to MongoDB Atlas instead (`mongodb.enabled: false`, repoint
  `MONGO_URI` in the Secret).
- **TLS:** install cert-manager, set `ingress.tlsSecret` + `ingress.clusterIssuer`.
- **Clean host access:** install MetalLB so ingress-nginx gets a real LB IP and
  the `:<NodePort>` disappears from the URL — full flow in §6.1 below.
- **Prod environment:** scope config per environment — keep `mern-app-dev` for
  dev and add a `mern-app-prod` variable group (same keys, prod values), selected
  by stage. Gate the prod Deploy behind an Azure DevOps *Environment* with a
  required-approval check, so a human signs off before it ships.
- **Image scanning:** add a Trivy step to the Security stage to fail on
  HIGH/CRITICAL CVEs in the built images.
- **Least-privilege pull token:** `regcred` currently reuses the Read & Write
  `DOCKERHUB_TOKEN`. Issue a second, **Read-only** Docker Hub PAT, add it to the
  variable group (e.g. `DOCKERHUB_PULL_TOKEN`), and point the Deploy stage's
  regcred step at it — the cluster then holds a credential that can't push.

### 6.1 Drop the port with MetalLB

Goal: `http://mern-app.deploy:<INGRESS_NODEPORT>` → `http://mern-app.deploy/` (or any domain
you like) with **no port** in the URL. The port exists only because a bare-metal
cluster has no cloud LoadBalancer, so ingress-nginx falls back to a NodePort
(30000–32767). Browsers default to port **80**, so losing the port means giving
ingress-nginx its own IP that answers on 80. That is what MetalLB does: it
claims a spare IP on the node subnet (a "VIP") via ARP and steers that traffic
to the ingress controller.

```mermaid
flowchart LR
    B["browser<br/>http://mern-app.deploy/"] -->|"hosts file:<br/>mern-app.deploy → 192.168.100.248"| V["MetalLB VIP<br/>192.168.100.248:80"]
    V --> C["ingress-nginx<br/>(now LoadBalancer)"]
    C -->|"Host: mern-app.deploy"| R["ingress rules"]
    R --> FE["frontend svc  /"]
    R --> BE["backend svc  /api"]
```

Run on the **master**.

**1. Install MetalLB** (skip if already installed):
```bash
kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.14.9/config/manifests/metallb-native.yaml
kubectl -n metallb-system wait --for=condition=Ready pod --all --timeout=120s
```
> Only if kube-proxy runs in **IPVS** mode: set `strictARP: true` in the
> kube-proxy ConfigMap first. The kubeadm default is iptables — nothing to do.

**2. Give MetalLB a pool of spare IPs** on the node subnet
(`192.168.100.0/24`, same L2 as the nodes' `enp0s3`). The addresses must be
genuinely free: outside the router's DHCP scope, not in any other machine's
LB pool (another k8s cluster on the LAN!), and silent when pinged **from both
the master and your Windows host** (`ping 192.168.100.248` → no reply on
either). A reply from *anywhere* means the IP is taken — pick another. This
LAN's `.240` turned out to be owned by another device, which is why the pool
starts at `.245`:
```bash
kubectl apply -f - <<'EOF'
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: vbox-pool
  namespace: metallb-system
spec:
  addresses:
    - 192.168.100.245-192.168.100.250
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: vbox-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - vbox-pool
EOF
```

**3. Promote ingress-nginx from NodePort to LoadBalancer**, pinning the VIP so
it never changes:
```bash
kubectl -n ingress-nginx annotate svc ingress-nginx-controller \
  metallb.universe.tf/loadBalancerIPs=192.168.100.248
kubectl -n ingress-nginx patch svc ingress-nginx-controller \
  -p '{"spec":{"type":"LoadBalancer"}}'
kubectl -n ingress-nginx get svc ingress-nginx-controller
# EXTERNAL-IP must show 192.168.100.248 — if it stays <pending>, the
# IPAddressPool / L2Advertisement from step 2 is wrong
```

**4. Point the app at the new domain** — the usual hostname flow: set
`INGRESS_HOST` in the `mern-app-dev` variable group (§3.5) to `mern-app.deploy` and
re-run the pipeline (or re-render + `helm upgrade` by hand as in §3.3). No
chart change needed — the ingress simply routes the new Host header.

**5. Hosts entry on the Windows host** — point the domain at the **VIP**, not
at a node IP as before:
```
192.168.100.248  mern-app.deploy
```

**Verify** (port 80 is implied everywhere now):
```bash
# from the master (no hosts entry → send the Host header):
curl -H 'Host: mern-app.deploy' http://192.168.100.248/api/v1/health
```
From the Windows host: `http://mern-app.deploy/` → SPA,
`http://mern-app.deploy/api/v1/health` → `{"status":"UP",...}`.

Notes:
- The old `:<NodePort>` URL keeps working — `LoadBalancer` is a superset of
  `NodePort`; the node ports stay allocated.
- **IP-conflict symptom** (learned the hard way): the app works from one
  machine but another gets 404s or hangs on the *same* VIP URL → two devices
  are answering ARP for the VIP. Check `arp -a` (Windows) / `ip neigh show
  <VIP>` (Linux) on both — the MAC must be one of the VirtualBox nodes
  (`08:00:27:*`) and identical everywhere. A foreign MAC = conflict: move the
  VIP to a free address (re-annotate, update hosts file). The NodePort URL
  (`node-ip:30080`) bypasses the VIP, so it's the quickest way to prove the
  cluster itself is healthy while ARP is being fought over.
- `mern-app.deploy` only resolves on machines with the hosts entry. In this
  VirtualBox lab the hosts file *is* your DNS; a real public domain would need
  a registrar + an A record to a routable IP instead.
- HTTPS later: cert-manager + `ingress.tlsSecret` (roadmap above). With the LB
  also owning 443, `https://mern-app.deploy/` is port-free too.

### 6.2 Persist MongoDB with a PVC

Why data used to vanish: Mongo's volume was an `emptyDir` — scratch space that
lives and dies with the pod. Any pod recreation (node reboot, eviction, spec
change) started Mongo from an empty directory. The fix has two halves: the
**cluster** needs a storage provisioner (kubeadm ships none, so a bare PVC
would sit `Pending` forever), and the **chart** needs to request a PVC instead
of an `emptyDir` (done: `templates/pvc.yaml` + `mongodb.persistence` in
`values.tokenized.yaml`).

**1. Install the local-path provisioner** — one-time, on the master:
```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.31/deploy/local-path-storage.yaml
kubectl get storageclass    # "local-path" must appear
```

**2. Deploy** — the chart change rides the normal pipeline: push → deploy.
The Deploy stage creates the PVC `mern-app-mongodb-data` (2Gi) once; every
later deploy reuses it. It carries `helm.sh/resource-policy: keep`, so even
`helm uninstall` leaves the data alone.

**3. Verify — kill the pod, data must survive:**
```bash
kubectl get pvc -n mern-app          # STATUS must be Bound
# register a user in the app, then force a mongo pod restart:
kubectl delete pod -n mern-app -l app.kubernetes.io/component=mongodb
kubectl get pods -n mern-app -w      # wait for the new mongodb pod Running
# → log in again in the browser: the user is still there
```

Caveats (lab-grade persistence, not HA):
- local-path stores the data **on one node's disk** (under
  `/opt/local-path-provisioner`, on whichever node the pod first schedules).
  The pod is pinned there from then on; if that node dies, the data is
  stranded on it. Real HA = MongoDB Atlas or networked storage.
- Mongo now uses `strategy: Recreate` — a ReadWriteOnce volume can't be
  mounted by the old and new pod at once during a rolling update.
- To wipe the data on purpose: `kubectl delete pvc mern-app-mongodb-data -n mern-app`
  (the PVC survives `helm uninstall` by design).

### 6.3 App secrets from the variable group (Helm-rendered Secret)

Before, `mern-app-secrets` was created **by hand** (`kubectl create secret`,
old §3.1) — invisible to the pipeline, easy to forget on a fresh cluster, and
rotation was a manual kubectl exercise. Now the chart owns it, and the values
live in the `mern-app-dev` variable group next to `DOCKERHUB_TOKEN`.

The Helm concepts in play:

- **Template** — `templates/secret.yaml` renders a `Secret` when
  `secrets.create` is true, `b64enc`-encoding the values.
- **Guard** — `required "…" $s.jwtSecret` makes the deploy **fail loudly** if a
  value wasn't injected, instead of silently creating an empty Secret and
  letting the backend crash-loop.
- **Injection** — the pipeline maps the secret variables into env vars and
  passes them with `--set-file secrets.jwtSecret=<(printf '%s' "$JWT_SECRET")`.
  `--set-file` takes the value verbatim (no `--set` comma/quote parsing), the
  process substitution never touches disk, and the value never appears on the
  command line or in the log.
- **Scoping** — `values.local.yaml` sets `secrets.create: false`, so the local
  flow keeps its hand-made Secret and helm won't overwrite it.

The flow end to end:

```mermaid
flowchart LR
    VG["mern-app-dev variable group<br/>JWT_SECRET · MONGO_URI (secret)"] -->|"env-mapped in Deploy"| H["helm upgrade<br/>--set-file secrets.*"]
    H --> T["templates/secret.yaml<br/>(required + b64enc)"]
    T --> S[("k8s Secret<br/>mern-app-secrets")]
    S -->|"secretKeyRef"| B["backend pod env"]
```

Rotation = edit the value in the variable group → run the pipeline. Same
lifecycle as `regcred`, no kubectl needed.

Caveats:
- Helm stores deploy-time values (secrets included, base64) in its **release
  Secret** in-cluster (`sh.helm.release.v1.mern-app.vN`). Same trust domain as
  the app Secret itself, so nothing is *more* exposed — but anyone with read
  access to Secrets in the namespace sees both.
- Rotating `JWT_SECRET` invalidates all issued tokens — every user logs in again.
- The backend only reads env vars at startup; the pipeline redeploys with a new
  image tag each commit so pods restart anyway, but a *variable-only* rotation
  needs a pod restart to take effect (`kubectl rollout restart deploy/mern-app-backend -n mern-app`
  after the deploy, if the image tag didn't change).

---

## 7. File map

| File | Role |
|---|---|
| `azure-pipelines.yml` | The full CI/CD pipeline: Security → Build & push → Deploy |
| `k8s-helm/mern-app/values.tokenized.yaml` | Deploy values (tokens filled by the pipeline) |
| `k8s-helm/mern-app/values.local.yaml` | optional single-node local testing |
| `k8s-helm/mern-app/` | chart: backend + frontend + mongodb + ingress + PVC (§6.2) + app Secret (§6.3) |
