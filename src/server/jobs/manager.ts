import { EventEmitter } from 'node:events';
import { ensureDb, prisma } from '../db';

export interface JobSnapshot {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  total: number;
  message: string;
  log: string[];
  result?: unknown;
  error?: string;
}

export interface JobHandle {
  id: string;
  progress(done: number, total: number, message: string): void;
  log(line: string): void;
  isCancelled(): boolean;
}

interface Live extends JobSnapshot {
  cancelRequested: boolean;
  lastPersist: number;
}

const g = globalThis as unknown as { __dcJobs?: { emitter: EventEmitter; live: Map<string, Live> } };
function state() {
  if (!g.__dcJobs) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(200);
    g.__dcJobs = { emitter, live: new Map() };
  }
  return g.__dcJobs;
}

const snapshot = (j: Live): JobSnapshot => ({ id: j.id, type: j.type, status: j.status, progress: j.progress, total: j.total, message: j.message, log: j.log.slice(-200), result: j.result, error: j.error });

async function persist(j: Live, final = false) {
  const now = Date.now();
  if (!final && now - j.lastPersist < 1000) return;
  j.lastPersist = now;
  await prisma()
    .job.update({
      where: { id: j.id },
      data: {
        status: j.status,
        progress: j.progress,
        total: j.total,
        message: j.message.slice(0, 500),
        log: JSON.stringify(j.log.slice(-200)),
        result: j.result === undefined ? undefined : JSON.stringify(j.result),
        error: j.error,
        finishedAt: final ? new Date() : undefined,
      },
    })
    .catch(() => undefined);
}

/**
 * Runs work in the background of the server process. Progress is pushed to subscribers
 * (the SSE endpoint) immediately and written to the Job table about once a second.
 */
export async function startJob(type: string, run: (h: JobHandle) => Promise<unknown>, opts: { exclusive?: boolean } = {}): Promise<string> {
  await ensureDb();
  const { emitter, live } = state();
  if (opts.exclusive) {
    const running = [...live.values()].find((j) => j.type === type && j.status === 'running');
    if (running) throw Object.assign(new Error(`A "${type}" job is already running.`), { status: 409, jobId: running.id });
  }
  const row = await prisma().job.create({ data: { type, status: 'running', startedAt: new Date(), message: 'Starting…' } });
  const job: Live = { id: row.id, type, status: 'running', progress: 0, total: 0, message: 'Starting…', log: [], cancelRequested: false, lastPersist: 0 };
  live.set(job.id, job);
  const emit = () => emitter.emit(job.id, snapshot(job));
  const handle: JobHandle = {
    id: job.id,
    progress(done, total, message) {
      job.progress = done;
      job.total = total;
      job.message = message;
      emit();
      void persist(job);
    },
    log(line) {
      job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
      if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
      emit();
    },
    isCancelled: () => job.cancelRequested,
  };

  void (async () => {
    try {
      job.result = await run(handle);
      job.status = job.cancelRequested ? 'cancelled' : 'completed';
    } catch (e) {
      job.status = 'failed';
      job.error = (e as Error).message;
      job.log.push(`ERROR ${job.error}`);
    }
    await persist(job, true);
    emit();
    setTimeout(() => live.delete(job.id), 10 * 60 * 1000).unref?.();
  })();
  return job.id;
}

export function getLiveJob(id: string): JobSnapshot | undefined {
  const j = state().live.get(id);
  return j ? snapshot(j) : undefined;
}

export function cancelJob(id: string): boolean {
  const j = state().live.get(id);
  if (!j || j.status !== 'running') return false;
  j.cancelRequested = true;
  j.message = 'Cancelling…';
  return true;
}

export function subscribeJob(id: string, cb: (s: JobSnapshot) => void): () => void {
  const { emitter } = state();
  emitter.on(id, cb);
  return () => emitter.off(id, cb);
}

/** Latest state of a job: live if it is running in this process, otherwise from the database. */
export async function getJob(id: string): Promise<JobSnapshot | null> {
  const liveJob = getLiveJob(id);
  if (liveJob) return liveJob;
  const row = await prisma().job.findUnique({ where: { id } });
  if (!row) return null;
  const parse = <T>(v: string | null, f: T): T => {
    try {
      return v ? (JSON.parse(v) as T) : f;
    } catch {
      return f;
    }
  };
  return { id: row.id, type: row.type, status: row.status as JobSnapshot['status'], progress: row.progress, total: row.total, message: row.message ?? '', log: parse<string[]>(row.log, []), result: parse<unknown>(row.result, undefined), error: row.error ?? undefined };
}
