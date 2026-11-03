// Job runner on the jobs table. At-least-once: a job is marked running before its
// handler starts, and a job left running by a crash goes back in the queue on the next
// start. Handlers must therefore be safe to run twice.
import type { Logger } from "pino";
import type { Db } from "./db.js";
import { newId } from "./db.js";
import { scrubString } from "./log.js";

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 8;

export type JobState = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  kind: string;
  payload: unknown;
  state: JobState;
  attempts: number;
  nextRunMs: number;
  idempotencyKey: string | null;
  lastError: string | null;
}

export type Handler = (payload: any, job: Job) => Promise<void> | void;

interface Row {
  id: string;
  kind: string;
  payload_json: string;
  state: JobState;
  attempts: number;
  next_run_ms: number;
  idempotency_key: string | null;
  last_error: string | null;
}

function toJob(r: Row): Job {
  return {
    id: r.id,
    kind: r.kind,
    payload: JSON.parse(r.payload_json),
    state: r.state,
    attempts: r.attempts,
    nextRunMs: r.next_run_ms,
    idempotencyKey: r.idempotency_key,
    lastError: r.last_error,
  };
}

/** Wait before the next try after `attempts` failed tries: 5 s, 10 s, 20 s, ... up to 10 min. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

export interface RunnerOptions {
  network: string;
  now?: () => number;
  log?: Logger;
}

export class JobRunner {
  private readonly handlers = new Map<string, Handler>();
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly db: Db,
    private readonly opts: RunnerOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.recover();
  }

  register(kind: string, handler: Handler): void {
    if (this.handlers.has(kind)) throw new Error(`handler for ${kind} is already registered`);
    this.handlers.set(kind, handler);
  }

  /** Add a job. The same idempotency key twice gives the one job already stored. */
  enqueue(kind: string, payload: unknown, idempotencyKey: string): string {
    if (!idempotencyKey) throw new Error("idempotency key is required");
    const now = this.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (id, kind, payload_json, state, attempts, next_run_ms, idempotency_key, created_ms, network)
         VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
      )
      .run(newId(), kind, JSON.stringify(payload ?? null), now, idempotencyKey, now, this.opts.network);
    const r = this.db.prepare("SELECT id FROM jobs WHERE idempotency_key = ?").get(idempotencyKey) as { id: string };
    return r.id;
  }

  get(id: string): Job | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return r && toJob(r);
  }

  /** Put jobs left running by a stopped process back in the queue (or fail them if out of tries). */
  recover(): number {
    const now = this.now();
    const failed = this.db
      .prepare("UPDATE jobs SET state = 'failed', last_error = 'stopped while running, no tries left' WHERE state = 'running' AND attempts >= ? AND network = ?")
      .run(MAX_ATTEMPTS, this.opts.network).changes;
    const requeued = this.db
      .prepare("UPDATE jobs SET state = 'queued', next_run_ms = ?, last_error = 'stopped while running' WHERE state = 'running' AND network = ?")
      .run(now, this.opts.network).changes;
    return failed + requeued;
  }

  /** Run every job that is due now, one after another. Returns how many ran. */
  async runDue(): Promise<number> {
    let ran = 0;
    for (;;) {
      const r = this.db
        .prepare("SELECT * FROM jobs WHERE state = 'queued' AND next_run_ms <= ? AND network = ? ORDER BY next_run_ms, created_ms LIMIT 1")
        .get(this.now(), this.opts.network) as Row | undefined;
      if (!r) return ran;
      const claimed = this.db
        .prepare("UPDATE jobs SET state = 'running', attempts = attempts + 1 WHERE id = ? AND state = 'queued'")
        .run(r.id).changes;
      if (claimed === 0) continue;
      ran += 1;
      await this.runOne(toJob({ ...r, state: "running", attempts: r.attempts + 1 }));
    }
  }

  private async runOne(job: Job): Promise<void> {
    const handler = this.handlers.get(job.kind);
    try {
      if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
      await handler(job.payload, job);
      this.db.prepare("UPDATE jobs SET state = 'done', last_error = NULL WHERE id = ?").run(job.id);
    } catch (e) {
      const msg = scrubString(e instanceof Error ? e.message : String(e)).slice(0, 500);
      if (job.attempts >= MAX_ATTEMPTS) {
        this.db.prepare("UPDATE jobs SET state = 'failed', last_error = ? WHERE id = ?").run(msg, job.id);
        this.opts.log?.error({ job: job.id, kind: job.kind, attempts: job.attempts, error: msg }, "job failed for good");
      } else {
        const next = this.now() + backoffMs(job.attempts);
        this.db.prepare("UPDATE jobs SET state = 'queued', next_run_ms = ?, last_error = ? WHERE id = ?").run(next, msg, job.id);
        this.opts.log?.warn({ job: job.id, kind: job.kind, attempts: job.attempts, error: msg }, "job failed, will retry");
      }
    }
  }

  /** Poll for due jobs every intervalMs until stop(). */
  start(intervalMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      this.runDue()
        .catch((e) => this.opts.log?.error({ error: String(e) }, "job loop error"))
        .finally(() => (this.busy = false));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
