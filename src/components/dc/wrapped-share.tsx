'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { AGENT_HEX } from '@/lib/format';
import type { Dict, Lang } from '@/lib/i18n';
import { useT } from './lang';

export interface ShareStats {
  periodLabel: string;
  sessions: number;
  prompts: number;
  toolCalls: number;
  activeDays: number;
  agents: { agent: string; label: string; sessions: number; finishRate: number }[];
  topProject: string | null;
  tokens: number | null;
}

const W = 1200;
const H = 630;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const compact = (n: number, lang: Lang) => new Intl.NumberFormat(lang === 'ar' ? 'ar' : 'en', { notation: n >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);

/** Draws the 1200×630 share card. Everything happens on a local canvas; nothing is uploaded. */
export function drawWrapped(canvas: HTMLCanvasElement, s: ShareStats, t: Dict, lang: Lang, fontFamily: string) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const rtl = lang === 'ar';
  ctx.direction = rtl ? 'rtl' : 'ltr';
  const x0 = rtl ? W - 72 : 72;
  const font = (weight: number, size: number) => `${weight} ${size}px ${fontFamily}`;

  // Background
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0b1020');
  bg.addColorStop(1, '#111a33');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.85, H * 0.1, 10, W * 0.85, H * 0.1, 520);
  glow.addColorStop(0, 'rgba(99,102,241,0.35)');
  glow.addColorStop(1, 'rgba(99,102,241,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Header
  ctx.textAlign = 'start';
  ctx.fillStyle = '#a5b4fc';
  ctx.font = font(600, 24);
  ctx.fillText(`${t.wrappedShareTitle} · ${s.periodLabel}`, x0, 92);
  ctx.fillStyle = '#ffffff';
  ctx.font = font(800, 92);
  ctx.fillText(compact(s.sessions, lang), x0, 196);
  const numW = ctx.measureText(compact(s.sessions, lang)).width;
  ctx.font = font(600, 34);
  ctx.fillStyle = '#cbd5e1';
  const sub = `${t.wrappedSessions} ${t.wrappedAcross.replace('{n}', String(s.agents.length))}`;
  ctx.fillText(sub, rtl ? x0 - numW - 22 : x0 + numW + 22, 192);

  // Stat chips
  const chips: [string, string][] = [
    [compact(s.prompts, lang), t.wrappedPrompts],
    [compact(s.toolCalls, lang), t.wrappedToolCalls],
    [compact(s.activeDays, lang), t.wrappedActiveDays],
    ...(s.tokens ? ([[compact(s.tokens, lang), t.wrappedTokens]] as [string, string][]) : []),
  ];
  let cx = rtl ? W - 72 : 72;
  for (const [v, l] of chips.slice(0, 4)) {
    ctx.font = font(700, 30);
    const vw = ctx.measureText(v).width;
    ctx.font = font(500, 20);
    const lw = ctx.measureText(l).width;
    const w = Math.max(vw, lw) + 40;
    const left = rtl ? cx - w : cx;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    roundRect(ctx, left, 236, w, 86, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = font(700, 30);
    ctx.fillText(v, rtl ? left + w - 20 : left + 20, 276);
    ctx.fillStyle = '#94a3b8';
    ctx.font = font(500, 20);
    ctx.fillText(l, rtl ? left + w - 20 : left + 20, 306);
    cx = rtl ? left - 14 : left + w + 14;
  }

  // Agent bars
  const top = s.agents.slice(0, 5);
  const max = Math.max(1, ...top.map((a) => a.sessions));
  const barX = rtl ? W - 72 - 230 : 72 + 230;
  const barMax = 560;
  top.forEach((a, i) => {
    const y = 372 + i * 40;
    const color = AGENT_HEX[a.agent] ?? '#cbd5e1';
    ctx.fillStyle = color;
    ctx.font = font(600, 22);
    ctx.textAlign = 'start';
    ctx.fillText(a.label, x0, y + 20);
    const w = Math.max(8, (a.sessions / max) * barMax);
    roundRect(ctx, rtl ? barX - w : barX, y + 4, w, 22, 11);
    ctx.fill();
    ctx.fillStyle = '#e2e8f0';
    ctx.font = font(600, 20);
    ctx.fillText(`${compact(a.sessions, lang)} · ${Math.round(a.finishRate * 100)}% ${t.wrappedFinished}`, rtl ? barX - w - 14 : barX + w + 14, y + 22);
  });

  // Footer
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(0, H - 64, W, 64);
  ctx.textAlign = 'start';
  ctx.fillStyle = '#94a3b8';
  ctx.font = font(500, 20);
  if (s.topProject) ctx.fillText(`${t.wrappedTopProjects}: ${s.topProject}`, x0, H - 25);
  ctx.textAlign = rtl ? 'left' : 'right';
  ctx.fillStyle = '#e2e8f0';
  ctx.font = font(700, 22);
  ctx.direction = 'ltr';
  ctx.fillText('DevContinuity · npx devcontinuity', rtl ? 72 : W - 72, H - 24);
}

export function WrappedShare({ stats, fileName }: { stats: ShareStats; fileName: string }) {
  const { t, lang } = useT();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      await document.fonts?.ready;
      const canvas = document.createElement('canvas');
      drawWrapped(canvas, stats, t, lang, getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif');
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button onClick={download} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-lg bg-gradient-to-r from-primary to-cyan px-4 text-sm font-semibold text-white shadow-lg shadow-primary/20 hover:opacity-90 disabled:opacity-60">
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
      {t.wrappedDownload}
    </button>
  );
}
