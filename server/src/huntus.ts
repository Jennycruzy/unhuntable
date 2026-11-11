// "Hunt us": a public challenge on one of our own live positions. The page shows one piece's
// Hyperliquid address and gives the visitor 90 seconds to find the other pieces and the
// stop with any public tool. Only after the 90 seconds does the server name the rest, with
// what Hyperliquid's public API says about each: its position, its resting orders, who
// funded it and how many other accounts that same payer funded, and whether any money ever
// moved between the pieces. Every fact is read live from Hyperliquid; nothing is stored.
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { hlAsset } from "unhuntable-client";
import { z } from "zod";
import type { Hyperliquid } from "./hl.js";
import { publicAccount, type PublicAccount } from "./hunter.js";
import { ApiError } from "./refusals.js";

export const HUNT_SECONDS = 90;
/** How far back a payer's sends are counted. */
export const PAYER_WINDOW_MS = 6 * 60 * 60_000;
export const REVEAL_KEEP_MS = 60_000;

export const HuntUsFile = z
  .object({
    coin: z.string().refine((c) => hlAsset(c) !== undefined),
    pieces: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).min(2).max(12),
  })
  .strict();

export interface RevealedPiece extends PublicAccount {
  /** The account that first sent this piece its money, and when. */
  fundedBy: string | null;
  fundedAtMs: number | null;
  /** How many different accounts that payer sent money to in the window before now. */
  payerAccounts: number | null;
}

export interface Reveal {
  coin: string;
  asOfMs: number;
  pieces: RevealedPiece[];
  /** Resting orders across all pieces in this market: a stop on the book would show here. */
  restingOrders: number;
  /** Sends between any two pieces, ever. */
  sendsBetweenPieces: number;
  payerWindowHours: number;
}

type Ledger = { time: number; delta: { type?: string; user?: string; destination?: string } }[];

export class HuntUs {
  private readonly secret = randomBytes(32);
  private kept: { at: number; reveal: Reveal } | undefined;
  private readonly coin: string;
  private readonly pieces: string[];

  constructor(
    private readonly hl: Hyperliquid,
    challenge: z.infer<typeof HuntUsFile>,
    private readonly now: () => number = Date.now,
  ) {
    this.coin = hlAsset(challenge.coin)!.coin;
    this.pieces = challenge.pieces.map((p) => p.toLowerCase());
  }

  static fromFile(hl: Hyperliquid, path: string, now?: () => number): HuntUs {
    const r = HuntUsFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!r.success) throw new Error(`${path} must hold { coin, pieces: [2-12 Hyperliquid addresses] }`);
    return new HuntUs(hl, r.data, now);
  }

  /** What the page shows before the hunt: the market, how many pieces, and one of them. */
  open() {
    return { coin: this.coin, count: this.pieces.length, shown: this.pieces[0], seconds: HUNT_SECONDS };
  }

  private sign(startMs: number): string {
    return createHmac("sha256", this.secret).update(String(startMs)).digest("hex");
  }

  /** Start the clock. The token says when it started, signed so it cannot be moved back. */
  start() {
    const startMs = this.now();
    return { token: `${startMs}.${this.sign(startMs)}`, revealAtMs: startMs + HUNT_SECONDS * 1000 };
  }

  async reveal(token: string): Promise<Reveal> {
    const m = /^(\d{13})\.([0-9a-f]{64})$/.exec(token);
    if (!m || this.sign(Number(m[1])) !== m[2]) throw new ApiError("bad_request");
    const left = Number(m[1]) + HUNT_SECONDS * 1000 - this.now();
    if (left > 0) throw new ApiError("hunt_wait", { seconds: Math.ceil(left / 1000) });
    if (this.kept && this.now() - this.kept.at < REVEAL_KEEP_MS) return this.kept.reveal;
    const reveal = await this.read();
    this.kept = { at: this.now(), reveal };
    return reveal;
  }

  private async read(): Promise<Reveal> {
    const dex = hlAsset(this.coin)?.dex ?? "";
    const list = dex ? { dex } : {};
    const mine = new Set(this.pieces);
    const payers = new Map<string, number>();
    let between = 0;
    const pieces: RevealedPiece[] = [];
    for (const user of this.pieces) {
      const [state, orders, ledger] = await Promise.all([
        this.hl.info({ type: "clearinghouseState", user, ...list }),
        this.hl.info({ type: "frontendOpenOrders", user, ...list }),
        this.hl.info({ type: "userNonFundingLedgerUpdates", user, startTime: 0 }) as Promise<Ledger>,
      ]);
      const sends = (Array.isArray(ledger) ? ledger : []).filter((e) => e?.delta?.type === "send");
      between += sends.filter((e) => {
        const from = String(e.delta.user ?? "").toLowerCase();
        const to = String(e.delta.destination ?? "").toLowerCase();
        return from !== to && mine.has(from) && mine.has(to);
      }).length;
      const first = sends.find((e) => String(e.delta.destination ?? "").toLowerCase() === user && String(e.delta.user ?? "").toLowerCase() !== user);
      const fundedBy = first ? String(first.delta.user).toLowerCase() : null;
      pieces.push({ ...publicAccount(user, this.coin, state, orders), fundedBy, fundedAtMs: first?.time ?? null, payerAccounts: null });
      if (fundedBy && !payers.has(fundedBy)) payers.set(fundedBy, await this.payerSpread(fundedBy));
    }
    for (const p of pieces) p.payerAccounts = p.fundedBy ? (payers.get(p.fundedBy) ?? null) : null;
    // each send between two pieces shows in both ledgers
    return {
      coin: this.coin,
      asOfMs: this.now(),
      pieces,
      restingOrders: pieces.reduce((n, p) => n + p.restingOrders, 0),
      sendsBetweenPieces: Math.ceil(between / 2),
      payerWindowHours: PAYER_WINDOW_MS / 3_600_000,
    };
  }

  /** Different accounts a payer sent money to in the window. */
  private async payerSpread(payer: string): Promise<number> {
    const ledger = (await this.hl.info({ type: "userNonFundingLedgerUpdates", user: payer, startTime: this.now() - PAYER_WINDOW_MS })) as Ledger;
    const to = new Set<string>();
    for (const e of Array.isArray(ledger) ? ledger : []) {
      if (e?.delta?.type === "send" && String(e.delta.user ?? "").toLowerCase() === payer) to.add(String(e.delta.destination ?? "").toLowerCase());
    }
    return to.size;
  }
}
