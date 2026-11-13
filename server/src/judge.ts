// Judge mode: one small real trade on Hyperliquid for anyone, with no wallet, no sign-in and
// no money of their own. Nobody can move money through it: it only opens and closes one
// small position on a piece that already holds its money. It runs on our own demo account and its ready pieces,
// through exactly the path every trade takes: a VRF plan, a piece controlled by NEAR Chain
// Signatures, a stop sealed in the judge's browser that only the guard can open, and a close
// by the guard. Limits keep it small: a fixed size and leverage, one run at a time, a few
// runs a day, and every run closes by itself after three minutes, sooner if no stop was sealed.
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { readCookie } from "./auth.js";
import type { Ctx } from "./ctx.js";
import { newId } from "./db.js";
import { GuardUnreachable } from "./guard.js";
import { hunterView } from "./hunter.js";
import { StopBody, closePosition, createPosition, forwardStops, freePieces, listPositions } from "./positions.js";
import { ApiError } from "./refusals.js";

export const JUDGE_COOKIE = "judge";
export const JUDGE_COINS = ["BTC", "ETH", "SOL"] as const;
export const JUDGE_NOTIONAL_USD = 15;
export const JUDGE_LEVERAGE = 2;
export const JUDGE_RUN_MS = 3 * 60_000;
/** A run whose position has been open this long with no sealed stop is closed. */
export const JUDGE_STOP_WITHIN_MS = 90_000;
const DAY_MS = 24 * 60 * 60_000;
/**
 * What the demo piece must hold to open a trade without a transfer: a $15 trade at 2x needs
 * $7.50 of margin and about 3 cents of fee reserve. Below this the page says it is not
 * available, rather than letting a judge wait.
 */
export const JUDGE_MIN_HELD_USD = 8;
/** One read of the demo piece's balance serves the page for this long. */
const HELD_CACHE_MS = 30_000;

export interface JudgeOptions {
  /** The demo account's user id. */
  userId: string;
  perDay: number;
}

export const JudgeOpen = z
  .object({
    coin: z.enum(JUDGE_COINS),
    side: z.enum(["long", "short"]),
  })
  .strict();

interface RunRow {
  id: string;
  token_hash: string;
  position_id: string;
  state: "live" | "done";
  has_stop: number;
  open_ms: number | null;
  created_ms: number;
  ends_ms: number;
  done_ms: number | null;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

export function judgeCookie(token: string, maxAgeS: number): string {
  return `${JUDGE_COOKIE}=${token}; Path=/api/judge; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeS}`;
}

const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16) + " UTC";

export class Judge {
  private opening = false;
  private held: { at: number; ok: boolean } | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly o: JudgeOptions,
  ) {
    if (!o.userId) throw new Error("judge mode needs the demo account's user id");
  }

  private live(): RunRow | undefined {
    return this.ctx.db.prepare("SELECT * FROM judge_runs WHERE state = 'live' AND network = ? ORDER BY created_ms DESC LIMIT 1").get(this.ctx.network) as RunRow | undefined;
  }

  private runOf(token: string | undefined): RunRow | undefined {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return undefined;
    return this.ctx.db.prepare("SELECT * FROM judge_runs WHERE token_hash = ?").get(sha256(token).toString("hex")) as RunRow | undefined;
  }

  private usedToday(): { n: number; first: number | null } {
    return this.ctx.db
      .prepare("SELECT COUNT(*) AS n, MIN(created_ms) AS first FROM judge_runs WHERE network = ? AND created_ms > ?")
      .get(this.ctx.network, this.ctx.now() - DAY_MS) as { n: number; first: number | null };
  }

  /** Whether a free demo piece holds enough to trade. A failed read does not block the page. */
  async funded(): Promise<boolean> {
    const now = this.ctx.now();
    if (this.held && now - this.held.at < HELD_CACHE_MS) return this.held.ok;
    let ok = true;
    try {
      ok = false;
      for (const p of freePieces(this.ctx, this.o.userId)) {
        if (!p.hl_address) continue;
        const perp = await this.ctx.hl.perp(p.hl_address);
        if (perp.positions.length === 0 && perp.accountValue >= JUDGE_MIN_HELD_USD) {
          ok = true;
          break;
        }
      }
    } catch {
      ok = true;
    }
    this.held = { at: now, ok };
    return ok;
  }

  /** Whether a trade can be opened right now. */
  async status() {
    const live = this.live();
    const used = this.usedToday();
    return {
      ready: live ? true : await this.funded(),
      notionalUsd: JUDGE_NOTIONAL_USD,
      leverage: JUDGE_LEVERAGE,
      coins: [...JUDGE_COINS],
      minutes: JUDGE_RUN_MS / 60_000,
      busyUntilMs: live ? live.ends_ms : null,
      leftToday: Math.max(0, this.o.perDay - used.n),
    };
  }

  /** Check the limits, then open the trade. Answers the run and its token. */
  async open(body: z.infer<typeof JudgeOpen>): Promise<{ token: string; run: ReturnType<Judge["view"]> }> {
    this.sweep();
    const used = this.usedToday();
    if (used.n >= this.o.perDay) throw new ApiError("judge_session_spent", { time: clock((used.first ?? this.ctx.now()) + DAY_MS) });
    const live = this.live();
    if (live || this.opening) throw new ApiError("judge_busy", { time: clock(live?.ends_ms ?? this.ctx.now() + JUDGE_RUN_MS) });
    if (freePieces(this.ctx, this.o.userId).length < 1) throw new ApiError("judge_busy", { time: clock(this.ctx.now() + JUDGE_RUN_MS) });
    if (!(await this.funded())) throw new ApiError("judge_unavailable");

    this.opening = true;
    try {
      const plan = { coin: body.coin, side: body.side, notionalUsd: JUDGE_NOTIONAL_USD, leverage: JUDGE_LEVERAGE, hiding: "normal" as const };
      let r;
      try {
        r = await createPosition(this.ctx, this.o.userId, plan, { reuseOnly: true });
      } catch (e) {
        if (e instanceof ApiError && e.code === "agent_needs_pieces") throw new ApiError("judge_busy", { time: clock(this.ctx.now() + JUDGE_RUN_MS) });
        throw e;
      }
      if (r.state !== "funding") {
        // the demo account has something to approve in the app first; nothing was funded
        this.ctx.db.prepare("UPDATE positions SET state = 'failed', error = 'judge_needs_app' WHERE id = ?").run(r.positionId);
        throw new ApiError("judge_unavailable");
      }
      const token = randomBytes(32).toString("hex");
      const now = this.ctx.now();
      this.ctx.db
        .prepare("INSERT INTO judge_runs (id, token_hash, position_id, state, created_ms, ends_ms, network) VALUES (?, ?, ?, 'live', ?, ?, ?)")
        .run(newId(), sha256(token).toString("hex"), r.positionId, now, now + JUDGE_RUN_MS, this.ctx.network);
      return { token, run: this.view(this.runOf(token)!) };
    } finally {
      this.opening = false;
    }
  }

  /** The judge's own run: the position as its owner sees it, the end time, and whether a stop is sealed. */
  view(run: RunRow) {
    const pos = listPositions(this.ctx, this.o.userId).positions.find((p) => p.id === run.position_id) ?? null;
    return {
      id: run.position_id,
      live: run.state === "live",
      endsMs: run.ends_ms,
      stopSealed: run.has_stop === 1,
      stopByMs: run.open_ms === null ? null : run.open_ms + JUDGE_STOP_WITHIN_MS,
      position: pos && { ...pos, alerts: [] },
    };
  }

  mine(token: string | undefined) {
    this.sweep();
    const run = this.runOf(token);
    return run ? this.view(run) : null;
  }

  private own(token: string | undefined): RunRow {
    const run = this.runOf(token);
    if (!run) throw new ApiError("judge_no_run");
    return run;
  }

  async stop(token: string | undefined, boxes: z.infer<typeof StopBody>["boxes"]) {
    const run = this.own(token);
    if (run.state !== "live") throw new ApiError("wrong_state");
    const out = await forwardStops(this.ctx, this.o.userId, run.position_id, boxes);
    if (out.sealed > 0) this.ctx.db.prepare("UPDATE judge_runs SET has_stop = 1 WHERE id = ?").run(run.id);
    return out;
  }

  close(token: string | undefined) {
    const run = this.own(token);
    return this.finish(run);
  }

  hunter(token: string | undefined) {
    return hunterView(this.ctx, this.o.userId, this.own(token).position_id);
  }

  /** Close the position, or call it off if nothing is open on Hyperliquid yet, and end the run. */
  private finish(run: RunRow) {
    const pos = this.ctx.db.prepare("SELECT state FROM positions WHERE id = ?").get(run.position_id) as { state: string };
    if (pos.state === "open" || pos.state === "opening") closePosition(this.ctx, this.o.userId, run.position_id, true);
    else if (pos.state === "planned" || pos.state === "funding" || pos.state === "policy_wait") {
      // no piece holds a position yet; money already on its way stays on the piece for the next run
      this.ctx.db.prepare("UPDATE positions SET state = 'failed', error = 'judge_closed' WHERE id = ? AND state IN ('planned', 'funding', 'policy_wait')").run(run.position_id);
    }
    const after = (this.ctx.db.prepare("SELECT state FROM positions WHERE id = ?").get(run.position_id) as { state: string }).state;
    if (run.state === "live") {
      this.ctx.db.prepare("UPDATE judge_runs SET state = 'done', done_ms = ? WHERE id = ?").run(this.ctx.now(), run.id);
    }
    return { ok: true as const, state: after };
  }

  /** Close runs past their time, and runs that opened with no sealed stop in time. Safe to run often. */
  sweep(): void {
    const now = this.ctx.now();
    const runs = this.ctx.db.prepare("SELECT * FROM judge_runs WHERE state = 'live' AND network = ?").all(this.ctx.network) as RunRow[];
    for (const run of runs) {
      const pos = this.ctx.db.prepare("SELECT state FROM positions WHERE id = ?").get(run.position_id) as { state: string };
      if (pos.state === "closed" || pos.state === "failed") {
        this.ctx.db.prepare("UPDATE judge_runs SET state = 'done', done_ms = ? WHERE id = ?").run(now, run.id);
        continue;
      }
      if (pos.state === "open" && run.open_ms === null) {
        this.ctx.db.prepare("UPDATE judge_runs SET open_ms = ? WHERE id = ?").run(now, run.id);
        run.open_ms = now;
      }
      const late = now >= run.ends_ms;
      const noStop = run.has_stop === 0 && run.open_ms !== null && now >= run.open_ms + JUDGE_STOP_WITHIN_MS;
      if (late || noStop) {
        if (pos.state === "closing") continue;
        // not open yet: the stop can only be sealed once it opens, so only the end time calls it off
        if (!late && (pos.state === "funding" || pos.state === "planned" || pos.state === "policy_wait")) continue;
        this.finish(run);
      }
    }
  }
}

export function registerJudgeRoutes(app: FastifyInstance, judge: Judge, ctx: Ctx): void {
  const token = (req: FastifyRequest) => readCookie(req.headers.cookie, JUDGE_COOKIE);
  app.get("/api/judge", async (req) => ({ ...(await judge.status()), run: judge.mine(token(req)) }));
  app.post("/api/judge/open", async (req, reply) => {
    const parsed = JudgeOpen.safeParse(req.body);
    if (!parsed.success) throw new ApiError("bad_request");
    const r = await judge.open(parsed.data);
    reply.header("Set-Cookie", judgeCookie(r.token, Math.floor((JUDGE_RUN_MS * 3) / 1000)));
    return { run: r.run };
  });
  app.get("/api/judge/box-pub", async (req) => {
    if (!judge.mine(token(req))) throw new ApiError("judge_no_run");
    try {
      return { boxPub: await ctx.guard.boxPub() };
    } catch (e) {
      if (e instanceof GuardUnreachable) throw new ApiError("guard_unreachable");
      throw e;
    }
  });
  app.post("/api/judge/stop", async (req) => {
    const parsed = StopBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError("bad_request");
    return judge.stop(token(req), parsed.data.boxes);
  });
  app.post("/api/judge/close", async (req) => judge.close(token(req)));
  app.get("/api/judge/hunter", async (req) => judge.hunter(token(req)));
}
