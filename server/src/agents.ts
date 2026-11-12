// AI agents: a second door into the same pieces, sealed stops and guard.
//
// The owner makes an agent key in the app and gives it limits: the largest size it may
// open, which coins, and how many opens a day. With that key an agent can open a position
// on pieces the owner already set up, seal a stop, read status and close. It cannot make
// pieces, move money, trade stocks or read a stop back: setting up pieces and moving money
// need the owner's pieces key, which never leaves the owner's browser, and stops are sealed
// on the agent's machine into a box only the guard opens.
//
// Every agent call passes the key and its limits first, then is paid with x402 (USDC on
// NEAR, settled before the call runs), then runs. Each call is recorded with its payment.
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hlAsset } from "unhuntable-client";
import { z } from "zod";
import { SESSION_COOKIE, readCookie, sessionUser } from "./auth.js";
import type { Ctx } from "./ctx.js";
import { newId } from "./db.js";
import { GuardUnreachable } from "./guard.js";
import { CloseBody, PlanBody, StopBody, closePosition, createPosition, forwardStops, freePieces, listPositions, previewPlan } from "./positions.js";
import { FollowBody, HANDLE, agentAskKey, closedTrades, traderCard } from "./followers.js";
import { ApiError } from "./refusals.js";
import type { Paid, Paywall } from "./x402.js";

export const KEY_PREFIX = "uak_";
export const MAX_KEYS = 10;
const DAY_MS = 24 * 60 * 60_000;

export interface AgentKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  max_notional_usd: number;
  coins_json: string;
  daily_opens: number;
  created_ms: number;
  revoked_ms: number | null;
}

const crypto = new Set(["BTC", "ETH", "SOL"]);

export const NewKeyBody = z
  .object({
    name: z.string().trim().min(1).max(40),
    maxNotionalUsd: z.number().finite().positive().max(5000),
    coins: z.array(z.string().refine((c) => crypto.has(c))).min(1).max(3),
    dailyOpens: z.number().int().min(1).max(100),
  })
  .strict();

const AgentOpen = z
  .object({
    coin: z.string().max(24),
    side: z.enum(["long", "short"]),
    notionalUsd: z.number().finite().positive(),
    leverage: z.number().int().min(1).max(100),
    hiding: z.enum(["normal", "whale"]).default("normal"),
  })
  .strict();

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  const r = schema.safeParse(v ?? {});
  if (!r.success) throw new ApiError("bad_request");
  return r.data;
}

// ------------------------------------------------------------ keys (the owner, signed in)

export function newKey(ctx: Ctx, userId: string, body: z.infer<typeof NewKeyBody>) {
  const live = ctx.db.prepare("SELECT COUNT(*) AS n FROM agent_keys WHERE user_id = ? AND revoked_ms IS NULL").get(userId) as { n: number };
  if (live.n >= MAX_KEYS) throw new ApiError("agent_limit", { reason: `an account can hold at most ${MAX_KEYS} agent keys` });
  const key = KEY_PREFIX + randomBytes(32).toString("hex");
  const id = newId();
  ctx.db
    .prepare(
      "INSERT INTO agent_keys (id, user_id, name, key_hash, max_notional_usd, coins_json, daily_opens, created_ms, network) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, userId, body.name, hashKey(key), body.maxNotionalUsd, JSON.stringify(body.coins), body.dailyOpens, ctx.now(), ctx.network);
  // the key is shown once, here, and never stored
  return { id, key, name: body.name };
}

export function listKeys(ctx: Ctx, userId: string) {
  const rows = ctx.db.prepare("SELECT * FROM agent_keys WHERE user_id = ? ORDER BY created_ms DESC").all(userId) as AgentKeyRow[];
  return {
    keys: rows.map((k) => {
      const calls = ctx.db.prepare("SELECT COUNT(*) AS n, COUNT(paid_tx) AS paid FROM agent_calls WHERE key_id = ?").get(k.id) as { n: number; paid: number };
      const last = ctx.db.prepare("SELECT op, result, paid_tx, created_ms FROM agent_calls WHERE key_id = ? ORDER BY created_ms DESC, rowid DESC LIMIT 5").all(k.id) as {
        op: string;
        result: string;
        paid_tx: string | null;
        created_ms: number;
      }[];
      return {
        id: k.id,
        name: k.name,
        maxNotionalUsd: k.max_notional_usd,
        coins: JSON.parse(k.coins_json) as string[],
        dailyOpens: k.daily_opens,
        createdMs: k.created_ms,
        revoked: k.revoked_ms !== null,
        calls: calls.n,
        paidCalls: calls.paid,
        recent: last.map((c) => ({ op: c.op, result: c.result, paidTx: c.paid_tx, ms: c.created_ms })),
      };
    }),
  };
}

export function revokeKey(ctx: Ctx, userId: string, id: string) {
  const r = ctx.db.prepare("UPDATE agent_keys SET revoked_ms = ? WHERE id = ? AND user_id = ? AND revoked_ms IS NULL").run(ctx.now(), id, userId);
  if (r.changes !== 1) throw new ApiError("not_found");
  return { ok: true as const };
}

// ------------------------------------------------------------ calls (the agent)

function agentOf(ctx: Ctx, req: FastifyRequest): AgentKeyRow {
  const h = req.headers.authorization;
  const m = typeof h === "string" ? /^Bearer (uak_[0-9a-f]{64})$/.exec(h) : null;
  if (!m) throw new ApiError("agent_key_missing");
  const k = ctx.db.prepare("SELECT * FROM agent_keys WHERE key_hash = ? AND revoked_ms IS NULL").get(hashKey(m[1])) as AgentKeyRow | undefined;
  if (!k) throw new ApiError("agent_key_refused");
  return k;
}

/** Limits that a call must pass before it is paid for, including enough ready pieces. */
async function checkOpen(ctx: Ctx, k: AgentKeyRow, body: z.infer<typeof AgentOpen>): Promise<void> {
  const a = hlAsset(body.coin);
  if (!a) throw new ApiError("bad_request");
  if (a.dex) throw new ApiError("agent_stocks");
  const coins = JSON.parse(k.coins_json) as string[];
  if (!coins.includes(a.coin)) throw new ApiError("agent_limit", { reason: `it trades only ${coins.join(", ")}` });
  if (body.notionalUsd > k.max_notional_usd) throw new ApiError("agent_limit", { reason: `its largest size is $${k.max_notional_usd}` });
  const opens = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM agent_calls WHERE key_id = ? AND op = 'open' AND result = 'ok' AND created_ms > ?")
    .get(k.id, ctx.now() - DAY_MS) as { n: number };
  if (opens.n >= k.daily_opens) throw new ApiError("agent_limit", { reason: `it may open ${k.daily_opens} positions a day` });
  // one piece for normal hiding; for whale, the count a plan at today's price asks for
  const have = freePieces(ctx, k.user_id).length;
  const need = body.hiding === "normal" ? 1 : (await previewPlan(ctx, k.user_id, parse(PlanBody, body))).plan.pieces.length;
  if (have < need) throw new ApiError("agent_needs_pieces", { need, have });
}

function ownAgentPosition(ctx: Ctx, k: AgentKeyRow, id: string): void {
  const p = ctx.db.prepare("SELECT id FROM positions WHERE id = ? AND user_id = ? AND agent_key_id = ?").get(id, k.user_id, k.id);
  if (!p) throw new ApiError("not_found");
}

/**
 * What an agent may see of its own positions: no Hyperliquid addresses and no levels. Each
 * piece's shard id (which only the guard knows the meaning of) and size are there so the
 * agent can seal a stop for every piece on its own machine.
 */
function agentStatus(ctx: Ctx, k: AgentKeyRow) {
  const all = listPositions(ctx, k.user_id).positions;
  const mine = new Set((ctx.db.prepare("SELECT id FROM positions WHERE agent_key_id = ?").all(k.id) as { id: string }[]).map((r) => r.id));
  return {
    positions: all
      .filter((p) => mine.has(p.id))
      .map((p) => ({
        id: p.id,
        coin: p.coin,
        side: p.side,
        notionalUsd: p.notionalUsd,
        leverage: p.leverage,
        state: p.state,
        pieces: p.pieces.map((x) => ({ shard: x.shard, size: x.size, liqDistance: x.liqDistance, hasStop: x.hasStop, hasTp: x.hasTp, guard: x.guard })),
      })),
  };
}

function record(ctx: Ctx, k: AgentKeyRow, op: string, result: string, paid: Paid | null, positionId: string | null = null): void {
  ctx.db
    .prepare("INSERT INTO agent_calls (id, key_id, op, position_id, price, payer, paid_tx, result, created_ms, network) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(newId(), k.id, op, positionId, paid?.price ?? null, paid?.payer ?? null, paid?.tx ?? null, result.slice(0, 120), ctx.now(), ctx.network);
}

/**
 * The agent routes. With a paywall every call but box-pub is paid; without one (x402 off)
 * calls are free and still recorded.
 */
export function registerAgentRoutes(app: FastifyInstance, ctx: Ctx, paywall?: Paywall): void {
  const owner = (req: FastifyRequest): string => {
    const u = sessionUser(ctx.db, readCookie(req.headers.cookie, SESSION_COOKIE), ctx.now());
    if (!u) throw new ApiError("not_signed_in");
    return u;
  };
  const Id = z.string().uuid();
  const id = (req: FastifyRequest): string => parse(Id, (req.params as { id?: string }).id);

  app.post("/api/agents", async (req) => newKey(ctx, owner(req), parse(NewKeyBody, req.body)));
  app.get("/api/agents", async (req) => ({
    ...listKeys(ctx, owner(req)),
    price: paywall?.price ?? null,
    payTo: paywall?.payTo ?? null,
    network: paywall?.network ?? null,
    routes: paywall?.routes ?? [],
  }));
  app.post("/api/agents/:id/revoke", async (req) => revokeKey(ctx, owner(req), id(req)));

  // Free: the guard's box key, so the agent can seal a stop on its own machine.
  app.get("/api/agent/box-pub", async (req) => {
    agentOf(ctx, req);
    try {
      return { boxPub: await ctx.guard.boxPub() };
    } catch (e) {
      if (e instanceof GuardUnreachable) throw new ApiError("guard_unreachable");
      throw e;
    }
  });

  /** Check, then take payment, then run. Answers with the x402 challenge when unpaid. */
  const paidCall = async (
    req: FastifyRequest,
    reply: FastifyReply,
    op: string,
    check: (k: AgentKeyRow) => void | Promise<void>,
    run: (k: AgentKeyRow) => Promise<{ out: unknown; positionId?: string }>,
  ) => {
    const k = agentOf(ctx, req);
    await check(k);
    let paid: Paid | null = null;
    if (paywall) {
      const c = await paywall.charge(req);
      if ("reply" in c) {
        const body = c.reply.body && typeof c.reply.body === "object" ? c.reply.body : {};
        const tried = req.headers["payment-signature"] !== undefined || req.headers["x-payment"] !== undefined;
        // a second challenge (PingPay's quote: deposit address and amount) is not a failure
        const challenge = Array.isArray((body as { accepts?: unknown }).accepts);
        const settling = (body as { errorReason?: unknown }).errorReason === "settlement_pending";
        const e = settling
          ? new ApiError("payment_settling")
          : tried && !challenge
            ? new ApiError("payment_failed", { reason: String((body as { error?: unknown }).error ?? "the facilitator refused it") })
            : new ApiError("payment_required", { price: paywall.price });
        return reply.code(c.reply.status).headers(c.reply.headers).send({ ...body, ...e.body() });
      }
      paid = c.paid;
      reply.headers(c.headers);
    }
    try {
      const r = await run(k);
      record(ctx, k, op, "ok", paid, r.positionId ?? null);
      return { ...(r.out as object), ...(paid ? { paid: { tx: paid.tx, price: paid.price } } : {}) };
    } catch (e) {
      record(ctx, k, op, e instanceof ApiError ? e.code : "error", paid);
      throw e;
    }
  };

  app.get("/api/agent/positions", async (req, reply) => paidCall(req, reply, "status", () => undefined, async (k) => ({ out: agentStatus(ctx, k) })));

  // Followers: closed trades of a trader the owner holds a key to, and asking the owner for a key.
  const handleOf = (req: FastifyRequest): string => parse(z.string().regex(HANDLE), (req.params as { handle?: string }).handle);
  app.get("/api/agent/traders/:handle/trades", async (req, reply) => {
    const h = handleOf(req);
    return paidCall(req, reply, "trades", () => void traderCard(ctx, h), async (k) => ({ out: closedTrades(ctx, k.user_id, h) }));
  });
  app.post("/api/agent/follow", async (req, reply) => {
    const body = parse(FollowBody, req.body);
    return paidCall(
      req,
      reply,
      "follow",
      (k) => {
        traderCard(ctx, body.handle);
        if (body.kind === "copy" && body.copyUsd! > k.max_notional_usd) throw new ApiError("agent_limit", { reason: `its largest size is $${k.max_notional_usd}` });
      },
      async (k) => ({ out: agentAskKey(ctx, k.user_id, k.name, k.max_notional_usd, body) }),
    );
  });

  app.post("/api/agent/positions", async (req, reply) => {
    const body = parse(AgentOpen, req.body);
    return paidCall(
      req,
      reply,
      "open",
      (k) => checkOpen(ctx, k, body),
      async (k) => {
        const plan = parse(PlanBody, body);
        const r = await createPosition(ctx, k.user_id, plan, { reuseOnly: true, agentKeyId: k.id });
        if (r.state !== "funding") {
          // the owner has something to approve first; nothing was funded
          ctx.db.prepare("UPDATE positions SET state = 'failed', error = 'agent_needs_app' WHERE id = ?").run(r.positionId);
          throw new ApiError("agent_needs_app");
        }
        return { out: { positionId: r.positionId, state: r.state }, positionId: r.positionId };
      },
    );
  });

  app.post("/api/agent/positions/:id/stop", async (req, reply) => {
    const pid = id(req);
    const body = parse(StopBody, req.body);
    return paidCall(
      req,
      reply,
      "stop",
      (k) => ownAgentPosition(ctx, k, pid),
      async (k) => ({ out: await forwardStops(ctx, k.user_id, pid, body.boxes), positionId: pid }),
    );
  });

  app.post("/api/agent/positions/:id/close", async (req, reply) => {
    const pid = id(req);
    const body = parse(CloseBody, req.body);
    return paidCall(
      req,
      reply,
      "close",
      (k) => ownAgentPosition(ctx, k, pid),
      async (k) => ({ out: closePosition(ctx, k.user_id, pid, body.now), positionId: pid }),
    );
  });
}
