export function fmtDate(d: Date | string | null | undefined, withTime = true): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  return withTime ? `${s} ${p(date.getHours())}:${p(date.getMinutes())}` : s;
}

/** A moment n days before now (used for "last N days" filters). */
export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

/** Relative time ("5m ago" / "منذ 5 د"). Pass the UI language for Arabic. */
export function ago(d: Date | string | null | undefined, lang: 'en' | 'ar' = 'en'): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  const ar = lang === 'ar';
  if (s < 60) return ar ? 'الآن' : 'just now';
  if (s < 3600) return ar ? `منذ ${Math.floor(s / 60)} د` : `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return ar ? `منذ ${Math.floor(s / 3600)} س` : `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return ar ? `منذ ${Math.floor(s / 86400)} يوم` : `${Math.floor(s / 86400)}d ago`;
  return fmtDate(date, false);
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function fmtNum(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('en-US');
}

export const STATUS_STYLE: Record<string, string> = {
  completed: 'bg-success/15 text-success border-success/30',
  in_progress: 'bg-cyan/15 text-cyan border-cyan/30',
  pending: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  blocked: 'bg-warning/15 text-warning border-warning/30',
  failed: 'bg-danger/15 text-danger border-danger/30',
  requires_verification: 'bg-primary/15 text-indigo-300 border-primary/30',
  cancelled: 'bg-slate-700/30 text-slate-400 border-slate-600/40',
};

export const VERIFY_STYLE: Record<string, string> = {
  verified: 'text-success',
  evidence_found: 'text-cyan',
  ai_reported: 'text-indigo-300',
  unverified: 'text-slate-400',
  failed: 'text-danger',
};

export const END_STATE_STYLE: Record<string, string> = {
  completed_turn: 'bg-success/15 text-success border-success/30',
  interrupted_tool: 'bg-warning/15 text-warning border-warning/30',
  interrupted_response: 'bg-warning/15 text-warning border-warning/30',
  awaiting_assistant: 'bg-cyan/15 text-cyan border-cyan/30',
  api_error: 'bg-danger/15 text-danger border-danger/30',
  empty: 'bg-slate-700/30 text-slate-400 border-slate-600/40',
  unknown: 'bg-slate-700/30 text-slate-400 border-slate-600/40',
};

export const label = (s: string | null | undefined) => (s ?? '').replace(/_/g, ' ');

export const AGENT_COLORS: Record<string, string> = {
  'claude-code': 'text-orange-300',
  opencode: 'text-cyan',
  codex: 'text-emerald-300',
  cursor: 'text-sky-300',
  antigravity: 'text-indigo-300',
  'gemini-cli': 'text-blue-300',
  cline: 'text-violet-300',
  'roo-code': 'text-fuchsia-300',
  'kilo-code': 'text-pink-300',
  copilot: 'text-lime-300',
  continue: 'text-teal-300',
  windsurf: 'text-amber-200',
  generic: 'text-slate-300',
};

/** Display names for every agent id a session can carry (adapters and live-captured agents). */
export const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  'gemini-cli': 'Gemini CLI',
  cline: 'Cline',
  'roo-code': 'Roo Code',
  'kilo-code': 'Kilo Code',
  copilot: 'GitHub Copilot',
  continue: 'Continue',
  windsurf: 'Windsurf',
  aider: 'Aider',
  'qwen-code': 'Qwen Code',
  amp: 'Amp',
  'copilot-cli': 'Copilot CLI',
  kiro: 'Kiro',
  trae: 'Trae',
  zed: 'Zed',
  live: 'Live capture',
  generic: 'Generic import',
};

export function agentName(id: string | null | undefined): string {
  if (!id) return 'Unknown agent';
  return AGENT_NAMES[id] ?? id.replace(/(^|-)([a-z])/g, (_m, sep: string, c: string) => `${sep ? ' ' : ''}${c.toUpperCase()}`);
}
