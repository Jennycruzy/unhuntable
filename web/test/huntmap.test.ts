import { describe, expect, it } from "vitest";
import { awayText, bandRows, money, px, short } from "../lib/huntmap";

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
