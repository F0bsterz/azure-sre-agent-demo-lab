# SRE demo runbook

How to run each scenario in front of an audience: what to say, what to inject, what prompt to
give Azure SRE Agent, what the agent should discover, and how to recover.

Each scenario takes about 10–15 minutes end to end. Detection is the slowest part — Azure
Monitor evaluates every five minutes, so allow 3–5 minutes between injecting a fault and
expecting an alert.

---

## Before the demo

```bash
./scripts/validate.sh
```

Everything must be **PASS**. Then:

- Open the **Scenario Controller** and the **Magic 8 Ball** side by side, and have Azure SRE
  Agent open in a third tab.
- Ask a couple of Magic 8 Ball questions so the history panel is populated and the audience sees
  a working application before you break it.
- Confirm the health grid is all **HEALTHY** and **No active incident**.

A useful framing before you inject anything:

> "This is a small but real Azure environment: two VMs, a Kubernetes cluster, a database, and
> full Azure Monitor instrumentation. I am about to genuinely break it. Nothing here is
> simulated — the disk really fills, the pods really fail to schedule, the certificate really
> is expired. Let us see what the agent makes of it."

---

## Scenario 01 — Disk capacity exhaustion

**Story.** A service enters a retry storm after an upstream timeout. Every retry logs an error.
The application log directory grows until the volume is nearly full.

**Inject.** Scenario card 01 → **Inject failure** → confirm.

**What to watch.** The App VM card climbs past 85% within 60–90 seconds. The sparkline shows a
steep, linear rise — not a spike.

**Prompt.**

```
Investigate why the application VM is reporting low disk capacity.
Identify the root cause and propose a safe mitigation.
```

**Expected findings.**

| The agent should find | Evidence |
|---|---|
| The affected VM | `vm-sre-app-<suffix>` |
| High disk utilisation | `sre_demo_disk_percent_used` > 85, and `Perf` `% Used Space` |
| The mount point | `/var/sre-demo`, a dedicated data disk, not the OS disk |
| The growing directory | `/var/sre-demo/logs` |
| The largest files | `sre-demo-scenario-01-*.log`, tens of MB each |
| The source application | Log lines carry `app=checkout-suite` and `retry_storm=true` |
| Growth rate | Roughly 5–6 MB/s while active |

**Good remediation.** Stop the runaway logger, then archive or delete its files and confirm free
capacity is restored. A strong answer distinguishes the *symptom* (a full disk) from the *cause*
(a retry loop), and does not simply propose a bigger disk.

**Recover.** **Verify** → **Reset**. Utilisation drops below 80% within seconds.

**Talking point.** The disk never reaches 100% and the OS disk is never touched. The fault is
real but the lab always remains recoverable — a property you would want in any chaos exercise.

---

## Scenario 02 — AKS resource exhaustion

**Story.** A batch workload is deployed with generous resource requests. The single-node cluster
cannot fit it. Pods stay Pending and the customer-facing service slows down.

**Inject.** Scenario card 02 → **Inject failure**.

**What to watch.** Within a minute the AKS card shows pending pods and node CPU
reaches 95-100%. Two burner replicas schedule; four cannot. Magic 8 Ball keeps
answering quickly — its workload is small enough that the scheduler still gives
it what it asks for. That contrast is worth pointing out: the node is saturated
and unable to place new work, while the application on it looks perfectly fine.

**Prompt.**

```
Investigate why Magic 8 Ball is degraded and whether the AKS
cluster has sufficient compute capacity.
```

**Expected findings.**

| The agent should find | Evidence |
|---|---|
| High node CPU | `Perf` `cpuUsageNanoCores` against `cpuCapacityNanoCores` |
| Memory pressure | `memoryWorkingSetBytes` against `memoryCapacityBytes` |
| Pending pods | `KubePodInventory` where `PodStatus == "Pending"` |
| The reason | `Unschedulable` — insufficient CPU |
| Allocatable vs requested | ~1.1 cores usable; the burner requests 300m × 6 |
| Node count | 1, and the autoscaler is disabled |

**Expected remediation.** Scale the system node pool **1 → 2**.

```bash
az aks nodepool scale -g <rg> --cluster-name <aks> -n system --node-count 2
```

Or press **Scale AKS to 2** on the card. Nodes take 2–4 minutes to join.

**Verify recovery.** Pending pods schedule, node CPU spreads across both nodes, and
health returns to **HEALTHY**.

**Recover.** **Reset** — removes the pressure workload and returns the pool to one node.

**Talking point.** The autoscaler is off deliberately. In production it would have absorbed
this silently — which is exactly why capacity incidents so often surface only when the
autoscaler hits *its* ceiling.

---

## Scenario 03 — Bad application deployment

**Story.** A release goes out on a Friday afternoon. Error rates climb minutes later.

**Inject.** Scenario card 03 → **Inject failure**. Kubernetes rolls the deployment onto the
`magic8ball-bad` image.

**What to watch.** Ask several Magic 8 Ball questions — roughly two in five fail outright and
the rest take 3–5 seconds. The build panel shows the version change.

**Prompt.**

```
Investigate the increase in HTTP 500 errors for Magic 8 Ball.
Determine whether the incident correlates with a deployment or
source-code change and propose a mitigation.
```

**Expected findings.**

| The agent should find | Evidence |
|---|---|
| Elevated failure rate | `AppRequests` where `Success == false`, ~42% |
| Increased latency | `AppRequests` duration, 3–5 s |
| Correlation with a rollout | Failures begin at the deployment timestamp |
| The deployed version | `/api/version` — variant `bad`, version `0.1.1` |
| The image | `magic8ball-bad:<tag>` |
| The commit | `GIT_COMMIT` on every telemetry item |
| Exceptions | "oracle backend returned null" in `AppExceptions` |

**Expected remediation.** Roll back to the stable image.

```bash
kubectl -n sre-demo set image deployment/magic8ball magic8ball=<acr>/magic8ball:<tag>
```

**Verify recovery.** Failure rate returns to zero, latency drops below 100 ms, probes pass.

**Recover.** **Reset** — rolls back automatically.

**Talking point.** This is why build metadata belongs in telemetry. Without the commit SHA and
image tag on every request, the agent could tell you *that* errors rose but not *which change*
caused them.

---

## Scenario 04 — Database connection exhaustion

**Story.** A new service ships with a misconfigured connection pool. Connections are opened and
never returned. Over time nothing else can connect.

**Inject.** Scenario card 04 → **Inject failure**.

**What to watch.** The PostgreSQL card climbs past 80% of `max_connections` within seconds.

**Prompt.**

```
Investigate the database errors affecting the application.
Determine whether PostgreSQL is healthy and identify why clients
cannot establish connections.
```

**Expected findings.**

| The agent should find | Evidence |
|---|---|
| Application dependency failures | `AppDependencies` type `PostgreSQL`, `Success == false` |
| Connection utilisation | `sre_demo_postgres_connection_percent` > 80 |
| The database itself is healthy | The VM is running; the service is listening; TCP 5432 connects |
| The offending sessions | `pg_stat_activity` `application_name = 'sre-demo-scenario-04'` |
| The signature | Sessions idle in transaction — a classic leak |

**Expected remediation.** Immediate: terminate the leaked sessions and restart the leaking
client. Root cause: fix pooling so connections are returned, and size the pool deliberately.

**Recover.** **Reset** — closes the sessions and terminates any strays, matched strictly on
`application_name`.

**Talking point.** Contrast with scenario 05. Both look like "the app cannot reach the
database". Here TCP connects and the *server* refuses new sessions. There, TCP never connects at
all. That distinction is the whole investigation, and it is the kind of thing an agent can
determine in seconds.

---

## Scenario 05 — Network / NSG failure

**Story.** A well-intentioned network security change is applied. It blocks more than intended.

**Inject.** Scenario card 05 → **Inject failure**. Adds `sre-demo-deny-postgres` to the database
NSG at priority 100.

**What to watch.** PostgreSQL goes **UNHEALTHY** with "TCP 5432 unreachable". Magic 8 Ball keeps
answering — but the history panel reports the database is unavailable, which is the graceful
degradation working as designed.

**Prompt.**

```
Investigate why the application cannot communicate with PostgreSQL.
Check application health, database health, routing and NSG configuration.
```

**Expected findings.**

| The agent should find | Evidence |
|---|---|
| Application database calls failing | `AppDependencies` failures, `sre_demo_postgres_connectivity` = 0 |
| The VM is healthy | Running, responsive, no guest errors |
| The service is healthy | PostgreSQL is up and listening |
| TCP 5432 times out | Timeout, not connection-refused — a filter, not a dead service |
| An NSG rule changed | `sre-demo-deny-postgres`, priority 100, Deny, TCP 5432 |
| Recent change evidence | The rule appears in the activity log at injection time |

**Expected remediation.** Remove or disable the rule.

```bash
az network nsg rule delete -g <rg> --nsg-name <db-nsg> -n sre-demo-deny-postgres
```

Then validate TCP connectivity, database login, application dependency health and HTTP health.

**Recover.** **Reset** — removes the rule.

**Talking point.** Note what the rule does *not* touch: SSH still works, the Scenario Controller
is still reachable, and every other flow is untouched. A blast radius that narrow is what makes
it safe to demonstrate a network fault at all.

---

## Scenario 06 — Certificate expiration

**Story.** A certificate nobody owned quietly expired. The service is perfectly healthy and
completely unreachable over HTTPS.

**Inject.** Scenario card 06 → **Inject failure**. Swaps the Kubernetes TLS secret to the expired
pair and restarts the workload.

**What to watch.** The TLS card goes **UNHEALTHY**. Pods stay **Ready** and plain HTTP still
works — that contradiction is the point of the scenario.

**Prompt.**

```
Investigate why HTTPS health checks for Magic 8 Ball are failing even
though the AKS pods appear healthy.
```

**Expected findings.**

| The agent should find | Evidence |
|---|---|
| HTTPS checks failing | `sre_demo_magic8ball_tls_valid` = 0 |
| Pods are healthy | `KubePodInventory` — all Running and Ready |
| The application is healthy | HTTP `/healthz` returns 200 |
| TLS validation fails | Handshake completes; validation does not |
| The certificate is expired | `notAfter` roughly 30 days in the past |
| Not a trust problem | The chain validates against the demo CA with time checks disabled |

**Expected remediation.** Install the valid certificate and restart the workload.

```bash
kubectl -n sre-demo patch secret magic8ball-tls --type=merge -p "$(...)"   # see scenario doc
kubectl -n sre-demo rollout restart deployment/magic8ball
```

**Verify recovery.** Certificate valid, handshake succeeds, HTTP 200 over TLS, synthetic check
passes.

**Recover.** **Reset** — reinstalls the valid certificate.

**Talking point.** Liveness probes use HTTP deliberately. Had they used HTTPS, Kubernetes would
have restarted the pods in a loop and buried the evidence under a `CrashLoopBackOff` — turning a
five-minute diagnosis into an hour. Probe design is a real operational lesson hiding inside this
scenario.

---

## Closing the demo

```bash
./scripts/reset-lab.sh
./scripts/validate.sh
./scripts/stop-lab.sh     # if you are finished for the day
```

A reasonable summary to end on:

> "Six incidents, six different layers — storage, compute capacity, application code, database,
> network and PKI. In each case the agent worked from the same telemetry an on-call engineer
> would have had, and reached the root cause in a couple of minutes rather than a couple of
> hours. The signal was always there. The difference is how quickly someone — or something —
> connects it."

---

## Timing reference

| Phase | Duration |
|---|---|
| Injection to visible degradation | 15–90 s |
| Injection to Azure Monitor alert | 3–5 min |
| Agent investigation | 1–3 min |
| Remediation (scenarios 01, 03, 04, 05, 06) | seconds to 1 min |
| Remediation (scenario 02, node join) | 2–4 min |
| Reset to healthy | 10–60 s |
| **Per scenario, end to end** | **10–15 min** |

Running all six with narration takes about 90 minutes. For a 60-minute slot, scenarios 01, 03
and 05 give the widest coverage: infrastructure, application and network.
