'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bot, Brain, ChevronDown, ChevronRight, FileText, Loader2, Paperclip, Settings2, Terminal, User, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Ev {
  id: number;
  seq: number;
  kind: string;
  role: string | null;
  rawType: string | null;
  subtype: string | null;
  timestamp: string | null;
  text: string | null;
  truncated: boolean;
  toolName: string | null;
  toolUseId: string | null;
  isError: boolean;
  isMeta: boolean;
  isSidechain: boolean;
  model: string | null;
  filePath: string | null;
  command: string | null;
  rawOffset: number | null;
  meta: Record<string, unknown> | null;
}

const GROUPS: { id: string; label: string; kinds: string[] }[] = [
  { id: 'conversation', label: 'Messages', kinds: ['user_message', 'assistant_message', 'summary'] },
  { id: 'tools', label: 'Tool calls & results', kinds: ['tool_call', 'tool_result'] },
  { id: 'thinking', label: 'Thinking', kinds: ['thinking'] },
  { id: 'errors', label: 'Errors', kinds: ['error'] },
  { id: 'system', label: 'System & attachments', kinds: ['system', 'attachment', 'file_snapshot'] },
  { id: 'meta', label: 'Metadata & unknown', kinds: ['meta', 'unknown'] },
];

const ICON: Record<string, typeof User> = { user_message: User, assistant_message: Bot, thinking: Brain, tool_call: Wrench, tool_result: Terminal, error: AlertTriangle, attachment: Paperclip, file_snapshot: FileText, system: Settings2, summary: FileText, meta: Settings2, unknown: Settings2 };
const TONE: Record<string, string> = { user_message: 'border-s-primary', assistant_message: 'border-s-cyan', tool_call: 'border-s-slate-500', tool_result: 'border-s-slate-600', error: 'border-s-danger', thinking: 'border-s-violet-500/50', summary: 'border-s-warning' };

function Raw({ sessionId, seq }: { sessionId: string; seq: number }) {
  const [data, setData] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api(`sessions/${sessionId}/raw/${seq}`).then(setData).catch((e) => setErr((e as Error).message));
  }, [sessionId, seq]);
  if (err) return <div className="text-xs text-danger">{err}</div>;
  if (!data) return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />;
  const d = data as { available: boolean; reason?: string; record?: unknown; text?: string; bytes?: number };
  if (!d.available) return <div className="text-xs text-muted-foreground">{d.reason}</div>;
  return <pre className="max-h-96 overflow-auto rounded-md bg-black/40 p-2 font-mono text-[11px] text-slate-300">{d.record !== undefined ? JSON.stringify(d.record, null, 2) : d.text}</pre>;
}

function EventRow({ e, sessionId }: { e: Ev; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const Icon = ICON[e.kind] ?? Settings2;
  const long = (e.text?.length ?? 0) > 600;
  const isConversation = e.kind === 'user_message' || e.kind === 'assistant_message';
  const title =
    e.kind === 'user_message' ? (e.isMeta ? `User (${e.subtype ?? 'injected'})` : 'User') :
    e.kind === 'assistant_message' ? 'Assistant' :
    e.kind === 'tool_call' ? `${e.toolName ?? 'tool'}` :
    e.kind === 'tool_result' ? `result${e.toolName ? ` · ${e.toolName}` : ''}` :
    `${e.kind.replace(/_/g, ' ')}${e.subtype ? ` · ${e.subtype}` : ''}`;
  const show = open || !long ? e.text : `${e.text?.slice(0, 600)}…`;
  return (
    <div className={cn('rounded-lg border border-border border-s-2 bg-card/70 px-3 py-2', TONE[e.kind] ?? 'border-s-transparent', e.isError && 'bg-danger/5', e.isMeta && 'opacity-75')}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Icon className={cn('size-3.5', e.isError ? 'text-danger' : 'text-muted-foreground')} />
        <span className={cn('font-medium', e.kind === 'user_message' && !e.isMeta ? 'text-indigo-300' : e.kind === 'assistant_message' ? 'text-cyan' : 'text-slate-300')}>{title}</span>
        {e.isError && <span className="text-danger">error</span>}
        {e.isSidechain && <span className="text-violet-300">sidechain</span>}
        {e.filePath && <span className="truncate font-mono text-[11px] text-slate-400" title={e.filePath}>{e.filePath}</span>}
        <span className="ms-auto text-[11px] text-slate-500">#{e.seq} · {fmtDate(e.timestamp)}</span>
        <button onClick={() => setRaw(!raw)} className="text-[11px] text-slate-500 hover:text-slate-200">{raw ? 'hide raw' : 'raw JSON'}</button>
      </div>
      {e.text && (
        <div className={cn('mt-1.5 whitespace-pre-wrap break-words text-sm', isConversation ? 'text-slate-200' : 'font-mono text-xs text-slate-400')}>
          {show}
          {long && (
            <button onClick={() => setOpen(!open)} className="ms-1 inline-flex items-center text-xs text-primary">
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {open ? 'less' : 'more'}
            </button>
          )}
          {e.truncated && <div className="mt-1 text-[11px] text-warning">Text truncated in the database. Use &quot;raw JSON&quot; for the full original record.</div>}
        </div>
      )}
      {raw && <div className="mt-2"><Raw sessionId={sessionId} seq={e.seq} /></div>}
    </div>
  );
}

/** Chronological timeline in original event order (seq), with filters, search and incremental loading. */
export function SessionTimeline({ sessionId, initialSeq }: { sessionId: string; initialSeq?: number }) {
  const [groups, setGroups] = useState<string[]>(['conversation', 'tools', 'errors']);
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [events, setEvents] = useState<Ev[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const kinds = GROUPS.filter((g) => groups.includes(g.id)).flatMap((g) => g.kinds);
  const kindsKey = kinds.join(',');
  const fetchPage = useCallback(
    async (after: number | undefined, replace: boolean) => {
      setLoading(true);
      setErr(null);
      try {
        const p = new URLSearchParams({ kinds: kindsKey, limit: '300' });
        if (after !== undefined) p.set('after', String(after));
        if (applied) p.set('q', applied);
        const r = await api<{ rows: Ev[]; hasMore: boolean }>(`sessions/${sessionId}/events?${p}`);
        setEvents((prev) => (replace ? r.rows : [...prev, ...r.rows]));
        setHasMore(r.hasMore);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [sessionId, kindsKey, applied],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load when filters change
    void fetchPage(initialSeq !== undefined ? initialSeq - 3 : undefined, true);
  }, [fetchPage, initialSeq]);

  return (
    <div>
      <div className="sticky top-14 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background/95 p-2 backdrop-blur">
        {GROUPS.map((g) => (
          <button key={g.id} onClick={() => setGroups((cur) => (cur.includes(g.id) ? cur.filter((x) => x !== g.id) : [...cur, g.id]))} className={cn('rounded-md border px-2 py-1 text-xs', groups.includes(g.id) ? 'border-primary/60 bg-primary/15 text-white' : 'border-border text-slate-400')}>
            {g.label}
          </button>
        ))}
        <form
          className="ms-auto flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(query.trim());
          }}
        >
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter text in this session" className="h-7 w-56 rounded-md border border-border bg-card px-2 text-xs" />
          <button className="h-7 rounded-md bg-secondary px-2 text-xs">Filter</button>
        </form>
      </div>
      {initialSeq !== undefined && <div className="mb-2 text-xs text-muted-foreground">Starting near event #{initialSeq}. <button className="text-primary" onClick={() => fetchPage(undefined, true)}>Load from the beginning</button></div>}
      {err && <div className="mb-2 text-sm text-danger">{err}</div>}
      <div className="space-y-2">
        {events.map((e) => (
          <EventRow key={e.id} e={e} sessionId={sessionId} />
        ))}
      </div>
      {!loading && events.length === 0 && <div className="py-10 text-center text-sm text-muted-foreground">No events match these filters.</div>}
      <div className="mt-4 flex justify-center">
        {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : hasMore && <button onClick={() => fetchPage(events[events.length - 1]?.seq, false)} className="h-8 rounded-lg border border-border px-4 text-sm hover:bg-secondary">Load more</button>}
      </div>
    </div>
  );
}
