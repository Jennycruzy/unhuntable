import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { depositView } from "../lib/deposit";
import { qrMatrix } from "../lib/qr";

/** Draw the matrix as pixels (4 per module, 4-module quiet zone) and read it back with a QR decoder. */
function decode(text: string): string | undefined {
  const m = qrMatrix(text);
  const scale = 4;
  const n = (m.size + 8) * scale;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const r = Math.floor(y / scale) - 4;
      const c = Math.floor(x / scale) - 4;
      if (r >= 0 && c >= 0 && r < m.size && c < m.size && m.dark(r, c)) px.fill(0, (y * n + x) * 4, (y * n + x) * 4 + 3);
    }
  return jsQR(px, n, n)?.data;
}

describe("deposit", () => {
  it("the QR encodes exactly the deposit address", () => {
    for (const a of ["0x1111111111111111111111111111111111111111", "alice.near", "So11111111111111111111111111111111111111112"]) expect(decode(a)).toBe(a);
  });

  it("maps each status to its screen", () => {
    expect(depositView("waiting", 10_000, 4_000)).toEqual({ kind: "waiting", msLeft: 6_000 });
    expect(depositView("waiting", 10_000, 10_000)).toEqual({ kind: "expired" });
    expect(depositView("seen", 10_000, 20_000).kind).toBe("seen");
    expect(depositView("done", 0, 1, "99.4")).toEqual({ kind: "done", amountOut: "99.4" });
    expect(depositView("refunded", 0, 1)).toEqual({ kind: "refunded" });
    expect(depositView("expired", 10_000, 1)).toEqual({ kind: "expired" });
  });
});
