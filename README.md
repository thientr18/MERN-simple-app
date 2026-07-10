# MERN App — Full CI/CD on Azure DevOps to a VirtualBox Kubernetes Cluster

This repo ships a MERN app (React + Express + MongoDB) to a self-hosted
Kubernetes cluster running in VirtualBox. **One Azure DevOps pipeline does the
whole job** — security check, build & push images, then deploy — all on a
self-hosted agent that lives *inside* the cluster network.

- **CI/CD — Azure DevOps** (self-hosted agent on the cluster master), one
  pipeline, three gated stages:
  1. **Security check** — backend `npm audit`, frontend lint + build.
  2. **Build & push** — build backend + frontend images, push to Docker Hub
     tagged `backend-<sha>` / `frontend-<sha>`.
  3. **Deploy** — `helm upgrade` with the exact `<sha>` just built. Runs only if
     the first two stages pass.
- **No secrets in git** — the Docker token is a secret variable in the ADO variable
  group; app secrets live in a k8s Secret (see **Config & secrets** below).

```mermaid
flowchart LR
    P["push → Azure Repos"] --> S["Stage 1<br/>Security check"]
    S -->|ok| B["Stage 2 · Build & push<br/>backend-&lt;sha&gt; / frontend-&lt;sha&gt;"]
    B -->|ok| D["Stage 3<br/>helm upgrade (sha)"]
    B --> H[("Docker Hub")]
    H -. pull .-> K["vbox cluster"]
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
ingress host `mern.local`, image repo `<DOCKERHUB_USERNAME>/web-app-mern`. The
ingress is exposed as a **NodePort** (bare-metal cluster, no cloud LB) — that port
is written as `<INGRESS_NODEPORT>` below (e.g. `32652`) and is reachable on **any**
node IP.

---

## 2. Prerequisites

- [ ] kubeadm cluster up; `kubectl get nodes` shows all 3 `Ready`.
- [ ] On the master (the agent host): `helm` v3, `kubectl`, **and Docker** — the
      agent now builds images too, so a working Docker daemon is required.
- [ ] Azure DevOps org + project (free tier is fine) with this repo in Azure Repos.
- [ ] A public Docker Hub repo `web-app-mern` (or make it private + add an
      `imagePullSecret`, see [Troubleshooting](#troubleshooting)).
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

**Namespace + app Secret** (holds `JWT_SECRET` and `MONGO_URI`):
```bash
kubectl create namespace mern-app
kubectl create secret generic mern-app-secrets -n mern-app \
  --from-literal=JWT_SECRET="$(openssl rand -hex 24)" \
  --from-literal=MONGO_URI='mongodb://mern-app-mongodb:27017/mern-app'
```

**Hosts entry** on your **Windows host** (`C:\Windows\System32\drivers\etc\hosts`,
as admin) so the browser resolves the app to a node:
```
192.168.100.231  mern.local
```
The app URL is then `http://mern.local:<INGRESS_NODEPORT>`.

> The master itself has **no** such entry — that's expected. When you `curl` the
> health endpoint from the master, use the Host-header form in §5.1, not the
> `mern.local` name.

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

Confirm both tags appear on Docker Hub. Note the `<sha>` — that's the tag you
deploy next. (This is exactly what the pipeline's **Build & push** stage
automates later.)

### 3.3 Manual Helm deploy — prove it by hand ⛔ (gate)

Before automating anything, deploy once by hand using the **same values file the
pipeline uses**, just rendered locally. On the master:

```bash
# render the tokenized values (exactly what the Deploy stage does)
sed -e "s|__crServer__|<DOCKERHUB_USERNAME>|g" \
    -e "s|__IMAGE_TAG__|<sha>|g" \
    -e "s|__ingressHost__|mern.local|g" \
    k8s-helm/mern-app/values.tokenized.yaml > /tmp/values.yaml

helm upgrade --install mern-app k8s-helm/mern-app \
  -n mern-app -f /tmp/values.yaml --wait --timeout 5m
```

Verify (see §5.1 for the health check), then open
`http://mern.local:<INGRESS_NODEPORT>` from your Windows host → register → login →
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
| `INGRESS_HOST` | `mern.local` |

Secrets (🔒 on):

| Variable | Value |
|---|---|
| `DOCKERHUB_TOKEN` | Docker Hub PAT (Read & Write) |

> App secrets `JWT_SECRET` / `MONGO_URI` are not here — they live in the k8s Secret
> `mern-app-secrets` (§3.1).

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
2. **Build & push** — `backend-<sha>` / `frontend-<sha>` to Docker Hub.
3. **Deploy** — `helm upgrade` to the exact `<sha>` image on the `vbox-k8s` agent.
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

# From the MASTER (which has no mern.local hosts entry): send the Host header
# the ingress routes on, and target any node IP directly.
curl -H 'Host: mern.local' http://192.168.100.231:<INGRESS_NODEPORT>/api/v1/health
# → {"status":"UP","message":"Server is healthy"}
```

> **From your Windows host** (which *does* have the hosts entry from §3.1) just use
> the name directly: `curl http://mern.local:<INGRESS_NODEPORT>/api/v1/health`, or
> open it in the browser.

Why the Host header? The ingress routes by hostname. If you `curl mern.local` on a
machine with no hosts entry you get `curl: (6) Could not resolve host: mern.local`
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
| `curl: (6) Could not resolve host: mern.local` on the master | Expected — the master has no hosts entry. Use `curl -H 'Host: mern.local' http://192.168.100.231:<INGRESS_NODEPORT>/api/v1/health` (§5.1). **Not** an app failure. |
| Pipeline "waiting for agent" | agent offline (`sudo ./svc.sh status`) or pool name ≠ `vbox-k8s` |
| Build stage: `permission denied … /var/run/docker.sock` | agent user not in the `docker` group, or agent started before Docker install — add the user and restart the agent (§3.4) |
| Build stage: auth / `denied: requested access` | `DOCKERHUB_TOKEN` wrong/expired, or `CR_SERVER` ≠ your Docker Hub username |
| Deploy stage: "Secret mern-app-secrets missing" | run §3.1 (create the Secret) before deploying |
| `ImagePullBackOff` | image tag not on Docker Hub, or private repo without an `imagePullSecret` (`kubectl create secret docker-registry regcred -n mern-app --docker-username=... --docker-password=...`, then set `backend.imagePullSecrets` / `frontend.imagePullSecrets`) |
| backend `CrashLoopBackOff` | `kubectl logs -n mern-app deploy/mern-app-backend` — usually a bad `MONGO_URI` |
| `http://mern.local:<port>` unreachable | wrong NodePort/IP, hosts entry missing, or ingress-nginx pods not Running |
| Deploy stage: unreplaced-tokens error | a variable is missing from `mern-app-dev` (`CR_SERVER` / `INGRESS_HOST`) |
| Mongo data lost after reschedule | `emptyDir` is ephemeral — use a PVC or external Mongo/Atlas |

Debug order: pipeline log → `kubectl get pods -n mern-app` →
`kubectl describe pod <pod> -n mern-app` → `kubectl logs <pod> -n mern-app`.

---

## 6. Hardening roadmap

- **Persistent Mongo:** replace the `emptyDir` in `values.tokenized.yaml` with a
  PersistentVolumeClaim, or point `MONGO_URI` at MongoDB Atlas.
- **TLS:** install cert-manager, set `ingress.tlsSecret` + `ingress.clusterIssuer`.
- **Clean host access:** install MetalLB with a pool in `192.168.100.0/24` so
  ingress-nginx gets a real LB IP and you can drop the `:<NodePort>`.
- **Prod environment:** scope config per environment — keep `mern-app-dev` for
  dev and add a `mern-app-prod` variable group (same keys, prod values), selected
  by stage. Gate the prod Deploy behind an Azure DevOps *Environment* with a
  required-approval check, so a human signs off before it ships.
- **Image scanning:** add a Trivy step to the Security stage to fail on
  HIGH/CRITICAL CVEs in the built images.

---

## 7. File map

| File | Role |
|---|---|
| `azure-pipelines.yml` | The full CI/CD pipeline: Security → Build & push → Deploy |
| `k8s-helm/mern-app/values.tokenized.yaml` | Deploy values (tokens filled by the pipeline) |
| `k8s-helm/mern-app/values.local.yaml` | optional single-node local testing |
| `k8s-helm/mern-app/` | chart: backend + frontend + mongodb + ingress |
