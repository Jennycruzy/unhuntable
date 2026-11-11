// The money routes of the HTTP API, and the jobs behind them. Every route needs a session
// and only touches the signed-in user's own wallets, positions, deposits and homes.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE, readCookie, sessionUser } from "./auth.js";
import type { Ctx } from "./ctx.js";
import { QuoteBody, depositStatus, pollDeposit, quote } from "./deposits.js";
import { GuardUnreachable } from "./guard.js";
import { HomeBody, advanceHome, confirmHomePolicies, homeStatus, startHome, takeHomeChainSig } from "./home.js";
import { ApproveBody, HomeSigsBody, RegisterBody, approvePiece, registerPiece } from "./chainsig.js";
import { hunterView } from "./hunter.js";
import type { JobRunner } from "./jobs.js";
import {
  CloseBody,
  PlanBody,
  StopBody,
  advancePosition,
  closePosition,
  confirmPositionPolicies,
  continuePosition,
  createPosition,
  forwardStops,
  listPositions,
  previewPlan,
} from "./positions.js";
import { ApiError } from "./refusals.js";
import { sendRefill } from "./watch.js";
import { ConfirmBody, KeyBody, PiecesKeyBody, balances, confirmWallet, me, newKey, setPiecesKey } from "./wallets.js";

const ConfirmPolicyBody = z
  .object({ positionId: z.string().uuid().optional(), homeId: z.string().uuid().optional(), txHashes: z.array(z.string().max(100)).max(64) })
  .refine((b) => (b.positionId === undefined) !== (b.homeId === undefined));

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  const r = schema.safeParse(v ?? {});
  if (!r.success) throw new ApiError("bad_request");
  return r.data;
}

const Id = z.string().uuid();

export function registerMoneyRoutes(app: FastifyInstance, ctx: Ctx): void {
  const user = (req: FastifyRequest): string => {
    const u = sessionUser(ctx.db, readCookie(req.headers.cookie, SESSION_COOKIE), ctx.now());
    if (!u) throw new ApiError("not_signed_in");
    return u;
  };
  const id = (req: FastifyRequest): string => parse(Id, (req.params as { id?: string }).id);

  app.get("/api/me", async (req) => me(ctx, user(req)));
  app.post("/api/pieces-key", async (req) => setPiecesKey(ctx, user(req), parse(PiecesKeyBody, req.body)));
  app.post("/api/wallets/key", async (req) => newKey(ctx, user(req), parse(KeyBody, req.body)));
  app.post("/api/wallets/confirm", async (req) => confirmWallet(ctx, user(req), parse(ConfirmBody, req.body)));
  app.get("/api/balance", async (req) => balances(ctx, user(req)));
  app.post("/api/chainsig/register", async (req) => registerPiece(ctx, user(req), parse(RegisterBody, req.body)));
  app.post("/api/chainsig/approve", async (req) => approvePiece(ctx, user(req), parse(ApproveBody, req.body)));

  app.post("/api/deposit/quote", async (req) => quote(ctx, user(req), parse(QuoteBody, req.body)));
  app.get("/api/deposit/:id", async (req) => depositStatus(ctx, user(req), id(req)));

  app.post("/api/plan", async (req) => previewPlan(ctx, user(req), parse(PlanBody, req.body)));
  app.post("/api/positions", async (req) => createPosition(ctx, user(req), parse(PlanBody, req.body)));
  app.post("/api/positions/:id/continue", async (req) => continuePosition(ctx, user(req), id(req)));
  app.post("/api/policy/confirm", async (req) => {
    const u = user(req);
    const b = parse(ConfirmPolicyBody, req.body);
    return b.positionId ? confirmPositionPolicies(ctx, u, b.positionId) : confirmHomePolicies(ctx, u, b.homeId!);
  });
  app.get("/api/positions", async (req) => listPositions(ctx, user(req)));
  app.get("/api/guard/box-pub", async (req) => {
    user(req);
    try {
      return { boxPub: await ctx.guard.boxPub() };
    } catch (e) {
      if (e instanceof GuardUnreachable) throw new ApiError("guard_unreachable");
      throw e;
    }
  });
  app.post("/api/positions/:id/stop", async (req) => {
    const u = user(req);
    return forwardStops(ctx, u, id(req), parse(StopBody, req.body).boxes);
  });
  app.post("/api/positions/:id/close", async (req) => {
    const u = user(req);
    return closePosition(ctx, u, id(req), parse(CloseBody, req.body).now);
  });

  // What Hyperliquid shows anyone about this position's pieces: public data, for the owner only.
  app.get("/api/positions/:id/hunter", async (req) => hunterView(ctx, user(req), id(req)));

  app.post("/api/home", async (req) => startHome(ctx, user(req), parse(HomeBody, req.body)));
  app.get("/api/home/:id", async (req) => homeStatus(ctx, user(req), id(req)));
  app.post("/api/home/:id/chainsig", async (req) => takeHomeChainSig(ctx, user(req), id(req), parse(HomeSigsBody, req.body)));

  app.get("/api/alerts", async (req) => {
    const rows = ctx.db.prepare("SELECT text, created_ms FROM alerts WHERE user_id = ? ORDER BY created_ms DESC, rowid DESC LIMIT 100").all(user(req)) as {
      text: string;
      created_ms: number;
    }[];
    return { alerts: rows.map((r) => ({ text: r.text, ms: r.created_ms })) };
  });
}

export function registerMoneyJobs(jobs: JobRunner, ctx: Ctx): void {
  jobs.register("deposit_poll", (p: { depositId: string }) => pollDeposit(ctx, p.depositId));
  jobs.register("position", (p: { positionId: string }, job) => advancePosition(ctx, p.positionId, job.attempts));
  jobs.register("home", (p: { homeId: string }) => advanceHome(ctx, p.homeId));
  jobs.register("refill", (p: { refillId: string }) => sendRefill(ctx, p.refillId));
}
