# Azure SRE Agent — setup for the demo lab

This document covers the Azure SRE Agent for a deployed lab: creating the agent, connecting the
GitHub repository, granting scoped access, verifying it can see the telemetry, and running the
first investigation.

> **What is automated, and what is not.** `scripts/deploy.sh --with-agent` creates the agent
> for you, wires it to the lab's Application Insights and prints the command to grant it
> access. Two things remain human decisions rather than script steps: **GitHub connector
> consent**, which requires an interactive OAuth approval, and **granting the agent write
> access**, which is deliberately a separate command.
>
> The agent is opt-in. Without `--with-agent` nothing is created, and the lab still deploys
> and runs completely — `scripts/deploy.sh` never fails because no agent is connected.
>
> **It is also the most expensive part of the lab.** Azure SRE Agent bills a fixed always-on
> charge of 4 Azure Agent Units per hour (~$0.40/hour), plus token-based usage while it works.
> That is more than every other resource combined, and `stop-lab.sh` does **not** stop it —
> the agent has no stopped state. Delete it or destroy the lab if it will sit idle.

---

## Before you start

You need:

- a deployed lab (`./scripts/deploy.sh` completed, `./scripts/validate.sh` green);
- **Owner** or **User Access Administrator** on the demo resource group, to grant the agent access;
- a region where Azure SRE Agent is available — it is **not** offered in `eastus`, the default
  lab region, so `--with-agent` requires `--location`/`--agent-location` to name one that is;
- 10–15 minutes of telemetry accumulated, so the agent has something to read.

Collect your lab details:

```bash
jq -r '{subscriptionId, resourceGroup, location, appInsightsName, logAnalyticsName, aksName}' .lab-state.json
```

If you deployed with `--with-agent`, the agent's own details are there too:

```bash
jq -r '{sreAgentName, sreAgentLocation, sreAgentMode, sreAgentPrincipalId}' .lab-state.json
```

---

## 1. Create or select an Azure SRE Agent

### With the deployment (recommended)

`deploy.sh` can create the agent for you. It is opt-in because the agent is chargeable and is
not offered in every region the lab runs in:

```bash
./scripts/deploy.sh --location eastus2 --with-agent --agent-mode Review
```

`--agent-mode` is `ReadOnly` (investigate only), `Review` (default — pause for human approval
before each remediation) or `Autonomous` (act unattended). Use `--agent-location` when the lab
region does not offer SRE Agent; the agent may sit in a different region from the lab.

SRE Agent is **not available in `eastus`**, the default lab region. `deploy.sh` checks before
deploying and prints the regions that do offer it.

The agent is created with a system-assigned identity and no role assignments. Its name,
region, mode and principal ID are written to `.lab-state.json`, and the principal ID is
printed at the end of the deployment for step 3.

An existing lab can gain an agent by re-running the deployment with the same `--suffix` and
adding `--with-agent`; the deployment is idempotent.

### Portal

1. Sign in to the [Azure portal](https://portal.azure.com).
2. Search for **SRE Agent** and open the service.
3. Select **Create**.
4. Configure:
   - **Subscription** — the subscription hosting the lab.
   - **Resource group** — create `rg-sre-agent-<suffix>` to keep the agent separate from the
     resources it observes, so a `destroy-lab` of the demo group does not remove the agent.
   - **Name** — for example `sre-agent-demo-<suffix>`.
   - **Region** — a region where the service is offered; it does not have to match the lab.
5. Create, and wait for provisioning to finish.

### Checking availability yourself

`deploy.sh --with-agent` performs this check for you and refuses to continue with the list of
valid regions. To check by hand:

```bash
az provider register --namespace Microsoft.App --wait
az provider show --namespace Microsoft.App \
  --query "resourceTypes[?resourceType=='agents'].locations[]" -o tsv
```

If that returns nothing, the provider is unavailable in your tenant and the agent has to be
created in the portal.

The same behaviour is available from `.env` via `WITH_AGENT`, `AGENT_MODE` and
`AGENT_LOCATION`, so a saved configuration deploys an agent without repeating the flags.

### Both managed identities are required

The agent is created with **system-assigned and user-assigned identities together**. The
user-assigned identity carries connector authentication and Azure RBAC; the system-assigned one
backs the agent's own infrastructure.

This is not cosmetic. An agent created with `type: 'UserAssigned'` alone provisions
successfully and runs, but lands on the **Public Preview generation**, and the portal then
offers:

> *A newer version of SRE Agent is available. This agent was created during Public Preview.
> Migrate to get an improved sandbox, code and file access, log-to-code investigation, better
> memory, and updated approval controls.*

Nothing in the resource reveals this. `upgradeChannel` reads `Stable`, the template already
targets the generally available API (`Microsoft.App/agents@2026-01-01`), both API versions
return an identical property set, and the properties behind the newer experience
(`sandboxConfiguration`, `experimentalSettings`, `firstPartyConfiguration`) are read-only and
null. The banner in the agent UI is the only signal.

With `type: 'SystemAssigned,UserAssigned'` the agent is created on the current generation and
the banner does not appear — verified by deleting a preview-generation agent and redeploying.

If you have an older agent showing that banner, either select **Migrate** in the portal, or
delete it and redeploy with `--with-agent`. Redeploying loses the agent's accumulated memory
and connections, and issues a new principal ID, so re-run `enable-sre-remediation.sh`
afterwards.

---

## 2. Connect the private GitHub repository

Connecting the repository lets the agent correlate an incident with the code and configuration
that caused it — which is what makes scenario 03 land properly.

1. Open your agent in the portal.
2. Go to **Connections** (or **Integrations**) → **GitHub**.
3. Select **Connect** and complete the OAuth flow.
4. Grant access to **`F0bsterz/azure-sre-agent-demo-lab`** — this is a private repository, so it
   must be selected explicitly.
5. Confirm the connection shows as **Connected**.

> **This step cannot be automated.** OAuth consent requires an interactive sign-in. If the
> connection fails, confirm you are an owner of the repository (or of the organisation) and that
> your policy permits the GitHub App.

What the agent gains: the Bicep templates, Kubernetes manifests, application source and
`docs/scenarios/` — so it can reason about intended state, not just observed state.

---

## 3. Give the agent access to the demo resource group

### First: your own access to the agent

Azure SRE Agent has **two independent permission planes**, and this catches people out:

| Plane | Governs | Roles |
|---|---|---|
| Control plane | Creating, reading and deleting the `Microsoft.App/agents` **resource** | Owner, Contributor, Reader |
| Data plane | Opening and using the **agent itself** at its `*.azuresre.ai` endpoint | SRE Agent Reader / Standard User / Author / Administrator |

**Subscription Owner grants you none of the data-plane roles.** Without one, the agent endpoint
returns HTTP 401 and the UI reports *"Taking longer than usual… Your agent may be cold-starting,
or there may be network issues"* — which is misleading, since the agent is running fine.

`deploy.sh --with-agent` assigns the deploying principal **SRE Agent Administrator** on the
agent, so this is already done for you. For anyone else who needs access:

```bash
AGENT_ID=$(jq -r .sreAgentId .lab-state.json)
az role assignment create --assignee <user-object-id> \
  --role "SRE Agent Administrator" --scope "$AGENT_ID"
```

Use **SRE Agent Reader** or **Standard User** for people who should watch but not configure.

To confirm access from the command line:

```bash
TOKEN=$(az account get-access-token --resource https://azuresre.ai --query accessToken -o tsv)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "$(jq -r .sreAgentEndpoint .lab-state.json)"     # 200 = you have access, 401 = you do not
```

### Then: the agent's access to the lab

The agent needs a managed identity with read access to the lab.

```bash
RG=$(jq -r .resourceGroup .lab-state.json)
SUB=$(jq -r .subscriptionId .lab-state.json)
SCOPE="/subscriptions/${SUB}/resourceGroups/${RG}"

# Deployed with --with-agent? The principal ID is already recorded.
# Otherwise take it from the portal: your agent -> Identity -> Object ID.
AGENT_PRINCIPAL_ID=$(jq -r '.sreAgentPrincipalId // empty' .lab-state.json)

# Read-only to begin with — enough for detection and investigation.
az role assignment create --assignee "$AGENT_PRINCIPAL_ID" --role "Reader"                      --scope "$SCOPE"
az role assignment create --assignee "$AGENT_PRINCIPAL_ID" --role "Monitoring Reader"           --scope "$SCOPE"
az role assignment create --assignee "$AGENT_PRINCIPAL_ID" --role "Log Analytics Reader"        --scope "$SCOPE"
az role assignment create --assignee "$AGENT_PRINCIPAL_ID" --role "Azure Kubernetes Service Cluster User Role" --scope "$SCOPE"
```

Verify:

```bash
az role assignment list --assignee "$AGENT_PRINCIPAL_ID" --scope "$SCOPE" -o table
```

**Scope discipline:** grant at the demo resource group, never at the subscription. If your
agent covers several environments, add each resource group individually.

---

## 4. Verify Application Insights access

```bash
APPI=$(jq -r .appInsightsName .lab-state.json)
RG=$(jq -r .resourceGroup .lab-state.json)

az monitor app-insights component show -g "$RG" -a "$APPI" --query "{name:name, appId:appId}" -o table
```

Confirm telemetry is arriving:

```bash
az monitor app-insights query -g "$RG" -a "$APPI" \
  --analytics-query "AppRequests | where TimeGenerated > ago(30m) | summarize count() by AppRoleName" -o table
```

You should see rows for `scenario-controller` and `magic8ball`. If empty, wait a further five
minutes — first ingestion can lag.

In the agent, confirm Application Insights appears as a discovered data source.

---

## 5. Verify Log Analytics access

```bash
LAW=$(jq -r .logAnalyticsName .lab-state.json)
RG=$(jq -r .resourceGroup .lab-state.json)
WORKSPACE_ID=$(az monitor log-analytics workspace show -g "$RG" -n "$LAW" --query customerId -o tsv)

az monitor log-analytics query --workspace "$WORKSPACE_ID" \
  --analytics-query "union AppMetrics, AppRequests, Perf, KubePodInventory | where TimeGenerated > ago(30m) | summarize Rows=count() by Type" -o table
```

Expect `AppMetrics`, `AppRequests`, `Perf` and `KubePodInventory`. The custom demo metrics live
in `AppMetrics`:

```bash
az monitor log-analytics query --workspace "$WORKSPACE_ID" \
  --analytics-query 'AppMetrics | where Name startswith "sre_demo_" | summarize Latest=max(TimeGenerated) by Name' -o table
```

You should see `sre_demo_disk_percent_used`, `sre_demo_postgres_connection_percent`,
`sre_demo_postgres_connectivity`, `sre_demo_magic8ball_tls_valid`,
`sre_demo_magic8ball_http_success` and others.

---

## 6. Verify Azure Monitor access

The lab creates six scheduled query alert rules:

```bash
az monitor scheduled-query list -g "$RG" --query "[].{Name:name, Enabled:enabled, Severity:severity}" -o table
```

Expect rules for disk capacity, AKS node pressure, pending pods, HTTP failure rate, PostgreSQL
connections, PostgreSQL connectivity and TLS validation.

Confirm the agent can enumerate them — this is how it learns what "abnormal" means in this
environment. Check fired alerts during a scenario with:

```bash
az monitor activity-log alert list -g "$RG" -o table
az rest --method get --url "https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.AlertsManagement/alerts?api-version=2019-05-05-preview" \
  --query "value[].{name:properties.essentials.alertRule, state:properties.essentials.monitorCondition, fired:properties.essentials.startDateTime}" -o table
```

---

## 7. Verify AKS diagnostics

```bash
AKS=$(jq -r .aksName .lab-state.json)

az aks show -g "$RG" -n "$AKS" --query "addonProfiles.omsagent.enabled"
```

This must return `true` — Container Insights is what gives the agent pod state, node capacity
and container logs.

```bash
az monitor log-analytics query --workspace "$WORKSPACE_ID" \
  --analytics-query 'KubePodInventory | where TimeGenerated > ago(15m) | where Namespace == "sre-demo" | summarize by Name, PodStatus' -o table
```

For the agent to inspect the cluster directly, it needs
**Azure Kubernetes Service Cluster User Role** (granted in step 3) and, if the cluster uses
Azure RBAC for Kubernetes authorisation, also
**Azure Kubernetes Service RBAC Reader**.

---

## 8. Run the first investigation

Start with scenario 01 — self-contained, fast and unambiguous.

1. Open the Scenario Controller and confirm every component is **HEALTHY**.
2. Inject **01 — Disk Capacity Exhaustion**.
3. Watch the App VM card climb past 85%; this takes about 60–90 seconds.
4. Wait 3–5 minutes for `SRE Demo 01 - App VM demo disk capacity` to fire.
5. Give the agent:

   ```
   Investigate why the application VM is reporting low disk capacity.
   Identify the root cause and propose a safe mitigation.
   ```

6. A good investigation identifies the VM, the mount point `/var/sre-demo`, the growing
   `logs` directory, the largest files, `app=checkout-suite` with `retry_storm=true` in the log
   lines, and an approximate growth rate — then proposes stopping the logger and reclaiming the
   files rather than simply enlarging the disk.
7. Press **Verify**, then **Reset**.

Prompts and expected findings for all six scenarios:
**[SRE-DEMO-RUNBOOK.md](SRE-DEMO-RUNBOOK.md)**.

---

## Enabling remediation (optional)

Investigation needs read access only. To let the agent *act*, grant Contributor — still scoped
to the demo resource group:

```bash
./scripts/enable-sre-remediation.sh --agent-principal-id <agent-managed-identity-object-id>
```

or manually:

```bash
az role assignment create --assignee "$AGENT_PRINCIPAL_ID" --role "Contributor" --scope "$SCOPE"
```

**What this permits, and what it does not:**

- Permits: scaling the AKS node pool, removing the NSG rule, restarting workloads, rolling back
  a deployment — everything the six scenarios require, within this resource group.
- Does not permit: anything outside the demo resource group. There is no subscription-scope
  grant anywhere in this lab.

> Mitigation actions remain **approval-controlled**. Azure SRE Agent proposes a change and waits
> for a human to approve it before acting. Contributor makes the action *possible*; it does not
> make it automatic. Keep approval enabled for demonstrations — watching the agent propose a
> precise, well-reasoned change and asking for consent is usually the most persuasive part.

To revoke afterwards:

```bash
az role assignment delete --assignee "$AGENT_PRINCIPAL_ID" --role "Contributor" --scope "$SCOPE"
```

---

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Agent sees no resources | Role assignment missing or not yet propagated | Re-check step 3; allow up to 5 minutes |
| No Application Insights data | Telemetry has not arrived yet | Wait 10 minutes; confirm with the step 4 query |
| No AKS data | Container Insights disabled | `az aks enable-addons -a monitoring -g $RG -n $AKS --workspace-resource-id <id>` |
| GitHub connection fails | Consent not granted, or no repository access | Reconnect as a repository/organisation owner |
| Agent UI spins, then "Taking longer than usual… cold-starting, or there may be network issues" | Almost always **not** cold start. You lack an SRE Agent data-plane role; the endpoint is returning 401 | Assign yourself **SRE Agent Administrator** on the agent (see §3). Subscription Owner does not cover this |
| Alerts never fire | Evaluation window not yet elapsed | Rules evaluate every 5 minutes over a 10-minute window; allow 5–10 minutes |
| Agent cannot query the cluster | Cluster User role missing | Grant it, plus RBAC Reader if Azure RBAC is enabled |

Lab-level problems: **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)**.

---

## What is automated, and what is not

Automated by `scripts/deploy.sh --with-agent`:

1. **Creating the SRE Agent** — a `Microsoft.App/agents` resource, with its mode and region
   validated before the deployment starts.
2. **Wiring it to telemetry** — the lab's Application Insights is attached at creation.
3. **Creating its identity** — a dedicated user-assigned identity, holding no roles.
4. **Granting you access to the agent** — the deploying principal receives **SRE Agent
   Administrator** on the agent, without which the agent exists but cannot be opened.
5. **Recording it** — name, region, mode, endpoint and principal ID land in `.lab-state.json`
   and the deployment summary.

Still yours to do, on purpose:

1. **Connect GitHub** — interactive OAuth consent; a human has to approve it.
2. **Grant the agent access** — `scripts/enable-sre-remediation.sh`, kept a separate command so
   that giving an automated agent write access is never a side effect of deploying a demo.

Everything else — infrastructure, applications, telemetry, alert rules, scenarios — is fully
automated.
