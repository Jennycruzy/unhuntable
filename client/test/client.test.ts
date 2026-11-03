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
    const { c, sent } = client(Array.from({ length: 7 }, () => ({ ...ok })));
    await c.agent("alpha");
    await c.leverage({ shard: "alpha", coin: "ETH", leverage: 5 });
    await c.open({ shard: "alpha", coin: "BTC", side: "short", size: 0.001 });
    await c.open({ shard: "alpha", coin: "SOL", side: "long", size: 1, builder: true });
    await c.tick({ shard: "alpha", coin: "ETH", dry: true });
    await c.register({ shard: "alpha", master: MASTER.toUpperCase().replace("0X", "0x") });
    await c.proof();
    expect(sent.map((s) => inner(s.body))).toEqual([
      { op: "agent", shard: "alpha" },
      { op: "leverage", shard: "alpha", coin: "ETH", leverage: 5 },
      { op: "open", shard: "alpha", coin: "BTC", side: "short", size: 0.001 },
      { op: "open", shard: "alpha", coin: "SOL", side: "long", size: 1, builder: true },
      { op: "tick", shard: "alpha", coin: "ETH", dry: true },
      { op: "register", shard: "alpha", master: MASTER },
      { op: "proof" },
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
