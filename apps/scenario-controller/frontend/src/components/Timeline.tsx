import type { TimelineEntry } from '../types';

interface Props {
  entries: TimelineEntry[];
  loading: boolean;
}

function time(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString();
}

export function Timeline({ entries, loading }: Props) {
  if (loading && entries.length === 0) {
    return <div className="skeleton" style={{ height: 160 }} />;
  }

  if (entries.length === 0) {
    return <div className="empty">No incident history yet. Inject a scenario to start the timeline.</div>;
  }

  return (
    <div className="timeline">
      {entries.map((entry, index) => (
        <div className="timeline-row" key={`${entry.occurredAt}-${entry.scenarioId}-${index}`}>
          <span className="time">{time(entry.occurredAt)}</span>
          <span className="sid">{entry.scenarioId}</span>
          <span className="state">
            <span className={`badge state-${entry.state}`}>{entry.state}</span>
          </span>
          <span className="msg">
            {entry.message}
            {/* Buffered rows were captured while PostgreSQL was intentionally unavailable. */}
            {entry.source === 'buffer' ? <span className="buffered">buffered</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}
