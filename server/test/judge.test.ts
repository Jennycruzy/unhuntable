import { describe, expect, it } from "vitest";
import { buildServer } from "../src/index.js";
import { JUDGE_RUN_MS, JUDGE_STOP_WITHIN_MS, Judge } from "../src/judge.js";
import { testConfig } from "./helpers.js";
import { addUser, addWallet, harness, runFor, type Harness } from "./world.js";

const ETH = { coin: "ETH", side: "long", notionalUsd: 30, leverage: 3, hiding: "normal" } as const;
const BOX = { epk: "11".repeat(32), nonce: "22".repeat(12), ct: "33".repeat(48) };

interface S {
  h: Harness;
  app: ReturnType<typeof buildServer>;
  judge: Judge;
  cookie: string;
  userId: string;
}

let nextWallet = 0x40;

/** Run the clock in 1 s steps, sweeping as the server does, until the position is open. */
async function untilOpen(s: S, id: string): Promise<void> {
  for (let i = 0; i < 200 && posState(s, id) !== "open"; i++) {
    await runFor(s.h, 1_000, 1_000);
    s.judge.sweep();
  }
  expect(posState(s, id)).toBe("open");
  s.judge.sweep();
}

function setup(perDay = 3): S {
  const h = harness();
  const demo = addUser(h);
  addWallet(h, demo.userId, "balance", "none");
  const judge = new Judge(h.ctx, { userId: demo.userId, perDay });
  const app = buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx, judge });
  return { h, app, judge, cookie: demo.cookie, userId: demo.userId };
}

const owner = (s: S, method: "GET" | "POST", url: string, payload?: object) => s.app.inject({ method, url, headers: { cookie: s.cookie }, payload });
const as = (s: S, jar: string | undefined, method: "GET" | "POST", url: string, payload?: object) =>
  s.app.inject({ method, url, headers: jar ? { cookie: jar } : {}, payload });
const jarOf = (r: { headers: Record<string, unknown> }): string => String(r.headers["set-cookie"]).split(";")[0];
const posState = (s: S, id: string) => (s.h.db.prepare("SELECT state FROM positions WHERE id = ?").get(id) as { state: string }).state;

/** The owner opens and closes one position in the app, which leaves one ready piece. */
async function readyPiece(s: S): Promise<string> {
  const created = (await owner(s, "POST", "/api/positions", ETH)).json();
  for (const label of created.needWallets) {
    const { requestId } = (await owner(s, "POST", "/api/wallets/key", { label })).json();
    const n = nextWallet++;
    const walletId = `00000000-0000-4000-8000-000000000${n.toString(16).padStart(3, "0")}`;
    s.h.world.addWallet(walletId, n);
    s.h.world.noPolicy.add(walletId);
    await s.h.keystore.withRequestKey(requestId, async (k) => s.h.world.addKey(k, walletId));
    expect((await owner(s, "POST", "/api/wallets/confirm", { requestId, label, seed: "unh-" + label })).statusCode).toBe(200);
  }
  await owner(s, "POST", `/api/positions/${created.positionId}/continue`);
  await runFor(s.h, 1_300_000);
  if (posState(s, created.positionId) === "policy_wait") {
    for (const id of s.h.world.noPolicy) s.h.world.noPolicy.delete(id);
    expect((await owner(s, "POST", "/api/policy/confirm", { positionId: created.positionId, txHashes: ["t"] })).statusCode).toBe(200);
  }
  await runFor(s.h, 1_300_000);
  await owner(s, "POST", `/api/positions/${created.positionId}/close`, { now: true });
  await runFor(s.h, 100_000, 1_000);
  expect(posState(s, created.positionId)).toBe("closed");
  const piece = s.h.db.prepare("SELECT hl_address FROM pieces WHERE user_id = ? AND kind = 'piece'").get(s.userId) as { hl_address: string };
  return piece.hl_address;
}

function withdrawCount(s: S): { n: number } {
  const c = { n: 0 };
  s.h.world.onWithdraw = () => void (c.n += 1);
  return c;
}

describe("a reused piece that still holds money", () => {
  it("trades on it: nothing is sent from the private balance", async () => {
    const s = setup();
    const addr = await readyPiece(s);
    s.h.world.setPerp(addr, 20, 20, []);
    const sent = withdrawCount(s);
    const r = (await owner(s, "POST", "/api/positions", { coin: "ETH", side: "long", notionalUsd: 15, leverage: 2, hiding: "normal" })).json();
    await runFor(s.h, 200_000, 1_000);
    expect(posState(s, r.positionId)).toBe("open");
    expect(sent.n).toBe(0);
  });

  it("trades on less than a transfer would send, as long as it covers margin, reserve and fees", async () => {
    // $15 at 2x needs $7.53 on the piece; a transfer would have sent $12
    const s = setup();
    const addr = await readyPiece(s);
    s.h.world.setPerp(addr, 9, 9, []);
    const sent = withdrawCount(s);
    const r = (await owner(s, "POST", "/api/positions", { coin: "ETH", side: "long", notionalUsd: 15, leverage: 2, hiding: "normal" })).json();
    await runFor(s.h, 200_000, 1_000);
    expect(posState(s, r.positionId)).toBe("open");
    expect(sent.n).toBe(0);
  });

  it("is funded as usual when it holds too little", async () => {
    const s = setup();
    const addr = await readyPiece(s);
    s.h.world.setPerp(addr, 5, 5, []);
    const sent = withdrawCount(s);
    const r = (await owner(s, "POST", "/api/positions", { coin: "ETH", side: "long", notionalUsd: 15, leverage: 2, hiding: "normal" })).json();
    await runFor(s.h, 200_000, 1_000);
    expect(sent.n).toBe(1);
    expect(posState(s, r.positionId)).toBe("open");
  });
});

describe("judge mode", () => {
  it("says what anyone can do, with no sign-in", async () => {
    const s = setup();
    const r = (await as(s, undefined, "GET", "/api/judge")).json();
    expect(r).toMatchObject({ notionalUsd: 15, leverage: 2, coins: ["BTC", "ETH", "SOL"], minutes: 3, busyUntilMs: null, leftToday: 3, run: null });
    // no ready piece yet, so the page says so before anyone presses anything
    expect(r.ready).toBe(false);
  });

  it("refuses bad input and anything that could move money, and opens nothing", async () => {
    const s = setup();
    await readyPiece(s);
    const before = (s.h.db.prepare("SELECT COUNT(*) AS n FROM positions").get() as { n: number }).n;
    // only the market and side are taken: no size, no leverage, no address, no amount
    for (const extra of [{ to: "0x" + "11".repeat(20) }, { amount: "5" }, { leverage: 50 }]) {
      expect((await as(s, undefined, "POST", "/api/judge/open", { coin: "ETH", side: "long", ...extra })).statusCode).toBe(400);
    }
    expect((await as(s, undefined, "POST", "/api/judge/open", { coin: "DOGE", side: "long" })).statusCode).toBe(400);
    expect((await as(s, undefined, "POST", "/api/judge/open", { coin: "ETH", side: "long", notionalUsd: 9000 })).statusCode).toBe(400);
    expect((s.h.db.prepare("SELECT COUNT(*) AS n FROM positions").get() as { n: number }).n).toBe(before);
  });

  it("opens a real $15 2x trade on the demo account's ready piece, seals a stop, shows the public view and closes", async () => {
    const s = setup();
    const addr = await readyPiece(s);
    s.h.world.setPerp(addr, 12, 12, []);
    const r = await as(s, undefined, "POST", "/api/judge/open", { coin: "ETH", side: "short" });
    expect(r.statusCode, r.body).toBe(200);
    const jar = jarOf(r);
    expect(String(r.headers["set-cookie"])).toMatch(/^judge=[0-9a-f]{64}; Path=\/api\/judge; HttpOnly; Secure; SameSite=Strict/);
    const run = r.json().run;
    expect(run.position).toMatchObject({ coin: "ETH", side: "short", notionalUsd: 15, leverage: 2 });
    const pos = s.h.db.prepare("SELECT * FROM positions WHERE id = ?").get(run.id) as any;
    expect(pos.user_id).toBe(s.userId);
    // the token is kept only as a hash
    expect(JSON.stringify(s.h.db.prepare("SELECT * FROM judge_runs").all())).not.toContain(jar.slice(6));

    await runFor(s.h, 120_000, 1_000);
    expect(posState(s, run.id)).toBe("open");
    const mine = (await as(s, jar, "GET", "/api/judge")).json().run;
    expect(mine).toMatchObject({ id: run.id, live: true, stopSealed: false });
    expect((await as(s, jar, "GET", "/api/judge/box-pub")).json().boxPub).toMatch(/^[0-9a-f]{64}$/);
    const shard = mine.position.pieces[0].shard;
    const sealed = await as(s, jar, "POST", "/api/judge/stop", { boxes: [{ shard, box: BOX }] });
    expect(sealed.statusCode, sealed.body).toBe(200);
    expect((await as(s, jar, "GET", "/api/judge")).json().run.stopSealed).toBe(true);
    const hv = (await as(s, jar, "GET", "/api/judge/hunter")).json();
    expect(hv.accounts.map((a: any) => a.address)).toEqual([addr]);

    // another browser sees the run as busy and cannot touch it
    expect((await as(s, undefined, "GET", "/api/judge")).json()).toMatchObject({ run: null, busyUntilMs: run.endsMs, leftToday: 2 });
    expect((await as(s, undefined, "POST", "/api/judge/open", { coin: "BTC", side: "long" })).json().error).toBe("judge_busy");
    expect((await as(s, undefined, "POST", "/api/judge/close")).json().error).toBe("judge_no_run");
    expect((await as(s, "judge=" + "0".repeat(64), "POST", "/api/judge/stop", { boxes: [{ shard, box: BOX }] })).json().error).toBe("judge_no_run");

    expect((await as(s, jar, "POST", "/api/judge/close")).statusCode).toBe(200);
    // while the piece is still closing, the page must not say the account is out of money
    expect((await as(s, undefined, "GET", "/api/judge")).json().ready).toBe(true);
    await runFor(s.h, 30_000, 1_000);
    expect(posState(s, run.id)).toBe("closed");
    expect((await as(s, undefined, "GET", "/api/judge")).json().ready).toBe(true);
    const after = (await as(s, undefined, "GET", "/api/judge")).json();
    expect(after.busyUntilMs).toBeNull();
    expect((await as(s, jar, "GET", "/api/judge")).json().run).toMatchObject({ live: false });
  });

  it("closes by itself when no stop is sealed in time, and at the end of its time with one", async () => {
    const s = setup();
    const addr = await readyPiece(s);
    s.h.world.setPerp(addr, 12, 12, []);
    const a = (await as(s, undefined, "POST", "/api/judge/open", { coin: "BTC", side: "long" })).json().run;
    await untilOpen(s, a.id); // the sweep sees it open: the stop clock starts
    await runFor(s.h, JUDGE_STOP_WITHIN_MS - 10_000, 5_000);
    s.judge.sweep();
    expect(posState(s, a.id)).toBe("open");
    await runFor(s.h, 15_000, 5_000);
    s.judge.sweep();
    await runFor(s.h, 10_000, 1_000);
    expect(posState(s, a.id)).toBe("closed");

    s.h.world.setPerp(addr, 12, 12, []);
    const r = await as(s, undefined, "POST", "/api/judge/open", { coin: "ETH", side: "long" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json().run;
    const jar = jarOf(r);
    await untilOpen(s, b.id);
    const shard = (await as(s, jar, "GET", "/api/judge")).json().run.position.pieces[0].shard;
    await as(s, jar, "POST", "/api/judge/stop", { boxes: [{ shard, box: BOX }] });
    await runFor(s.h, 20_000, 5_000);
    s.judge.sweep();
    expect(posState(s, b.id)).toBe("open");
    await runFor(s.h, JUDGE_RUN_MS, 5_000);
    s.judge.sweep();
    await runFor(s.h, 10_000, 1_000);
    expect(posState(s, b.id)).toBe("closed");
  });

  it("says it is not available, and opens nothing, when the demo piece holds too little", async () => {
    const s = setup();
    const addr = await readyPiece(s);
    s.h.world.setPerp(addr, 6, 6, []);
    expect((await as(s, undefined, "GET", "/api/judge")).json().ready).toBe(false);
    const before = (s.h.db.prepare("SELECT COUNT(*) AS n FROM positions").get() as { n: number }).n;
    expect((await as(s, undefined, "POST", "/api/judge/open", { coin: "ETH", side: "long" })).json().error).toBe("judge_unavailable");
    expect((s.h.db.prepare("SELECT COUNT(*) AS n FROM positions").get() as { n: number }).n).toBe(before);
    // topped up: ready again within seconds
    s.h.world.setPerp(addr, 12, 12, []);
    await runFor(s.h, 6_000, 1_000);
    expect((await as(s, undefined, "GET", "/api/judge")).json().ready).toBe(true);
  });

  it("calls a run off when closed before anything opened", async () => {
    const s = setup();
    const addr = await readyPiece(s);
    s.h.world.setPerp(addr, 12, 12, []);
    const r = await as(s, undefined, "POST", "/api/judge/open", { coin: "ETH", side: "long" });
    const id = r.json().run.id;
    expect((await as(s, jarOf(r), "POST", "/api/judge/close")).json()).toMatchObject({ ok: true, state: "failed" });
    await runFor(s.h, 100_000, 1_000);
    expect(posState(s, id)).toBe("failed");
    expect((await as(s, undefined, "GET", "/api/judge")).json().busyUntilMs).toBeNull();
  });

  it("stops at the daily limit", async () => {
    const s = setup(1);
    const addr = await readyPiece(s);
    s.h.world.setPerp(addr, 12, 12, []);
    const r = await as(s, undefined, "POST", "/api/judge/open", { coin: "ETH", side: "long" });
    await runFor(s.h, 60_000, 1_000);
    await as(s, jarOf(r), "POST", "/api/judge/close");
    await runFor(s.h, 10_000, 1_000);
    s.judge.sweep();
    expect((await as(s, undefined, "POST", "/api/judge/open", { coin: "ETH", side: "long" })).json().error).toBe("judge_session_spent");
  });

  it("is busy when the demo account has no free piece", async () => {
    const s = setup();
    expect((await as(s, undefined, "POST", "/api/judge/open", { coin: "ETH", side: "long" })).json().error).toBe("judge_busy");
  });

  it("needs the demo account's user id", () => {
    expect(() => new Judge(harness().ctx, { userId: "", perDay: 1 })).toThrow();
  });
});
