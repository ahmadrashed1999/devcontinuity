'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, Bot, Loader2, Mic, MicOff, Power, Rocket, Terminal } from 'lucide-react';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Minimal, safe Markdown renderer (no raw HTML): headings, lists, bold, inline code, code blocks, links to internal pages. */
export function Md({ text, className }: { text: string; className?: string }) {
  const lines = (text ?? '').replace(/\r/g, '').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  const inline = (s: string, k: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`|\[S\d+\])/g).map((p, j) => {
      if (p.startsWith('**') && p.endsWith('**')) return <strong key={`${k}-${j}`} className="text-white">{p.slice(2, -2)}</strong>;
      if (p.startsWith('`') && p.endsWith('`')) return <code key={`${k}-${j}`} className="rounded bg-black/40 px-1 font-mono text-[0.85em] text-cyan">{p.slice(1, -1)}</code>;
      if (/^\[S\d+\]$/.test(p)) return <a key={`${k}-${j}`} href={`#src-${p.slice(2, -1)}`} className="rounded bg-primary/20 px-1 text-[0.8em] text-indigo-200">{p.slice(1, -1)}</a>;
      return <Fragment key={`${k}-${j}`}>{p}</Fragment>;
    });
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(<pre key={i} className="my-2 overflow-auto rounded-md bg-black/40 p-2 font-mono text-[11px] text-slate-300">{buf.join('\n')}</pre>);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) out.push(<div key={i} className={cn('mt-3 mb-1 font-semibold text-white', h[1].length === 1 ? 'text-lg' : h[1].length === 2 ? 'text-base' : 'text-sm')}>{inline(h[2], `h${i}`)}</div>);
    else if (/^\s*[-*]\s+/.test(l)) out.push(<div key={i} className="flex gap-2 ps-1" style={{ paddingInlineStart: `${(l.match(/^\s*/)?.[0].length ?? 0) * 6}px` }}><span className="text-slate-500">•</span><span>{inline(l.replace(/^\s*[-*]\s+/, ''), `l${i}`)}</span></div>);
    else if (/^\s*\d+\.\s+/.test(l)) out.push(<div key={i} className="flex gap-2"><span className="text-slate-500">{l.match(/^\s*(\d+)\./)?.[1]}.</span><span>{inline(l.replace(/^\s*\d+\.\s+/, ''), `n${i}`)}</span></div>);
    else if (l.trim() === '') out.push(<div key={i} className="h-2" />);
    else out.push(<div key={i}>{inline(l, `p${i}`)}</div>);
    i++;
  }
  return <div className={cn('text-sm leading-relaxed text-slate-300', className)}>{out}</div>;
}

type SR = { lang: string; interimResults: boolean; continuous: boolean; start: () => void; stop: () => void; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void; onerror: (e: { error: string }) => void };

/** Voice input via the browser's speech recognition (Chrome/Edge). Note: the browser vendor processes the audio. */
export function VoiceButton({ onText, lang }: { onText: (t: string) => void; lang?: 'en' | 'ar' }) {
  const [on, setOn] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [l, setL] = useState<'en' | 'ar'>(lang ?? 'en');
  const rec = useRef<SR | null>(null);
  const start = () => {
    const W = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) return setErr('Voice input needs Chrome or Edge.');
    const r = new Ctor();
    r.lang = l === 'ar' ? 'ar-SA' : 'en-US';
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e) => onText(Array.from(e.results).map((x) => x[0].transcript).join(' '));
    r.onend = () => setOn(false);
    r.onerror = (e) => {
      setErr(e.error === 'not-allowed' ? 'Microphone permission denied.' : `Voice error: ${e.error}`);
      setOn(false);
    };
    rec.current = r;
    setErr(null);
    setOn(true);
    r.start();
  };
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" onClick={() => (on ? rec.current?.stop() : start())} title="Voice input (Arabic / English)" className={cn('inline-flex h-9 items-center gap-1 rounded-lg border px-2.5 text-sm', on ? 'animate-pulse border-danger/60 bg-danger/15 text-red-200' : 'border-border text-slate-300 hover:bg-secondary')}>
        {on ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </button>
      <button type="button" onClick={() => setL(l === 'en' ? 'ar' : 'en')} className="h-9 rounded-lg border border-border px-2 text-xs text-slate-400" title="Recognition language">{l === 'en' ? 'EN' : 'ع'}</button>
      {err && <span className="text-xs text-warning">{err}</span>}
    </span>
  );
}

interface Detected {
  agent: string;
  path: string | null;
  kind: 'cli' | 'app' | null;
}
let detectCache: Promise<{ agents: Detected[] }> | null = null;

const LAUNCH_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', terminal: 'Terminal' };

/** "Open in …" buttons: a new terminal opens in the right folder/worktree with the agent started and the briefing loaded. */
export function LaunchButtons({ projectId, sessionId, dir, resumeClaude, compact }: { projectId?: string; sessionId?: string; dir?: string; resumeClaude?: boolean; compact?: boolean }) {
  const [agents, setAgents] = useState<Detected[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    detectCache ??= api<{ agents: Detected[] }>('agents/detect');
    detectCache.then((r) => setAgents(r.agents)).catch(() => setAgents([]));
  }, []);
  const launch = async (agent: string, resume = false) => {
    setBusy(agent + resume);
    setMsg(null);
    try {
      const r = await api<{ note: string; dir: string }>('launch', { method: 'POST', json: { agent, projectId, sessionId, dir, resume } });
      setMsg({ ok: true, text: `${r.note} (${r.dir})` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {!compact && <span className="text-xs text-muted-foreground"><Rocket className="me-1 inline size-3.5" />Open in</span>}
        {(agents ?? []).filter((a) => a.agent !== 'terminal').map((a) => (
          <button key={a.agent} disabled={!a.path || !!busy} onClick={() => launch(a.agent)} title={a.path ? `${a.path}${a.kind === 'app' ? ' (desktop app: prompt goes to the clipboard)' : ''}` : 'Not installed — set its path in Settings → Agents'} className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2.5 text-xs text-slate-200 hover:border-primary/50 hover:bg-primary/10 disabled:opacity-40">
            {busy === a.agent + 'false' ? <Loader2 className="size-3.5 animate-spin" /> : <Bot className="size-3.5" />}
            {LAUNCH_LABEL[a.agent]}
          </button>
        ))}
        {resumeClaude && agents?.find((a) => a.agent === 'claude-code')?.path && (
          <button disabled={!!busy} onClick={() => launch('claude-code', true)} className="inline-flex h-8 items-center gap-1 rounded-lg border border-orange-400/30 px-2.5 text-xs text-orange-200 hover:bg-orange-400/10" title="claude --resume <session id> (needs your Claude account)">
            Resume in Claude
          </button>
        )}
        <button disabled={!!busy} onClick={() => launch('terminal')} className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-xs text-slate-400 hover:bg-secondary" title="Terminal in the folder, prompt on the clipboard">
          <Terminal className="size-3.5" />
        </button>
        {agents === null && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </span>
      {msg && <span className={cn('max-w-xl text-xs', msg.ok ? 'text-success' : 'text-danger')}>{msg.text}</span>}
    </span>
  );
}

interface Notif {
  id: number;
  at: string;
  level: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
}

export function NotificationBell() {
  const [data, setData] = useState<{ unread: number; rows: Notif[] }>({ unread: 0, rows: [] });
  const [open, setOpen] = useState(false);
  const load = () => api<{ unread: number; rows: Notif[] }>('notifications').then(setData).catch(() => undefined);
  useEffect(() => {
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);
  const tone: Record<string, string> = { error: 'text-danger', warning: 'text-warning', success: 'text-success', info: 'text-cyan' };
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="relative inline-flex h-9 items-center rounded-lg border border-border px-2.5 text-slate-300 hover:bg-secondary" title="Notifications">
        <Bell className="size-4" />
        {data.unread > 0 && <span className="absolute -end-1 -top-1 rounded-full bg-danger px-1.5 text-[10px] font-semibold text-white">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="absolute end-0 z-50 mt-2 w-96 max-w-[90vw] overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2 text-sm">
            <span className="font-semibold text-white">Notifications</span>
            <button onClick={async () => { await api('notifications/read', { method: 'POST', json: {} }); void load(); }} className="text-xs text-primary">Mark all read</button>
          </div>
          <div className="max-h-[60vh] overflow-auto">
            {data.rows.length === 0 && <div className="p-4 text-sm text-muted-foreground">Nothing yet.</div>}
            {data.rows.map((n) => (
              <Link key={n.id} href={n.link ?? '#'} onClick={() => { setOpen(false); void api('notifications/read', { method: 'POST', json: { ids: [n.id] } }).then(load); }} className={cn('block border-b border-border/50 px-3 py-2 hover:bg-secondary/40', !n.read && 'bg-primary/5')}>
                <div className={cn('text-sm font-medium', tone[n.level] ?? 'text-slate-200')}>{n.title}</div>
                {n.body && <div className="line-clamp-2 text-xs text-muted-foreground">{n.body}</div>}
                <div className="text-[10px] text-slate-500">{ago(n.at)}</div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function KillSwitch({ big }: { big?: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    api<{ on: boolean }>('killswitch').then((r) => setOn(r.on)).catch(() => undefined);
  }, []);
  const toggle = async () => {
    const next = !on;
    if (next && !window.confirm('Stop ALL AI organization activity now? Running work is aborted and queued work waits until you resume.')) return;
    const r = await api<{ on: boolean }>('killswitch', { method: 'PUT', json: { on: next } });
    setOn(r.on);
    router.refresh();
  };
  if (on === null) return null;
  return (
    <button onClick={toggle} title={on ? 'AI organization is STOPPED — click to resume' : 'Kill switch: stop all AI agents'} className={cn('inline-flex items-center gap-1.5 rounded-lg border font-medium', big ? 'h-10 px-4 text-sm' : 'h-9 px-2.5 text-xs', on ? 'border-danger bg-danger text-white' : 'border-danger/40 text-red-300 hover:bg-danger/10')}>
      <Power className="size-4" />
      {on ? 'STOPPED — Resume' : big ? 'Kill switch: stop all agents' : 'Stop all'}
    </button>
  );
}
