// HTTP API. JSON only, no HTML. Every error is { error, message } with a plain sentence.
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { pathToFileURL } from "node:url";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SessionRequest,
  endSession,
  nearViewAccessKey,
  readCookie,
  sessionCookie,
  signIn,
  type ViewAccessKey,
} from "./auth.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { openDb, type Db } from "./db.js";
import { JobRunner } from "./jobs.js";
import { createLogger } from "./log.js";
import { ApiError, sendError } from "./refusals.js";
import { randomBytes } from "node:crypto";
import type { Ctx } from "./ctx.js";
import { GuardAdapter } from "./guard.js";
import { Hyperliquid } from "./hl.js";
import { KeyStore } from "./keystore.js";
import { NearRpc } from "./near.js";
import { OneClick } from "./oneclick.js";
import { NearRelay } from "./relay.js";
import { walletClient } from "./outlayer.js";
import { registerMoneyJobs, registerMoneyRoutes } from "./routes.js";
import { HEARTBEAT_MS, MIDS_POLL_MS, heartbeat, watchMids } from "./watch.js";
import { WHALE_EVERY_MS, WhaleWatch } from "./whale.js";
import { openHuntDbReadOnly } from "./huntmap.js";
import { HuntMapView } from "./huntview.js";

export interface ServerDeps {
  config: Config;
  db: Db;
  viewAccessKey?: ViewAccessKey;
  now?: () => number;
  log?: Logger;
  /** The money flows; their routes are served when this is given. */
  money?: Ctx;
  /** The largest public position on Hyperliquid, for the start page. */
  whale?: WhaleWatch;
  /** The Hunt Map, read from the collector's store. */
  huntMap?: HuntMapView;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config, db } = deps;
  const now = deps.now ?? Date.now;
  const viewAccessKey = deps.viewAccessKey ?? nearViewAccessKey(config.nearRpcUrl);
  const app = Fastify({
    loggerInstance: (deps.log ?? createLogger({ level: "silent" })) as FastifyBaseLogger,
    bodyLimit: 16 * 1024,
    trustProxy: true,
  });
  const allowed = new Set(config.corsOrigins);

  app.addHook("onRequest", async (req, reply) => {
    reply.headers(SECURITY_HEADERS);
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      if (!origin || !allowed.has(origin)) return sendError(reply, "not_found");
      reply.header("Access-Control-Allow-Methods", "GET, POST");
      reply.header("Access-Control-Allow-Headers", "Content-Type");
      reply.header("Access-Control-Max-Age", "600");
      return reply.code(204).send();
    }
  });

  app.setNotFoundHandler((_req, reply) => sendError(reply, "not_found"));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send(err.body());
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return sendError(reply, "bad_request");
    req.log.error({ err }, "request failed");
    return sendError(reply, "internal");
  });

  app.get("/api/health", async () => ({ ok: true, version: config.version }));

  app.post("/api/session", async (req, reply) => {
    const body = SessionRequest.safeParse(req.body);
    if (!body.success) throw new ApiError("bad_request");
    const s = await signIn({ db, network: config.network, appName: config.appName, viewAccessKey, now }, body.data);
    reply.header("Set-Cookie", sessionCookie(s.token, Math.floor(SESSION_TTL_MS / 1000)));
    return { ok: true, accountId: body.data.accountId, expiresMs: s.expiresMs };
  });

  app.post("/api/logout", async (req, reply) => {
    endSession(db, readCookie(req.headers.cookie, SESSION_COOKIE));
    reply.header("Set-Cookie", sessionCookie("", 0));
    return { ok: true };
  });

  app.get("/api/evidence", async () => {
    const rows = db
      .prepare("SELECT kind, COUNT(*) AS n FROM evidence WHERE network = ? GROUP BY kind ORDER BY kind")
      .all(config.network) as { kind: string; n: number }[];
    return { counts: Object.fromEntries(rows.map((r) => [r.kind, r.n])) };
  });

  // Public data only, and never an error: the page draws its film without numbers until one is read.
  app.get("/api/whale", async () => ({ whale: deps.whale?.latest ?? null }));

  // Public data only: the visible liquidation prices of the largest Hyperliquid accounts.
  app.get("/api/hunt-map", async () => ({ map: deps.huntMap?.read() ?? null }));

  if (deps.money) registerMoneyRoutes(app, deps.money);

  return app;
}

/** Everything the money flows need, from the config. */
export function moneyContext(config: Config, db: Db, jobs: JobRunner, log: Logger): Ctx {
  if (!config.secrets.keystoreKey) throw new ConfigError("keystoreKey is missing from the secrets file");
  if (!config.walletKeysFile) throw new ConfigError("WALLET_KEYS_FILE must name the wallet key file");
  const keystore = new KeyStore({ path: config.walletKeysFile, key: config.secrets.keystoreKey });
  let chainsig: Ctx["chainsig"];
  if (config.chainsigContract) {
    if (!config.relayAccount || !config.secrets.relayKey) throw new ConfigError("CHAINSIG_CONTRACT needs RELAY_ACCOUNT and relayKey in the secrets file");
    chainsig = {
      contract: config.chainsigContract,
      relay: new NearRelay(config.nearRpcUrl, config.relayAccount, config.secrets.relayKey),
      chain: config.network === "mainnet" ? "Mainnet" : "Testnet",
    };
  }
  return {
    db,
    network: config.network,
    now: Date.now,
    wallet: walletClient(config, { log, keystore }),
    keystore,
    near: new NearRpc(config.nearRpcUrl),
    hl: new Hyperliquid(config.hyperliquidUrl),
    oneClick: new OneClick(config.oneClickUrl, config.secrets.auroraKey),
    guard: new GuardAdapter({
      db,
      network: config.network,
      owner: config.guardOwner,
      project: config.guardProject,
      paymentKey: config.secrets.paymentKey,
      baseUrl: config.outlayerUrl,
    }),
    jobs,
    policyContract: config.policyContract,
    appFeeAccount: config.appFeeAccount,
    chainsig,
    builderFee: config.builderFee,
    random: (n) => randomBytes(n),
    log,
  };
}

/** Start the server: load config, open the store, start the job runner, listen. */
export async function main(): Promise<void> {
  const log = createLogger();
  const config = loadConfig();
  const db = openDb(config.dbPath, { network: config.network });
  const jobs = new JobRunner(db, { network: config.network, log });
  const money = moneyContext(config, db, jobs, log);
  registerMoneyJobs(jobs, money);
  jobs.start();
  const whale = new WhaleWatch(money.hl);
  let huntMap: HuntMapView | undefined;
  if (config.huntmapDb) {
    try {
      huntMap = new HuntMapView(openHuntDbReadOnly(config.huntmapDb));
    } catch {
      log.warn({ path: config.huntmapDb }, "hunt map store cannot be opened; /api/hunt-map serves no map");
    }
  }
  const app = buildServer({ config, db, log, money, whale, huntMap });
  let watching = false;
  const watch = (fn: () => Promise<unknown>) => () => {
    if (watching) return;
    watching = true;
    fn()
      .catch((e) => log.warn({ error: e instanceof Error ? e.message : String(e) }, "watch failed"))
      .finally(() => (watching = false));
  };
  const mids = setInterval(watch(() => watchMids(money)), MIDS_POLL_MS);
  const beat = setInterval(watch(() => heartbeat(money)), HEARTBEAT_MS / 12);
  let reading = false;
  const readWhale = () => {
    if (reading) return;
    reading = true;
    whale
      .refresh()
      .catch((e) => log.warn({ error: e instanceof Error ? e.message : String(e) }, "whale read failed"))
      .finally(() => (reading = false));
  };
  const whales = setInterval(readWhale, WHALE_EVERY_MS);
  readWhale();
  mids.unref();
  beat.unref();
  whales.unref();
  await app.listen({ port: config.port, host: config.host });
  const stop = async () => {
    clearInterval(mids);
    clearInterval(beat);
    clearInterval(whales);
    jobs.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // ConfigError messages never hold secret values
    console.error(e instanceof Error ? e.message : "server failed to start");
    process.exit(1);
  });
}
