import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { HealthGrid } from './components/HealthGrid';
import { ScenarioCard } from './components/ScenarioCard';
import { Timeline } from './components/Timeline';
import { ConfirmDialog } from './components/ConfirmDialog';
import type {
  LabStatus,
  ScenarioListResponse,
  ScenarioStatus,
  ScenarioTelemetry,
  TimelineEntry,
  VerificationResult,
} from './types';

type Tab = 'overview' | 'scenarios' | 'timeline' | 'runbook';

const POLL_MS = 8000;
const HISTORY_POINTS = 40;

const TREND_KEYS: Record<string, string> = {
  'App VM': 'percentUsed',
  PostgreSQL: 'percentUsed',
  AKS: 'pendingPods',
  'Magic 8 Ball': 'latencyMs',
  TLS: 'daysRemaining',
};

export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioListResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [telemetry, setTelemetry] = useState<Record<string, ScenarioTelemetry>>({});
  const [verifications, setVerifications] = useState<Record<string, VerificationResult>>({});
  const [history, setHistory] = useState<Record<string, number[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string | null>>({});
  const [labResetBusy, setLabResetBusy] = useState(false);
  const [confirm, setConfirm] = useState<
    { kind: 'inject'; scenario: ScenarioStatus } | { kind: 'reset-lab' } | null
  >(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [labStatus, scenarioList, timelineResponse] = await Promise.all([
        api.labStatus(),
        api.scenarios(),
        api.timeline(undefined, 60),
      ]);
      if (!mounted.current) return;
      setStatus(labStatus);
      setScenarios(scenarioList);
      setTimeline(timelineResponse.entries);
      setError(null);

      setHistory((previous) => {
        const next = { ...previous };
        for (const component of labStatus.components) {
          const key = TREND_KEYS[component.name];
          const value = key ? component.metrics?.[key] : undefined;
          if (typeof value !== 'number') continue;
          next[component.name] = [...(previous[component.name] ?? []), value].slice(-HISTORY_POINTS);
        }
        return next;
      });
    } catch (fetchError) {
      if (!mounted.current) return;
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const handle = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(handle);
  }, [refresh]);

  // Telemetry for the active scenario keeps the card live during an incident.
  const activeScenarioId = status?.activeIncident?.scenarioId;
  useEffect(() => {
    if (!activeScenarioId) return undefined;
    const pull = async () => {
      try {
        const result = await api.telemetry(activeScenarioId);
        if (mounted.current) setTelemetry((previous) => ({ ...previous, [activeScenarioId]: result }));
      } catch {
        // Telemetry is advisory; a failure here should not disturb the console.
      }
    };
    void pull();
    const handle = window.setInterval(() => void pull(), POLL_MS);
    return () => window.clearInterval(handle);
  }, [activeScenarioId]);

  const setScenarioBusy = (id: string, value: string | null) =>
    setBusy((previous) => ({ ...previous, [id]: value }));

  const runInject = async (scenario: ScenarioStatus) => {
    setScenarioBusy(scenario.id, 'activate');
    setNotice(null);
    try {
      await api.activate(scenario.id);
      setNotice(`Scenario ${scenario.id} activated. Give Azure Monitor a few minutes to raise the alert.`);
      await refresh();
    } catch (activateError) {
      setError(activateError instanceof Error ? activateError.message : String(activateError));
    } finally {
      setScenarioBusy(scenario.id, null);
      setConfirm(null);
    }
  };

  const runVerify = async (scenario: ScenarioStatus) => {
    setScenarioBusy(scenario.id, 'verify');
    try {
      const [result, scenarioTelemetry] = await Promise.all([
        api.verify(scenario.id),
        api.telemetry(scenario.id).catch(() => undefined),
      ]);
      setVerifications((previous) => ({ ...previous, [scenario.id]: result }));
      if (scenarioTelemetry) {
        setTelemetry((previous) => ({ ...previous, [scenario.id]: scenarioTelemetry }));
      }
      setNotice(
        `Scenario ${scenario.id} verification ${result.passed ? 'PASSED' : 'FAILED'} — fault ${
          result.faultPresent ? 'present' : 'not present'
        }.`,
      );
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : String(verifyError));
    } finally {
      setScenarioBusy(scenario.id, null);
    }
  };

  const runReset = async (scenario: ScenarioStatus) => {
    setScenarioBusy(scenario.id, 'reset');
    try {
      await api.reset(scenario.id);
      setNotice(`Scenario ${scenario.id} reset.`);
      await refresh();
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : String(resetError));
    } finally {
      setScenarioBusy(scenario.id, null);
    }
  };

  const runScale = async () => {
    setScenarioBusy('02', 'scale');
    try {
      const result = await api.scaleAks(2);
      setNotice(`AKS node pool scale to ${result.count} requested. Nodes take a few minutes to join.`);
      await refresh();
    } catch (scaleError) {
      setError(scaleError instanceof Error ? scaleError.message : String(scaleError));
    } finally {
      setScenarioBusy('02', null);
    }
  };

  const runLabReset = async () => {
    setLabResetBusy(true);
    try {
      const summary = await api.resetLab();
      setNotice(
        summary.allCleared
          ? 'Lab reset complete. Every scenario is idle and baselines are restored.'
          : 'Lab reset finished with warnings. Review the timeline for the steps that failed.',
      );
      setVerifications({});
      await refresh();
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : String(resetError));
    } finally {
      setLabResetBusy(false);
      setConfirm(null);
    }
  };

  const blockingScenario = useMemo(
    () =>
      scenarios?.policy.oneAtATime
        ? scenarios.scenarios.find((scenario) =>
            ['INJECTING', 'ACTIVE', 'DETECTED', 'MITIGATING'].includes(scenario.state),
          )
        : undefined,
    [scenarios],
  );

  const environment = status?.environment;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">SRE</div>
          <div>
            <h1>Azure SRE Agent Demo Lab</h1>
            <p className="subtitle">Fault injection and recovery console</p>
          </div>
        </div>
        <div className="topbar-spacer" />
        {environment ? (
          <>
            <div className="env-chip" title="Demo resource group">
              rg: {environment.resourceGroup || 'unknown'}
            </div>
            <div className="env-chip" title="Azure region">
              {environment.location || 'unknown'}
            </div>
            <div className="env-chip" title="Overall lab health">
              health: {status?.overall}
            </div>
            {environment.magic8ballPublicUrl ? (
              <a
                className="env-chip"
                href={environment.magic8ballPublicUrl}
                target="_blank"
                rel="noreferrer"
                title="Open the Magic 8 Ball application in a new tab"
              >
                Magic 8 Ball ↗
              </a>
            ) : null}
          </>
        ) : null}
      </header>

      <nav className="tabs">
        {(
          [
            ['overview', 'Overview'],
            ['scenarios', 'Incident scenarios'],
            ['timeline', 'Incident history'],
            ['runbook', 'SRE prompts'],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            className={`tab${tab === value ? ' active' : ''}`}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main>
        {error ? (
          <div className="banner error">
            {error}
            <button className="btn small ghost" style={{ marginLeft: 12 }} onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className="banner success">
            {notice}
            <button className="btn small ghost" style={{ marginLeft: 12 }} onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        ) : null}

        {(tab === 'overview' || tab === 'scenarios') && (
          <section>
            <div className="section-head">
              <h2>System health</h2>
              <span className="hint">
                {status ? `updated ${new Date(status.collectedAt).toLocaleTimeString()}` : 'loading…'}
              </span>
            </div>
            <HealthGrid status={status} loading={loading} history={history} />
          </section>
        )}

        {(tab === 'overview' || tab === 'scenarios') && (
          <section>
            <div className="section-head">
              <h2>Active incident</h2>
            </div>
            {status?.activeIncident ? (
              <div className="incident active">
                <span className="pulse" />
                <div>
                  <div className="title">
                    {status.activeIncident.scenarioId} — {status.activeIncident.name}
                  </div>
                  <div className="meta">
                    <span>
                      state <b>{status.activeIncident.state}</b>
                    </span>
                    <span>
                      severity <b>{status.activeIncident.severity}</b>
                    </span>
                    <span>
                      elapsed <b>{status.activeIncident.elapsedSeconds ?? 0}s</b>
                    </span>
                    {status.activeIncident.expiresAt ? (
                      <span>
                        auto-reset <b>{new Date(status.activeIncident.expiresAt).toLocaleTimeString()}</b>
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <div className="incident none">No active incident. The lab is at baseline.</div>
            )}
          </section>
        )}

        {(tab === 'overview' || tab === 'scenarios') && (
          <section>
            <div className="section-head">
              <h2>Incident scenarios</h2>
              <span className="hint">
                {scenarios?.policy.oneAtATime
                  ? `one at a time · auto-reset after ${scenarios.policy.timeoutMinutes} minutes`
                  : 'concurrent scenarios enabled'}
              </span>
            </div>
            <div className="scenario-grid">
              {(scenarios?.scenarios ?? []).map((scenario) => (
                <ScenarioCard
                  key={scenario.id}
                  scenario={scenario}
                  telemetry={telemetry[scenario.id]}
                  verification={verifications[scenario.id]}
                  busy={busy[scenario.id] ?? null}
                  disabled={Boolean(blockingScenario && blockingScenario.id !== scenario.id)}
                  disabledReason={
                    blockingScenario
                      ? `Scenario ${blockingScenario.id} is active. Reset it first, or enable concurrent scenarios.`
                      : undefined
                  }
                  onInject={(target) => setConfirm({ kind: 'inject', scenario: target })}
                  onVerify={runVerify}
                  onReset={runReset}
                  onScale={scenario.id === '02' ? runScale : undefined}
                />
              ))}
              {!scenarios && loading
                ? [0, 1, 2].map((index) => <div className="skeleton" style={{ height: 260 }} key={index} />)
                : null}
            </div>
          </section>
        )}

        {tab === 'timeline' && (
          <section>
            <div className="section-head">
              <h2>Incident history</h2>
              <span className="hint">
                {status?.telemetry.bufferedEvents
                  ? `${status.telemetry.bufferedEvents} event(s) buffered locally while PostgreSQL is unavailable`
                  : 'stored in PostgreSQL'}
              </span>
            </div>
            <Timeline entries={timeline} loading={loading} />
          </section>
        )}

        {tab === 'runbook' && (
          <section>
            <div className="section-head">
              <h2>Suggested Azure SRE Agent prompts</h2>
              <span className="hint">paste into the agent after injecting the matching scenario</span>
            </div>
            <div className="scenario-grid">
              {(scenarios?.scenarios ?? []).map((scenario) => (
                <article className="scenario" key={scenario.id}>
                  <header className="scenario-head">
                    <div className="scenario-id">{scenario.id}</div>
                    <div className="scenario-title">
                      <h3>{scenario.name}</h3>
                      <div className="component">{scenario.component}</div>
                    </div>
                  </header>
                  <div style={{ padding: '0 16px 14px' }}>
                    <pre className="prompt-box">{scenario.investigationPrompt}</pre>
                    <div className="kv-grid" style={{ marginTop: 10 }}>
                      {scenario.telemetryMetrics.map((metric) => (
                        <div key={metric}>
                          <span className="k">metric: </span>
                          <span className="v">{metric}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="reset-bar">
            <div className="copy">
              <strong>Reset entire lab</strong> — stops the disk logger, removes the resource-pressure
              workload, restores the AKS node pool baseline and the stable Magic 8 Ball image, closes
              scenario database sessions, removes the NSG deny rule and reinstalls the valid certificate.
              Safe to run repeatedly.
            </div>
            <button
              className="btn danger"
              onClick={() => setConfirm({ kind: 'reset-lab' })}
              disabled={labResetBusy}
            >
              {labResetBusy ? <span className="spinner" /> : null}
              Reset entire lab
            </button>
          </div>
        </section>
      </main>

      <ConfirmDialog
        open={confirm?.kind === 'inject'}
        title={
          confirm?.kind === 'inject'
            ? `Inject scenario ${confirm.scenario.id}: ${confirm.scenario.name}?`
            : ''
        }
        body={
          confirm?.kind === 'inject'
            ? `This creates a real fault in ${confirm.scenario.component}. It is bounded to demo resources and resets automatically after ${scenarios?.policy.timeoutMinutes ?? 30} minutes.`
            : ''
        }
        prompt={confirm?.kind === 'inject' ? confirm.scenario.investigationPrompt : undefined}
        confirmLabel="Inject failure"
        destructive
        busy={confirm?.kind === 'inject' ? busy[confirm.scenario.id] === 'activate' : false}
        onConfirm={() => {
          if (confirm?.kind === 'inject') void runInject(confirm.scenario);
        }}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm?.kind === 'reset-lab'}
        title="Reset the entire lab?"
        body="Every scenario is cleared and all baselines are restored. Only resources created by this lab are touched."
        confirmLabel="Reset lab"
        busy={labResetBusy}
        onConfirm={() => void runLabReset()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
