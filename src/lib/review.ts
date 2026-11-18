/**
 * "Review before sharing": splits a briefing or handoff file into sections the owner can drop, and
 * finds what deserves a second look before the text leaves the machine: secrets the redactor already
 * replaced, strings that still look like secrets, e-mail addresses and home-folder paths that reveal
 * a user name. Pure functions, used by the browser review dialog and by the tests.
 */

export interface ReviewSection {
  id: string;
  /** Heading line ("## Last user request"), or "" for the text before the first heading. */
  title: string;
  /** Full text of the section, heading included. */
  text: string;
}

export type FindingKind = 'redacted' | 'secret' | 'email' | 'path';

export interface Finding {
  kind: FindingKind;
  start: number;
  end: number;
  match: string;
}

/** Splits Markdown at level-1/2 headings outside code fences. Joining the sections gives the input back. */
export function splitSections(text: string): ReviewSection[] {
  const lines = text.split('\n');
  const out: ReviewSection[] = [];
  let current: string[] = [];
  let title = '';
  let fence = false;
  const flush = () => {
    if (current.length === 0) return;
    out.push({ id: `s${out.length}`, title, text: current.join('\n') });
    current = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^#{1,2} \S/.test(line)) {
      flush();
      title = line.replace(/^#+ /, '').trim();
    }
    current.push(line);
  }
  flush();
  return out;
}

/** Joins the sections that were kept. */
export function assemble(sections: ReviewSection[], removed: Iterable<string>): string {
  const drop = new Set(removed);
  return sections
    .filter((s) => !drop.has(s.id))
    .map((s) => s.text)
    .join('\n');
}

const PATTERNS: { kind: FindingKind; re: RegExp }[] = [
  { kind: 'redacted', re: /\[REDACTED:[a-z-]+\]/g },
  // Long random-looking tokens: 32+ chars of base64/hex with letters and digits mixed in.
  { kind: 'secret', re: /(?<![A-Za-z0-9_/.-])(?=[A-Za-z0-9_+/=-]{32,})(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9_+/=-]{32,}(?![A-Za-z0-9_/.-])/g },
  { kind: 'secret', re: /-----BEGIN [A-Z ]+-----|\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{4,}/gi },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'path', re: /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^\\/\s"'`)]+/g },
];

/** Hex commit hashes and UUIDs are normal in briefings; they are not flagged as secrets. */
const BENIGN = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function findSensitive(text: string): Finding[] {
  const found: Finding[] = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (kind === 'secret' && BENIGN.test(m[0])) continue;
      if (kind === 'path' && /\\Users\\(Public|Default)$|\/home\/(runner|user)$/i.test(m[0])) continue;
      found.push({ kind, start: m.index, end: m.index + m[0].length, match: m[0] });
    }
  }
  // Earliest first; drop matches inside an earlier one (a redaction marker is not also a "secret").
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Finding[] = [];
  for (const f of found) if (!out.length || f.start >= out[out.length - 1].end) out.push(f);
  return out;
}

export function summarize(findings: Finding[]): Record<FindingKind, number> {
  const s: Record<FindingKind, number> = { redacted: 0, secret: 0, email: 0, path: 0 };
  for (const f of findings) s[f.kind]++;
  return s;
}

/** Text split into plain and highlighted runs, for rendering. */
export function highlightRuns(text: string, findings = findSensitive(text)): { text: string; kind?: FindingKind }[] {
  const runs: { text: string; kind?: FindingKind }[] = [];
  let at = 0;
  for (const f of findings) {
    if (f.start > at) runs.push({ text: text.slice(at, f.start) });
    runs.push({ text: text.slice(f.start, f.end), kind: f.kind });
    at = f.end;
  }
  if (at < text.length) runs.push({ text: text.slice(at) });
  return runs;
}
