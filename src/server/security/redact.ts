/**
 * Secret redaction. Applied to every piece of transcript text before it is stored in the
 * database, exported, placed in a handoff, or sent to an AI provider. The byte-exact
 * originals stay only in the local archive.
 */

type Rule = { name: string; re: RegExp; replace: (...m: string[]) => string };

const R = (name: string) => `[REDACTED:${name}]`;

const RULES: Rule[] = [
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: () => R('private-key'),
  },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replace: () => R('anthropic-key') },
  { name: 'api-key', re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{24,}/g, replace: () => R('api-key') },
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, replace: () => R('github-token') },
  { name: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => R('aws-key') },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => R('google-key') },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: () => R('slack-token') },
  { name: 'stripe-key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: () => R('stripe-key') },
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replace: () => R('jwt'),
  },
  { name: 'bearer', re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, replace: (_m, p1) => `${p1}${R('bearer')}` },
  {
    name: 'url-credentials',
    re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"]{1,80}:)([^\s@/'"]{3,})(@)/gi,
    replace: (_m, p1, _p2, p3) => `${p1}${R('password')}${p3}`,
  },
  {
    // ENV style: SOME_API_KEY=value
    name: 'env-secret',
    re: /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)[A-Z0-9_]*[ \t]*=[ \t]*)(["']?)([^\s"']{6,})\2/g,
    replace: (_m, p1, q) => `${p1}${q}${R('secret')}${q}`,
  },
  {
    // "apiKey": "literal" / password = 'literal' — quoted literals only, so ordinary code is left alone
    name: 'quoted-secret',
    re: /((?:api[_-]?key|secret|token|passwd|password|private[_-]?key)["']?\s*[:=]\s*)(["'])([^"'\s]{8,})\2/gi,
    replace: (_m, p1, q) => `${p1}${q}${R('secret')}${q}`,
  },
];

export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, rule.replace as (...args: string[]) => string);
  }
  return out;
}

/** Redact every string inside a JSON-compatible value (used for raw record views and exports). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

export function containsSecret(input: string): boolean {
  return redactSecrets(input) !== input;
}
