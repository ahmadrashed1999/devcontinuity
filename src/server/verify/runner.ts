import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { audit } from '../audit';
import { prisma } from '../db';
import { redactSecrets } from '../security/redact';

/**
 * Runs a project's own test/build command on explicit owner request (or an owner-created schedule).
 * Commands come only from the project's manifests or from the owner, and must start with an
 * allow-listed program. Commands found in imported transcripts are never run.
 */

const ALLOWED = /^(npm|npx|pnpm|yarn|bun|flutter|dart|php|composer|vendor[\\/]bin[\\/](phpunit|pest)|pytest|python -m pytest|go|cargo|dotnet|gradlew(\.bat)?|\.[\\/]gradlew(\.bat)?|mvn|deno)\b/i;
const FORBIDDEN = /[;&|`$<>]|\b(rm|del|rmdir|format|shutdown|curl|wget|Invoke-WebRequest|iwr|powershell|cmd)\b/i;

export function validateCommand(cmd: string): string {
  const c = cmd.trim();
  if (!c || c.length > 300) throw new Error('Command is empty or too long.');
  if (!ALLOWED.test(c)) throw new Error('Only test/build commands of known toolchains are allowed (npm, flutter, php, pytest, go, cargo, dotnet, gradle…).');
  if (FORBIDDEN.test(c)) throw new Error('Command contains disallowed characters or programs.');
  return c;
}

export function detectCommands(root: string): { command: string; reason: string }[] {
  const out: { command: string; reason: string }[] = [];
  const has = (f: string) => fs.existsSync(path.join(root, f));
  try {
    if (has('package.json')) {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) out.push({ command: 'npm test', reason: 'package.json "test" script' });
      if (pkg.scripts?.build) out.push({ command: 'npm run build', reason: 'package.json "build" script' });
      if (pkg.scripts?.lint) out.push({ command: 'npm run lint', reason: 'package.json "lint" script' });
    }
  } catch {
    /* ignore invalid package.json */
  }
  if (has('pubspec.yaml')) {
    if (has('test')) out.push({ command: 'flutter test', reason: 'Flutter project with test/' });
    out.push({ command: 'flutter analyze', reason: 'Flutter static analysis' });
  }
  if (has('artisan')) out.push({ command: 'php artisan test', reason: 'Laravel project' });
  else if (has('phpunit.xml') || has('phpunit.xml.dist')) out.push({ command: 'vendor\\bin\\phpunit', reason: 'phpunit.xml' });
  if (has('pytest.ini') || has('pyproject.toml')) out.push({ command: 'pytest', reason: 'Python project' });
  if (has('go.mod')) out.push({ command: 'go test ./...', reason: 'Go module' });
  if (has('Cargo.toml')) out.push({ command: 'cargo test', reason: 'Rust crate' });
  return out;
}

const running = new Map<string, ReturnType<typeof spawn>>();

export async function startVerification(projectId: string, command: string, cwdOverride?: string, actor = 'owner'): Promise<string> {
  const p = await prisma().project.findUnique({ where: { id: projectId } });
  if (!p || !p.pathVerified || !fs.existsSync(p.rootPath)) throw new Error('The project folder does not exist on this machine.');
  const cwd = cwdOverride ?? p.rootPath;
  const cmd = validateCommand(command);
  const row = await prisma().verificationRun.create({ data: { projectId, cwd, command: cmd } });
  await audit(actor, 'verify.run', projectId, { command: cmd, cwd });
  const started = Date.now();
  const child = spawn('cmd.exe', ['/d', '/s', '/c', cmd], { cwd, windowsHide: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(row.id, child);
  let output = '';
  const add = (b: Buffer) => {
    output += b.toString('utf8');
    if (output.length > 400_000) output = output.slice(-200_000);
  };
  child.stdout?.on('data', add);
  child.stderr?.on('data', add);
  const timer = setTimeout(() => child.kill(), 20 * 60_000);
  const finish = async (code: number | null) => {
    clearTimeout(timer);
    running.delete(row.id);
    await prisma().verificationRun.update({ where: { id: row.id }, data: { status: code === 0 ? 'passed' : 'failed', exitCode: code, output: redactSecrets(output.slice(-30_000)), durationMs: Date.now() - started, finishedAt: new Date() } });
  };
  child.on('close', (code) => void finish(code));
  child.on('error', (e) => {
    output += `\n${e.message}`;
    void finish(-1);
  });
  return row.id;
}

/** Runs and waits (used by QA in the AI organization). */
export async function runAndWait(projectId: string, command: string, cwd: string, actor: string): Promise<{ id: string; passed: boolean; output: string }> {
  const id = await startVerification(projectId, command, cwd, actor);
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await prisma().verificationRun.findUnique({ where: { id } });
    if (r && r.status !== 'running') return { id, passed: r.status === 'passed', output: r.output ?? '' };
  }
}

export function cancelVerification(id: string): boolean {
  const c = running.get(id);
  if (!c) return false;
  c.kill();
  return true;
}
