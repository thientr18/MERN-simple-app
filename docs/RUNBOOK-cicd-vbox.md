# Runbook — MERN App CI/CD on VirtualBox k8s (Azure DevOps self-hosted agent)

**Use this runbook to:** stand up, operate, and troubleshoot the CI/CD pipeline that
builds the MERN app's Docker images and deploys them with Helm onto a Kubernetes
cluster running inside VirtualBox VMs, driven by an Azure DevOps self-hosted agent.

**Audience:** you (DevOps), on a Windows host with VirtualBox, Docker, Helm, kubectl.

---

## 1. The big picture

```
                 GitHub (this repo)
                        │
        push to main    │  (webhook / poll)
                        ▼
      ┌────────────────────────────────────┐
      │ Azure DevOps (cloud, free tier OK) │
      │  pipeline: pipelines.deployment.   │
      │            mern-app.yaml           │
      └───────────────┬────────────────────┘
                      │ job is dispatched to the agent POOL "vbox-k8s"
                      ▼
   ┌──────────────────────────────────────────────────┐
   │ VirtualBox VM (Linux)                            │
   │  • Azure DevOps SELF-HOSTED AGENT (systemd svc)  │
   │  • docker  → builds backend + frontend images    │
   │  •         → pushes to Docker Hub / registry     │
   │  • sed     → replaces tokens in values.tokenized │
   │  • helm    → upgrade --install into the cluster  │
   │  • kubectl → kubeconfig points at vbox cluster   │
   └───────────────────────┬──────────────────────────┘
                           ▼
   ┌──────────────────────────────────────────────────┐
   │ k8s cluster (VirtualBox VMs)          ns: mern-app│
   │  Ingress (nginx)  host: <INGRESS_HOST>           │
   │    /api  ──► svc mern-app-backend :80 → pod :4000│
   │    /     ──► svc mern-app-frontend:80 → pod :80  │
   │  svc mern-app-mongodb :27017 (in-cluster Mongo)  │
   └──────────────────────────────────────────────────┘
```

Why a **self-hosted** agent? The vbox cluster lives on your private network.
Microsoft-hosted agents (and GitHub-hosted runners) cannot reach it. The agent
runs *inside* your network, polls Azure DevOps over HTTPS (outbound only — no
inbound firewall holes), and executes the pipeline steps locally where
`kubectl`/`helm` can see the cluster.

### How this repo's pieces fit

| Piece | Role |
|---|---|
| `.github/workflows/01-security_check.yml` | CI: `npm audit` (backend) + lint/build (frontend) on push/PR to main |
| `.github/workflows/02-build-push-docker.yml` | CI: builds `web-app-mern:backend-<sha>` / `frontend-<sha>` → Docker Hub |
| ~~`03-sync-cd-image-tags.yml`~~ | **removed** — previous developer's GitOps flow: it PR'd image tags into *his* CD repo (`rizy44/MERN-cd-pipeline`) for *his* ArgoCD, using a PAT we don't have. Our CD is the Helm deploy below. |
| `k8s-helm/mern-app/` | Helm chart: backend + frontend + mongodb + ingress |
| `k8s-helm/mern-app/values.tokenized.yaml` | CD source of truth; tokens filled in by the ADO pipeline |
| `k8s-helm/mern-app/values.local.yaml` | Complete, token-free values for manual local testing |
| `azure-pipelines/pipelines.deployment.mern-app.yaml` | The vbox CI/CD: build images → token replace → helm upgrade |
| `RUNBOOK-cicd-vbox.md` | this file |

The GitHub workflows stay as GitHub-side CI (they run fine on GitHub's runners
because they never touch your cluster). The **Azure pipeline is the path to the
vbox cluster** and does its own image build so image tags line up with
`$(Build.BuildId)` — the same trick MoniAgent used (`tag: BuildID`).

---

## 2. How the CD flow works (template → MERN)

### 2.1 The MoniAgent template flow, decoded

MoniAgent's `pipelines.deployment.moni-agent.yaml` was only a *stub* that
extended a shared template (`DevOps/Pipeline_Templates` repo) with parameters
(`ServiceName`, `ImageName`, `DockerfilePath`, `isDeployAks`, …). That hidden
template did, in order:

1. **Build stage** — `docker build` the service, tag with `$(Build.BuildId)`, push to a registry (`__crServer__`).
2. **Deploy stage** — take `values.tokenized.yaml`, replace tokens:
   - `__crServer__` → registry address
   - `BuildID` → the build id (this is how the *new* image reaches the cluster)
   - `__SECRET_X__` → secret values pulled from an ADO **variable group** (`MoniAgent-<env>`)
3. `helm upgrade --install` the chart with the generated values into AKS.

**Key idea to internalize:** the chart templates never change per release —
*only the values file does*, and the only values that change per release are
the image tag (BuildID) and secrets. Everything non-secret is committed in
`values.tokenized.yaml`; everything secret stays a `__TOKEN__` filled at deploy
time. That is exactly the flow reproduced for MERN, minus AKS/service
connections (replaced by a self-hosted agent with direct kubeconfig access).

### 2.2 Values mapping: MoniAgent → MERN app

| MoniAgent value | MERN app value | Why |
|---|---|---|
| single component `moni-agent` | `backend`, `frontend`, `mongodb` components | MERN = 3 deployables; chart helpers were already generic (component name → config) |
| `image: __crServer__/moni-agent:BuildID` | `__crServer__/web-app-mern:backend-BuildID` and `:frontend-BuildID` | keeps the single-repo + prefixed-tag convention of `.github/workflows/02` |
| `service: 80 → 8000` | backend `80 → 4000`, frontend `80 → 80`, mongo `27017` | `app.js` listens on `PORT` (default 4000); frontend nginx on 80 |
| probes `GET /health :8000` | backend `GET /api/v1/health :4000`, frontend `GET / :80`, mongo `tcpSocket 27017` | actual health endpoint in `app.js:19` |
| `ingress: moni-agent.wecopytrade.com` + TLS | single host `__ingressHost__`, **path routing**: `/api`→backend, `/`→frontend, TLS optional | the SPA calls the API with *relative* `/api/v1/...` URLs (see `client/src/pages/Login.jsx`), so both must share one host |
| env: Prometheus/Azure/Anthropic config + `__SECRET__` tokens | env: `PORT` (plain) + `__MONGO_URI__`, `__JWT_SECRET__` (tokens) | the only env `app.js` / `middleware/auth.js` read |
| variable group `MoniAgent-<env>` | variable group `mern-app-dev` | same pattern, new name |
| `ServiceConnection: LFGLOBALTECH-...` (AKS) | *(none)* — self-hosted agent uses local kubeconfig | no cloud API to authenticate against |
| cert-manager `letsencrypt-prod` hardcoded | `clusterIssuer` optional, off by default | vbox cluster typically has no cert-manager |
| `moni-agent-alert` / `-daily` cronjob charts | *(dropped)* | MERN app has no cronjobs |

Chart mechanics kept identical: `values.tokenized.yaml` naming, component-keyed
values, `_helpers.tpl` label scheme, generic deployment helper (extended only
with `volumes`/`volumeMounts` for Mongo's data dir).

---

## 3. Prerequisites

- [ ] Windows host with VirtualBox; a Linux VM (Ubuntu 22.04/24.04 recommended, 2 vCPU / 4 GB+ / 40 GB disk)
- [ ] A k8s cluster on vbox VM(s) — kubeadm, k3s, or minikube inside the VM all work
- [ ] **ingress-nginx** installed in the cluster (required for end-to-end app access)
- [ ] Docker Hub account (or a private registry reachable from the cluster)
- [ ] Azure DevOps organization (free tier: 1 self-hosted agent job is free) — https://dev.azure.com
- [ ] This repo pushed to **your own GitHub** (see §3.1)

### 3.1 Push this repo to your own GitHub

Why: the `.github/workflows/*` files only ever run on **GitHub** — Azure DevOps
completely ignores that folder, which is why you can't see them in the ADO repo.
`origin` here points at the company ADO repo
(`dev.azure.com/lfglobaltech/DevOps/_git/MERN-simple-app`, branch `side-branch`)
where your permissions are limited; your own GitHub repo is where GitHub Actions
run AND what your own ADO pipeline (§6.2) points at.

```powershell
# 1. Create an EMPTY repo on github.com (no README/license), e.g. MERN-simple-app

# 2. Add it as a second remote (origin stays = company ADO)
git remote add github https://github.com/<your-user>/MERN-simple-app.git

# 3. Publish your local side-branch AS main on your GitHub — main only,
#    that's what workflows 01/02 and the ADO pipeline trigger on.
#    (No -u: plain `git push` keeps going to the company ADO repo.)
git push github side-branch:main
```

Treat GitHub `main` as a push-only mirror — never commit on github.com
directly, or the next push will be rejected until you `git pull github main`.

Git Credential Manager (bundled with Git for Windows) pops up a browser login
on first push — no PAT needed.

Then give the workflows *your* Docker Hub credentials, otherwise workflow 02
fails at "Validate Docker Hub secrets": GitHub repo → **Settings → Secrets and
variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `DOCKERHUB_USERNAME` | your Docker Hub username |
| `DOCKERHUB_TOKEN` | Docker Hub → Account Settings → Personal access tokens (Read & Write) |

(The jobs reference `environment: ENV`; GitHub auto-creates it on first run,
and repository-level secrets are visible to it — nothing else to configure.)

**Verify:** GitHub repo → **Actions** tab → "Security Check" runs on the main
push, then "Build and Push Images" follows it and pushes
`<you>/web-app-mern:backend-<sha>` / `:frontend-<sha>` to Docker Hub.

Day-to-day: commit on `side-branch`, then
`git push origin side-branch` (company ADO) and
`git push github side-branch:main` (your GitHub, triggers Actions).
Full two-remote reference: [docs/git-push-workflow.md](docs/git-push-workflow.md).

**VM networking:** give the VM a **Bridged** or **Host-only + NAT** adapter so
that (a) the VM has outbound internet (to poll Azure DevOps and pull images),
and (b) your Windows host can reach the VM's IP (to open the app). Note the
VM/node IP — referred to below as `<NODE_IP>` (e.g. `192.168.56.10`).

---

## 4. Phase 1 — Manual local Helm test (do this BEFORE any CI/CD)

Goal: prove chart + images + routing work, deployed by hand. Run these on
whatever machine has docker + kubectl + helm pointed at your **test** cluster
(the vbox cluster, or minikube/kind/Docker Desktop locally).

> ⚠️ Check you're on the right cluster first: `kubectl config current-context`.
> If it shows some other/cloud cluster, switch:
> `kubectl config use-context <your-vbox-context>`.

### 4.1 Build the images locally

```bash
cd MERN-simple-app
docker build -t web-app-mern:backend-local .
docker build -t web-app-mern:frontend-local ./client
```

### 4.2 Get the images onto the cluster nodes

`values.local.yaml` uses `pullPolicy: Never`, so the image must already exist
on the node. Pick your row:

| Cluster type | Command |
|---|---|
| minikube | `minikube image load web-app-mern:backend-local` (and frontend) |
| kind | `kind load docker-image web-app-mern:backend-local` |
| k3s in the VM | `docker save web-app-mern:backend-local \| ssh <vm> "sudo k3s ctr images import -"` |
| kubeadm + containerd in the VM | `docker save web-app-mern:backend-local \| ssh <vm> "sudo ctr -n k8s.io images import -"` |
| Docker Desktop k8s | nothing — it shares the docker image store |

(Repeat for `frontend-local`. Multi-node cluster → load on **every** node, or
skip this and push to Docker Hub + edit `values.local.yaml` repository/pullPolicy.)

### 4.3 Lint, render, install

```bash
helm lint  k8s-helm/mern-app -f k8s-helm/mern-app/values.local.yaml
helm template mern-app k8s-helm/mern-app -f k8s-helm/mern-app/values.local.yaml | less   # eyeball it

helm upgrade --install mern-app k8s-helm/mern-app \
  --namespace mern-app --create-namespace \
  -f k8s-helm/mern-app/values.local.yaml \
  --wait --timeout 5m
```

### 4.4 Verify

```bash
kubectl get pods,svc,ingress -n mern-app
# expect: mern-app-backend, mern-app-frontend, mern-app-mongodb pods Running & READY 1/1

# API smoke test (no ingress needed):
kubectl port-forward -n mern-app svc/mern-app-backend 4000:80 &
curl http://localhost:4000/api/v1/health
# → {"status":"UP","message":"Server is healthy"}
```

Full end-to-end through ingress (the SPA needs `/api` routed to the backend —
NodePort alone will NOT work for login/register):

1. Add to your hosts file (`C:\Windows\System32\drivers\etc\hosts` as admin):
   `<NODE_IP>  mern.local` — e.g. `192.168.56.10  mern.local`
   (minikube: use `minikube ip`; if the ingress controller is a NodePort
   service, browse to `http://mern.local:<ingress-nodeport>` instead)
2. Open `http://mern.local` → register a user → log in → dashboard loads.
   That proves frontend → ingress → backend → MongoDB round trip.

### 4.5 Clean up (optional)

```bash
helm uninstall mern-app -n mern-app
kubectl delete ns mern-app
```

**Gate: do not proceed to CI/CD until 4.4 passes.**

---

## 5. Phase 2 — Install the Azure DevOps self-hosted agent in the VM

The agent is "the scripts that automatically run the pipeline" — a small
service that polls Azure DevOps for jobs and runs them on the VM.

### 5.1 Azure DevOps side

1. Create org + project at https://dev.azure.com (e.g. project `MERN-simple-app`).
2. **Agent pool:** Project settings → Agent pools → *Add pool* → Self-hosted →
   name it exactly **`vbox-k8s`** (the pipeline's `AgentPool` parameter default).
3. **PAT for registration:** User settings (top-right) → Personal access tokens →
   New Token → Scope: **Agent Pools (Read & manage)** → copy it (shown once).

### 5.2 VM side — install prerequisites

```bash
# docker
sudo apt-get update && sudo apt-get install -y docker.io git curl
sudo usermod -aG docker $USER && newgrp docker

# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install kubectl /usr/local/bin/

# helm
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# kubeconfig for the agent user — MUST work non-interactively
mkdir -p ~/.kube && cp <your-cluster-admin-kubeconfig> ~/.kube/config
# k3s: sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/config  (fix server IP if needed)
kubectl get nodes   # sanity check
```

### 5.3 VM side — install & register the agent

```bash
mkdir -p ~/azagent && cd ~/azagent
# get the latest Linux x64 agent URL from:
# Project settings → Agent pools → vbox-k8s → New agent → Linux
curl -LO https://download.agent.dev.azure.com/agent/4.255.0/vsts-agent-linux-x64-4.255.0.tar.gz
tar zxvf vsts-agent-linux-x64-*.tar.gz

./config.sh
#   Server URL:   https://dev.azure.com/<your-org>
#   Auth type:    PAT           → paste the PAT from 5.1
#   Agent pool:   vbox-k8s
#   Agent name:   vbox-agent-01 (anything)
#   Work folder:  _work         (default)

# run as a systemd service so it survives reboots
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

**Verify:** Agent pools → vbox-k8s → agent shows **Online**. Then check the
agent user can do everything the pipeline needs:

```bash
docker ps && kubectl get nodes && helm version   # all must succeed WITHOUT sudo
```

---

## 6. Phase 3 — Wire up the pipeline

### 6.1 Variable group (the secrets store)

Pipelines → Library → **+ Variable group** → name **`mern-app-dev`**
(referenced by `variables: - group: mern-app-dev` in the pipeline):

| Variable | Example | Secret? |
|---|---|---|
| `CR_SERVER` | `thientran03` (Docker Hub user) or `192.168.56.10:5000` | no |
| `CR_USERNAME` | `thientran03` | no |
| `CR_PASSWORD` | Docker Hub access token | **yes** (padlock) |
| `INGRESS_HOST` | `mern.local` | no |
| `MONGO_URI` | `mongodb://mern-app-mongodb:27017/mern-app` (in-cluster) or an Atlas URI | **yes** |
| `JWT_SECRET` | long random string | **yes** |

> `MONGO_URI` for in-cluster Mongo: service name = `<release>-mongodb`, so with
> release `mern-app` it's `mongodb://mern-app-mongodb:27017/mern-app`.

### 6.2 Create the pipeline

1. Pipelines → New pipeline → **GitHub** → select **your own GitHub repo**
   from §3.1 (authorize the Azure Pipelines GitHub App when prompted). Don't
   point it at the company ADO repo — your permissions there are limited.
2. *Existing Azure Pipelines YAML file* → branch + path:
   `azure-pipelines/pipelines.deployment.mern-app.yaml`.
3. First run: grant the pipeline permission to use the `vbox-k8s` pool and the
   `mern-app-dev` variable group when the run asks (one-time approval banners).

### 6.3 What a run does (read along in the YAML)

| Stage | Step | What happens on the VM |
|---|---|---|
| Build | Docker login | `docker login` to Docker Hub (or private registry, auto-detected from `CR_SERVER`) |
| Build | Build & push backend | `docker build -f Dockerfile .` → `CR_SERVER/web-app-mern:backend-<BuildId>` + `:backend-latest` → push |
| Build | Build & push frontend | same from `client/` → `:frontend-<BuildId>` |
| Deploy | Replace tokens | `sed` fills `__crServer__`, `BuildID`, `__ingressHost__`, `__MONGO_URI__`, `__JWT_SECRET__` into a **temp** `values.generated.yaml`; fails if any `__token__` is left |
| Deploy | helm upgrade | `helm lint` → `helm upgrade --install mern-app k8s-helm/mern-app -n mern-app --create-namespace --wait` → prints pods + history |
| Deploy | Clean up | deletes `values.generated.yaml` (it contains real secrets) |

Trigger: every push to `main`. Manual runs: Pipelines → Run pipeline (you can
flip `isBuildStage`/`isDeployK8s` parameters, e.g. redeploy without rebuilding).

### 6.4 Verify a green run

```bash
kubectl get pods -n mern-app -o wide      # new pods, image tag = backend-<BuildId>
helm history mern-app -n mern-app
curl http://mern.local/api/v1/health      # from the Windows host (hosts entry from §4.4)
```

Browser: `http://mern.local` → register/login must work.

---

## 7. Rollback

```bash
helm history mern-app -n mern-app             # find the last good REVISION
helm rollback mern-app <REVISION> -n mern-app --wait
```

Or re-run the pipeline with `isBuildStage=false` after reverting the offending
commit — it redeploys the chart using the previous image only if you also pin
the tag, so **`helm rollback` is the fast path**. Mongo data note: with the
default `emptyDir`, deleting/rescheduling the mongodb pod wipes data; rollbacks
that only touch backend/frontend deployments don't restart Mongo.

---

## 8. Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| Pipeline stuck on "Waiting for an agent" | agent offline (`sudo ./svc.sh status` in VM), wrong pool name, or pipeline lacks pool permission (Agent pools → Security) |
| `docker: permission denied` in Build stage | agent user not in `docker` group → `sudo usermod -aG docker <user>`, then `sudo ./svc.sh stop && start` |
| `ImagePullBackOff` | private repo + no `imagePullSecrets` → create `regcred` (`kubectl create secret docker-registry regcred -n mern-app --docker-username=... --docker-password=...`) and uncomment `imagePullSecrets` in values; or node can't resolve/reach `CR_SERVER` |
| Token-replace step fails "Unreplaced tokens remain" | variable missing from `mern-app-dev` group, or group not linked/authorized for the pipeline |
| `helm upgrade` timeout, backend pod `CrashLoopBackOff` | `kubectl logs -n mern-app deploy/mern-app-backend` — usually bad `MONGO_URI` or Mongo pod not ready |
| Backend `Readiness probe failed` | app up but Mongo unreachable, or PORT mismatch — health lives at `/api/v1/health` on 4000 |
| Frontend loads but login returns HTML/404 | request didn't go through ingress (`/api` route) — you're on the NodePort; use `http://<INGRESS_HOST>` |
| `http://mern.local` unreachable from Windows | hosts entry missing/wrong IP; ingress-nginx not installed (`kubectl get pods -n ingress-nginx`); vbox network not host-reachable (use Bridged/Host-only) |
| Agent runs but `kubectl` fails in Deploy stage | kubeconfig missing for the *agent's* user, or points at wrong cluster → `kubectl config current-context` as that user |
| Mongo data vanished after node reboot | expected with `emptyDir` — switch `mongodb.volumes` to a PVC or use external Mongo/Atlas |

**Logs to check, in order:** pipeline step log (ADO web UI) → `kubectl get pods -n mern-app`
→ `kubectl describe pod <pod> -n mern-app` (events) → `kubectl logs <pod> -n mern-app`.

---

## 9. Security notes & next steps

- Secrets live **only** in the ADO variable group (padlocked) — never commit
  real values into `values.tokenized.yaml`; the generated file is deleted after
  each deploy and is also in `.helmignore`.
- `/metrics` (Prometheus endpoint) is deliberately **not** exposed via ingress;
  scrape it in-cluster.
- Improvements when ready: PVC for Mongo (or Atlas), k8s `Secret` +
  `secretKeyRef` instead of env tokens (the MoniAgent `DATABASE_URL` pattern),
  TLS via cert-manager (`ingress.clusterIssuer`), a `mern-app-prod` variable
  group + second pipeline environment with approvals.
