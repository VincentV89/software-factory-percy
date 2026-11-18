import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api';

export function ErrorBox({ error, testId = 'error-message' }: { error: unknown; testId?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof ApiError ? error.details : [];
  return (
    <div className="error" role="alert" data-testid={testId}>
      <p>{message}</p>
      {details.length > 0 && (
        <ul>
          {details.map((d, i) => (
            <li key={i}>{d.field ? `${d.field}: ` : ''}{d.reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Empty({ children, testId }: { children: ReactNode; testId: string }) {
  return <div className="empty" data-testid={testId}>{children}</div>;
}

/** Loads data and reloads on demand or on an interval. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], intervalMs?: number): { data?: T; error?: unknown; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    load().then(
      (d) => alive && (setData(d), setError(undefined)),
      (e: unknown) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [...deps, tick]);
  useEffect(() => {
    if (!intervalMs) return;
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

export function StateBadge({ state, testId }: { state: string; testId?: string }) {
  return <span className={`badge badge-${state.toLowerCase()}`} data-testid={testId}>{state}</span>;
}

export function formatTime(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}
