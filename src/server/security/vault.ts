import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDir } from '../config';
import { prisma } from '../db';

/**
 * Secrets vault. Values are encrypted with AES-256-GCM. The master key is itself protected with
 * Windows DPAPI (CurrentUser scope), so the key file is useless on another machine or account.
 * Plain values never leave the server and are never logged.
 */

let masterKey: Buffer | undefined;

function dpapi(mode: 'Protect' | 'Unprotect', b64: string): string {
  const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:DC_VAULT_IN); $r=[Security.Cryptography.ProtectedData]::${mode}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($r)`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, DC_VAULT_IN: b64 }, windowsHide: true, encoding: 'utf8', timeout: 30_000 }).trim();
}

function keyFile() {
  return path.join(ensureDir(dataDir()), process.platform === 'win32' ? '.vault-key.dpapi' : '.vault-key');
}

export function getMasterKey(): Buffer {
  if (masterKey) return masterKey;
  const file = keyFile();
  if (fs.existsSync(file)) {
    const stored = fs.readFileSync(file, 'utf8').trim();
    masterKey = Buffer.from(process.platform === 'win32' ? dpapi('Unprotect', stored) : stored, 'base64');
  } else {
    const key = crypto.randomBytes(32);
    const b64 = key.toString('base64');
    fs.writeFileSync(file, process.platform === 'win32' ? dpapi('Protect', b64) : b64, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    masterKey = key;
  }
  if (masterKey.length !== 32) throw new Error('Vault master key is corrupted.');
  return masterKey;
}

export function encrypt(plain: string, key = getMasterKey()): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decrypt(cipher: string, key = getMasterKey()): string {
  const buf = Buffer.from(cipher, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

const cache = new Map<string, string>();

export async function setSecret(name: string, value: string): Promise<void> {
  if (!/^[\w.:-]{1,80}$/.test(name)) throw new Error('Invalid secret name.');
  const cipher = encrypt(value);
  await prisma().secret.upsert({ where: { name }, create: { name, cipher }, update: { cipher } });
  cache.set(name, value);
}

export async function getSecret(name: string): Promise<string | undefined> {
  if (cache.has(name)) return cache.get(name);
  const row = await prisma().secret.findUnique({ where: { name } });
  if (!row) return undefined;
  const v = decrypt(row.cipher);
  cache.set(name, v);
  return v;
}

export async function deleteSecret(name: string): Promise<void> {
  cache.delete(name);
  await prisma().secret.deleteMany({ where: { name } });
}

export async function listSecretNames(): Promise<string[]> {
  return (await prisma().secret.findMany({ select: { name: true }, orderBy: { name: 'asc' } })).map((s) => s.name);
}

/** Resolves "env:VAR" or "secret:NAME" references. */
export async function resolveKeyRef(ref: string | null | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  if (ref.startsWith('env:')) return process.env[ref.slice(4)]?.trim() || undefined;
  if (ref.startsWith('secret:')) return getSecret(ref.slice(7));
  return undefined;
}

/** Passphrase-based encryption for portable backups (scrypt KDF). */
export function encryptWithPassphrase(data: Buffer, passphrase: string): Buffer {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([Buffer.from('DCENC1'), salt, iv, c.getAuthTag(), ct]);
}

export function decryptWithPassphrase(data: Buffer, passphrase: string): Buffer {
  if (data.subarray(0, 6).toString() !== 'DCENC1') throw new Error('Not a DevContinuity encrypted file.');
  const salt = data.subarray(6, 22);
  const iv = data.subarray(22, 34);
  const tag = data.subarray(34, 50);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data.subarray(50)), d.final()]);
}
