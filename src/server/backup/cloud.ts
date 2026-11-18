import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { audit, notify } from '../audit';
import { dataPath, ensureDir } from '../config';
import { getSetting, prisma } from '../db';
import { PathError, nonClobberingPath } from '../security/paths';
import { decryptWithPassphrase, encryptWithPassphrase, getSecret } from '../security/vault';
import { createBackup } from './backup';

/**
 * Encrypted off-machine backups. The backup ZIP is encrypted with a passphrase you choose
 * (AES-256-GCM, scrypt), then copied to a folder (e.g. a Google Drive / OneDrive / Dropbox sync
 * folder) and/or uploaded to Cloudflare R2 (S3 API). Only the encrypted file ever leaves the PC.
 */

export interface CloudBackupSettings {
  folder?: string;
  r2?: { accountId: string; bucket: string; accessKeyId: string; prefix?: string };
}

const MAX_ENCRYPT_BYTES = 1.5 * 1024 * 1024 * 1024;

function hmac(key: Buffer | string, data: string) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/** Minimal AWS Signature V4 PUT for S3-compatible storage (Cloudflare R2). */
export function signS3Put(opts: { host: string; key: string; region: string; accessKeyId: string; secret: string; now?: Date; contentLength: number }) {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const canonicalUri = `/${opts.key.split('/').map(encodeURIComponent).join('/')}`;
  const headers: Record<string, string> = { host: opts.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate, 'content-length': String(opts.contentLength) };
  const signed = Object.keys(headers).sort();
  const canonical = ['PUT', canonicalUri, '', ...signed.map((h) => `${h}:${headers[h]}`), '', signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${date}/${opts.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secret}`, date), opts.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { url: `https://${opts.host}${canonicalUri}`, headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}` } };
}

export async function runCloudBackup(opts: { includeArchives?: boolean } = {}) {
  const cfg = await getSetting<CloudBackupSettings>('cloudBackup', {});
  const pass = await getSecret('backupPassphrase');
  if (!pass) throw new PathError('Set a backup passphrase in Backups → Cloud backup first. Without it the file cannot be encrypted (or ever restored).');
  if (!cfg.folder && !cfg.r2) throw new PathError('Configure a destination folder or Cloudflare R2 first.');
  const backup = await createBackup({ includeArchives: opts.includeArchives, kind: 'cloud', note: 'encrypted off-machine backup' });
  const size = fs.statSync(backup.filePath).size;
  if (size > MAX_ENCRYPT_BYTES) throw new PathError('This backup is too large to encrypt in one piece. Use a standard (non-full) backup for cloud copies.');
  const enc = encryptWithPassphrase(fs.readFileSync(backup.filePath), pass);
  const name = `${path.basename(backup.filePath)}.dcenc`;
  const local = path.join(ensureDir(dataPath('backups')), name);
  fs.writeFileSync(local, enc, { flag: 'wx' });
  const results: string[] = [];
  if (cfg.folder) {
    if (!fs.existsSync(cfg.folder)) throw new PathError(`Destination folder ${cfg.folder} does not exist.`);
    const dest = nonClobberingPath(path.join(cfg.folder, name));
    fs.copyFileSync(local, dest, fs.constants.COPYFILE_EXCL);
    results.push(`copied to ${dest}`);
  }
  if (cfg.r2) {
    const secret = await getSecret('r2SecretAccessKey');
    if (!secret) throw new PathError('R2 secret access key is not set.');
    const key = `${(cfg.r2.prefix ?? 'devcontinuity').replace(/^\/+|\/+$/g, '')}/${name}`;
    const host = `${cfg.r2.bucket}.${cfg.r2.accountId}.r2.cloudflarestorage.com`;
    const s = signS3Put({ host, key, region: 'auto', accessKeyId: cfg.r2.accessKeyId, secret, contentLength: enc.length });
    const res = await fetch(s.url, { method: 'PUT', headers: s.headers, body: Readable.toWeb(fs.createReadStream(local)) as ReadableStream, duplex: 'half' } as RequestInit);
    if (!res.ok) throw new PathError(`R2 upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    results.push(`uploaded to r2://${cfg.r2.bucket}/${key}`);
  }
  await prisma().backup.update({ where: { id: backup.id }, data: { note: `encrypted copy: ${results.join('; ')}` } });
  await audit('owner', 'backup.cloud', backup.id, results);
  await notify('success', 'Encrypted cloud backup completed', results.join('\n'), '/backups');
  return { backupId: backup.id, encryptedFile: local, results };
}

/** Decrypts a .dcenc file into data/uploads so it can be restored normally. */
export async function decryptBackupFile(file: string, passphrase: string): Promise<string> {
  const out = nonClobberingPath(path.join(ensureDir(dataPath('uploads')), path.basename(file).replace(/\.dcenc$/i, '')));
  fs.writeFileSync(out, decryptWithPassphrase(fs.readFileSync(file), passphrase), { flag: 'wx' });
  return out;
}
