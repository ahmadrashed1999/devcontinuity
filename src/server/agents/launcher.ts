import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { audit } from '../audit';
import { dataPath, ensureDir, timestampSlug } from '../config';
import { prisma } from '../db';
import { buildResumeContext, renderContinuationPrompt } from '../handoff/context';
import { PathError } from '../security/paths';
import { findAgent, LaunchAgent } from './binaries';

const PROMPT_AGENT: Record<LaunchAgent, string> = { 'claude-code': 'claude-code', codex: 'codex', opencode: 'opencode', cursor: 'cursor', terminal: 'generic' };

/** PowerShell single-quoted literal. */
export function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export interface LaunchPlan {
  dir: string;
  promptFile: string;
  script: string;
  note: string;
}

/**
 * Builds the PowerShell script a launch will run. It only ever contains the agent's own executable,
 * the working directory and a path to the prompt file DevContinuity wrote. Commands found in imported
 * transcripts are never placed in it.
 */
export function buildLaunchScript(opts: { agent: LaunchAgent; exe: string | null; kind: 'cli' | 'app' | null; dir: string; promptFile: string; resumeId?: string }): { script: string; note: string } {
  const L: string[] = [
    '$ErrorActionPreference = "Continue"',
    `Set-Location -LiteralPath ${psq(opts.dir)}`,
    `$p = Get-Content -Raw -Encoding UTF8 -LiteralPath ${psq(opts.promptFile)}`,
    'Set-Clipboard -Value $p',
    `Write-Host 'DevContinuity: continuation prompt loaded and copied to the clipboard.' -ForegroundColor Cyan`,
    `Write-Host ('Folder: ' + ${psq(opts.dir)}) -ForegroundColor DarkGray`,
  ];
  let note = '';
  const exe = opts.exe ? psq(opts.exe) : null;
  const shim = !!opts.exe && /\.cmd$/i.test(opts.exe);
  const short = `Read the continuation briefing in this file and continue the work it describes: ${opts.promptFile}`;
  switch (opts.agent) {
    case 'claude-code':
      if (!exe) throw new PathError('Claude Code was not found. Install it or set its path in Settings → Agents.');
      if (opts.resumeId) {
        L.push(`& ${exe} --resume ${psq(opts.resumeId)}`);
        note = 'Opening the original Claude Code session with --resume. If it cannot be resumed (e.g. signed out), run claude and paste the prompt from the clipboard.';
      } else {
        L.push(shim ? `& ${exe} ${psq(short)}` : `& ${exe} $p`);
        note = 'Claude Code starts with the continuation prompt as its first message.';
      }
      break;
    case 'codex':
      if (!exe) throw new PathError('Codex was not found. Install it or set its path in Settings → Agents.');
      L.push(shim ? `& ${exe} ${psq(short)}` : `& ${exe} $p`);
      note = 'Codex starts with the continuation prompt as its first message.';
      break;
    case 'opencode':
      if (!exe) throw new PathError('OpenCode was not found. Install the CLI (npm i -g opencode-ai) or set its path in Settings → Agents.');
      if (opts.kind === 'app') {
        L.push(`Start-Process -FilePath ${exe}`, `Write-Host 'OpenCode desktop opened. Open this folder in it and paste the prompt (Ctrl+V) as the first message.' -ForegroundColor Yellow`);
        note = 'OpenCode desktop is opened; the prompt is on your clipboard. Paste it as the first message.';
      } else {
        L.push(`& ${exe}`);
        note = 'OpenCode starts in the project folder. Paste the prompt (Ctrl+V) as the first message.';
      }
      break;
    case 'cursor':
      if (!exe) throw new PathError('Cursor was not found. Install it or set its path in Settings → Agents.');
      L.push(opts.kind === 'app' ? `Start-Process -FilePath ${exe} -ArgumentList ${psq(`"${opts.dir}"`)}` : `& ${exe} ${psq(opts.dir)}`, `Write-Host 'Cursor opened. Open the Agent chat and paste the prompt (Ctrl+V).' -ForegroundColor Yellow`);
      note = 'Cursor opens the folder; paste the prompt into the Agent chat.';
      break;
    case 'terminal':
      L.push(`Write-Host 'Paste the prompt into any AI tool.' -ForegroundColor Yellow`);
      note = 'A terminal opens in the folder with the prompt on your clipboard.';
      break;
  }
  return { script: L.join('\r\n'), note };
}

/** Opens a new terminal window in the right folder (or worktree) with the agent started and the prompt loaded. Owner-initiated only. */
export async function launchAgent(input: { agent: LaunchAgent; projectId?: string; sessionId?: string; dir?: string; resume?: boolean; promptText?: string }): Promise<{ dir: string; note: string; promptFile: string }> {
  const db = prisma();
  const session = input.sessionId ? await db.session.findUnique({ where: { id: input.sessionId } }) : null;
  const project = input.projectId ? await db.project.findUnique({ where: { id: input.projectId } }) : session?.projectId ? await db.project.findUnique({ where: { id: session.projectId } }) : null;
  const candidates = [input.dir, session?.worktree && session.cwd ? session.cwd : undefined, project?.pathVerified ? project.rootPath : undefined, session?.cwd ?? undefined].filter((d): d is string => !!d);
  const dir = candidates.find((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());
  if (!dir) throw new PathError('None of the known folders for this project or session exist on this machine.');

  let prompt = input.promptText;
  if (!prompt) {
    const ctx = await buildResumeContext({ projectId: project?.id, sessionId: session?.id });
    prompt = renderContinuationPrompt(ctx, PROMPT_AGENT[input.agent]);
  }
  const launchDir = ensureDir(dataPath('handoffs', 'launch'));
  const stamp = `${timestampSlug()}-${input.agent}`;
  const promptFile = path.join(launchDir, `${stamp}.md`);
  fs.writeFileSync(promptFile, prompt, 'utf8');

  const bin = await findAgent(input.agent);
  const resumeId = input.resume && session?.agent === 'claude-code' && input.agent === 'claude-code' ? session.externalId : undefined;
  const { script, note } = buildLaunchScript({ agent: input.agent, exe: bin.path, kind: bin.kind, dir, promptFile, resumeId });
  const scriptFile = path.join(launchDir, `${stamp}.ps1`);
  fs.writeFileSync(scriptFile, `\uFEFF${script}`, 'utf8');

  const wt = await findAgent('terminal');
  const psArgs = ['-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile];
  const child = wt.path ? spawn(wt.path, ['-w', 'new', '-d', dir, 'powershell.exe', ...psArgs], { detached: true, stdio: 'ignore', windowsHide: false }) : spawn('cmd.exe', ['/d', '/c', 'start', '"DevContinuity"', 'powershell.exe', ...psArgs], { detached: true, stdio: 'ignore', cwd: dir });
  child.unref();
  await audit('owner', 'agent.launch', input.agent, { dir, sessionId: session?.id, projectId: project?.id, resume: !!resumeId });
  return { dir, note, promptFile };
}
