import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import yauzl from 'yauzl';
import { PathError, safeJoin } from './security/paths';

export type ZipSource = { name: string; file: string } | { name: string; dir: string; filter?: (rel: string) => boolean } | { name: string; content: string | Buffer };

/** Writes a ZIP. `out` must not already exist: archives are never overwritten. */
export async function createZip(out: string, sources: ZipSource[]): Promise<{ bytes: number }> {
  if (fs.existsSync(out)) throw new PathError(`${out} already exists.`);
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  const output = fs.createWriteStream(out, { flags: 'wx' });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(output);
  const addDir = (dir: string, prefix: string, filter?: (rel: string) => boolean, rel = '') => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) addDir(dir, prefix, filter, r);
      else if (e.isFile() && (!filter || filter(r))) archive.file(path.join(dir, r), { name: `${prefix}/${r}` });
    }
  };
  for (const s of sources) {
    if ('content' in s) archive.append(s.content, { name: s.name });
    else if ('file' in s) archive.file(s.file, { name: s.name });
    else addDir(s.dir, s.name, s.filter);
  }
  await archive.finalize();
  await done;
  return { bytes: fs.statSync(out).size };
}

export interface ExtractLimits {
  maxEntries?: number;
  maxTotalBytes?: number;
  /** Only entries accepted by this predicate are extracted. */
  accept?: (name: string) => boolean;
}

/**
 * Secure archive extraction. Every entry name is validated before anything is written:
 * absolute paths, drive letters, ".." segments and anything resolving outside `targetDir`
 * are rejected (zip-slip). Symlink entries are refused, existing files are never overwritten,
 * and entry count and total uncompressed size are capped to stop zip bombs.
 */
export function extractZipSafely(zipFile: string, targetDir: string, limits: ExtractLimits = {}): Promise<{ files: string[]; bytes: number }> {
  const maxEntries = limits.maxEntries ?? 200_000;
  const maxTotal = limits.maxTotalBytes ?? 40 * 1024 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Cannot open archive.'));
      const files: string[] = [];
      let bytes = 0;
      let entries = 0;
      const fail = (e: Error) => {
        zip.close();
        reject(e);
      };
      zip.on('error', fail);
      zip.on('end', () => resolve({ files, bytes }));
      zip.on('entry', (entry: yauzl.Entry) => {
        (async () => {
          if (++entries > maxEntries) throw new PathError(`Archive has too many entries (> ${maxEntries}).`);
          const name = entry.fileName;
          const target = safeJoin(targetDir, name);
          const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (unixMode === 0o120000) throw new PathError(`Symbolic link entries are not allowed: ${name}`);
          if (/\/$/.test(name)) {
            await fs.promises.mkdir(target, { recursive: true });
            return;
          }
          if (limits.accept && !limits.accept(name.replace(/\\/g, '/'))) return;
          bytes += entry.uncompressedSize;
          if (bytes > maxTotal) throw new PathError('Archive exceeds the allowed uncompressed size.');
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (e, s) => (e || !s ? rej(e ?? new Error('Cannot read entry.')) : res(s))));
          // 'wx' fails if the file exists: extraction can never overwrite anything.
          await pipeline(stream, fs.createWriteStream(target, { flags: 'wx' }));
          files.push(target);
        })()
          .then(() => zip.readEntry())
          .catch(fail);
      });
      zip.readEntry();
    });
  });
}
