/**
 * Read-only demo mode (DEVCONTINUITY_DEMO=1), for a public instance serving the fictional demo
 * workspace (npm run demo). Every write, import, connect, launch and AI call is refused, and the API
 * never reveals anything about the host machine (agent binaries, home folders, GitHub, backups).
 */
export const isDemo = (): boolean => process.env.DEVCONTINUITY_DEMO === '1';

export const DEMO_MESSAGE = 'This is the read-only DevContinuity demo with fictional data. Install it on your machine (npx devcontinuity) to import your own agents, connect them and continue sessions.';

/** GET endpoints that inspect the host or hand out files: off in the demo. */
const BLOCKED_GET: RegExp[] = [
  /^inventory$/,
  /^agents\/detect$/,
  /^claude\/status$/,
  /^mcp$/,
  /^github\/status$/,
  /^projects\/[^/]+\/github$/,
  /^backup\/cloud$/,
  /^backups\/[^/]+\/download$/,
  /^handoffs\/[^/]+\/download$/,
  /^ai\/models$/,
  /^providers(\/.*)?$/,
  /^settings\/advanced$/,
  /^remote\/status$/,
  /^audit$/,
];

/** Whether the demo serves this API call. Only reads are allowed, minus the host-revealing ones. */
export function demoAllows(method: string, segs: string[]): boolean {
  const p = segs.join('/');
  // Rendering a handoff package for review writes nothing.
  if (method === 'POST' && p === 'handoffs/preview') return true;
  if (method !== 'GET') return false;
  return !BLOCKED_GET.some((re) => re.test(p));
}
