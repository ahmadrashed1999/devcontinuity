'use client';

/** Browser-side API helper. Auth is the HttpOnly cookie set by the proxy; no token ever lives in JS. */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`/api/${path.replace(/^\//, '')}`, {
    ...rest,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface JobState {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  total: number;
  message: string;
  log: string[];
  result?: unknown;
  error?: string;
}

/** Follows a background job over Server-Sent Events. Returns an unsubscribe function. */
export function followJob(id: string, onUpdate: (j: JobState) => void): () => void {
  const es = new EventSource(`/api/jobs/${id}/stream`);
  es.onmessage = (e) => {
    const j = JSON.parse(e.data) as JobState;
    onUpdate(j);
    if (j.status !== 'running') es.close();
  };
  es.onerror = () => {
    es.close();
    // Fall back to one poll so the final state is not lost.
    api<JobState>(`jobs/${id}`).then(onUpdate).catch(() => undefined);
  };
  return () => es.close();
}

export function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
