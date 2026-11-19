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

/** POSIX shell single-quoted literal. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * macOS / Linux equivalent of buildLaunchScript: a bash script that changes to the folder, copies the
 * prompt to the clipboard when a clipboard tool exists, starts the agent and leaves a shell open.
 * As on Windows it only contains the agent's executable, the folder and the prompt file path.
 */
export function buildPosixLaunchScript(opts: { agent: LaunchAgent; exe: string | null; kind: 'cli' | 'app' | null; dir: string; promptFile: string; resumeId?: string; platform?: NodeJS.Platform }): { script: string; note: string } {
  const mac = (opts.platform ?? process.platform) === 'darwin';
  const L: string[] = [
    '#!/usr/bin/env bash',
    `cd ${shq(opts.dir)} || exit 1`,
    `p="$(cat ${shq(opts.promptFile)})"`,
    'if command -v pbcopy >/dev/null 2>&1; then printf "%s" "$p" | pbcopy; elif command -v wl-copy >/dev/null 2>&1; then printf "%s" "$p" | wl-copy; elif command -v xclip >/dev/null 2>&1; then printf "%s" "$p" | xclip -selection clipboard; elif command -v xsel >/dev/null 2>&1; then printf "%s" "$p" | xsel --clipboard --input; fi',
    `printf '\\033[36m%s\\033[0m\\n' 'DevContinuity: continuation prompt loaded (copied to the clipboard when a clipboard tool is available).'`,
    `printf '\\033[90m%s\\033[0m\\n' ${shq(`Folder: ${opts.dir}`)} ${shq(`Prompt file: ${opts.promptFile}`)}`,
  ];
  const exe = opts.exe ? shq(opts.exe) : null;
  let note = '';
  switch (opts.agent) {
    case 'claude-code':
      if (!exe) throw new PathError('Claude Code was not found. Install it or set its path in Settings → Agents.');
      if (opts.resumeId) {
        L.push(`${exe} --resume ${shq(opts.resumeId)}`);
        note = 'Opening the original Claude Code session with --resume. If it cannot be resumed, run claude and paste the prompt.';
      } else {
        L.push(`${exe} "$p"`);
        note = 'Claude Code starts with the continuation prompt as its first message.';
      }
      break;
    case 'codex':
      if (!exe) throw new PathError('Codex was not found. Install it or set its path in Settings → Agents.');
      L.push(`${exe} "$p"`);
      note = 'Codex starts with the continuation prompt as its first message.';
      break;
    case 'opencode':
      if (!exe) throw new PathError('OpenCode was not found. Install the CLI (npm i -g opencode-ai) or set its path in Settings → Agents.');
      L.push(opts.kind === 'app' ? (mac ? `open -a ${exe}` : `${exe} &`) : exe, `echo 'Paste the prompt as the first message (it is also in the prompt file above).'`);
      note = 'OpenCode starts in the project folder. Paste the prompt as the first message.';
      break;
    case 'cursor':
      if (!exe) throw new PathError('Cursor was not found. Install it or set its path in Settings → Agents.');
      L.push(`${exe} ${shq(opts.dir)}`, `echo 'Cursor opened. Open the Agent chat and paste the prompt.'`);
      note = 'Cursor opens the folder; paste the prompt into the Agent chat.';
      break;
    case 'terminal':
      L.push(`echo 'Paste the prompt into any AI tool.'`);
      note = 'A terminal opens in the folder with the prompt on your clipboard.';
      break;
  }
  L.push('exec "${SHELL:-bash}" -l');
  return { script: `${L.join('\n')}\n`, note };
}

/** Linux terminals, in order of preference, and how each one runs a script in a folder. */
export const POSIX_TERMINALS: { name: string; args: (script: string, dir: string) => string[] }[] = [
  { name: 'x-terminal-emulator', args: (s) => ['-e', 'bash', s] },
  { name: 'gnome-terminal', args: (s, d) => ['--working-directory', d, '--', 'bash', s] },
  { name: 'konsole', args: (s, d) => ['--workdir', d, '-e', 'bash', s] },
  { name: 'xfce4-terminal', args: (s, d) => ['--working-directory', d, '-x', 'bash', s] },
  { name: 'kitty', args: (s, d) => ['--directory', d, 'bash', s] },
  { name: 'alacritty', args: (s, d) => ['--working-directory', d, '-e', 'bash', s] },
  { name: 'xterm', args: (s) => ['-e', 'bash', s] },
];

/** The command that opens a new terminal window running the script (macOS: iTerm if installed, else Terminal). */
export function posixTerminalCommand(platform: NodeJS.Platform, script: string, dir: string, which: (name: string) => string | null, hasApp: (app: string) => boolean = (a) => fs.existsSync(a)): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: ['-a', hasApp('/Applications/iTerm.app') ? 'iTerm' : 'Terminal', script] };
  for (const t of POSIX_TERMINALS) {
    const bin = which(t.name);
    if (bin) return { cmd: bin, args: t.args(script, dir) };
  }
  throw new PathError('No terminal emulator was found (tried x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, kitty, alacritty, xterm). Copy the prompt instead.');
}

function which(name: string): string | null {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
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

  if (process.platform !== 'win32') {
    const { script, note } = buildPosixLaunchScript({ agent: input.agent, exe: bin.path, kind: bin.kind, dir, promptFile, resumeId });
    // .command makes macOS Terminal/iTerm run it when opened.
    const scriptFile = path.join(launchDir, `${stamp}.${process.platform === 'darwin' ? 'command' : 'sh'}`);
    fs.writeFileSync(scriptFile, script, { encoding: 'utf8', mode: 0o700 });
    const term = posixTerminalCommand(process.platform, scriptFile, dir, which);
    spawn(term.cmd, term.args, { detached: true, stdio: 'ignore', cwd: dir }).unref();
    await audit('owner', 'agent.launch', input.agent, { dir, sessionId: session?.id, projectId: project?.id, resume: !!resumeId, terminal: term.cmd });
    return { dir, note, promptFile };
  }

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
