import { useEffect, useState } from 'react';
import type { ScenarioStatus, ScenarioTelemetry, VerificationResult } from '../types';

interface Props {
  scenario: ScenarioStatus;
  telemetry?: ScenarioTelemetry;
  verification?: VerificationResult;
  busy: string | null;
  disabled: boolean;
  disabledReason?: string;
  onInject: (scenario: ScenarioStatus) => void;
  onVerify: (scenario: ScenarioStatus) => void;
  onReset: (scenario: ScenarioStatus) => void;
  onScale?: () => void;
}

const ACTIVE_STATES = new Set(['INJECTING', 'ACTIVE', 'DETECTED', 'MITIGATING']);

function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remaining}s`;
  if (minutes > 0) return `${minutes}m ${remaining}s`;
  return `${remaining}s`;
}

function formatValue(value: number | string | boolean | null): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

export function ScenarioCard({
  scenario,
  telemetry,
  verification,
  busy,
  disabled,
  disabledReason,
  onInject,
  onVerify,
  onReset,
  onScale,
}: Props) {
  const isActive = ACTIVE_STATES.has(scenario.state);

  // Tick locally so the incident timer moves between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive) return undefined;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [isActive]);

  const elapsedSeconds = scenario.activatedAt
    ? Math.max(0, Math.floor((now - Date.parse(scenario.activatedAt)) / 1000))
    : undefined;

  const expiresInSeconds = scenario.expiresAt
    ? Math.max(0, Math.floor((Date.parse(scenario.expiresAt) - now) / 1000))
    : undefined;

  return (
    <article className={`scenario${isActive ? ' is-active' : ''}`}>
      <header className="scenario-head">
        <div className="scenario-id">{scenario.id}</div>
        <div className="scenario-title">
          <h3>{scenario.name}</h3>
          <div className="component">{scenario.component}</div>
        </div>
        <div className="badges">
          <span className={`badge state-${scenario.state}`}>{scenario.state}</span>
          <span className={`badge sev-${scenario.severity}`}>{scenario.severity}</span>
          <span className={`badge ${scenario.telemetryHealthy ? 'telemetry-on' : 'telemetry-off'}`}>
            {scenario.telemetryHealthy ? 'telemetry ok' : 'telemetry off'}
          </span>
        </div>
      </header>

      <p className="scenario-desc">{scenario.description}</p>

      <div className="scenario-stats">
        <div className="stat">
          <div className="label">Activated</div>
          <div className="value">
            {scenario.activatedAt ? new Date(scenario.activatedAt).toLocaleTimeString() : '—'}
          </div>
        </div>
        <div className="stat">
          <div className="label">Elapsed</div>
          <div className="value">{elapsedSeconds === undefined ? '—' : formatElapsed(elapsedSeconds)}</div>
        </div>
        <div className="stat">
          <div className="label">Auto-reset in</div>
          <div className="value">
            {expiresInSeconds === undefined ? '—' : formatElapsed(expiresInSeconds)}
          </div>
        </div>
        <div className="stat">
          <div className="label">Correlation</div>
          <div className="value">{scenario.correlationId?.slice(0, 8) ?? '—'}</div>
        </div>
      </div>

      {telemetry ? (
        <div className="telemetry-block">
          <div className="kv-grid">
            {Object.entries(telemetry.metrics)
              .slice(0, 8)
              .map(([key, value]) => (
                <div key={key}>
                  <span className="k">{key}: </span>
                  <span className="v">{formatValue(value)}</span>
                </div>
              ))}
          </div>
          {telemetry.observations.length > 0 ? (
            <ul>
              {telemetry.observations.slice(0, 3).map((observation) => (
                <li key={observation}>{observation}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {verification ? (
        <div className="checks">
          {verification.checks.map((check) => (
            <div className={`check ${check.passed ? 'pass' : 'fail'}`} key={check.name}>
              <span className="mark">{check.passed ? 'PASS' : 'FAIL'}</span>
              <span>
                {check.name} — <span className="detail">{check.detail}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {scenario.lastError ? <div className="checks banner error">{scenario.lastError}</div> : null}

      <div className="scenario-actions">
        <button
          className="btn inject"
          onClick={() => onInject(scenario)}
          disabled={Boolean(busy) || isActive || disabled}
          title={disabled ? disabledReason : 'Inject this fault into the lab'}
        >
          {busy === 'activate' ? <span className="spinner" /> : null}
          Inject failure
        </button>
        <button className="btn" onClick={() => onVerify(scenario)} disabled={Boolean(busy)}>
          {busy === 'verify' ? <span className="spinner" /> : null}
          Verify
        </button>
        <button className="btn" onClick={() => onReset(scenario)} disabled={Boolean(busy)}>
          {busy === 'reset' ? <span className="spinner" /> : null}
          Reset
        </button>
        {onScale ? (
          <button
            className="btn small"
            onClick={onScale}
            disabled={Boolean(busy)}
            title="Perform the expected remediation: scale the AKS node pool to 2 nodes"
          >
            {busy === 'scale' ? <span className="spinner" /> : null}
            Scale AKS to 2
          </button>
        ) : null}
      </div>
    </article>
  );
}
