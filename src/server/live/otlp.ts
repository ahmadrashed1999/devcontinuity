import { appendLive, normalizeAgentId } from './store';

type Rec = Record<string, unknown>;

/** OTLP AnyValue → plain JS value. */
export function anyValue(v: unknown): unknown {
  const o = v as Rec | undefined;
  if (!o || typeof o !== 'object') return v;
  if ('stringValue' in o) return o.stringValue;
  if ('boolValue' in o) return o.boolValue;
  if ('intValue' in o) return Number(o.intValue);
  if ('doubleValue' in o) return o.doubleValue;
  if ('bytesValue' in o) return o.bytesValue;
  if ('arrayValue' in o) return ((o.arrayValue as Rec)?.values as unknown[] | undefined)?.map(anyValue) ?? [];
  if ('kvlistValue' in o) return attrs((o.kvlistValue as Rec)?.values);
  return undefined;
}

export function attrs(list: unknown): Rec {
  const out: Rec = {};
  if (Array.isArray(list)) for (const kv of list as Rec[]) if (kv && typeof kv.key === 'string') out[kv.key] = anyValue(kv.value);
  return out;
}

/**
 * Splits an OTLP/HTTP JSON logs export (ExportLogsServiceRequest) into live records, one per log
 * record, routed by agent (service.name) and session (session.id / conversation.id).
 * Returns how many records were stored.
 */
export function ingestOtlpLogs(body: unknown): { stored: number; agents: string[] } {
  const agents = new Set<string>();
  let stored = 0;
  const resourceLogs = (body as Rec | undefined)?.resourceLogs;
  if (!Array.isArray(resourceLogs)) return { stored, agents: [] };
  for (const rl of resourceLogs as Rec[]) {
    const resource = attrs((rl.resource as Rec | undefined)?.attributes);
    const agent = normalizeAgentId(resource['service.name']);
    for (const sl of (rl.scopeLogs as Rec[] | undefined) ?? []) {
      for (const lr of (sl.logRecords as Rec[] | undefined) ?? []) {
        const a = attrs(lr.attributes);
        const name = (a['event.name'] as string | undefined) ?? (typeof anyValue(lr.body) === 'string' ? (anyValue(lr.body) as string) : undefined) ?? (lr.eventName as string | undefined) ?? 'log';
        const session = (a['session.id'] ?? a['conversation.id'] ?? a.session_id ?? resource['session.id']) as string | undefined;
        const time = (lr.timeUnixNano ?? lr.observedTimeUnixNano) as string | number | undefined;
        appendLive({
          source: 'otlp',
          agent,
          session: session ?? `${agent}-${new Date().toISOString().slice(0, 10)}`,
          payload: { name, time: time != null ? Number(time) : undefined, attributes: a, body: anyValue(lr.body), severity: lr.severityText, resource: { 'service.name': resource['service.name'], 'service.version': resource['service.version'] } },
        });
        agents.add(agent);
        stored++;
      }
    }
  }
  return { stored, agents: [...agents] };
}
