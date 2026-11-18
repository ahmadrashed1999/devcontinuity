import { getSetting, prisma } from './db';
import { redactSecrets } from './security/redact';

/** Append-only audit trail. The UI can read it but has no way to edit or delete entries. */
export async function audit(actor: string, action: string, target?: string | null, detail?: unknown): Promise<void> {
  await prisma()
    .auditEvent.create({ data: { actor, action, target: target ?? null, detail: detail === undefined ? null : redactSecrets(JSON.stringify(detail)).slice(0, 8000) } })
    .catch(() => undefined);
}

export type NotifyLevel = 'info' | 'success' | 'warning' | 'error';

/** In-app notification (shown in the bell and as a Windows balloon by the tray app). */
export async function notify(level: NotifyLevel, title: string, body?: string, link?: string, dedupeKey?: string): Promise<void> {
  const data = { level, title: title.slice(0, 200), body: body ? redactSecrets(body).slice(0, 2000) : null, link: link ?? null };
  try {
    if (dedupeKey) await prisma().notification.upsert({ where: { dedupeKey }, create: { ...data, dedupeKey }, update: {} });
    else await prisma().notification.create({ data });
  } catch {
    /* notifications must never break the caller */
  }
}

export async function isKillSwitchOn(): Promise<boolean> {
  return getSetting<boolean>('killSwitch', false);
}
