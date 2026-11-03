import { describe, expect, it } from "vitest";
import { JobRunner, MAX_ATTEMPTS, backoffMs } from "../src/jobs.js";
import { memoryDb } from "./helpers.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("job runner idempotency", () => {
  it("one job per idempotency key", async () => {
    const db = memoryDb();
    const c = clock();
    const r = new JobRunner(db, { network: "mainnet", now: c.now });
    const seen: unknown[] = [];
    r.register("fund", (p) => void seen.push(p));
    const a = r.enqueue("fund", { piece: "p1" }, "fund:p1");
    const b = r.enqueue("fund", { piece: "other" }, "fund:p1");
    expect(b).toBe(a);
    expect(await r.runDue()).toBe(1);
    expect(seen).toEqual([{ piece: "p1" }]);
    expect(r.get(a)?.state).toBe("done");
    // enqueueing a done key again does not run it again
    r.enqueue("fund", { piece: "p1" }, "fund:p1");
    expect(await r.runDue()).toBe(0);
    expect(() => r.enqueue("fund", {}, "")).toThrow();
  });

  it("runs only due jobs", async () => {
    const db = memoryDb();
    const c = clock();
    const r = new JobRunner(db, { network: "mainnet", now: c.now });
    r.register("k", () => {});
    r.enqueue("k", {}, "a");
    expect(await r.runDue()).toBe(1);
    expect(await r.runDue()).toBe(0);
  });
});

describe("job runner backoff", () => {
  it("backs off 5 s doubling up to 10 min", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map(backoffMs)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000, 600_000]);
  });

  it("retries a failing job after its wait and fails it after 8 tries", async () => {
    const db = memoryDb();
    const c = clock();
    const r = new JobRunner(db, { network: "mainnet", now: c.now });
    let calls = 0;
    r.register("flaky", () => {
      calls += 1;
      throw new Error(`upstream said no to wk_${"11".repeat(16)}`);
    });
    const id = r.enqueue("flaky", {}, "flaky:1");
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(await r.runDue()).toBe(1);
      const j = r.get(id)!;
      expect(j.attempts).toBe(attempt);
      expect(j.lastError).toContain("upstream said no");
      expect(j.lastError).not.toContain("wk_");
      if (attempt < MAX_ATTEMPTS) {
        expect(j.state).toBe("queued");
        expect(j.nextRunMs).toBe(c.now() + backoffMs(attempt));
        // not due a moment before the wait ends
        c.advance(backoffMs(attempt) - 1);
        expect(await r.runDue()).toBe(0);
        c.advance(1);
      } else {
        expect(j.state).toBe("failed");
      }
    }
    expect(calls).toBe(MAX_ATTEMPTS);
    c.advance(3_600_000);
    expect(await r.runDue()).toBe(0);
  });

  it("succeeds after a failure", async () => {
    const db = memoryDb();
    const c = clock();
    const r = new JobRunner(db, { network: "mainnet", now: c.now });
    let n = 0;
    r.register("once", () => {
      if (++n === 1) throw new Error("first try fails");
    });
    const id = r.enqueue("once", {}, "once");
    await r.runDue();
    c.advance(5_000);
    await r.runDue();
    expect(r.get(id)).toMatchObject({ state: "done", attempts: 2, lastError: null });
  });

  it("a job with no handler fails like any error", async () => {
    const db = memoryDb();
    const r = new JobRunner(db, { network: "mainnet", now: clock().now });
    const id = r.enqueue("nobody", {}, "x");
    await r.runDue();
    expect(r.get(id)).toMatchObject({ state: "queued", attempts: 1 });
    expect(r.get(id)!.lastError).toContain("no handler");
  });
});

describe("job runner restart", () => {
  it("a job left running by a crash runs again after restart", async () => {
    const db = memoryDb();
    const c = clock();
    const first = new JobRunner(db, { network: "mainnet", now: c.now });
    // the handler never finishes: the process dies while the job is running
    first.register("send", () => new Promise<void>(() => {}));
    const id = first.enqueue("send", { piece: "p1" }, "send:p1");
    void first.runDue();
    await Promise.resolve();
    expect(first.get(id)?.state).toBe("running");

    c.advance(60_000);
    const second = new JobRunner(db, { network: "mainnet", now: c.now });
    expect(second.get(id)).toMatchObject({ state: "queued", attempts: 1, nextRunMs: c.now() });
    const seen: unknown[] = [];
    second.register("send", (p) => void seen.push(p));
    expect(await second.runDue()).toBe(1);
    expect(seen).toEqual([{ piece: "p1" }]);
    expect(second.get(id)).toMatchObject({ state: "done", attempts: 2 });
  });

  it("a crashed job with no tries left is failed on restart", async () => {
    const db = memoryDb();
    const c = clock();
    const r = new JobRunner(db, { network: "mainnet", now: c.now });
    const id = r.enqueue("send", {}, "send:x");
    db.prepare("UPDATE jobs SET state = 'running', attempts = ? WHERE id = ?").run(MAX_ATTEMPTS, id);
    const again = new JobRunner(db, { network: "mainnet", now: c.now });
    expect(again.get(id)?.state).toBe("failed");
  });
});
