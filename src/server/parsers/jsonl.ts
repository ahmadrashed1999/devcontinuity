import fs from 'node:fs';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';

export interface JsonlLine {
  /** 1-based physical line number in the (decompressed) source. */
  lineNo: number;
  /** Byte offset and length of the line in the (decompressed) source, excluding the line terminator. */
  offset: number;
  length: number;
  /** Parsed value. Undefined when the line could not be parsed. */
  value?: unknown;
  /** Set when the line is malformed, truncated or oversized. The line is reported, never silently dropped. */
  error?: string;
  /** Short preview of an unparseable line, for diagnostics. */
  preview?: string;
  /** True for a final line with no terminating newline (typical of a session interrupted mid-write). */
  unterminated?: boolean;
}

export interface JsonlOptions {
  /** Lines longer than this are skipped and reported instead of being buffered. Default 256 MB. */
  maxLineBytes?: number;
}

const NL = 0x0a;
const CR = 0x0d;

/** Opens a source for reading, transparently decompressing .zst and .gz files. */
export function openSource(file: string): Readable {
  const raw = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  if (/\.zst$/i.test(file)) {
    const z = zlib.createZstdDecompress();
    raw.on('error', (e) => z.destroy(e));
    return raw.pipe(z);
  }
  if (/\.gz$/i.test(file)) {
    const z = zlib.createGunzip();
    raw.on('error', (e) => z.destroy(e));
    return raw.pipe(z);
  }
  return raw;
}

/**
 * Streaming JSONL reader that tolerates everything real transcripts contain: blank lines, CRLF,
 * a UTF-8 BOM, malformed lines, a truncated last line and very large lines. Memory use is bounded
 * by the largest single line, not the file size.
 */
export async function* readJsonl(source: string | Readable, opts: JsonlOptions = {}): AsyncGenerator<JsonlLine> {
  const maxLineBytes = opts.maxLineBytes ?? 256 * 1024 * 1024;
  const stream = typeof source === 'string' ? openSource(source) : source;

  let pending: Buffer[] = [];
  let pendingLen = 0;
  let skipping = false; // inside an oversized line
  let skippedLen = 0;
  let lineStart = 0; // absolute offset of the current line
  let pos = 0; // absolute offset of the current chunk
  let lineNo = 0;

  const emit = (buf: Buffer, unterminated: boolean): JsonlLine | null => {
    lineNo++;
    let start = 0;
    let end = buf.length;
    if (lineNo === 1 && end >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
    if (end > start && buf[end - 1] === CR) end--;
    const offset = lineStart + start;
    const length = end - start;
    if (length === 0) return null;
    const text = buf.toString('utf8', start, end);
    if (!text.trim()) return null;
    try {
      return { lineNo, offset, length, value: JSON.parse(text), unterminated: unterminated || undefined };
    } catch (e) {
      return {
        lineNo,
        offset,
        length,
        error: unterminated ? `Truncated final line (no newline; likely interrupted mid-write): ${(e as Error).message}` : `Malformed JSON: ${(e as Error).message}`,
        preview: text.slice(0, 200),
        unterminated: unterminated || undefined,
      };
    }
  };

  for await (const chunkRaw of stream) {
    const chunk: Buffer = Buffer.isBuffer(chunkRaw) ? chunkRaw : Buffer.from(chunkRaw as string);
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(NL, start);
      if (nl === -1) break;
      if (skipping) {
        lineNo++;
        yield { lineNo, offset: lineStart, length: skippedLen + (nl - start), error: `Oversized line skipped (> ${maxLineBytes} bytes). The original remains in the archive.` };
        skipping = false;
        skippedLen = 0;
      } else if (pendingLen + (nl - start) > maxLineBytes) {
        lineNo++;
        yield { lineNo, offset: lineStart, length: pendingLen + (nl - start), error: `Oversized line skipped (> ${maxLineBytes} bytes). The original remains in the archive.` };
        pending = [];
        pendingLen = 0;
      } else {
        const piece = chunk.subarray(start, nl);
        const buf = pendingLen ? Buffer.concat([...pending, piece], pendingLen + piece.length) : piece;
        pending = [];
        pendingLen = 0;
        const line = emit(buf, false);
        if (line) yield line;
      }
      lineStart = pos + nl + 1;
      start = nl + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      if (skipping) {
        skippedLen += rest.length;
      } else if (pendingLen + rest.length > maxLineBytes) {
        skipping = true;
        skippedLen = pendingLen + rest.length;
        pending = [];
        pendingLen = 0;
      } else {
        pending.push(rest);
        pendingLen += rest.length;
      }
    }
    pos += chunk.length;
  }

  if (skipping) {
    lineNo++;
    yield { lineNo, offset: lineStart, length: skippedLen, error: `Oversized line skipped (> ${maxLineBytes} bytes).`, unterminated: true };
  } else if (pendingLen) {
    const line = emit(Buffer.concat(pending, pendingLen), true);
    if (line) yield line;
  }
}

/** Reads one original record back out of a source by byte range. Handles compressed sources by streaming. */
export async function readRawRange(file: string, offset: number, length: number): Promise<string> {
  if (length <= 0) return '';
  if (!/\.(zst|gz)$/i.test(file)) {
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.toString('utf8', 0, bytesRead);
    } finally {
      await fh.close();
    }
  }
  const stream = openSource(file);
  const parts: Buffer[] = [];
  let pos = 0;
  const end = offset + length;
  try {
    for await (const chunkRaw of stream) {
      const chunk = chunkRaw as Buffer;
      const from = Math.max(offset, pos) - pos;
      const to = Math.min(end, pos + chunk.length) - pos;
      if (to > from) parts.push(chunk.subarray(from, to));
      pos += chunk.length;
      if (pos >= end) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(parts).toString('utf8');
}
