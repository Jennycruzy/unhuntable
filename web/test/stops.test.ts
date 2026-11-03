import { describe, expect, it } from "vitest";
import { CALL_AAD, boxOpen, boxPublic } from "unhuntable-client";
import { Api } from "../lib/api";
import { buildBoxes, forgetBoxPub, sealLevels, sealOpened, keepUntilOpen } from "../lib/stops";
import type { SealedBox } from "../lib/types";
import { loadRecord } from "../lib/vault";
import { scriptedFetch } from "./helpers";

// Throwaway box key: 0x33 repeated, the same one the guard's test vectors use.
const SECRET = new Uint8Array(32).fill(0x33);
const BOX_PUB = boxPublic(SECRET);

/** Open a box the way the guard does (box.ts is the guard-side reference). */
function open(box: SealedBox) {
  return JSON.parse(boxOpen(SECRET, box, CALL_AAD).toString());
}

const TARGET = { coin: "BTC", side: "short", pieces: [{ shard: "s0", size: 0.0012 }, { shard: "s1", size: "0.0034" }] } as const;

describe("invisible stops", () => {
  it("seals one box per piece with exactly the guard's inner JSON", () => {
    expect(BOX_PUB).toBe("7b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b14");
    const boxes = buildBoxes(BOX_PUB, { ...TARGET, pieces: [...TARGET.pieces] }, { stop: 98765.5, tp: 81234.25, jitterBps: 35 });
    expect(boxes.map((b) => b.shard)).toEqual(["s0", "s0", "s1", "s1"]);
    const inner = boxes.map((b) => open(b.box));
    for (const i of inner) expect(i.salt).toMatch(/^[0-9a-f]{64}$/);
    const strip = ({ salt, ...rest }: { salt: string }) => (void salt, rest);
    expect(inner.map(strip)).toEqual([
      { op: "seal", shard: "s0", stop: { coin: "BTC", side: "short", trigger: 98765.5, size: 0.0012 }, jitter_bps: 35 },
      { op: "seal_tp", shard: "s0", tp: { coin: "BTC", side: "short", trigger: 81234.25, size: 0.0012 } },
      { op: "seal", shard: "s1", stop: { coin: "BTC", side: "short", trigger: 98765.5, size: 0.0034 }, jitter_bps: 35 },
      { op: "seal_tp", shard: "s1", tp: { coin: "BTC", side: "short", trigger: 81234.25, size: 0.0034 } },
    ]);
    expect(buildBoxes(BOX_PUB, { ...TARGET, pieces: [TARGET.pieces[0]] }, { stop: 1 }).map((b) => open(b.box).jitter_bps)).toEqual([20]);
  });

  it("the trigger never appears outside the box, and the level is kept in this browser", async () => {
    forgetBoxPub();
    const { fetch, sent } = scriptedFetch([
      ["GET /api/guard/box-pub", { body: { boxPub: BOX_PUB } }],
      ["POST /api/positions/pos9/stop", (s) => ({ body: { ok: true, sealed: JSON.parse(s.body).boxes.length } })],
    ]);
    const n = await sealLevels(new Api(fetch, ""), "dave.near", "pos9", { ...TARGET, pieces: [...TARGET.pieces] }, { stop: 98765.5 });
    expect(n).toBe(2);
    const body = JSON.parse(sent[1].body);
    expect(Object.keys(body)).toEqual(["boxes"]);
    for (const b of body.boxes) {
      expect(Object.keys(b).sort()).toEqual(["box", "shard"]);
      expect(Object.keys(b.box).sort()).toEqual(["ct", "epk", "nonce"]);
      expect(open(b.box).stop.trigger).toBe(98765.5);
    }
    for (const s of sent) {
      const outside = JSON.stringify({ url: s.url, headers: s.headers, body: s.body ? { ...JSON.parse(s.body), boxes: "sealed" } : null });
      expect(outside).not.toContain("98765");
    }
    expect((await loadRecord("dave.near")).levels.pos9).toEqual({ s0: { stop: 98765.5, jitterBps: 20 }, s1: { stop: 98765.5, jitterBps: 20 } });
  });

  it("levels chosen at confirm are sealed once the position is open", async () => {
    forgetBoxPub();
    await keepUntilOpen("erin.near", "pos3", { tp: 2500 });
    const { fetch, sent } = scriptedFetch([
      ["GET /api/guard/box-pub", { body: { boxPub: BOX_PUB } }],
      ["POST /api/positions/pos3/stop", { body: { ok: true, sealed: 1 } }],
    ]);
    const api = new Api(fetch, "");
    const pos = { id: "pos3", coin: "ETH" as const, side: "long" as const, pieces: [{ shard: "a", size: 0.01 }] };
    expect(await sealOpened(api, "erin.near", [{ ...pos, state: "opening" }])).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(await sealOpened(api, "erin.near", [{ ...pos, state: "open" }])).toEqual(["pos3"]);
    expect(open(JSON.parse(sent[1].body).boxes[0].box).tp.trigger).toBe(2500);
    expect((await loadRecord("erin.near")).waitingLevels).toEqual({});
  });

  it("refuses a level that is not a positive number", () => {
    expect(() => buildBoxes(BOX_PUB, { ...TARGET, pieces: [...TARGET.pieces] }, { stop: -1 })).toThrow("The stop price must be a positive number.");
    // the guard takes 0-100 basis points
    expect(() => buildBoxes(BOX_PUB, { ...TARGET, pieces: [...TARGET.pieces] }, { stop: 1, jitterBps: 101 })).toThrow("from 0 to 100");
    expect(buildBoxes(BOX_PUB, { ...TARGET, pieces: [...TARGET.pieces] }, { stop: 1, jitterBps: 100 })).toHaveLength(2);
  });
});
