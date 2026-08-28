# Troubleshooting

Problems grouped by where they show up, each with the diagnosis that actually distinguishes the
cause rather than a list of things to try.

Start here:

```bash
./scripts/validate.sh
```

It prints PASS/FAIL for every component and usually identifies the layer at fault in one run.

---

## Deployment

### `AKSCapacityHeavyUsage`

```
"code": "AKSCapacityHeavyUsage",
"message": "Creating a new cluster is unavailable at this time in region eastus."
```

Azure is temporarily refusing new AKS clusters in that region. **This is not quota and not
permissions** — requesting a quota increase will not help.

```bash
./scripts/destroy-lab.sh --resource-group rg-sre-demo-<suffix> --yes
./scripts/deploy.sh --location eastus2
```

Try `eastus2`, `westus3`, `centralus`, `westus2`, `canadacentral`, `northeurope`, `uksouth`. The
condition is transient, so the original region will usually work again later.

### All D-series SKUs reported unavailable

```
==> SKU Standard_D2as_v5 unavailable in eastus: Location:NotAvailableForSubscription
```

Some subscription types (particularly sandbox and MSDN subscriptions) are not offered older
generations in some regions. The script falls back automatically through v7, v6, v5, v4 and
DSv2. If every candidate fails, change region.

Check for yourself:

```bash
az vm list-skus --location <region> --resource-type virtualMachines --all -o json \
  | jq -r '.[] | select(.name|test("^Standard_D2(as|s)_v[4-7]$"))
           | "\(.name): \([.restrictions[]? | "\(.type):\(.reasonCode)"] | join(", ") // "available")"'
```

Only **Location**-type restrictions block a deployment. A Zone restriction is irrelevant to this
lab, which pins no availability zones.

### `AuthorizationFailed` on role assignments

You have Contributor but not User Access Administrator. The deployment detects this, redeploys
without role assignments and prints the commands to run afterwards. Until they are granted,
scenarios 02 and 05 will fail because the controller cannot call Azure Resource Manager.

### Key Vault name already exists

A previous deployment's vault is soft-deleted:

```bash
az keyvault purge --name kv-sredemo-<suffix>
```

### Deployment hangs or exits silently

Check the log, then confirm the process is alive:

```bash
tail -50 /tmp/sre-deploy.log
pgrep -af scripts/deploy.sh
```

If you backgrounded the script yourself, launch it fully detached — otherwise a SIGPIPE from a
later command in the same pipeline can kill it:

```bash
setsid nohup bash scripts/deploy.sh --location eastus2 --yes > /tmp/sre-deploy.log 2>&1 < /dev/null &
```

---

## Scenario Controller

### Unreachable

Work outward from the VM:

```bash
RG=$(jq -r .resourceGroup .lab-state.json)
VM=$(jq -r .appVmName .lab-state.json)

# 1. Is the VM running?
az vm get-instance-view -g $RG -n $VM \
  --query "instanceView.statuses[?starts_with(code,'PowerState')].displayStatus" -o tsv

# 2. Is the container running?
az vm run-command invoke -g $RG -n $VM --command-id RunShellScript \
  --scripts "docker ps -a --filter name=sre-scenario-controller" \
  --query "value[0].message" -o tsv

# 3. What do its logs say?
az vm run-command invoke -g $RG -n $VM --command-id RunShellScript \
  --scripts "docker logs --tail 100 sre-scenario-controller" \
  --query "value[0].message" -o tsv

# 4. Is it healthy locally? (rules out NSG vs application)
az vm run-command invoke -g $RG -n $VM --command-id RunShellScript \
  --scripts "curl -fsS http://127.0.0.1:8080/healthz" \
  --query "value[0].message" -o tsv
```

If step 4 succeeds but you cannot reach it, the problem is network — almost always that your
public IP changed:

```bash
curl -s https://api.ipify.org                       # your IP now
jq -r .adminCidr .lab-state.json                    # what the NSG allows

az network nsg rule update -g $RG --nsg-name nsg-app-<suffix> \
  --name Allow-Controller-UI-Admin --source-address-prefixes "$(curl -s https://api.ipify.org)/32"
az network nsg rule update -g $RG --nsg-name nsg-app-<suffix> \
  --name Allow-SSH-Admin --source-address-prefixes "$(curl -s https://api.ipify.org)/32"
```

### Container missing after a restart

It runs with `--restart unless-stopped`, so it should return with the VM. If not:

```bash
az vm run-command invoke -g $RG -n $VM --command-id RunShellScript \
  --scripts "docker start sre-scenario-controller && sleep 5 && curl -fsS http://127.0.0.1:8080/healthz"
```

If the container is gone entirely, re-run the deployment — step 19 recreates it:

```bash
./scripts/deploy.sh --location <region> --suffix <suffix> --skip-build --yes
```

### Scenarios 02 or 05 fail with an ARM error

The managed identity is missing its role assignment:

```bash
IDENTITY_ID=$(az identity show -g $RG -n id-sre-demo-<suffix> --query principalId -o tsv)
az role assignment list --assignee $IDENTITY_ID --scope "/subscriptions/<sub>/resourceGroups/$RG" -o table

az role assignment create --assignee $IDENTITY_ID --role Contributor \
  --scope "/subscriptions/<sub>/resourceGroups/$RG"
```

Role assignments take up to five minutes to propagate.

---

## Magic 8 Ball

### Pods not starting

```bash
export KUBECONFIG=$(jq -r .kubeconfig .lab-state.json)
kubectl -n sre-demo get pods
kubectl -n sre-demo describe pod <pod>
kubectl -n sre-demo logs <pod> --tail=50
```

| Pod status | Cause | Fix |
|---|---|---|
| `ImagePullBackOff` | AKS cannot pull from ACR | `az aks update -g $RG -n <aks> --attach-acr <acr>` |
| `Pending` | Insufficient node capacity | Scenario 02 may be active — reset it, or scale the node pool |
| `CrashLoopBackOff` | Application error | Check `kubectl logs`; usually a missing secret |
| `CreateContainerConfigError` | Missing secret or key | `kubectl -n sre-demo get secrets` |

### No load balancer address

```bash
kubectl -n sre-demo get svc magic8ball -w
kubectl -n sre-demo describe svc magic8ball | tail -20
```

Allocation normally takes 1–3 minutes. Persistent failure usually means the AKS identity lacks
Network Contributor on the node resource group, which `az aks update` repairs.

### Reachable from the cluster but not from you

`loadBalancerSourceRanges` restricts the service to `ADMIN_CIDR`:

```bash
kubectl -n sre-demo get svc magic8ball -o jsonpath='{.spec.loadBalancerSourceRanges}'
kubectl -n sre-demo patch svc magic8ball --type=merge \
  -p "{\"spec\":{\"loadBalancerSourceRanges\":[\"$(curl -s https://api.ipify.org)/32\"]}}"
```

---

## PostgreSQL

### Unreachable

The decisive question is **whether TCP connects**, because it separates two very different
causes:

```bash
az vm run-command invoke -g $RG -n $(jq -r .appVmName .lab-state.json) \
  --command-id RunShellScript \
  --scripts "nc -zv -w 5 $(jq -r .postgresPrivateIp .lab-state.json) 5432" \
  --query "value[0].message" -o tsv
```

| Result | Meaning | Where to look |
|---|---|---|
| Connects | Network is fine | Connection limits (scenario 04) or PostgreSQL itself |
| Times out | Packets dropped | NSG rules (scenario 05) |
| Refused | Nothing listening | PostgreSQL is not running |

Check for a stray scenario rule:

```bash
az network nsg rule list -g $RG --nsg-name $(jq -r .databaseNsgName .lab-state.json) \
  -o table --query "[].{Name:name,Priority:priority,Access:access,Port:destinationPortRange}"

az network nsg rule delete -g $RG --nsg-name <db-nsg> -n sre-demo-deny-postgres
```

### Setup did not complete

PostgreSQL is configured by a custom script extension after cloud-init:

```bash
az vm run-command invoke -g $RG -n $(jq -r .postgresVmName .lab-state.json) \
  --command-id RunShellScript \
  --scripts "tail -60 /var/log/sre-demo-postgres-setup.log; systemctl status postgresql --no-pager" \
  --query "value[0].message" -o tsv
```

A marker file `/var/log/sre-demo-postgres-ready` indicates success.

### Connections exhausted outside a scenario

```bash
az vm run-command invoke -g $RG -n $(jq -r .postgresVmName .lab-state.json) \
  --command-id RunShellScript \
  --scripts "sudo -u postgres psql -c \"SELECT application_name, state, count(*) FROM pg_stat_activity GROUP BY 1,2 ORDER BY 3 DESC\"" \
  --query "value[0].message" -o tsv
```

Terminate only the lab's sessions:

```sql
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE application_name LIKE 'sre-demo-scenario%' AND pid <> pg_backend_pid();
```

---

## Telemetry

### Nothing in Application Insights

First ingestion takes **5–10 minutes**. Then:

```bash
LAW_ID=$(jq -r .logAnalyticsId .lab-state.json)
az monitor log-analytics query --workspace "$LAW_ID" \
  --analytics-query "AppRequests | where TimeGenerated > ago(30m) | summarize count() by AppRoleName" -o table
```

Empty after 15 minutes means the connection string did not reach the workload:

```bash
az vm run-command invoke -g $RG -n $(jq -r .appVmName .lab-state.json) \
  --command-id RunShellScript \
  --scripts "grep -c APPLICATIONINSIGHTS /etc/sre-demo-controller.env" \
  --query "value[0].message" -o tsv

kubectl -n sre-demo get secret magic8ball-telemetry -o jsonpath='{.data.connectionString}' | base64 -d | head -c 40
```

### No AKS data in Container Insights

```bash
az aks show -g $RG -n <aks> --query "addonProfiles.omsagent.enabled"
kubectl -n kube-system get pods -l dsName=ama-logs
```

If disabled:

```bash
az aks enable-addons -a monitoring -g $RG -n <aks> \
  --workspace-resource-id $(jq -r .logAnalyticsId .lab-state.json)
```

### Alerts never fire

Rules evaluate every 5 minutes over a 10-minute window, so allow 5–10 minutes.

```bash
az monitor scheduled-query list -g $RG -o table

# Run a rule's query by hand to see whether it would fire
az monitor log-analytics query --workspace "$LAW_ID" \
  --analytics-query 'AppMetrics | where Name == "sre_demo_disk_percent_used"
    | extend Value = iif(ItemCount > 0, Sum / ItemCount, Sum)
    | summarize DiskPercentUsed = max(Value)' -o table
```

If the query returns no rows, the metric is not arriving — a telemetry problem, not an alerting
one.

---

## Scenarios

### Activation returns 409 Conflict

Another scenario is active. Only one runs at a time by default:

```bash
curl -s http://<app-vm-ip>:8080/api/scenarios | jq -r '.scenarios[] | select(.state != "IDLE") | "\(.id) \(.name) \(.state)"'
curl -X POST http://<app-vm-ip>:8080/api/scenarios/<id>/reset
```

### Scenario stuck in INJECTING or RESETTING

```bash
curl -X POST http://<app-vm-ip>:8080/api/lab/reset
./scripts/reset-lab.sh
```

`reset-lab.sh` re-asserts every baseline directly against Azure and Kubernetes, so it works even
when the controller is unreachable.

### Verify fails after a reset

Some resets are not instantaneous — an AKS node pool scale-down takes minutes, and a rollout
restart takes 30–60 seconds. Wait, then re-verify.

### Disk scenario does not fill

```bash
az vm run-command invoke -g $RG -n <app-vm> --command-id RunShellScript \
  --scripts "df -h /var/sre-demo; ls -la /var/sre-demo/logs | head" \
  --query "value[0].message" -o tsv
```

If `/var/sre-demo` is not a separate mount, the data disk failed to attach:

```bash
az vm run-command invoke -g $RG -n <app-vm> --command-id RunShellScript \
  --scripts "/usr/local/bin/sre-demo-mount-disk.sh && df -h /var/sre-demo"
```

---

## Subscription governance automation

On Microsoft-managed subscriptions (MCAPS / `MngEnv*`), a tenant automation called
**MCAPSGovernance-AutomationApp** holds Owner at the management group and acts on lab
resources without warning. Observed during a demo run:

| Symptom | What actually happened |
|---|---|
| Everything works, then Magic 8 Ball returns nothing and `kubectl` cannot resolve the API server. Scenario verification reports `0/0 replicas` and `no image` | The automation called `Microsoft.ContainerService/managedClusters/stop/action`. The cluster is **Stopped**, not broken |
| `Allow-SSH-Admin` disappears from the app NSG some time after deployment, while the 8080 rule survives | The automation rewrote the NSG and stripped inbound TCP 22 |

Confirm before assuming a lab bug:

```bash
az aks show -g <rg> -n <cluster> --query powerState.code -o tsv    # Stopped?

az monitor activity-log list -g <rg> --offset 3h --max-events 300 \
  --query "[?contains(operationName.value,'stop')].{time:eventTimestamp,caller:caller}" -o table
```

Recover with `az aks start -g <rg> -n <cluster>` — allow two to three minutes after the
cluster reports `Running` for workloads to become reachable — then
`scripts/grant-access.sh --cidr <your-ip>/32` to reinstate the SSH rule. `deploy.sh` step 20
reconciles the same rules, which is why they reappear after a redeploy.

Nothing here is caused by the lab, and nothing in the repository can prevent it. Budget for it
when demonstrating on an MCAPS subscription: leaving a lab idle invites the cluster to be
stopped underneath you.

---

## Complete reset

When the state is unclear:

```bash
./scripts/reset-lab.sh          # restore all baselines
./scripts/validate.sh           # confirm

# Still wrong? Redeploy over the top — idempotent, no data lost
./scripts/deploy.sh --location <region> --suffix <suffix> --yes

# Last resort
./scripts/destroy-lab.sh
./scripts/deploy.sh --location <region>
```

---

## Collecting diagnostics

```bash
{
  echo "=== state ==="; jq . .lab-state.json
  echo "=== validate ==="; ./scripts/validate.sh 2>&1
  echo "=== resources ==="; az resource list -g $RG -o table
  echo "=== pods ==="; KUBECONFIG=$(jq -r .kubeconfig .lab-state.json) kubectl -n sre-demo get all
  echo "=== lab status ==="; curl -s "$(jq -r .controllerUrl .lab-state.json)/api/lab/status" | jq
} > /tmp/sre-lab-diagnostics.txt 2>&1
```

Review it before sharing — it contains resource names and IP addresses, though no secrets.
