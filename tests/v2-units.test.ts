import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { z } from 'zod';
import { decrypt, decryptWithPassphrase, encrypt, encryptWithPassphrase } from '../src/server/security/vault';
import { END, START, mergeBlock } from '../src/server/rules';
import { buildLaunchScript, psq } from '../src/server/agents/launcher';
import { validateCommand } from '../src/server/verify/runner';
import { classify } from '../src/server/git/worktrees';
import { decide } from '../src/server/verify/triage';
import { nextRun } from '../src/server/org/scheduler';
import { signS3Put } from '../src/server/backup/cloud';
import { extractJson, toJsonSchema } from '../src/server/ai/gateway';
import { parseRepo } from '../src/server/github';
import { assertRef } from '../src/server/git/write';

describe('vault crypto', () => {
  it('round-trips with AES-256-GCM and detects tampering', () => {
    const key = crypto.randomBytes(32);
    const c = encrypt('sk-secret-value', key);
    expect(c).not.toContain('sk-secret');
    expect(decrypt(c, key)).toBe('sk-secret-value');
    const bad = Buffer.from(c, 'base64');
    bad[bad.length - 1] ^= 1;
    expect(() => decrypt(bad.toString('base64'), key)).toThrow();
    expect(() => decrypt(c, crypto.randomBytes(32))).toThrow();
  });
  it('passphrase backups decrypt only with the right passphrase', () => {
    const data = Buffer.from('zip bytes');
    const enc = encryptWithPassphrase(data, 'correct horse battery');
    expect(decryptWithPassphrase(enc, 'correct horse battery').toString()).toBe('zip bytes');
    expect(() => decryptWithPassphrase(enc, 'wrong passphrase!!')).toThrow();
  });
});

describe('rules block', () => {
  it('creates, appends and updates only the managed block', () => {
    expect(mergeBlock(null, 'A')).toBe(`${START}\nA\n${END}\n`);
    const appended = mergeBlock('# My notes\nkeep me', 'B');
    expect(appended.startsWith('# My notes\nkeep me')).toBe(true);
    const updated = mergeBlock(appended, 'C');
    expect(updated).toContain('keep me');
    expect(updated).toContain(`${START}\nC\n${END}`);
    expect(updated).not.toContain('\nB\n');
    expect(mergeBlock(null, 'R', true)).toMatch(/^---\ndescription:/);
  });
});

describe('agent launch script', () => {
  it('contains only the executable, the folder and the prompt file — never prompt text', () => {
    const { script } = buildLaunchScript({ agent: 'codex', exe: 'C:\\npm\\codex.ps1', kind: 'cli', dir: "C:\\work\\o'brien", promptFile: 'C:\\dc\\p.md' });
    expect(script).toContain("Set-Location -LiteralPath 'C:\\work\\o''brien'");
    expect(script).toContain("& 'C:\\npm\\codex.ps1' $p");
    const resume = buildLaunchScript({ agent: 'claude-code', exe: 'C:\\c\\claude.exe', kind: 'cli', dir: 'C:\\w', promptFile: 'C:\\p.md', resumeId: 'abc-123' });
    expect(resume.script).toContain("--resume 'abc-123'");
    const shim = buildLaunchScript({ agent: 'codex', exe: 'C:\\npm\\codex.cmd', kind: 'cli', dir: 'C:\\w', promptFile: 'C:\\p.md' });
    expect(shim.script).toContain('Read the continuation briefing in this file');
    expect(() => buildLaunchScript({ agent: 'cursor', exe: null, kind: null, dir: 'C:\\w', promptFile: 'C:\\p.md' })).toThrow(/not found/);
    expect(psq("a'b")).toBe("'a''b'");
  });
});

describe('command allow-list', () => {
  it('accepts toolchain commands and rejects everything else', () => {
    for (const ok of ['npm test', 'flutter test', 'php artisan test', 'vendor\\bin\\phpunit', 'go test ./...', 'npm run build', 'pytest -q']) expect(validateCommand(ok)).toBe(ok);
    for (const bad of ['rm -rf /', 'npm test && del x', 'curl evil.sh', 'powershell -c x', 'npm test; shutdown', 'git reset --hard', 'npm test | tee', 'echo $HOME']) expect(() => validateCommand(bad)).toThrow();
  });
  it('validates git refs', () => {
    expect(assertRef('dc/abc-fix-login')).toBe('dc/abc-fix-login');
    for (const bad of ['-x', 'a..b', 'a b', 'a;b']) expect(() => assertRef(bad)).toThrow();
  });
});

describe('worktree & triage classification', () => {
  it('classifies worktrees by risk', () => {
    expect(classify({ exists: true, isMain: false, dirty: 2, ahead: 0, merged: true })).toBe('at_risk');
    expect(classify({ exists: true, isMain: false, dirty: 0, ahead: 3, merged: false })).toBe('unmerged');
    expect(classify({ exists: true, isMain: false, dirty: 0, ahead: 0, merged: true })).toBe('merged');
    expect(classify({ exists: false, isMain: false, dirty: 0, ahead: null, merged: null })).toBe('missing');
    expect(classify({ exists: true, isMain: true, dirty: 5, ahead: null, merged: null })).toBe('main');
  });
  it('suggests triage outcomes from evidence', () => {
    const base = { changes: 0, present: 0, missing: 0, filesGone: 0, commits: 0, commitsInRepo: 0, answered: true, errors: 0 };
    expect(decide({ ...base, changes: 5, present: 5 }, true).triage).toBe('likely_done');
    expect(decide({ ...base, changes: 5, present: 1, missing: 4 }, true).triage).toBe('likely_not_done');
    expect(decide({ ...base }, true).triage).toBe('no_code_changes');
    expect(decide({ ...base, commits: 1, commitsInRepo: 1 }, true).triage).toBe('likely_done');
    expect(decide({ ...base, changes: 4, present: 2 }, true).triage).toBe('unknown');
    expect(decide({ ...base, changes: 4, present: 4 }, false).triage).toBe('unknown');
  });
});

describe('scheduler timing', () => {
  it('computes next daily, weekly and hourly runs', () => {
    const from = new Date(2026, 10, 11, 9, 30); // Wed 09:30
    expect(nextRun({ every: 'day', at: '08:00' }, from)).toEqual(new Date(2026, 10, 12, 8, 0));
    expect(nextRun({ every: 'day', at: '10:00' }, from)).toEqual(new Date(2026, 10, 11, 10, 0));
    expect(nextRun({ every: 'week', weekday: 0, at: '08:30' }, from)).toEqual(new Date(2026, 10, 15, 8, 30));
    expect(nextRun({ every: 'hours', hours: 6 }, from)).toEqual(new Date(from.getTime() + 6 * 3600_000));
  });
});

describe('gateway helpers & S3 signing', () => {
  it('produces strict JSON schemas and extracts JSON from model text', () => {
    const s = toJsonSchema(z.object({ a: z.string(), b: z.array(z.object({ c: z.number() })) }));
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(['a', 'b']);
    expect(((s.properties as Record<string, { items: { additionalProperties: boolean } }>).b.items).additionalProperties).toBe(false);
    expect(extractJson('Here:\n```json\n{"x":1}\n```')).toEqual({ x: 1 });
    expect(extractJson('noise {"y":2}')).toEqual({ y: 2 });
  });
  it('signs R2 uploads deterministically (SigV4)', () => {
    const a = signS3Put({ host: 'b.acc.r2.cloudflarestorage.com', key: 'dc/x y.zip', region: 'auto', accessKeyId: 'AKID', secret: 'SECRET', now: new Date('2026-11-11T00:00:00Z'), contentLength: 10 });
    const b = signS3Put({ host: 'b.acc.r2.cloudflarestorage.com', key: 'dc/x y.zip', region: 'auto', accessKeyId: 'AKID', secret: 'SECRET', now: new Date('2026-11-11T00:00:00Z'), contentLength: 10 });
    expect(a.headers.Authorization).toBe(b.headers.Authorization);
    expect(a.url).toBe('https://b.acc.r2.cloudflarestorage.com/dc/x%20y.zip');
    expect(a.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/20261111\/auto\/s3\/aws4_request, SignedHeaders=content-length;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });
  it('parses GitHub remotes', () => {
    expect(parseRepo('https://github.com/acme/app.git')).toBe('acme/app');
    expect(parseRepo('git@github.com:acme/my.app.git')).toBe('acme/my.app');
    expect(parseRepo('https://gitlab.com/a/b')).toBeNull();
  });
});
