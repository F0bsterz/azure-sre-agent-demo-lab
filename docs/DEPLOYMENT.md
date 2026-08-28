# Deployment

Detailed deployment reference. For the short version, see the
[Quick start](../README.md#quick-start).

---

## Prerequisites

| Requirement | Check |
|---|---|
| Azure CLI 2.60+ | `az version` |
| Authenticated | `az account show` |
| `jq` | `jq --version` |
| `openssl` 3.0+ | `openssl version` |
| `kubectl` | `kubectl version --client` or `az aks install-cli` |
| `git` | `git --version` |
| Bash | Linux/macOS native; Windows via Git Bash or WSL |

Docker is **not** required locally. Images are built with `az acr build`, which runs the build
in Azure.

### Azure permissions

| Operation | Role |
|---|---|
| Create the resource group and resources | **Contributor** on the subscription |
| Create role assignments | **User Access Administrator**, or **Owner** for both |

Without permission to create role assignments the deployment still succeeds: it detects the
authorisation failure, redeploys without them, and prints the exact commands to run afterwards.
The lab works; scenarios 02 and 05 need those roles before they will function.

### Quota

Eight vCPU of headroom in the target region:

- 4 for the two `Standard_B2s` VMs (`standardBSFamily`)
- 2 for the AKS node (`StandardDasv7Family` by default)
- 2 spare for the scenario 02 scale-out

`deploy.sh` checks the regional total **and** the per-family limits before deploying, because a
family limit of zero fails a deployment even when the regional total looks healthy.

---

## What the script does

Twenty steps, in order:

| # | Step | Notes |
|---|---|---|
| 1 | Validate tools | Fails immediately with install guidance |
| 2 | Validate Azure authentication | |
| 3 | Select subscription | Defaults to the current one |
| 4 | Validate region | Against the subscription's available locations |
| 5 | Register resource providers | Waits for registration to complete. `Microsoft.App` only when `--with-agent` |
| 5b | Validate SRE Agent options | Only with `--with-agent`. Checks the mode, and that the region actually offers SRE Agent |
| 6 | Determine `ADMIN_CIDR` | Prompts for the CIDRs; refuses to default to `0.0.0.0/0` |
| 7 | Validate SKUs and quota | Caches the SKU catalogue once; checks family and regional quota |
| 8 | Resolve lab identity | Generates a suffix unless `--suffix` is given |
| 9 | Prepare SSH key | ed25519, written to `.secrets/`, reused if present |
| 10 | Generate credentials | 32-character alphanumeric, from `/dev/urandom` |
| 11 | Create resource group | Tagged |
| 12 | Select Kubernetes version | Latest GA for the region; no patch version pinned |
| 13 | Deploy Bicep | ~10-15 minutes |
| 14 | Store secrets in Key Vault | |
| 15 | Build images in ACR | Five images, built in Azure |
| 16 | Get AKS credentials | Written to `.secrets/kubeconfig-<suffix>` |
| 17 | Generate TLS certificates | Demo CA plus valid and expired pairs |
| 18 | Deploy Kubernetes workloads | Then waits for load balancer addresses |
| 18b | Reissue certificates for the LB IP | The certificate must cover the address clients use |
| 19 | Configure the App VM | Pulls and runs the controller with a managed identity |
| 20 | Smoke tests and summary | Writes `.lab-state.json` |

### Idempotency

Re-running is safe and is the supported recovery path. The resource group, Bicep deployment,
Kubernetes manifests and secrets are all applied declaratively; the SSH key and suffix are
reused when `--suffix` is supplied.

```bash
# Resume an interrupted deployment against the same environment
./scripts/deploy.sh --location eastus2 --suffix a1b2c3
```

---

## Options

```
--subscription <id>    Subscription (default: current az account)
--location <region>    Azure region (default: eastus)
--suffix <string>      Reuse a specific lab suffix
--admin-cidr <cidr>    Allowed inbound CIDR. Repeatable; prompted for when omitted
--skip-build           Do not rebuild container images
--skip-apps            Deploy infrastructure only
--with-agent           Also create an Azure SRE Agent (off by default; chargeable)
--agent-mode <mode>    ReadOnly | Review (default) | Autonomous
--agent-location <r>   Agent region when the lab region does not offer SRE Agent
--yes                  No confirmation prompt
```

`--with-agent` adds a `Microsoft.App/agents` resource and a user-assigned identity for it. The
identity is created with **no role assignments**; run `scripts/enable-sre-remediation.sh` to
grant access. SRE Agent is not offered in every region — notably not in `eastus` — so step 5b
validates the region up front and lists the valid ones rather than failing mid-deployment.

Anything not passed can come from `.env` — copy `.env.example` and edit. Command-line arguments
take precedence over `.env`.

---

## Choosing a region

Any region with capacity for one AKS cluster, two B-series VMs and a D-series node works.

Two conditions cause a region to be rejected, and they are reported differently:

**SKU not available for the subscription.** The script tries the preferred node SKU, then falls
back through a documented list, and substitutes automatically:

```
==> SKU Standard_D2as_v5 unavailable in eastus: Location:NotAvailableForSubscription
  PASS AKS node SKU Standard_D2as_v7 is available
```

Only **Location**-type restrictions are treated as blocking. A Zone-type restriction means the
SKU is unavailable in particular availability zones but is fine for a non-zonal deployment like
this one — treating those as blocking would reject perfectly usable SKUs.

**Regional capacity exhaustion.** Azure sometimes refuses new AKS clusters in a busy region:

```
{"code": "AKSCapacityHeavyUsage",
 "message": "Creating a new cluster is unavailable at this time in region eastus."}
```

This is transient and unrelated to quota or permissions. The script detects it and tells you to
either try another region or retry later. Regions worth trying: `eastus2`, `westus3`,
`centralus`, `westus2`, `canadacentral`, `northeurope`, `uksouth`.

---

## After deployment

```bash
./scripts/validate.sh
```

`.lab-state.json` (git-ignored, mode 0600) records everything the other scripts need:

```bash
jq -r '{resourceGroup, location, controllerUrl, magic8ballUrl, aksName, aksNodeSize}' .lab-state.json
```

Connect to things:

```bash
# Scenario Controller
open "$(jq -r .controllerUrl .lab-state.json)"

# SSH
ssh -i "$(jq -r .sshKey .lab-state.json)" "$(jq -r .adminUsername .lab-state.json)@$(jq -r .appVmPublicIp .lab-state.json)"

# kubectl
export KUBECONFIG="$(jq -r .kubeconfig .lab-state.json)"
kubectl -n sre-demo get pods
```

Telemetry takes **5–10 minutes** to appear in Application Insights and Container Insights after
first deployment. `validate.sh` reports telemetry checks as failures before then; re-run it after
ten minutes.

---

## Deploying into a different subscription

Nothing is tied to the subscription this was first built in:

```bash
git clone https://github.com/F0bsterz/azure-sre-agent-demo-lab.git
cd azure-sre-agent-demo-lab
az login
./scripts/deploy.sh --subscription <their-subscription-id> --location <their-region>
```

Everything environment-specific is discovered or generated at deploy time: names from the
suffix, node SKU from regional availability, Kubernetes version from `az aks get-versions`,
passwords from `/dev/urandom`, admin CIDR from the detected IP, load balancer addresses after
provisioning, and certificates reissued for the assigned address.

---

## Running multiple labs side by side

Each deployment gets its own suffix and resource group, so several can coexist:

```bash
./scripts/deploy.sh --location eastus2 --suffix teamA
./scripts/deploy.sh --location westus3 --suffix teamB
```

`.lab-state.json` holds only the most recent one. To operate an older lab, either re-run
`deploy.sh --suffix <old>` to regenerate the state file, or pass the resource group explicitly:

```bash
./scripts/destroy-lab.sh --resource-group rg-sre-demo-teamA
```

---

## CI/CD

`.github/workflows/validate.yml` runs TypeScript checks, React builds, Bicep compilation and
Kubernetes manifest validation on every push and pull request.

`.github/workflows/build.yml` builds the container images.

**GitHub Actions is not required to deploy.** The local path is the supported one; CI exists to
keep the repository healthy. For pipeline deployment, prefer GitHub OIDC federated credentials
over a long-lived client secret:

```yaml
- uses: azure/login@v2
  with:
    client-id: ${{ secrets.AZURE_CLIENT_ID }}
    tenant-id: ${{ secrets.AZURE_TENANT_ID }}
    subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
```

---

## Cleaning up

```bash
./scripts/stop-lab.sh                  # deallocate compute, keep everything else
./scripts/start-lab.sh                 # bring it back
./scripts/destroy-lab.sh --dry-run     # review what would be deleted
./scripts/destroy-lab.sh               # delete the resource group
```

`destroy-lab.sh` deletes only a resource group tagged `project=azure-sre-agent-demo`, and
requires the name to be typed unless `--yes` is passed. It also purges the soft-deleted Key
Vault so the same suffix can be reused.

Local artefacts are left behind deliberately — remove them yourself:

```bash
rm -rf certs/ .secrets/ .lab-state.json
```

---

## Common deployment problems

| Symptom | Cause | Fix |
|---|---|---|
| `AKSCapacityHeavyUsage` | Regional capacity | Deploy to another region |
| `SkuNotAvailable` | SKU not offered to the subscription | The script substitutes automatically; if all fail, change region |
| `QuotaExceeded` | Insufficient vCPU | Request an increase, or change region |
| `AuthorizationFailed` on role assignments | No User Access Administrator | The script retries without them and prints manual commands |
| Key Vault name already exists | Soft-deleted vault from a prior run | `az keyvault purge --name kv-sredemo-<suffix>` |
| Controller health not confirmed | cloud-init still running | Wait 2-3 minutes, then re-run `validate.sh` |
| Load balancer has no address | AKS still assigning | The script waits up to 10 minutes; re-run if it times out |

More in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
