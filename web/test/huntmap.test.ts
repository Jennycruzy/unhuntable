import { describe, expect, it } from "vitest";
import { awayText, bandRows, money, px, replayPath, replayVerdict, short } from "../lib/huntmap";

describe("Hunt Map words", () => {
  it("writes prices, money, addresses and distances the way the page shows them", () => {
    expect(px(73564.4)).toBe("73,564");
    expect(px(65.895)).toBe("65.9");
    expect(px(0.36771)).toBe("0.3677");
    expect(money(4_110_994_722)).toBe("$4.1B");
    expect(money(85_425_527)).toBe("$85M");
    expect(money(866_569)).toBe("$867K");
    expect(short("0x8eff8ff863c1a54ec6697b7ad98fe30aa344bd5e")).toBe("0x8eff…bd5e");
    expect(awayText(-1.4829)).toBe("1.5% below");
    expect(awayText(2.4964)).toBe("2.5% above");
  });

  it("lists only bands that hold money, highest first, with the price between above and below", () => {
    const rows = bandRows({
      coin: "BTC",
      markPx: 100,
      usd: 6,
      nearest: [],
      bands: [
        { pct: -4, usd: 3, count: 1 },
        { pct: -2, usd: 0, count: 0 },
        { pct: -1, usd: 1, count: 1 },
        { pct: 3, usd: 2, count: 2 },
      ],
    });
    expect(rows).toEqual([
      { kind: "band", pct: 3, px: 103, usd: 2, count: 2 },
      { kind: "price" },
      { kind: "band", pct: -1, px: 99, usd: 1, count: 1 },
      { kind: "band", pct: -4, px: 96, usd: 3, count: 1 },
    ]);
  });

  it("still shows the price when nothing is near", () => {
    expect(bandRows({ coin: "BTC", markPx: 100, usd: 0, nearest: [], bands: [] })).toEqual([{ kind: "price" }]);
  });
});

describe("replays", () => {
  const r = {
    account: "0x0423b4b2acb4f219ae4a270abd5dde2360e455bb",
    coin: "xyz:HOOD",
    side: "long" as const,
    valueUsd: 200000,
    px: 90,
    ms: 2000,
    beforePx: 92,
    afterPx: 91,
    extremePx: 89,
    cameBack: true,
    candles: [
      { t: 1000, h: 92, l: 91, c: 91.5 },
      { t: 2000, h: 91, l: 89, c: 90.5 },
      { t: 3000, h: 92, l: 90.5, c: 91 },
    ],
  };

  it("draw the closes, the level and the moment inside the box", () => {
    const d = replayPath(r);
    expect(d.line).toBe("M0.00 8.00 L50.00 20.00 L100.00 14.00");
    expect(d.levelY).toBe(26);
    expect(d.markX).toBe(50);
    expect(d.extremeY).toBe(38);
  });

  it("say where the price was an hour later, for longs and shorts", () => {
    expect(replayVerdict(r)).toBe("Back above the level an hour later");
    expect(replayVerdict({ ...r, cameBack: false })).toBe("Still below the level an hour later");
    expect(replayVerdict({ ...r, side: "short" })).toBe("Back below the level an hour later");
    expect(replayVerdict({ ...r, side: "short", cameBack: false })).toBe("Still above the level an hour later");
  });
});
