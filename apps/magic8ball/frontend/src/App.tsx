import { useCallback, useEffect, useState } from 'react';

interface AnswerResponse {
  question: string;
  answer: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  latencyMs: number;
  persisted: boolean;
  version: string;
  imageTag: string;
  variant: string;
}

interface VersionInfo {
  service: string;
  version: string;
  imageTag: string;
  gitCommit: string;
  buildTimestamp: string;
  variant: string;
}

interface HistoryEntry {
  askedAt: string;
  question: string;
  answer: string;
  sentiment: string;
}

const SUGGESTIONS = [
  'Will the deployment succeed?',
  'Is the database healthy?',
  'Should we scale the cluster?',
  'Will the certificate outlive the demo?',
];

export default function App() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AnswerResponse | null>(null);
  const [shaking, setShaking] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyAvailable, setHistoryAvailable] = useState(true);
  const [serviceHealthy, setServiceHealthy] = useState<boolean | null>(null);
  const [latency, setLatency] = useState<number | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch('/api/history');
      const body = (await response.json()) as { available: boolean; answers: HistoryEntry[] };
      setHistoryAvailable(body.available);
      setHistory(body.answers ?? []);
    } catch {
      setHistoryAvailable(false);
    }
  }, []);

  // Health and latency indicators, so degradation is visible on this page too.
  useEffect(() => {
    const check = async () => {
      const started = performance.now();
      try {
        const response = await fetch('/healthz', { cache: 'no-store' });
        setServiceHealthy(response.ok);
        setLatency(Math.round(performance.now() - started));
      } catch {
        setServiceHealthy(false);
        setLatency(null);
      }
    };
    void check();
    void loadHistory();
    fetch('/api/version')
      .then((response) => response.json())
      .then((body: VersionInfo) => setVersion(body))
      .catch(() => undefined);

    const handle = window.setInterval(() => void check(), 10_000);
    return () => window.clearInterval(handle);
  }, [loadHistory]);

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || asking) return;

    setAsking(true);
    setError(null);
    setShaking(true);
    window.setTimeout(() => setShaking(false), 620);

    const started = performance.now();
    try {
      const response = await fetch('/api/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      });
      setLatency(Math.round(performance.now() - started));

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed with status ${response.status}`);
      }

      const body = (await response.json()) as AnswerResponse;
      setAnswer(body);
      setQuestion('');
      void loadHistory();
    } catch (askError) {
      setAnswer(null);
      setError(askError instanceof Error ? askError.message : String(askError));
    } finally {
      setAsking(false);
    }
  };

  const healthDot = serviceHealthy === null ? '' : serviceHealthy ? 'good' : 'bad';
  const latencyDot = latency === null ? '' : latency > 2500 ? 'bad' : latency > 900 ? 'warn' : 'good';

  return (
    <div className="page">
      <header className="hero">
        <div>
          <h1>Magic 8 Ball</h1>
          <p>Sample workload for the Azure SRE Agent Demo Lab</p>
        </div>
        <div className="hero-spacer" />
        <div className="status-strip">
          <span className="pill">
            <span className={`dot ${healthDot}`} />
            {serviceHealthy === null ? 'checking' : serviceHealthy ? 'service healthy' : 'service unhealthy'}
          </span>
          <span className="pill">
            <span className={`dot ${latencyDot}`} />
            {latency === null ? 'latency —' : `latency ${latency}ms`}
          </span>
          {version ? <span className="pill">build {version.imageTag}</span> : null}
        </div>
      </header>

      {error ? <div className="notice bad">{error}</div> : null}
      {!historyAvailable ? (
        <div className="notice warn">
          History is unavailable — the database cannot be reached. Answers still work; recent questions are
          not being recorded.
        </div>
      ) : null}

      <div className="layout">
        <section className="stage">
          <div className={`ball${shaking ? ' shaking' : ''}`} aria-live="polite">
            <div className="window">
              <div className="triangle">
                {asking ? (
                  <span className="answer-text">…</span>
                ) : answer ? (
                  <span className="answer-text" key={`${answer.answer}-${answer.latencyMs}`}>
                    {answer.answer}
                  </span>
                ) : error ? (
                  <span className="answer-text error">Try again</span>
                ) : (
                  <span className="answer-text">Ask a question</span>
                )}
              </div>
            </div>
          </div>

          <form
            className="ask-form"
            onSubmit={(event) => {
              event.preventDefault();
              void ask(question);
            }}
          >
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask the Magic 8 Ball a yes or no question…"
              maxLength={200}
              aria-label="Your question"
            />
            <button type="submit" disabled={asking || question.trim().length === 0}>
              {asking ? 'Consulting…' : 'Ask'}
            </button>
          </form>

          <div className="hint-row">
            {SUGGESTIONS.map((suggestion) => (
              <button
                type="button"
                className="chip"
                key={suggestion}
                onClick={() => {
                  setQuestion(suggestion);
                  void ask(suggestion);
                }}
                disabled={asking}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </section>

        <aside>
          <div className="panel">
            <h2>Recent questions</h2>
            {history.length === 0 ? (
              <div className="empty">
                {historyAvailable ? 'No questions asked yet.' : 'History unavailable while the database is down.'}
              </div>
            ) : (
              history.map((entry, index) => (
                <div className="history-item" key={`${entry.askedAt}-${index}`}>
                  <div className="q">{entry.question}</div>
                  <div className={`a ${entry.sentiment}`}>
                    {entry.answer} · {new Date(entry.askedAt).toLocaleTimeString()}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="panel">
            <h2>Build information</h2>
            <div className="panel-body">
              {version ? (
                <div className="meta-grid">
                  <span className="k">version</span>
                  <span className="v">{version.version}</span>
                  <span className="k">image tag</span>
                  <span className="v">{version.imageTag}</span>
                  <span className="k">variant</span>
                  <span className="v">{version.variant}</span>
                  <span className="k">commit</span>
                  <span className="v">{version.gitCommit}</span>
                  <span className="k">built</span>
                  <span className="v">{version.buildTimestamp}</span>
                </div>
              ) : (
                <div className="empty">Build information unavailable.</div>
              )}
            </div>
          </div>

          {answer ? (
            <div className="panel">
              <h2>Last response</h2>
              <div className="panel-body">
                <div className="meta-grid">
                  <span className="k">latency</span>
                  <span className="v">{answer.latencyMs}ms</span>
                  <span className="k">recorded</span>
                  <span className="v">{answer.persisted ? 'yes' : 'no (database unavailable)'}</span>
                  <span className="k">served by</span>
                  <span className="v">{answer.imageTag}</span>
                </div>
              </div>
            </div>
          ) : null}
        </aside>
      </div>

      <footer>Azure SRE Agent Demo Lab · answers are generated by the API, not the browser</footer>
    </div>
  );
}
