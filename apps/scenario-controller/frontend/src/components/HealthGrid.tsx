import type { LabStatus } from '../types';
import { Sparkline } from './Sparkline';

interface Props {
  status: LabStatus | null;
  loading: boolean;
  /** Recent history per component, keyed by component name, for the sparklines. */
  history: Record<string, number[]>;
}

/** Picks the number worth trending for each component. */
const TREND_METRIC: Record<string, { key: string; warnAt: number; suffix: string }> = {
  'App VM': { key: 'percentUsed', warnAt: 85, suffix: '%' },
  PostgreSQL: { key: 'percentUsed', warnAt: 80, suffix: '%' },
  AKS: { key: 'pendingPods', warnAt: 1, suffix: '' },
  'Magic 8 Ball': { key: 'latencyMs', warnAt: 1000, suffix: 'ms' },
  TLS: { key: 'daysRemaining', warnAt: 14, suffix: 'd' },
};

export function HealthGrid({ status, loading, history }: Props) {
  if (loading && !status) {
    return (
      <div className="health-grid">
        {[0, 1, 2, 3, 4].map((index) => (
          <div className="skeleton" key={index} />
        ))}
      </div>
    );
  }

  if (!status) {
    return <div className="empty">Lab status unavailable. The controller may still be starting.</div>;
  }

  return (
    <div className="health-grid">
      {status.components.map((component) => {
        const trend = TREND_METRIC[component.name];
        const series = history[component.name] ?? [];
        const current = trend ? component.metrics?.[trend.key] : undefined;
        return (
          <div className={`health-card state-${component.state}`} key={component.name}>
            <div className="name">{component.name}</div>
            <div className="state">{component.state}</div>
            <div className="detail">{component.detail}</div>
            {trend && series.length > 1 ? (
              <div style={{ marginTop: 8 }}>
                <Sparkline values={series} warnAt={trend.warnAt} />
                <div className="detail" style={{ marginTop: 2 }}>
                  {typeof current === 'number' ? `${current}${trend.suffix}` : '—'}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
