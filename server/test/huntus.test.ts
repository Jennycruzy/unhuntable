import { describe, expect, it } from "vitest";
import { Hyperliquid } from "../src/hl.js";
import { HuntUs, HUNT_SECONDS } from "../src/huntus.js";
import { buildServer } from "../src/index.js";
import { memoryDb, testConfig } from "./helpers.js";

const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const C = "0x" + "c3".repeat(20);
const PAYER = "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24";
const T0 = 1_800_000_000_000;

const position = (szi: string, value: string, liq: string) => ({
  assetPositions: [{ type: "oneWay", position: { coin: "ETH", szi, leverage: { type: "isolated", value: 3 }, entryPx: "2500", positionValue: value, liquidationPx: liq } }],
});
const funded = (to: string, time: number, amount = "15") => ({ time, delta: { type: "send", user: PAYER, destination: to, token: "USDC", amount } });

/** Hyperliquid's public API for three pieces funded by one shared payer. No network. */
function fakeHl(over: { orders?: Record<string, unknown[]>; extraSend?: boolean } = {}) {
  const asked: any[] = [];
  const f = (async (_url: string, init?: RequestInit) => {
    const b = JSON.parse(String(init!.body));
    asked.push(b);
    const json = (x: unknown) => new Response(JSON.stringify(x));
    if (b.type === "clearinghouseState") return json(position(b.user === B ? "-0.004" : "0.004", "10.1", b.user === C ? "2100" : "2050"));
    if (b.type === "frontendOpenOrders") return json(over.orders?.[b.user] ?? []);
    if (b.type === "userNonFundingLedgerUpdates") {
      if (b.user === PAYER) {
        expect(b.startTime).toBe(T0 + HUNT_SECONDS * 1000 - 6 * 3600_000);
        return json([...Array.from({ length: 40 }, (_, i) => funded("0x" + String(i).padStart(40, "0"), T0 - i)), funded(A, T0 - 50), funded(B, T0 - 60), funded(C, T0 - 70)]);
      }
      const own = [funded(b.user, T0 - 1000 * (b.user === A ? 1 : b.user === B ? 7 : 13))];
      if (over.extraSend && b.user === A) own.push({ time: T0 - 5, delta: { type: "send", user: A, destination: B, token: "USDC", amount: "1" } });
      if (over.extraSend && b.user === B) own.push({ time: T0 - 5, delta: { type: "send", user: A, destination: B, token: "USDC", amount: "1" } });
      return json(own);
    }
    throw new Error(`unexpected ${b.type}`);
  }) as typeof fetch;
  return { hl: new Hyperliquid("https://hl.test", f), asked };
}

function setup(over?: Parameters<typeof fakeHl>[0]) {
  const clock = { t: T0 };
  const { hl, asked } = fakeHl(over);
  const huntUs = new HuntUs(hl, { coin: "eth", pieces: [A, B, C] }, () => clock.t);
  const app = buildServer({ config: testConfig(), db: memoryDb(), now: () => clock.t, huntUs });
  return { app, clock, asked };
}

describe("Hunt us", () => {
  it("shows one piece, keeps the rest for 90 seconds, then reveals each piece with its public facts", async () => {
    const { app, clock, asked } = setup();
    expect((await app.inject({ method: "GET", url: "/api/hunt-us" })).json()).toEqual({ challenge: { coin: "ETH", count: 3, shown: A, seconds: 90 } });

    const { token, revealAtMs } = (await app.inject({ method: "POST", url: "/api/hunt-us/start" })).json();
    expect(revealAtMs).toBe(T0 + 90_000);
    clock.t += 30_000;
    const early = await app.inject({ method: "GET", url: `/api/hunt-us/reveal?token=${token}` });
    expect(early.json()).toEqual({ error: "hunt_wait", message: "Keep hunting: the answer opens in 60 seconds." });
    // nothing about the hidden pieces was asked for before the time
    expect(asked).toEqual([]);

    clock.t += 60_000;
    const r = (await app.inject({ method: "GET", url: `/api/hunt-us/reveal?token=${token}` })).json();
    expect(r.pieces.map((p: any) => p.address)).toEqual([A, B, C]);
    expect(r.pieces[1]).toMatchObject({ side: "short", size: 0.004, valueUsd: 10.1, liqPx: 2050, restingOrders: 0, fundedBy: PAYER, fundedAtMs: T0 - 7000, payerAccounts: 43 });
    expect(r).toMatchObject({ coin: "ETH", restingOrders: 0, sendsBetweenPieces: 0, payerWindowHours: 6 });
  });

  it("does not let a token be made or moved back by hand", async () => {
    const { app, clock } = setup();
    clock.t += 200_000;
    for (const token of ["1799999000000.00", `${T0 - 100_000}.${"ab".repeat(32)}`, "x"]) {
      expect((await app.inject({ method: "GET", url: `/api/hunt-us/reveal?token=${token}` })).statusCode).toBe(400);
    }
  });

  it("counts a stop resting on the book and money sent between pieces, if there ever is any", async () => {
    const { app, clock } = setup({ orders: { [C]: [{ coin: "ETH", isTrigger: true, triggerPx: "2300.0", orderType: "Stop Market" }] }, extraSend: true });
    const { token } = (await app.inject({ method: "POST", url: "/api/hunt-us/start" })).json();
    clock.t += 90_000;
    const r = (await app.inject({ method: "GET", url: `/api/hunt-us/reveal?token=${token}` })).json();
    expect(r.restingOrders).toBe(1);
    expect(r.pieces[2].triggerPxs).toEqual([2300]);
    expect(r.sendsBetweenPieces).toBe(1);
  });

  it("with no challenge set, says so and refuses the rest", async () => {
    const app = buildServer({ config: testConfig(), db: memoryDb() });
    expect((await app.inject({ method: "GET", url: "/api/hunt-us" })).json()).toEqual({ challenge: null });
    expect((await app.inject({ method: "POST", url: "/api/hunt-us/start" })).statusCode).toBe(404);
  });
});
