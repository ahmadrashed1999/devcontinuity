import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataPath, ensureDir, timestampSlug } from '../config';
import { assertInsideData, isSensitiveFile, pathKey } from '../security/paths';

/** Archive location for one agent root: data/archives/<agent>/<hash of root>/ */
export function archiveRootFor(agent: string, root: string): string {
  const hash = crypto.createHash('sha1').update(pathKey(root)).digest('hex').slice(0, 10);
  const dir = ensureDir(dataPath('archives', agent, hash));
  const marker = path.join(dir, 'ORIGIN.txt');
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, `DevContinuity safe copy\nOriginal location: ${root}\nFirst archived: ${new Date().toISOString()}\nFiles here are byte-for-byte copies. The originals were only read, never modified.\n`, 'utf8');
  }
  return dir;
}

export interface CopyResult {
  dest: string;
  copied: boolean;
  size: number;
  skippedReason?: string;
}

/**
 * Copies one original file into the archive. The source is opened read-only and is never
 * modified, moved or deleted. An existing archive copy is reused when size and mtime match.
 * If the source has shrunk since the last copy, the previous copy is kept under a timestamped
 * name instead of being replaced, so an archive can never lose data it already holds.
 */
export async function safeCopy(src: string, dest: string): Promise<CopyResult> {
  if (isSensitiveFile(src)) return { dest, copied: false, size: 0, skippedReason: 'sensitive file (never copied)' };
  assertInsideData(dest);
  const st = await fs.promises.stat(src);
  let existing: fs.Stats | undefined;
  try {
    existing = await fs.promises.stat(dest);
  } catch {
    /* not archived yet */
  }
  if (existing && existing.size === st.size && Math.abs(existing.mtimeMs - st.mtimeMs) < 2000) {
    return { dest, copied: false, size: st.size };
  }
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  if (existing && st.size < existing.size) {
    await fs.promises.rename(dest, `${dest}.kept-${timestampSlug()}`);
  }
  await fs.promises.copyFile(src, dest);
  await fs.promises.utimes(dest, st.atime, st.mtime);
  const after = await fs.promises.stat(dest);
  // A live session may still be appended to; the copy must be at least as large as what we saw.
  if (after.size < st.size) throw new Error(`Archive copy is incomplete for ${src} (${after.size} of ${st.size} bytes).`);
  return { dest, copied: true, size: after.size };
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Copies a directory tree (or single file) from an agent root into the archive, skipping sensitive files and symlinks. */
export async function archiveTree(root: string, rel: string, archiveRoot: string, onFile?: (n: number) => void): Promise<{ files: number; copied: number; bytes: number; skipped: number; errors: string[] }> {
  const res = { files: 0, copied: 0, bytes: 0, skipped: 0, errors: [] as string[] };
  const start = path.join(root, rel);
  if (!fs.existsSync(start)) return res;
  const visit = async (abs: string, depth: number): Promise<void> => {
    if (depth > 14) return;
    const st = await fs.promises.lstat(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const name of await fs.promises.readdir(abs)) await visit(path.join(abs, name), depth + 1);
      return;
    }
    if (!st.isFile()) return;
    res.files++;
    try {
      const r = await safeCopy(abs, path.join(archiveRoot, path.relative(root, abs)));
      if (r.skippedReason) res.skipped++;
      else {
        if (r.copied) res.copied++;
        res.bytes += r.size;
      }
    } catch (e) {
      res.errors.push(`${abs}: ${(e as Error).message}`);
    }
    onFile?.(res.files);
  };
  await visit(start, 0);
  return res;
}

/** Appends original records to a normalized JSONL inside the archive, for sources that are not line-oriented. */
export class RawWriter {
  private fd: number | undefined;
  private offset = 0;
  used = false;
  constructor(readonly file: string) {
    assertInsideData(file);
  }
  write = (record: unknown): { offset: number; length: number } => {
    if (this.fd === undefined) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.fd = fs.openSync(this.file, 'w');
      this.used = true;
    }
    const buf = Buffer.from(JSON.stringify(record) ?? 'null', 'utf8');
    fs.writeSync(this.fd, buf);
    fs.writeSync(this.fd, '\n');
    const at = this.offset;
    this.offset += buf.length + 1;
    return { offset: at, length: buf.length };
  };
  close() {
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
  }
}
