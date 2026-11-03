import { boxOpen, boxSeal, CALL_AAD, type Box } from "unhuntable-client";
import { describe, expect, it } from "vitest";
import { fillOf, GuardRefusal, GuardUnreachable, refusalFor } from "../src/guard.js";
import { createLogger } from "../src/log.js";
import { BOX_PUB, BOX_SECRET, harness, reply } from "./world.js";
import { logSink } from "./helpers.js";

const SHARD = "0123456789abcdef";
const MASTER = "0x" + "66".repeat(20);

function setup() {
  const h = harness();
  h.db.prepare("INSERT INTO users (id, near_account, created_ms, network) VALUES ('u', 'alice.near', 1, 'mainnet')").run();
  h.db.prepare("INSERT INTO pieces (id, user_id, label, kind, shard_id, created_ms, network) VALUES ('p', 'u', 'piece:0', 'piece', ?, 1, 'mainnet')").run(SHARD);
  h.db.prepare("INSERT INTO positions (id, user_id, coin, side, notional_usd, leverage, hiding, state, created_ms, network) VALUES ('x', 'u', 'ETH', 'long', 12, 3, 'normal', 'opening', 1, 'mainnet')").run();
  return h;
}

describe("guard adapter", () => {
  it("each op sends exactly one sealed box with the right inner fields", async () => {
    const h = setup();
    const g = h.ctx.guard;
    const ctxOrder = { positionId: "x", pieceId: "p" };
    const cases: Array<[string, () => Promise<unknown>, Record<string, unknown>]> = [
      ["agent", () => g.agent(SHARD), { op: "agent", shard: SHARD }],
      ["register", () => g.register(SHARD, MASTER), { op: "register", shard: SHARD, master: MASTER }],
      ["leverage", () => g.leverage(SHARD, "ETH", 3), { op: "leverage", shard: SHARD, coin: "ETH", leverage: 3 }],
      ["open", () => g.open(SHARD, "ETH", "long", 0.0045, ctxOrder), { op: "open", shard: SHARD, coin: "ETH", side: "long", size: 0.0045 }],
      ["close", () => g.close(SHARD, "ETH", ctxOrder), { op: "close", shard: SHARD, coin: "ETH" }],
      ["vrf", () => g.vrf("position-1"), { op: "vrf", label: "position-1" }],
      ["tick_coin", () => g.tickCoin("ETH", [SHARD]), { op: "tick_coin", coin: "ETH", shards: [SHARD], defend: true }],
      ["defend", () => g.defend(SHARD, "ETH"), { op: "defend", shard: SHARD, coin: "ETH" }],
    ];
    for (const [name, run, inner] of cases) {
      const before = h.world.calls.length;
      await run();
      const sent = h.world.calls.slice(before);
      expect(sent, name).toHaveLength(1);
      expect(sent[0].path).toBe("/call/guard.near/guard");
      const input = sent[0].body.input;
      // outside: only the box
      expect(Object.keys(input)).toEqual(["box"]);
      expect(JSON.stringify(input)).not.toContain(SHARD);
      const opened = JSON.parse(boxOpen(BOX_SECRET, input.box, CALL_AAD).toString("utf8"));
      const { salt, ...rest } = opened;
      expect(salt).toMatch(/^[0-9a-f]{64}$/);
      expect(rest, name).toEqual(inner);
    }
    // every call wrote a row; ticks and orders wrote theirs
    expect(h.db.prepare("SELECT op FROM guard_calls ORDER BY rowid").all()).toEqual(cases.map(([n]) => ({ op: n })));
    expect(h.db.prepare("SELECT kind, size, px, hl_oid FROM piece_orders ORDER BY rowid").all()).toEqual([
      { kind: "open", size: 0.0045, px: 2500.5, hl_oid: "77738308" },
      { kind: "close", size: 0.0045, px: 2510, hl_oid: "77738309" },
    ]);
    const tick = h.db.prepare("SELECT coin, shards_json, done_json, band_json FROM ticks").get();
    expect(tick).toEqual({ coin: "ETH", shards_json: JSON.stringify([SHARD]), done_json: JSON.stringify({ [SHARD]: "watch" }), band_json: JSON.stringify({ [SHARD]: [2400, 2600] }) });
  });

  it("close of a shard with nothing open is not an order", async () => {
    const h = setup();
    h.world.guardClose.push("guard-close-nothing-open");
    expect(await h.ctx.guard.close(SHARD, "ETH", { positionId: "x", pieceId: "p" })).toBeNull();
    expect(h.db.prepare("SELECT kind, size, px FROM piece_orders").all()).toEqual([{ kind: "close", size: null, px: null }]);
  });

  it("tick_coin reads the guard's shard reports, an error for one shard included", async () => {
    const h = setup();
    const t = reply("guard-tick-coin");
    t.output.shards = {
      [SHARD]: { done: "watch", band: [2400, 2600], has_stop: true, has_tp: null, defence: { action: "cut", rung: 1, distance: 0.11, size: 0.0011 }, order: null },
      fedcba9876543210: { error: "shard is not registered" },
    };
    h.world.guardTick = t;
    expect(await h.ctx.guard.tickCoin("ETH", [SHARD, "fedcba9876543210"])).toEqual({
      [SHARD]: { done: "watch", band: [2400, 2600], hasStop: true, hasTp: false, defence: { action: "cut", rung: 1, distance: 0.11, size: 0.0011 }, error: null },
      fedcba9876543210: { done: null, band: null, hasStop: false, hasTp: false, defence: null, error: "shard is not registered" },
    });
  });

  it("vrf answers output, proof and alpha", async () => {
    const h = setup();
    expect(await h.ctx.guard.vrf("position-1")).toEqual({ outputHex: "ab".repeat(32), proof: "cd".repeat(40), alpha: "position-1" });
  });

  it("forward puts the shard outside and the box unchanged, and never logs it", async () => {
    const h = setup();
    const sink = logSink();
    const log = createLogger({ level: "debug", destination: sink });
    const box: Box = boxSeal(BOX_PUB, Buffer.from(JSON.stringify({ op: "seal", shard: SHARD, stop: { coin: "ETH", side: "long", trigger: 2100.5, size: 0.0045 }, salt: "00" })), CALL_AAD);
    const out = await h.ctx.guard.forward(SHARD, box);
    log.info({ box, shard: SHARD }, "forwarded");
    expect(out.sealed).toBe(true);
    const sent = h.world.calls.at(-1)!;
    expect(sent.body).toEqual({ input: { box, shard: SHARD } });
    expect(sink.text()).not.toContain(box.ct);
    expect(JSON.stringify(h.db.prepare("SELECT * FROM guard_calls").all())).not.toContain(box.ct);
  });

  it("guard errors become refusals with our codes; no answer is unreachable", async () => {
    expect(refusalFor("fewer than 3 price sources agree")).toBe("prices_disagree");
    expect(refusalFor("prices are stale")).toBe("stale_price");
    expect(refusalFor("too few sources answered")).toBe("too_few_sources");
    expect(refusalFor("notional over the 1000 USD cap")).toBe("over_cap");
    expect(refusalFor("something else")).toBe("venue_rejected");
    const venue = (() => {
      try {
        fillOf(reply("guard-open-venue").output);
      } catch (e) {
        return e;
      }
    })() as GuardRefusal;
    expect(venue).toBeInstanceOf(GuardRefusal);
    expect(venue.code).toBe("venue_rejected");
    expect(venue.reason).toBe("Insufficient margin to place order.");

    const h = setup();
    h.world.guardOpen.push("guard-open-disagree");
    const e = await h.ctx.guard.open(SHARD, "ETH", "long", 0.0045, { positionId: "x", pieceId: "p" }).catch((x) => x);
    expect(e).toBeInstanceOf(GuardRefusal);
    expect(e.code).toBe("prices_disagree");
    h.world.guardDown = true;
    await expect(h.ctx.guard.agent(SHARD)).rejects.toBeInstanceOf(GuardUnreachable);
    expect(h.db.prepare("SELECT op, ok, error FROM guard_calls ORDER BY rowid").all()).toEqual([
      { op: "open", ok: 0, error: "fewer than 3 price sources agree" },
      { op: "agent", ok: 0, error: "unreachable" },
    ]);
    // no order row for a refused open
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM piece_orders").get()).toEqual({ n: 0 });
  });
});
