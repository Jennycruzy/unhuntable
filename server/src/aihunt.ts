// NEAR AI Hunter: an attacker AI, running in a NEAR AI Cloud TEE, tries to find the other
// pieces of one of the owner's positions using only what Hyperliquid shows the public.
//
// It starts where a real hunter starts: one piece's address. It is shown a lineup of
// accounts built the way a hunter would build one: every account the same payer funded
// close to the time it funded each piece, preferring accounts that hold the same market.
// The lineup always holds the owner's other pieces (an easier job than real life, where the
// hunter does not know they are there), and the hunter is told so. For every account it
// gets the public facts: who funded it and when, its positions, resting orders and trigger
// prices, its fills, and any sends between accounts. It must name the accounts it thinks
// share an owner with the first one. We score its names against the truth, which only we
// know, and keep the enclave's signature over the exact question and answer.
import { hlAsset } from "unhuntable-client";
import type { Db } from "./db.js";
import { newId } from "./db.js";
import { Pacer } from "./huntmap.js";
import type { Hyperliquid } from "./hl.js";
import type { Answer, NearAi, Proof } from "./nearai.js";
import { ApiError } from "./refusals.js";

/** Accounts in the lineup besides the starting piece. */
export const LINEUP_SIZE = 15;
/** Recipients of the same payer funded this close to a piece count as its neighbours. */
export const NEIGHBOUR_WINDOW_MS = 20 * 60_000;
/** Neighbours per piece whose positions are read to find ones in the same market. */
export const NEIGHBOURS_SCANNED = 30;
/** How far back fills are read for each account. */
export const FILL_DAYS = 14;
export const HUNTS_PER_USER_PER_DAY = 3;
export const HUNTS_PER_DAY = 60;
/** Hyperliquid request weight per minute for hunts; the Hunt Map collector uses 500 of 1200. */
export const HUNT_WEIGHT_PER_MINUTE = 400;
const DAY_MS = 86_400_000;

type Info = (body: Record<string, unknown>) => Promise<any>;

interface Funding {
  payer: string;
  atMs: number;
  usd: number | null;
}

interface Move {
  from: string;
  to: string;
  atMs: number;
  usd: number | null;
}

export interface MarketPosition {
  market: string;
  side: "long" | "short";
  usd: number | null;
  entryPx: number | null;
  leverage: number | null;
  margin: string | null;
  liqPx: number | null;
}

/** What the model is told about one account. Labels only: T, L1..Ln, P1..Pn. */
export interface Profile {
  label: string;
  funding: { by: string; minutesAfterT: number; usd: number | null } | null;
  accountUsd: number | null;
  positions: MarketPosition[];
  restingOrdersInMarket: number;
  triggerPricesInMarket: number[];
  fills14d: number;
  marketsTraded: string[];
  fillsInMarket: { minutesAfterT: number; side: string; usd: number | null; dir: string | null }[];
  sendsTo: string[];
  sendsFrom: string[];
}

export interface HuntCase {
  market: string;
  target: Profile;
  lineup: Profile[];
  payers: { label: string; accountsFundedNearT: number | null }[];
}

export interface LineupEntry {
  label: string;
  address: string;
  /** True for the owner's own pieces. Never shown to the model. */
  yours: boolean;
}

export interface HuntAnswer {
  picks: { label: string; confidence: number | null; why: string }[];
  combined: { side: string | null; usd: number | null };
  stopGuess: number | null;
  stopWhy: string;
  summary: string;
}

export interface HuntScore {
  verdict: "held" | "caught" | "partly";
  /** Of the owner's pieces in the lineup, how many the hunter named. */
  found: number;
  pieces: number;
  /** Accounts it named that are not the owner's. */
  wrong: number;
  lineup: number;
  /** Hits a random pick of the same number of names would get on average. */
  chanceHits: number;
}

export interface HuntOutcome {
  lineup: LineupEntry[];
  answer: HuntAnswer;
  score: HuntScore;
  proof: Proof;
  request: string;
  response: string;
}

const num = (v: unknown): number | null => {
  const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : null;
};
const low = (v: unknown): string => String(v ?? "").toLowerCase();
const r2 = (x: number | null): number | null => (x === null ? null : Math.round(x * 100) / 100);

/** Money moved from one account to another, from one ledger. Bridge deposits count as paid by "bridge". */
export function moves(ledger: unknown): Move[] {
  const out: Move[] = [];
  for (const e of Array.isArray(ledger) ? ledger : []) {
    const d = e?.delta ?? {};
    const atMs = num(e?.time);
    if (atMs === null) continue;
    const usd = num(d.usdcValue ?? d.usdc ?? d.amount);
    if (d.type === "deposit") {
      out.push({ from: "bridge", to: "", atMs, usd });
      continue;
    }
    const from = low(d.user);
    const to = low(d.destination);
    if (from && to && from !== to) out.push({ from, to, atMs, usd });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** The first money an account received from someone else. */
export function firstFunding(address: string, ledger: unknown): Funding | null {
  const a = low(address);
  const m = moves(ledger).find((x) => (x.to === a || (x.from === "bridge" && x.to === "")) && x.from !== a);
  return m ? { payer: m.from, atMs: m.atMs, usd: m.usd } : null;
}

/** Positions of one clearinghouseState answer. */
export function positionsOf(state: any): MarketPosition[] {
  return (state?.assetPositions ?? [])
    .map((x: any) => x?.position)
    .filter((p: any) => p && num(p.szi))
    .map((p: any) => ({
      market: String(p.coin),
      side: num(p.szi)! > 0 ? ("long" as const) : ("short" as const),
      usd: r2(num(p.positionValue)),
      entryPx: num(p.entryPx),
      leverage: num(p?.leverage?.value),
      margin: typeof p?.leverage?.type === "string" ? p.leverage.type : null,
      liqPx: num(p.liquidationPx),
    }));
}

/** A shuffle driven by the given random bytes, so tests can fix it. */
function shuffle<T>(xs: T[], random: (n: number) => Uint8Array): T[] {
  const a = [...xs];
  const r = random(a.length * 4);
  for (let i = a.length - 1; i > 0; i--) {
    const v = ((r[i * 4]! << 24) | (r[i * 4 + 1]! << 16) | (r[i * 4 + 2]! << 8) | r[i * 4 + 3]!) >>> 0;
    const j = v % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface GatherDeps {
  info: Info;
  pacer: Pacer;
  now: () => number;
  random: (n: number) => Uint8Array;
}

/** Build the lineup and the public facts, from one starting piece and the owner's other pieces. */
export async function gatherCase(deps: GatherDeps, coin: string, pieces: string[]): Promise<{ hunt: HuntCase; lineup: LineupEntry[] }> {
  const asset = hlAsset(coin);
  if (!asset) throw new Error(`unknown market ${coin}`);
  const market = asset.coin;
  const dex = asset.dex ?? "";
  const list = dex ? { dex } : {};
  const ask = async (weight: number, body: Record<string, unknown>) => {
    await deps.pacer.take(weight);
    return deps.info(body);
  };
  const own = [...new Set(pieces.map(low))];
  if (own.length < 2) throw new Error("a hunt needs a position with at least two pieces");
  const target = own[0]!;
  const ownSet = new Set(own);

  // 1. Who funded each piece, and when.
  const ledgers = new Map<string, unknown>();
  for (const p of own) ledgers.set(p, await ask(20, { type: "userNonFundingLedgerUpdates", user: p, startTime: 0 }));
  const fundings = new Map<string, Funding | null>(own.map((p) => [p, firstFunding(p, ledgers.get(p))]));

  // 2. Each piece's neighbours: other accounts its payer funded close to the same time.
  const clusters: { near: string[]; spread: number }[] = [];
  const spreadNearT = new Map<string, number>();
  for (const p of own) {
    const f = fundings.get(p);
    if (!f || f.payer === "bridge") continue;
    const sent = moves(await ask(20, { type: "userNonFundingLedgerUpdates", user: f.payer, startTime: f.atMs - NEIGHBOUR_WINDOW_MS, endTime: f.atMs + NEIGHBOUR_WINDOW_MS }))
      .filter((m) => m.from === f.payer && m.to && m.to !== f.payer);
    const dist = new Map<string, number>();
    for (const m of sent) {
      const d = Math.abs(m.atMs - f.atMs);
      if (!dist.has(m.to) || d < dist.get(m.to)!) dist.set(m.to, d);
    }
    if (p === target) spreadNearT.set(f.payer, dist.size);
    const near = [...dist.entries()]
      .filter(([a]) => !ownSet.has(a))
      .sort((x, y) => x[1] - y[1])
      .slice(0, NEIGHBOURS_SCANNED)
      .map(([a]) => a);
    clusters.push({ near, spread: dist.size });
  }

  // 3. Read the neighbours' positions; those in the same market are the best decoys.
  const states = new Map<string, any>();
  const scanned = [...new Set(clusters.flatMap((c) => c.near))];
  for (const a of scanned) states.set(a, await ask(2, { type: "clearinghouseState", user: a, ...list }));
  const holds = (a: string) => positionsOf(states.get(a)).some((p) => p.market === market);

  const room = Math.max(0, LINEUP_SIZE - (own.length - 1));
  const decoys: string[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const quota = Math.floor(room / clusters.length) + (i < room % clusters.length ? 1 : 0);
    const ranked = [...clusters[i]!.near.filter(holds), ...clusters[i]!.near.filter((a) => !holds(a))];
    let took = 0;
    for (const a of ranked) {
      if (took >= quota) break;
      if (decoys.includes(a)) continue;
      decoys.push(a);
      took++;
    }
  }

  const members = shuffle([...own.slice(1), ...decoys], deps.random);
  const lineup: LineupEntry[] = members.map((address, i) => ({ label: `L${i + 1}`, address, yours: ownSet.has(address) }));
  const labelOf = new Map<string, string>([[target, "T"], ...lineup.map((l) => [l.address, l.label] as [string, string])]);

  // 4. The public facts of every account in the hunt.
  const tFunding = fundings.get(target) ?? null;
  const since = deps.now() - FILL_DAYS * DAY_MS;
  const payerLabels = new Map<string, string>();
  const payerLabel = (a: string) => {
    if (a === "bridge") return "bridge deposit";
    if (labelOf.has(a)) return labelOf.get(a)!;
    if (!payerLabels.has(a)) payerLabels.set(a, `P${payerLabels.size + 1}`);
    return payerLabels.get(a)!;
  };
  const anchor = tFunding?.atMs ?? since;
  const minutes = (ms: number) => Math.round((ms - anchor) / 60_000);

  const profile = async (address: string): Promise<Profile> => {
    const state = states.get(address) ?? (await ask(2, { type: "clearinghouseState", user: address, ...list }));
    const mainState = dex ? await ask(2, { type: "clearinghouseState", user: address }) : null;
    const orders = await ask(20, { type: "frontendOpenOrders", user: address, ...list });
    const ledger = ledgers.get(address) ?? (await ask(20, { type: "userNonFundingLedgerUpdates", user: address, startTime: 0 }));
    const fills = await ask(20, { type: "userFillsByTime", user: address, startTime: since, aggregateByTime: true });
    const fl: any[] = Array.isArray(fills) ? fills : [];
    const count = new Map<string, number>();
    for (const f of fl) count.set(String(f?.coin), (count.get(String(f?.coin)) ?? 0) + 1);
    const inMarket = fl.filter((f) => f?.coin === market).sort((a, b) => (num(b?.time) ?? 0) - (num(a?.time) ?? 0));
    const mine = (Array.isArray(orders) ? orders : []).filter((o: any) => o?.coin === market);
    const f = firstFunding(address, ledger);
    const mv = moves(ledger);
    const linked = (xs: string[]) => [...new Set(xs.filter((a) => labelOf.has(a)).map((a) => labelOf.get(a)!))];
    return {
      label: labelOf.get(address)!,
      funding: f ? { by: payerLabel(f.payer), minutesAfterT: minutes(f.atMs), usd: r2(f.usd) } : null,
      accountUsd: r2(num(state?.marginSummary?.accountValue)),
      positions: [...positionsOf(state), ...positionsOf(mainState)],
      restingOrdersInMarket: mine.length,
      triggerPricesInMarket: mine.filter((o: any) => o?.isTrigger).map((o: any) => num(o?.triggerPx)).filter((x: number | null): x is number => x !== null && x > 0),
      fills14d: fl.length,
      marketsTraded: [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c]) => c),
      fillsInMarket: inMarket.slice(0, 8).map((x) => ({
        minutesAfterT: minutes(num(x?.time) ?? anchor),
        side: x?.side === "B" ? "buy" : "sell",
        usd: r2((num(x?.px) ?? 0) * (num(x?.sz) ?? 0)),
        dir: typeof x?.dir === "string" ? x.dir : null,
      })),
      sendsTo: linked(mv.filter((m) => m.from === address).map((m) => m.to)),
      sendsFrom: linked(mv.filter((m) => m.to === address).map((m) => m.from)),
    };
  };

  const targetProfile = await profile(target);
  const lineupProfiles: Profile[] = [];
  for (const l of lineup) lineupProfiles.push(await profile(l.address));
  // payer labels are made while profiles are read; name the spread of T's own payer
  const payers = [...payerLabels.entries()].map(([a, label]) => ({ label, accountsFundedNearT: spreadNearT.get(a) ?? null }));
  return { hunt: { market, target: targetProfile, lineup: lineupProfiles, payers }, lineup };
}

export const HUNTER_SYSTEM = [
  "You are a professional liquidation hunter on Hyperliquid. Large traders try to hide by splitting one position across several accounts, so that nobody can see the full size or where the stop loss sits.",
  "You start from account T. You are given a lineup of other accounts. At least one account in the lineup is controlled by the same person as T; the others belong to strangers.",
  "Use only the public facts given: who funded each account and when (minutes are counted from when T was funded; P1, P2... are payers outside the lineup), positions, resting orders and trigger prices, recent fills, and any money sent between accounts.",
  "Name every lineup account you believe is controlled by T's owner. Do not name accounts you cannot tell apart from strangers: wrong names count against you.",
  "Then estimate the owner's combined position in the market, and the price where the owner's stop loss most likely sits (null if you cannot tell).",
  'Answer with one JSON object only: {"same_owner":[{"label":"L1","confidence":0-100,"why":"short reason"}],"combined":{"side":"long|short|unknown","usd":number|null},"stop_guess":number|null,"stop_why":"short reason","summary":"two short sentences"}',
].join("\n");

export function hunterQuestion(hunt: HuntCase): string {
  return `Market: ${hunt.market}\nPayers: ${JSON.stringify(hunt.payers)}\nT: ${JSON.stringify(hunt.target)}\nLineup:\n${hunt.lineup.map((p) => JSON.stringify(p)).join("\n")}`;
}

/** The model's JSON, read leniently: anything not in the expected shape is dropped. */
export function readAnswer(content: string, labels: Set<string>): HuntAnswer {
  let j: any = {};
  try {
    j = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    j = {};
  }
  const seen = new Set<string>();
  const picks = (Array.isArray(j?.same_owner) ? j.same_owner : [])
    .map((p: any) => ({ label: String(p?.label ?? "").trim().toUpperCase(), confidence: num(p?.confidence), why: String(p?.why ?? "").slice(0, 300) }))
    .filter((p: { label: string }) => labels.has(p.label) && !seen.has(p.label) && seen.add(p.label));
  const side = typeof j?.combined?.side === "string" ? j.combined.side.toLowerCase() : null;
  return {
    picks,
    combined: { side: side === "long" || side === "short" ? side : null, usd: num(j?.combined?.usd) },
    stopGuess: num(j?.stop_guess),
    stopWhy: String(j?.stop_why ?? "").slice(0, 300),
    summary: String(j?.summary ?? "").slice(0, 400),
  };
}

/** Caught: named every piece and was mostly right. Partly: named some, mostly right. Held: otherwise. */
export function scoreHunt(lineup: LineupEntry[], answer: HuntAnswer): HuntScore {
  const yours = new Set(lineup.filter((l) => l.yours).map((l) => l.label));
  const named = answer.picks.map((p) => p.label);
  const found = named.filter((l) => yours.has(l)).length;
  const wrong = named.length - found;
  const precise = named.length > 0 && found / named.length >= 0.5;
  const verdict = found > 0 && precise ? (found === yours.size ? "caught" : "partly") : "held";
  return {
    verdict,
    found,
    pieces: yours.size,
    wrong,
    lineup: lineup.length,
    chanceHits: lineup.length ? Math.round(((named.length * yours.size) / lineup.length) * 100) / 100 : 0,
  };
}

/** One full hunt: gather, ask the model in its TEE, read and score its answer. */
export async function runHunt(deps: GatherDeps & { ai: Pick<NearAi, "chatJson"> }, coin: string, pieces: string[]): Promise<HuntOutcome> {
  const { hunt, lineup } = await gatherCase(deps, coin, pieces);
  const answer: Answer = await deps.ai.chatJson(HUNTER_SYSTEM, hunterQuestion(hunt));
  const read = readAnswer(answer.content, new Set(lineup.map((l) => l.label)));
  return { lineup, answer: read, score: scoreHunt(lineup, read), proof: answer.proof, request: answer.request, response: answer.response };
}

export interface AiHuntView {
  id: string;
  state: "running" | "done" | "failed";
  createdMs: number;
  doneMs: number | null;
  error: string | null;
  lineup: LineupEntry[] | null;
  answer: HuntAnswer | null;
  score: HuntScore | null;
  proof: Proof | null;
  /** What the position really is, for the owner to compare with the hunter's guess. */
  truth: { side: string; usd: number };
  hunts: { today: number; perDay: number };
}

/** Runs hunts for signed-in owners, one at a time, and keeps each result. */
export class AiHunter {
  private running: Promise<void> | null = null;
  private readonly pacer: Pacer;

  constructor(
    private readonly db: Db,
    private readonly hl: Pick<Hyperliquid, "info">,
    private readonly ai: Pick<NearAi, "chatJson">,
    private readonly network: string,
    private readonly now: () => number = Date.now,
    private readonly random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
    pacer?: Pacer,
  ) {
    this.pacer = pacer ?? new Pacer(HUNT_WEIGHT_PER_MINUTE, now);
    // a restart ends any hunt that was running
    db.prepare("UPDATE ai_hunts SET state = 'failed', error = 'The server restarted during this hunt. Run it again.', done_ms = ? WHERE state = 'running'").run(now());
  }

  private position(userId: string, positionId: string) {
    const pos = this.db.prepare("SELECT id, coin, side, notional_usd FROM positions WHERE id = ? AND user_id = ?").get(positionId, userId) as
      | { id: string; coin: string; side: string; notional_usd: number }
      | undefined;
    if (!pos) throw new ApiError("not_found");
    const pieces = (
      this.db
        .prepare("SELECT w.hl_address AS a FROM position_pieces pp JOIN pieces w ON w.id = pp.piece_id WHERE pp.position_id = ? ORDER BY pp.idx")
        .all(pos.id) as { a: string | null }[]
    )
      .map((r) => r.a)
      .filter((a): a is string => !!a);
    return { pos, pieces };
  }

  private today(userId?: string): number {
    const since = this.now() - DAY_MS;
    const row = userId
      ? (this.db.prepare("SELECT COUNT(*) AS n FROM ai_hunts WHERE user_id = ? AND created_ms > ? AND network = ?").get(userId, since, this.network) as { n: number })
      : (this.db.prepare("SELECT COUNT(*) AS n FROM ai_hunts WHERE created_ms > ? AND network = ?").get(since, this.network) as { n: number });
    return row.n;
  }

  /** Start a hunt on one of the owner's positions. */
  start(userId: string, positionId: string): { id: string } {
    const { pos, pieces } = this.position(userId, positionId);
    if (pieces.length < 2) throw new ApiError("ai_hunt_needs_pieces");
    if (this.running) throw new ApiError("ai_hunt_busy");
    if (this.today(userId) >= HUNTS_PER_USER_PER_DAY || this.today() >= HUNTS_PER_DAY) throw new ApiError("ai_hunt_limit", { perDay: HUNTS_PER_USER_PER_DAY });
    const id = newId();
    this.db
      .prepare("INSERT INTO ai_hunts (id, user_id, position_id, state, created_ms, network) VALUES (?, ?, ?, 'running', ?, ?)")
      .run(id, userId, pos.id, this.now(), this.network);
    this.running = this.finish(id, pos.coin, pieces).finally(() => (this.running = null));
    return { id };
  }

  /** Resolves when the hunt now running ends (tests and shutdown). */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async finish(id: string, coin: string, pieces: string[]): Promise<void> {
    try {
      const out = await runHunt({ info: (b) => this.hl.info(b), pacer: this.pacer, now: this.now, random: this.random, ai: this.ai }, coin, pieces);
      this.db
        .prepare(
          "UPDATE ai_hunts SET state = 'done', verdict = ?, lineup_json = ?, answer_json = ?, score_json = ?, proof_json = ?, request_text = ?, response_text = ?, done_ms = ? WHERE id = ?",
        )
        .run(out.score.verdict, JSON.stringify(out.lineup), JSON.stringify(out.answer), JSON.stringify(out.score), JSON.stringify(out.proof), out.request, out.response, this.now(), id);
    } catch (e) {
      const msg = e instanceof Error && /^(NEAR AI|Hyperliquid)/.test(e.message) ? e.message : "The hunt could not finish. Run it again.";
      this.db.prepare("UPDATE ai_hunts SET state = 'failed', error = ?, done_ms = ? WHERE id = ?").run(msg, this.now(), id);
    }
  }

  /** The latest hunt on a position, or null. */
  latest(userId: string, positionId: string): AiHuntView | null {
    const { pos } = this.position(userId, positionId);
    const r = this.db.prepare("SELECT * FROM ai_hunts WHERE position_id = ? AND user_id = ? ORDER BY created_ms DESC LIMIT 1").get(pos.id, userId) as any;
    if (!r) return null;
    const j = (s: string | null) => (s ? JSON.parse(s) : null);
    return {
      id: r.id,
      state: r.state,
      createdMs: r.created_ms,
      doneMs: r.done_ms ?? null,
      error: r.error ?? null,
      lineup: j(r.lineup_json),
      answer: j(r.answer_json),
      score: j(r.score_json),
      proof: j(r.proof_json),
      truth: { side: pos.side, usd: pos.notional_usd },
      hunts: { today: this.today(userId), perDay: HUNTS_PER_USER_PER_DAY },
    };
  }

  /** The exact request and answer bytes the enclave signed, for anyone redoing the check. */
  receipt(userId: string, positionId: string, huntId: string): { request: string; response: string; proof: Proof } {
    const { pos } = this.position(userId, positionId);
    const r = this.db.prepare("SELECT request_text, response_text, proof_json FROM ai_hunts WHERE id = ? AND position_id = ? AND user_id = ? AND state = 'done'").get(huntId, pos.id, userId) as
      | { request_text: string; response_text: string; proof_json: string }
      | undefined;
    if (!r) throw new ApiError("not_found");
    return { request: r.request_text, response: r.response_text, proof: JSON.parse(r.proof_json) };
  }
}
