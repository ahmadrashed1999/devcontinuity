import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const COOKIE = 'dc_token';

let cached: string | undefined;
/** Same token file as src/server/config.ts apiToken(); kept self-contained so the proxy bundle stays small. */
function apiToken(): string {
  if (cached) return cached;
  const dir = process.env.DEVCONTINUITY_DATA_DIR?.trim() || (process.env.DEVCONTINUITY_PACKAGED === '1' ? path.join(os.homedir(), '.devcontinuity') : path.join(process.cwd(), 'data'));
  const file = path.join(dir, '.api-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{48,}$/.test(t)) return (cached = t);
  } catch {
    /* first run */
  }
  fs.mkdirSync(dir, { recursive: true });
  const t = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, t, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return (cached = t);
  } catch {
    // Another process created it first.
    return (cached = fs.readFileSync(file, 'utf8').trim());
  }
}

function same(a: string | undefined | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Local-only protection for every request:
 * - Only localhost Host headers are served (blocks DNS-rebinding and LAN access).
 * - API calls need the local token: an HttpOnly SameSite=Strict cookie (set when the UI loads)
 *   or "Authorization: Bearer <token>" for CLI/scripts. Cross-origin API calls are rejected.
 */
// ---- Cloudflare Access verification for remote (phone) access ----
let jwks: { keys: (crypto.JsonWebKey & { kid?: string })[]; at: number } | undefined;
async function accessKeys(team: string) {
  if (jwks && Date.now() - jwks.at < 3600_000) return jwks.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error('Cannot load Cloudflare Access keys.');
  jwks = { keys: ((await res.json()) as { keys: (crypto.JsonWebKey & { kid?: string })[] }).keys, at: Date.now() };
  return jwks.keys;
}

/** Verifies the Cf-Access-Jwt-Assertion header (RS256, audience, issuer, expiry). */
async function verifyAccess(req: NextRequest): Promise<boolean> {
  const team = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const aud = process.env.CF_ACCESS_AUD?.trim();
  const jwt = req.headers.get('cf-access-jwt-assertion');
  if (!team || !aud || !jwt) return false;
  const [h, p, s] = jwt.split('.');
  if (!h || !p || !s) return false;
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg: string; kid: string };
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as { aud: string | string[]; iss: string; exp: number };
    if (header.alg !== 'RS256') return false;
    const key = (await accessKeys(team)).find((k) => k.kid === header.kid);
    if (!key) return false;
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key, format: 'jwk' }), Buffer.from(s, 'base64url'));
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    return ok && auds.includes(aud) && payload.iss === `https://${team}` && payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

export async function proxy(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').toLowerCase();
  const hostname = host.replace(/:\d+$/, '');
  const local = LOCAL_HOSTS.has(hostname);
  // The read-only public demo (DEVCONTINUITY_DEMO=1) is served on any host name; the API route refuses every write.
  const demo = process.env.DEVCONTINUITY_DEMO === '1';
  if (!local && !demo) {
    const hosts = (process.env.DEVCONTINUITY_REMOTE_HOSTS ?? '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
    if (process.env.DEVCONTINUITY_ALLOW_REMOTE !== '1' || !hosts.includes(hostname)) return new NextResponse('DevContinuity only accepts local requests (open it via http://localhost).', { status: 403 });
    if (!(await verifyAccess(req))) return new NextResponse('Remote access requires a valid Cloudflare Access login.', { status: 403 });
  }
  const token = apiToken();
  const headers = new Headers(req.headers);
  headers.delete('x-dc-remote');
  if (!local) headers.set('x-dc-remote', '1');
  if (req.nextUrl.pathname.startsWith('/api/')) {
    const origin = req.headers.get('origin');
    if (origin) {
      let ok = false;
      try {
        ok = new URL(origin).host.toLowerCase() === host;
      } catch {
        ok = false;
      }
      if (!ok) return NextResponse.json({ error: 'Cross-origin request rejected.' }, { status: 403 });
    }
    const auth = req.headers.get('authorization');
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    // Telemetry exporters that cannot send headers (Gemini CLI) put the token in the path instead.
    const pathToken = local ? req.nextUrl.pathname.match(/^\/api\/(?:otlp|ingest)\/t\/([a-f0-9]+)(?:\/|$)/)?.[1] : undefined;
    if (!same(req.cookies.get(COOKIE)?.value, token) && !same(bearer, token) && !same(pathToken, token)) return NextResponse.json({ error: 'Unauthorized. Open the DevContinuity UI first, or send the local API token.' }, { status: 401 });
    return NextResponse.next({ request: { headers } });
  }
  const res = NextResponse.next({ request: { headers } });
  const secure = demo ? req.headers.get('x-forwarded-proto') === 'https' || req.nextUrl.protocol === 'https:' : !local;
  if (!same(req.cookies.get(COOKIE)?.value, token)) res.cookies.set(COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', secure });
  return res;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
