import { describe, expect, it } from "vitest";
import { CALL_AAD, boxOpen } from "../src/box.js";
import { GuardClient } from "../src/client.js";
import { GUARD_PUB, GUARD_SECRET, PAYMENT_KEY, fakeFetch } from "./helpers.js";

const MASTER = "0x" + "22".repeat(20);

function client(answers: Array<{ status?: number; body: unknown }>, boxPub: string | null = GUARD_PUB) {
  const f = fakeFetch(answers);
  return { c: new GuardClient({ owner: "own", project: "guard", paymentKey: PAYMENT_KEY, boxPub: boxPub ?? undefined, fetch: f.fetch }), sent: f.sent };
}

function inner(body: any) {
  expect(Object.keys(body)).toEqual(["input"]);
  expect(Object.keys(body.input)).toEqual(["box"]);
  const v = JSON.parse(boxOpen(GUARD_SECRET, body.input.box, CALL_AAD).toString());
  expect(v.salt).toMatch(/^[0-9a-f]{64}$/);
  delete v.salt;
  return v;
}

describe("plain ops", () => {
  it("addr goes plain", async () => {
    const { c, sent } = client([{ body: { output: { hl_address: "0xab" } } }]);
    expect(await c.addr()).toEqual({ hl_address: "0xab" });
    expect(sent[0].body).toEqual({ input: { op: "addr" } });
  });

  it("box_pub goes plain and is kept for sealed calls", async () => {
    const { c, sent } = client(
      [{ body: { output: { box_pub: GUARD_PUB } } }, { body: { output: { agent: "0x1" } } }, { body: { output: { agent: "0x1" } } }],
      null,
    );
    await c.agent("alpha");
    await c.agent("alpha");
    expect(sent).toHaveLength(3);
    expect(sent[0].body).toEqual({ input: { op: "box_pub" } });
    expect(inner(sent[1].body)).toEqual({ op: "agent", shard: "alpha" });
  });

  it("refuses a malformed box_pub answer", async () => {
    const { c } = client([{ body: { output: { box_pub: "12" } } }], null);
    await expect(c.boxPub()).rejects.toThrow("32 bytes of hex");
  });
});

describe("sealed ops", () => {
  const ok = { body: { output: { ok: true } } };

  it("each op is one sealed box with the op name inside", async () => {
    const { c, sent } = client(Array.from({ length: 9 }, () => ({ ...ok })));
    await c.agent("alpha");
    await c.leverage({ shard: "alpha", coin: "ETH", leverage: 5 });
    await c.open({ shard: "alpha", coin: "BTC", side: "short", size: 0.001 });
    await c.open({ shard: "alpha", coin: "SOL", side: "long", size: 1, builder: true });
    await c.tick({ shard: "alpha", coin: "ETH", dry: true });
    await c.register({ shard: "alpha", master: MASTER.toUpperCase().replace("0X", "0x") });
    await c.proof();
    await c.register({ shard: "beta", master: MASTER, owner: "ab".repeat(32) });
    await c.record({ trader: "ab".repeat(32) });
    expect(sent.map((s) => inner(s.body))).toEqual([
      { op: "agent", shard: "alpha" },
      { op: "leverage", shard: "alpha", coin: "ETH", leverage: 5 },
      { op: "open", shard: "alpha", coin: "BTC", side: "short", size: 0.001 },
      { op: "open", shard: "alpha", coin: "SOL", side: "long", size: 1, builder: true },
      { op: "tick", shard: "alpha", coin: "ETH", dry: true },
      { op: "register", shard: "alpha", master: MASTER },
      { op: "proof" },
      { op: "register", shard: "beta", master: MASTER, owner: "ab".repeat(32) },
      { op: "record", trader: "ab".repeat(32) },
    ]);
  });

  it("seal puts the stop inside the sealed call", async () => {
    const { c, sent } = client([{ body: { output: { sealed: true } } }]);
    const out = await c.seal({ shard: "s1", stop: { coin: "ETH", side: "long", trigger: 2100.5, size: 0.0045 } });
    expect(out).toEqual({ sealed: true });
    expect(inner(sent[0].body)).toEqual({ op: "seal", shard: "s1", stop: { coin: "ETH", side: "long", trigger: 2100.5, size: 0.0045 } });
    expect(JSON.stringify(sent[0].body)).not.toContain("2100.5");
    expect(JSON.stringify(sent[0].body)).not.toContain("s1");
  });
});

describe("checks before any call", () => {
  const bad: Array<[string, (c: GuardClient) => Promise<unknown>]> = [
    ["empty shard", (c) => c.agent("")],
    ["long shard", (c) => c.agent("a".repeat(17))],
    ["uppercase shard", (c) => c.agent("Alpha")],
    ["shard with dash", (c) => c.agent("a-b")],
    ["coin", (c) => c.leverage({ shard: "a", coin: "DOGE" as any, leverage: 2 })],
    ["leverage 0", (c) => c.leverage({ shard: "a", coin: "ETH", leverage: 0 })],
    ["leverage 11", (c) => c.leverage({ shard: "a", coin: "ETH", leverage: 11 })],
    ["leverage 2.5", (c) => c.leverage({ shard: "a", coin: "ETH", leverage: 2.5 })],
    ["side", (c) => c.open({ shard: "a", coin: "ETH", side: "up" as any, size: 1 })],
    ["size 0", (c) => c.open({ shard: "a", coin: "ETH", side: "long", size: 0 })],
    ["size NaN", (c) => c.open({ shard: "a", coin: "ETH", side: "long", size: NaN })],
    ["stop trigger", (c) => c.seal({ shard: "a", stop: { coin: "ETH", side: "long", trigger: -1, size: 1 } })],
    ["stop size", (c) => c.seal({ shard: "a", stop: { coin: "ETH", side: "long", trigger: 1, size: Infinity } })],
    ["stop side", (c) => c.seal({ shard: "a", stop: { coin: "ETH", side: "x" as any, trigger: 1, size: 1 } })],
    ["no stop", (c) => c.seal({ shard: "a", stop: undefined as any })],
    ["tick coin", (c) => c.tick({ shard: "a", coin: "XRP" as any })],
    ["master short", (c) => c.register({ shard: "a", master: "0x1234" })],
    ["master no 0x", (c) => c.register({ shard: "a", master: "22".repeat(20) })],
    ["master not hex", (c) => c.register({ shard: "a", master: "0x" + "zz".repeat(20) })],
    ["owner tag short", (c) => c.register({ shard: "a", master: "0x" + "22".repeat(20), owner: "ab" })],
    ["owner tag uppercase", (c) => c.record({ trader: "AB".repeat(32) })],
  ];
  for (const [name, op] of bad) {
    it(`refuses ${name}`, async () => {
      // no box key given: a bad request must not even fetch box_pub
      const { c, sent } = client([], null);
      await expect(op(c)).rejects.toBeInstanceOf(TypeError);
      expect(sent).toHaveLength(0);
    });
  }

  it("accepts lowercase coins as the guard does", async () => {
    const { c, sent } = client([{ body: { output: {} } }]);
    await c.tick({ shard: "a", coin: "eth" as any });
    expect(inner(sent[0].body).coin).toBe("ETH");
  });

  it("needs owner, project, payment key and a valid box key", () => {
    expect(() => new GuardClient({ owner: "", project: "p", paymentKey: PAYMENT_KEY })).toThrow();
    expect(() => new GuardClient({ owner: "o", project: "p", paymentKey: "" })).toThrow();
    expect(() => new GuardClient({ owner: "o", project: "p", paymentKey: PAYMENT_KEY, boxPub: "xy" })).toThrow();
  });
});

describe("trading and defence ops", () => {
  const ok = () => ({ body: { output: { ok: true } } });
  const tp = { coin: "ETH" as const, side: "long" as const, trigger: 2600.25, size: 0.0045 };
  const stop = { coin: "ETH" as const, side: "long" as const, trigger: 2100.5, size: 0.0045 };

  it("each new op is one sealed box with the guard's field names", async () => {
    const { c, sent } = client(Array.from({ length: 9 }, ok));
    await c.close({ shard: "alpha", coin: "eth" as any });
    await c.sealTp({ shard: "alpha", tp });
    await c.seal({ shard: "alpha", stop, jitterBps: 40 });
    await c.seal({ shard: "alpha", stop, jitterBps: 0 });
    await c.tickCoin({ coin: "BTC", shards: ["alpha", "beta2"], dry: true, defend: true });
    await c.tickCoin({ coin: "SOL", shards: ["alpha"] });
    await c.defend({ shard: "alpha", coin: "SOL" });
    await c.tick({ shard: "alpha", coin: "ETH", defend: true });
    await c.vrf("plan-7-eth");
    expect(sent.map((s) => inner(s.body))).toEqual([
      { op: "close", shard: "alpha", coin: "ETH" },
      { op: "seal_tp", shard: "alpha", tp },
      { op: "seal", shard: "alpha", stop, jitter_bps: 40 },
      { op: "seal", shard: "alpha", stop, jitter_bps: 0 },
      { op: "tick_coin", coin: "BTC", shards: ["alpha", "beta2"], dry: true, defend: true },
      { op: "tick_coin", coin: "SOL", shards: ["alpha"] },
      { op: "defend", shard: "alpha", coin: "SOL" },
      { op: "tick", shard: "alpha", coin: "ETH", defend: true },
      { op: "vrf", label: "plan-7-eth" },
    ]);
    // the take-profit level only travels inside the box
    expect(JSON.stringify(sent[1].body)).not.toContain("2600.25");
  });

  it("outer shard goes in plain next to the box and matches the shard inside", async () => {
    const { c, sent } = client(Array.from({ length: 9 }, ok));
    const route = { outerShard: true };
    await c.agent("alpha", route);
    await c.leverage({ shard: "alpha", coin: "ETH", leverage: 2, ...route });
    await c.open({ shard: "alpha", coin: "ETH", side: "long", size: 0.01, ...route });
    await c.seal({ shard: "alpha", stop, ...route });
    await c.sealTp({ shard: "alpha", tp, ...route });
    await c.tick({ shard: "alpha", coin: "ETH", ...route });
    await c.defend({ shard: "alpha", coin: "ETH", ...route });
    await c.close({ shard: "alpha", coin: "ETH", ...route });
    await c.register({ shard: "alpha", master: MASTER, ...route });
    for (const s of sent) {
      expect(Object.keys(s.body.input).sort()).toEqual(["box", "shard"]);
      expect(s.body.input.shard).toBe("alpha");
      const v = JSON.parse(boxOpen(GUARD_SECRET, s.body.input.box, CALL_AAD).toString());
      expect(v.shard).toBe("alpha");
    }
  });

  it("without outerShard the shard stays inside the box only", async () => {
    const { c, sent } = client([ok()]);
    await c.close({ shard: "alpha", coin: "ETH" });
    expect(Object.keys(sent[0].body.input)).toEqual(["box"]);
    expect(JSON.stringify(sent[0].body)).not.toContain("alpha");
  });

  const bad: Array<[string, (c: GuardClient) => Promise<unknown>]> = [
    ["close shard", (c) => c.close({ shard: "A", coin: "ETH" })],
    ["close coin", (c) => c.close({ shard: "a", coin: "XRP" as any })],
    ["tp side", (c) => c.sealTp({ shard: "a", tp: { ...tp, side: "up" as any } })],
    ["tp trigger", (c) => c.sealTp({ shard: "a", tp: { ...tp, trigger: 0 } })],
    ["tp size", (c) => c.sealTp({ shard: "a", tp: { ...tp, size: -1 } })],
    ["tp coin", (c) => c.sealTp({ shard: "a", tp: { ...tp, coin: "DOGE" as any } })],
    ["no tp", (c) => c.sealTp({ shard: "a", tp: undefined as any })],
    ["jitter 101", (c) => c.seal({ shard: "a", stop, jitterBps: 101 })],
    ["jitter -1", (c) => c.seal({ shard: "a", stop, jitterBps: -1 })],
    ["jitter 2.5", (c) => c.seal({ shard: "a", stop, jitterBps: 2.5 })],
    ["no shards", (c) => c.tickCoin({ coin: "ETH", shards: [] })],
    ["33 shards", (c) => c.tickCoin({ coin: "ETH", shards: Array.from({ length: 33 }, (_, i) => `s${i}`) })],
    ["duplicate shards", (c) => c.tickCoin({ coin: "ETH", shards: ["a", "b", "a"] })],
    ["bad shard in list", (c) => c.tickCoin({ coin: "ETH", shards: ["a", "B"] })],
    ["shards not a list", (c) => c.tickCoin({ coin: "ETH", shards: "a" as any })],
    ["tick_coin coin", (c) => c.tickCoin({ coin: "XRP" as any, shards: ["a"] })],
    ["defend shard", (c) => c.defend({ shard: "a:b", coin: "ETH" })],
    ["defend coin", (c) => c.defend({ shard: "a", coin: "XRP" as any })],
    ["vrf empty", (c) => c.vrf("")],
    ["vrf long", (c) => c.vrf("a".repeat(65))],
    ["vrf upper", (c) => c.vrf("Plan")],
    ["vrf underscore", (c) => c.vrf("a_b")],
  ];
  for (const [name, op] of bad) {
    it(`refuses ${name} before any call`, async () => {
      const { c, sent } = client([], null);
      await expect(op(c)).rejects.toBeInstanceOf(TypeError);
      expect(sent).toHaveLength(0);
    });
  }

  it("accepts 32 shards and a 64-character label", async () => {
    const { c, sent } = client([ok(), ok()]);
    await c.tickCoin({ coin: "ETH", shards: Array.from({ length: 32 }, (_, i) => `s${i}`) });
    await c.vrf("a".repeat(64));
    expect(inner(sent[0].body).shards).toHaveLength(32);
  });
});
