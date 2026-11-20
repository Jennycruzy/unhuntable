import { describe, expect, it } from "vitest";
import { keyFromMnemonic } from "unhuntable-client/keys";
import { USDC_NEAR } from "unhuntable-client/exit";
import { fromUnits6, previewWithdraw, privateUsdc, sendWithdraw, usdcUnits6 } from "../lib/withdraw";
import { scriptedFetch } from "./helpers";

const key = keyFromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
const deps = (f: typeof fetch) => ({ key, account: "alice.near", outlayerFetch: f, now: () => 1_800_000_000_000 });

describe("withdrawing from the private balance", () => {
  it("reads USDC amounts both ways", () => {
    expect(usdcUnits6("12.5")).toBe("12500000");
    expect(usdcUnits6(" 0.000001 ")).toBe("1");
    expect(() => usdcUnits6("0")).toThrow("above zero");
    expect(() => usdcUnits6("1.0000001")).toThrow("Type an amount in USDC");
    expect(() => usdcUnits6("-1")).toThrow("Type an amount in USDC");
    expect(fromUnits6(21_340_000n)).toBe("21.34");
    expect(fromUnits6("5000000")).toBe("5");
  });

  it("reads the private balance from OutLayer, signed with the pieces key", async () => {
    const s = scriptedFetch([["GET /wallet/v1/confidential/balance", { body: { balances: [{ token: "nep141:other", balance: "9" }, { token: USDC_NEAR, balance: "21340000" }] } }]]);
    expect(await privateUsdc(deps(s.fetch))).toBe(21_340_000n);
    expect(s.sent[0]!.headers.authorization).toMatch(/^Bearer near:/);
  });

  it("asks what arrives, then sends to the signed-in NEAR account only", async () => {
    const s = scriptedFetch([
      ["POST /wallet/v1/confidential/withdraw/dry-run", { body: { amount_out: "12490000", time_estimate_seconds: 20 } }],
      ["POST /wallet/v1/confidential/withdraw", { body: { request_id: "req-1", status: "submitted" } }],
    ]);
    const p = await previewWithdraw(deps(s.fetch), "12.5", 21_340_000n);
    expect(p).toEqual({ units: "12500000", amountOut: "12.49", seconds: 20 });
    expect(await sendWithdraw(deps(s.fetch), p)).toEqual({ requestId: "req-1", status: "submitted" });
    for (const r of s.sent) expect(JSON.parse(r.body)).toEqual({ chain: "near", to: "alice.near", amount: "12500000", token: USDC_NEAR });
    expect(s.sent.map((r) => r.url)).toEqual(["https://api.outlayer.ai/wallet/v1/confidential/withdraw/dry-run", "https://api.outlayer.ai/wallet/v1/confidential/withdraw"]);
  });

  it("refuses more than the balance before asking anyone", async () => {
    const s = scriptedFetch([]);
    await expect(previewWithdraw(deps(s.fetch), "30", 21_340_000n)).rejects.toThrow("Your private balance holds 21.34 USDC. Type that or less.");
    expect(s.sent).toHaveLength(0);
  });

  it("says plainly when the wallet's policy refuses, and that nothing was sent", async () => {
    const s = scriptedFetch([["POST /wallet/v1/confidential/withdraw/dry-run", { status: 403, body: { error: "policy_denied", message: "address not in whitelist" } }]]);
    await expect(previewWithdraw(deps(s.fetch), "1", 21_340_000n)).rejects.toThrow("only sends to your own addresses");
  });

  it("says plainly when OutLayer is down", async () => {
    const f = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    await expect(privateUsdc(deps(f))).rejects.toThrow("OutLayer is not answering right now. Nothing was sent.");
  });
});
