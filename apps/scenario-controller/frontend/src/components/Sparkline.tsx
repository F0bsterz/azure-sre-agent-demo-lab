/** Minimal inline sparkline: enough trend to see a fault developing live. */

interface Props {
  values: number[];
  /** Values above this render in warning colour, and 1.25x it in alert colour. */
  warnAt?: number;
  height?: number;
}

export function Sparkline({ values, warnAt, height = 34 }: Props) {
  if (values.length < 2) {
    return <svg className="sparkline" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" />;
  }

  const max = Math.max(...values, warnAt ?? 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = 100 / (values.length - 1);

  const points = values.map((value, index) => {
    const x = index * step;
    const y = height - ((value - min) / span) * (height - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const latest = values[values.length - 1] ?? 0;
  const tone = warnAt === undefined ? '' : latest >= warnAt * 1.25 ? 'bad' : latest >= warnAt ? 'warn' : '';

  return (
    <svg
      className={`sparkline ${tone}`.trim()}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Trend, latest value ${latest}`}
    >
      <polygon className="area" points={`0,${height} ${points.join(' ')} 100,${height}`} />
      <polyline className="line" points={points.join(' ')} />
    </svg>
  );
}
