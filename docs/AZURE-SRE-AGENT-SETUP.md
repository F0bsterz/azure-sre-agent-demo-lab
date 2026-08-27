# Azure SRE Agent — setup for the demo lab

This document connects an Azure SRE Agent to a deployed lab: creating the agent, connecting the
GitHub repository, granting scoped access, verifying it can see the telemetry, and running the
first investigation.

> **Provisioning is partly interactive.** Azure SRE Agent availability, regions and connector
> consent vary by tenant, and GitHub authorisation requires a human to approve an OAuth grant.
> The lab deploys fully without any of this — `scripts/deploy.sh` never fails because the agent
> is not yet connected. The steps below are the remaining manual work.

---

## Before you start

You need:

- a deployed lab (`./scripts/deploy.sh` completed, `./scripts/validate.sh` green);
- **Owner** or **User Access Administrator** on the demo resource group, to grant the agent access;
- an Azure region where Azure SRE Agent is available;
- 10–15 minutes of telemetry accumulated, so the agent has something to read.

Collect your lab details:

```bash
jq -r '{subscriptionId, resourceGroup, location, appInsightsName, logAnalyticsName, aksName}' .lab-state.json
```

---

## 1. Create or select an Azure SRE Agent

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

### CLI, where available

Programmatic provisioning is only possible if the resource provider is registered and available
in your tenant:

```bash
az provider register --namespace Microsoft.App --wait
az provider show --namespace Microsoft.App --query "resourceTypes[?resourceType=='agents']" -o table
```

If that returns nothing, the agent must be created in the portal for now.

The deploy script honours `DEPLOY_SRE_AGENT=true` in `.env` and will attempt provisioning when
the API and permissions allow it, reporting clearly and continuing when they do not.

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

The agent needs a managed identity with read access to the lab.

```bash
RG=$(jq -r .resourceGroup .lab-state.json)
SUB=$(jq -r .subscriptionId .lab-state.json)
SCOPE="/subscriptions/${SUB}/resourceGroups/${RG}"

# Object ID of the agent's managed identity, from the portal Identity blade
AGENT_PRINCIPAL_ID="<agent-managed-identity-object-id>"

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
| Alerts never fire | Evaluation window not yet elapsed | Rules evaluate every 5 minutes over a 10-minute window; allow 5–10 minutes |
| Agent cannot query the cluster | Cluster User role missing | Grant it, plus RBAC Reader if Azure RBAC is enabled |

Lab-level problems: **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)**.

---

## Manual steps summary

Everything the deployment cannot do for you:

1. **Create the SRE Agent** — portal, unless the API is available in your tenant.
2. **Connect GitHub** — interactive OAuth consent.
3. **Assign roles to the agent identity** — the object ID only exists after the agent does.
4. **Optionally enable remediation** — a deliberate decision, kept manual on purpose.

Everything else — infrastructure, applications, telemetry, alert rules, scenarios — is fully
automated.
