// Serves the static export (out/) and our HTTP API with fixed replies, on one local port,
// for the Playwright tests. It is only our own API: nothing here speaks for Hyperliquid,
// OutLayer or NEAR. Each test picks its replies with a "scenario" cookie; per-test state
// (go home's progress) is kept under the "sid" cookie.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../out", import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);

/** x25519 public key of the throwaway box secret 0x33 repeated (the guard's test vectors use it). */
export const TEST_BOX_PUB = "7b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b14";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".txt": "text/plain", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2" };

const homes = new Map();

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const fail = (status, error, message) => ({ status, body: { error, message } });
const ok = (body) => ({ status: 200, body });

const policyBatch = (verb) => ({
  summary: [`Piece 1: ${verb} so it can only trade on Hyperliquid and send money back to your private balance.`, `Piece 2: ${verb} the same way.`],
  transactions: [
    {
      receiverId: "outlayer.near",
      actions: [
        { type: "FunctionCall", params: { methodName: "store_wallet_policy", args: { wallet: "piece:0", locked: verb === "lock" }, gas: "30000000000000", deposit: "0" } },
        { type: "FunctionCall", params: { methodName: "store_wallet_policy", args: { wallet: "piece:1", locked: verb === "lock" }, gas: "30000000000000", deposit: "0" } },
      ],
    },
  ],
});

export const PLAN_ANSWER = {
  plan: {
    coin: "ETH",
    side: "long",
    leverage: 3,
    totalSize: 0.0912,
    pieces: [
      { index: 0, size: 0.0456, notionalUsd: 150.25, fundingUsd: 75, entryOffsetMs: 130000, reserveUsd: 12.5 },
      { index: 1, size: 0.0456, notionalUsd: 149.75, fundingUsd: 75, entryOffsetMs: 410000, reserveUsd: 12.5 },
    ],
    totalFundingUsd: 150,
    estFeesUsd: 0.27,
    vrfHex: "ab".repeat(32),
  },
  feesUsd: "0.93",
  exitFeeUsd: "2.40",
  world: [
    { name: "Account 1", sizeUsd: "150.25", side: "long" },
    { name: "Account 2", sizeUsd: "149.75", side: "long" },
  ],
  newPiecesNeeded: 0,
};

function positions(scenario) {
  const guard = scenario === "guard_down" ? "unreachable" : "ok";
  return {
    positions: [
      {
        id: "pos1",
        coin: "ETH",
        side: "long",
        notionalUsd: 300,
        leverage: 3,
        hiding: "whale",
        state: "open",
        createdMs: 1767225600000,
        pieces: [
          { label: "piece:0", shard: "s0", size: 0.0456, entryPx: 3290.5, liqDistance: 0.24, hasStop: true, hasTp: false, guard },
          { label: "piece:1", shard: "s1", size: 0.0456, entryPx: 3291.1, liqDistance: 0.24, hasStop: true, hasTp: false, guard },
        ],
        alerts:
          scenario === "guard_down"
            ? [{ text: "The guard isn't answering. Your positions are open on Hyperliquid; stops can't fire until it's back. You can close now.", ms: 1767226200000 }]
            : [{ text: "Both pieces are open.", ms: 1767225900000 }],
      },
    ],
  };
}

function api(method, path, body, c) {
  const scenario = c.scenario ?? "ok";
  const signedIn = !!c.sid;
  if (method === "POST" && path === "/api/session") {
    if (scenario === "signin_refused") return fail(401, "key_not_on_account", "That key is not a full-access key of this NEAR account.");
    return { ...ok({ ok: true, accountId: body.accountId, expiresMs: Date.now() + 3600_000 }), cookie: `sid=t${Math.random().toString(36).slice(2)}; Path=/; SameSite=Strict` };
  }
  // public, like the real server: the largest position it last read on Hyperliquid
  if (method === "GET" && path === "/api/whale")
    return ok({
      whale:
        scenario === "no_whale"
          ? null
          : { address: "0x5b5d51203a0f9079f8aeb098a6523a13f298c060", coin: "ETH", side: "short", sizeUsd: 213452000, entryPx: 2322.71, liqPx: 3893.16, markPx: 3401.2, stopPx: null, asOfMs: Date.now() - 120_000 },
    });
  // public: the Hunt us challenge
  if (method === "GET" && path === "/api/hunt-us")
    return ok({ challenge: scenario === "no_hunt" ? null : { coin: "ETH", count: 3, shown: "0x" + "a1".repeat(20), seconds: 90 } });
  if (method === "POST" && path === "/api/hunt-us/start") return ok({ token: "1767225600000." + "ab".repeat(32), revealAtMs: Date.now() + 1500 });
  if (method === "GET" && path === "/api/hunt-us/reveal") {
    const piece = (a, side, liq, at) => ({ address: "0x" + a.repeat(20), side, size: 0.004, valueUsd: 10.1, entryPx: 2500, liqPx: liq, leverage: 3, restingOrders: 0, triggerPxs: [], fundedBy: "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24", fundedAtMs: at, payerAccounts: 871 });
    return ok({ coin: "ETH", asOfMs: 1767226000000, restingOrders: 0, sendsBetweenPieces: 0, payerWindowHours: 6, pieces: [piece("a1", "long", 2050, 1767225000000), piece("b2", "long", 2061, 1767225400000), piece("c3", "long", 2044, 1767225800000)] });
  }
  if (method === "GET" && path === "/api/hunt-map")
    return ok({
      map:
        scenario === "no_map"
          ? null
          : {
              asOfMs: Date.now() - 120_000,
              sinceMs: Date.now() - 86_400_000,
              rounds: 288,
              accounts: 295,
              positions: 832,
              usd: 4110994722.66,
              stops: 12,
              coins: [
                {
                  coin: "BTC",
                  markPx: 73564,
                  usd: 85425527,
                  bands: [
                    { pct: -6, usd: 37_000_000, count: 2 },
                    { pct: -4, usd: 41_000_000, count: 3 },
                    { pct: -2, usd: 1_061_261, count: 1 },
                    { pct: 3, usd: 6_364_266, count: 1 },
                  ],
                  nearest: [
                    { account: "0x8eff8ff863c1a54ec6697b7ad98fe30aa344bd5e", side: "long", valueUsd: 1061261.35, liqPx: 72473.12, awayPct: -1.4829, leverage: 40 },
                    { account: "0xe2823659be02e0f48a4660e4da008b5e1abfdf29", side: "short", valueUsd: 6364266, liqPx: 75400.5, awayPct: 2.4964, leverage: 20 },
                  ],
                },
                {
                  coin: "ETH",
                  markPx: 2060.8,
                  usd: 51640901,
                  bands: [{ pct: -5, usd: 26_255_038, count: 1 }],
                  nearest: [{ account: "0x60468ba27448f88b19f52ed02f1a8c52f7a0b21d", side: "long", valueUsd: 26255038.94, liqPx: 1958.18, awayPct: -4.9797, leverage: 6 }],
                },
              ],
              followed: { levels: 41, reached: 9, mirrorReached: 4, cameBack: 6 },
              touches: [
                {
                  account: "0x7c4b71c1d8a11ed426f301c372a72e06f528e00b",
                  coin: "BTC",
                  side: "long",
                  valueUsd: 36921500,
                  liqPx: 69339.77,
                  seenPx: 71100,
                  seenMs: Date.now() - 20 * 3_600_000,
                  touchedMs: Date.now() - 14 * 3_600_000,
                  cameBack: true,
                },
              ],
            },
    });
  if (!signedIn) return fail(401, "not_signed_in", "Sign in first.");
  const home = homes.get(c.sid) ?? { state: "unlock_wait", steps: [] };
  homes.set(c.sid, home);

  if (method === "GET" && path === "/api/me")
    return ok({ accountId: "alice.near", piecesKey: scenario === "setup" ? "missing" : "on_account", wallets: scenario === "setup" ? [] : [{ label: "balance", kind: "balance", ready: true }] });
  if (method === "GET" && path === "/api/balance") return ok({ privateUsdc: "250.5", pieces: [] });
  if (method === "POST" && path === "/api/deposit/quote") {
    if (scenario === "deposit_min") return fail(422, "deposit_below_min", "The smallest deposit for this route is 10 USDC.");
    return ok({
      id: "dep1",
      depositAddress: "0x1111111111111111111111111111111111111111",
      amountIn: body.amount,
      amountOut: "99.42",
      feeUsd: "0.58",
      ourFeeBps: 6,
      expiresMs: Date.now() + (scenario === "deposit_expired" ? 2000 : 600_000),
      minAmount: "10",
    });
  }
  if (method === "GET" && path.startsWith("/api/deposit/")) {
    const status = { deposit_done: "done", deposit_refunded: "refunded" }[scenario] ?? "waiting";
    return ok({ id: "dep1", status, ...(status === "done" ? { amountIn: "100", amountOut: "99.42" } : {}) });
  }
  if (method === "POST" && path === "/api/plan") {
    if (scenario === "prices_disagree") return fail(503, "prices_disagree", "Price sources disagree right now, so we held off. Your stop is still set.");
    if (scenario === "builder_fee") return ok({ ...PLAN_ANSWER, builderFee: { rate: "0.01%", usd: "0.0300" } });
    return ok(PLAN_ANSWER);
  }
  if (method === "POST" && path === "/api/positions") return ok({ positionId: "pos1", state: "policy_wait", needWallets: [], policyBatch: policyBatch("lock") });
  if (method === "POST" && /^\/api\/positions\/[^/]+\/continue$/.test(path)) return ok({ positionId: "pos1", state: "policy_wait", needWallets: [], policyBatch: policyBatch("lock") });
  if (method === "POST" && path === "/api/policy/confirm") {
    if (body.homeId) {
      if (home.state === "unlock_wait") {
        home.state = "relock_wait";
        home.steps = [
          { label: "piece:0", step: "close", status: "done", ms: 1767226000000 },
          { label: "piece:0", step: "send", status: "done", ms: 1767226060000 },
        ];
        home.arrivedUsdc = "148.2";
        return ok({ ok: true, locked: [], unlocked: ["piece:0", "piece:1"] });
      }
      home.state = "done";
      home.steps.push({ label: "piece:0", step: "relock", status: "done", ms: 1767226120000 });
      return ok({ ok: true, locked: ["piece:0", "piece:1"], unlocked: [] });
    }
    return ok({ ok: true, locked: ["piece:0", "piece:1"], unlocked: [] });
  }
  if (method === "GET" && path === "/api/positions") return ok(positions(scenario));
  if (method === "GET" && /^\/api\/positions\/[^/]+\/hunter$/.test(path)) {
    if (scenario === "hunter_down") return fail(500, "internal", "Something went wrong on our side. Try again.");
    const account = (address, valueUsd, liqPx) => ({ address, side: "long", size: 0.0456, valueUsd, entryPx: 3290.5, liqPx, leverage: 3, restingOrders: 0, triggerPxs: [] });
    return ok({
      asOfMs: 1767225900000,
      coin: "ETH",
      markPx: 3301.2,
      accounts: [account("0x" + "a1".repeat(20), 150.53, 2501.4), account("0x" + "b2".repeat(20), 150.53, 2502.0)],
    });
  }
  if (method === "GET" && path === "/api/guard/box-pub") return ok({ boxPub: TEST_BOX_PUB });
  if (method === "POST" && /^\/api\/positions\/[^/]+\/stop$/.test(path)) return ok({ ok: true, sealed: body.boxes.length });
  if (method === "POST" && /^\/api\/positions\/[^/]+\/close$/.test(path)) return ok({ ok: true, state: "closing" });
  if (method === "POST" && path === "/api/home") return ok({ homeId: "home1", feeUsd: "2.40", unlockBatch: policyBatch("unlock") });
  if (method === "GET" && path.startsWith("/api/home/"))
    return ok({ homeId: "home1", state: home.state, steps: home.steps, relockBatch: home.state === "relock_wait" ? policyBatch("lock") : null, ...(home.arrivedUsdc ? { arrivedUsdc: home.arrivedUsdc } : {}) });
  if (method === "GET" && path === "/api/alerts") return ok({ alerts: [] });
  if (method === "GET" && path === "/api/settings") return ok({ autoRefill: false, refillCapUsdPerDay: 0, refilledTodayUsd: 0 });
  if (method === "POST" && path === "/api/settings") {
    if (typeof body.refillCapUsdPerDay !== "number" || body.refillCapUsdPerDay < 0) return fail(400, "bad_request", "That request is not in the shape we expect.");
    return ok({ autoRefill: body.autoRefill, refillCapUsdPerDay: body.refillCapUsdPerDay, refilledTodayUsd: 0 });
  }
  if (method === "GET" && path === "/api/agents")
    return ok({
      price: scenario === "agents_free" ? null : "0.002",
      payTo: scenario === "agents_free" ? null : "unhuntable.near",
      network: scenario === "agents_free" ? null : "near:mainnet",
      keys: [
        {
          id: "aaaaaaaa-1111-4111-8111-111111111111",
          name: "trend bot",
          maxNotionalUsd: 100,
          coins: ["ETH", "BTC"],
          dailyOpens: 5,
          createdMs: 1767225600000,
          revoked: false,
          calls: 2,
          paidCalls: 2,
          recent: [
            { op: "close", result: "ok", paidTx: "PayTx2", ms: 1767226200000 },
            { op: "open", result: "ok", paidTx: "PayTx1", ms: 1767225900000 },
          ],
        },
      ],
    });
  if (method === "POST" && path === "/api/agents") {
    if (!body.coins?.length) return fail(400, "bad_request", "That request is not in the shape we expect.");
    return ok({ id: "bbbbbbbb-2222-4222-8222-222222222222", key: "uak_" + "c3".repeat(32), name: body.name });
  }
  if (method === "POST" && /^\/api\/agents\/[^/]+\/revoke$/.test(path)) return ok({ ok: true });
  return fail(404, "not_found", "There is nothing here.");
}

async function file(path) {
  let p = normalize(join(OUT, decodeURIComponent(path)));
  if (!p.startsWith(OUT)) return undefined;
  try {
    if ((await stat(p)).isDirectory()) p = join(p, "index.html");
    return { body: await readFile(p), type: TYPES[extname(p)] ?? "application/octet-stream" };
  } catch {
    return undefined;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const r = api(req.method ?? "GET", url.pathname, body, cookies(req));
    const headers = { "Content-Type": "application/json" };
    if (r.cookie) headers["Set-Cookie"] = r.cookie;
    res.writeHead(r.status, headers).end(JSON.stringify(r.body));
    return;
  }
  const f = await file(url.pathname);
  if (f) return void res.writeHead(200, { "Content-Type": f.type }).end(f.body);
  const nf = await file("/404.html");
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" }).end(nf?.body ?? "");
});

server.listen(PORT, "127.0.0.1", () => console.log(`test server on http://127.0.0.1:${PORT}`));
